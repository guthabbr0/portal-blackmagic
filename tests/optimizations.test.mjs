import assert from 'node:assert/strict';
import { buildScene, intersectPacked, BVH_MAX_LEAF, BVH_STACK_SIZE } from '../src/rendering/bvh.ts';
import { GpuTimer } from '../src/rendering/GpuTimer.ts';

const material = { color: [.6,.6,.6], emission: [0,0,0], metalness: 0, roughness: .6, atlas: [0,0,0,0], opacity: 1, textured: false };
const triangle = (x=0,y=0,z=0) => ({p:[x-1,y-1,z,x+1,y-1,z,x,y+1,z],n:[0,0,1,0,0,1,0,0,1],uv:[0,0,1,0,.5,1],material:0,object:0});
let checks=0,seed=101;
const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const test=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
// Independent reference: plane intersection followed by oriented edge tests.
// This does not call the BVH's Moller-Trumbore routine or build a one-triangle BVH.
function referenceHit(t,o,d,limit=Infinity){
 const a=t.p.slice(0,3),b=t.p.slice(3,6),c=t.p.slice(6,9),n=cross(sub(b,a),sub(c,a));
 const denom=dot(n,d);if(Math.abs(denom)<1e-9)return null;
 const distance=dot(n,sub(a,o))/denom;if(distance<=.00035||distance>=limit)return null;
 const p=o.map((v,i)=>v+d[i]*distance);
 for(const [v0,v1] of [[a,b],[b,c],[c,a]])if(dot(n,cross(sub(v1,v0),sub(p,v0)))<0)return null;
 return distance;
}
const tris=Array.from({length:360},()=>{
 const p=Array.from({length:9},()=>Math.round((rand()*18-9)*8)/8);
 return {...triangle(),p};
});
const scene=buildScene([tris,[],[],[]],[material]);

test('SAH closest hit matches independent plane/edge reference over 1200 arbitrary rays',()=>{
 for(let i=0;i<1200;i++){
  const o=Array.from({length:3},()=>rand()*24-12),d=Array.from({length:3},()=>rand()*2-1);
  const limit=rand()*30;let best=limit;
  for(const t of tris){const v=referenceHit(t,o,d,best);if(v!==null)best=v;}
  const hit=intersectPacked(scene,scene.roots[0],o,d,{limit});
  if(best===limit)assert.equal(hit,null);else assert.ok(hit&&Math.abs(best-hit.distance)<1e-5,JSON.stringify({best,hit}));
 }
});
test('SAH any-hit agrees with reference visibility over 1200 finite shadow segments',()=>{
 for(let i=0;i<1200;i++){
  const o=Array.from({length:3},()=>rand()*24-12),d=Array.from({length:3},()=>rand()*2-1),limit=rand()*20;
  const expected=tris.some(t=>referenceHit(t,o,d,limit)!==null);
  assert.equal(!!intersectPacked(scene,scene.roots[0],o,d,{limit,anyHit:true}),expected);
 }
});
test('Median and SAH agree on axis-aligned and nearly parallel rays',()=>{
 const ts=[triangle(0,0,0),triangle(0,0,-3),...Array.from({length:50},(_,i)=>triangle(i,4,-i))];
 const a=buildScene([ts],[material]),b=buildScene([ts],[material],{strategy:'median'});
 for(const d of [[0,0,-1],[-1e-12,0,-1],[1e-12,0,-1],[0,0,1],[1,0,0]]){
  const x=intersectPacked(a,a.roots[0],[0,0,2],d),y=intersectPacked(b,b.roots[0],[0,0,2],d);
  assert.equal(x?.distance,y?.distance);
 }
});
test('No scene mutation; leaf and stack bounds are enforced',()=>{
 const repeated=Array.from({length:4096},()=>triangle());const before=JSON.stringify(repeated);
 const s=buildScene([repeated],[material]);assert.equal(JSON.stringify(repeated),before);
 assert.ok(s.maxDepth<BVH_STACK_SIZE-2);
 for(let i=0;i<s.nodeCount;i++){const k=i*8;if(s.nodes.data[k+3]<0)assert.ok(s.nodes.data[k+7]<=BVH_MAX_LEAF);}
});
test('Invalid coordinates fail explicitly rather than corrupt the GPU texture',()=>{
 const bad=triangle();bad.p[3]=NaN;assert.throws(()=>buildScene([[bad]],[material]),/Invalid triangle/);
});
test('Any-hit stops early and respects segment length',()=>{
 const s=buildScene([[triangle(0,0,-5),triangle(0,0,0),triangle(0,0,-2)]],[material]);
 const a={boxes:0,triangles:0},b={boxes:0,triangles:0};
 assert.equal(intersectPacked(s,0,[0,0,3],[0,0,-1],{limit:2,anyHit:true}),null);
 assert.ok(intersectPacked(s,0,[0,0,3],[0,0,-1],{limit:20,counters:a,anyHit:true}));
 assert.ok(intersectPacked(s,0,[0,0,3],[0,0,-1],{limit:20,counters:b}));
 assert.ok(a.triangles<b.triangles);
});
function mockGL(supported=true){
 let disjoint=false,id=0,reads=0,deleted=0;
 return {QUERY_RESULT_AVAILABLE:1,QUERY_RESULT:2,
 getExtension:()=>supported?{TIME_ELAPSED_EXT:3,GPU_DISJOINT_EXT:4}:null,isContextLost:()=>false,
 getParameter:()=>disjoint,createQuery:()=>({id:++id,ready:false,ns:4000000}),beginQuery:()=>{},endQuery:()=>{},
 getQueryParameter:(q,kind)=>{if(kind===1)return q.ready;reads++;return q.ns;},deleteQuery:()=>deleted++,
 setDisjoint:v=>disjoint=v,get reads(){return reads;},get deleted(){return deleted;}};
}
test('GPU queries never read results before readiness',()=>{
 const gl=mockGL(),timer=new GpuTimer(gl);timer.begin();timer.end();timer.poll();
 assert.equal(gl.reads,0);assert.equal(timer.milliseconds,null);
 // TypeScript private is intentionally accessible only in this isolated mock test.
 timer.pending[0].ready=true;timer.poll();assert.equal(timer.milliseconds,4);assert.equal(timer.measurements,1);timer.dispose();
});
test('GPU query queue is bounded, disjoint results are discarded',()=>{
 const gl=mockGL(),timer=new GpuTimer(gl);for(let i=0;i<100;i++){timer.begin();timer.end();}
 assert.equal(timer.pending.length,4);gl.setDisjoint(true);timer.poll();assert.equal(timer.pending.length,0);
 assert.equal(timer.milliseconds,null);assert.equal(gl.reads,0);assert.equal(gl.deleted,4);timer.dispose();
});
test('Missing timer extension keeps the non-blocking fallback available',()=>{
 const timer=new GpuTimer(mockGL(false));timer.begin();timer.end();timer.poll();assert.equal(timer.supported,false);assert.equal(timer.milliseconds,null);timer.dispose();
});
console.log(`${checks} independent traversal and timer tests passed.`);
