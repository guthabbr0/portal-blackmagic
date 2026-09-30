/** Synthetic chamber-like geometry. Operation counts, NOT gaming-GPU timings.
 * Both A/B trees use the same new traversal; only the builder strategy changes.
 */
import { buildScene, intersectPacked } from '../src/rendering/bvh.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
const m={color:[.6,.6,.6],emission:[0,0,0],metalness:0,roughness:.6,atlas:[0,0,0,0],opacity:1,textured:false};
function quad(a,b,c,d){return [[a,b,c],[a,c,d]].map(p=>({p:p.flat(),n:[0,1,0,0,1,0,0,1,0],uv:[0,0,1,0,1,1],material:0,object:0}));}
function box(x,y,z,w,h,d){
 const a=x-w/2,b=x+w/2,c=y-h/2,e=y+h/2,f=z-d/2,g=z+d/2;
 return [...quad([a,c,g],[b,c,g],[b,e,g],[a,e,g]),...quad([b,c,f],[a,c,f],[a,e,f],[b,e,f]),
 ...quad([a,c,f],[a,c,g],[a,e,g],[a,e,f]),...quad([b,c,g],[b,c,f],[b,e,f],[b,e,g]),
 ...quad([a,e,g],[b,e,g],[b,e,f],[a,e,f]),...quad([a,c,f],[b,c,f],[b,c,g],[a,c,g])];
}
const geometry=[...box(0,-.25,0,18,.5,28),...box(0,8.25,0,18,.5,28),...box(-9.25,4,0,.5,8,28),...box(9.25,4,0,.5,8,28),...box(0,4,-14.25,18,8,.5),...box(0,4,14.25,18,8,.5)];
for(let z=-12;z<=12;z+=1.5){
 geometry.push(...box(0,7.8,z,18,.18,.12));
 for(const x of [-8.7,8.7])geometry.push(...box(x,1.4,z,.2,2.8,.15),...box(x,.06,z,.12,.12,1.3));
}
for(let z=-10;z<=8;z+=3)for(const x of [-5,-2,2,5])geometry.push(...box(x,.5,z,.9,1,.9));
let seed=37;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const normalized=d=>{const l=Math.hypot(...d);return d.map(v=>v/l);};
const camera=Array.from({length:3000},()=>({o:[0,1.7,12],d:normalized([(rand()-.5)*1.5,(rand()-.5),-1]),limit:100}));
const secondary=Array.from({length:3000},()=>({o:[rand()*16-8,rand()*7.5+.1,rand()*26-13],d:normalized([rand()*2-1,rand()*2-1,rand()*2-1]),limit:100}));
const shadow=Array.from({length:3000},()=>{
 const o=[rand()*16-8,.04,rand()*26-13],target=[rand()<.5?-4.8:4.8,7.6,[8,-1.5,-11.8][Math.floor(rand()*3)]];
 const delta=target.map((v,i)=>v-o[i]);return {o,d:normalized(delta),limit:Math.hypot(...delta)-.001};
});
const trees=Object.fromEntries(['median','sah'].map(strategy=>[strategy,buildScene([geometry,[],[],[]],[m],{strategy})]));
function measure(tree,rays,anyHit=false){
 const counters={boxes:0,triangles:0};let hits=0;
 for(const q of rays)if(intersectPacked(tree,tree.roots[0],q.o,q.d,{limit:q.limit,anyHit,counters}))hits++;
 return {...counters,hits,rays:rays.length};
}
const rows={};
for(const [name,rays] of Object.entries({camera,secondary,shadow})){
 rows[name]={median:measure(trees.median,rays),sah:measure(trees.sah,rays)};
 if(rows[name].median.hits!==rows[name].sah.hits)throw new Error('Visibility mismatch in '+name);
}
rows.shadow.sahAnyHit=measure(trees.sah,shadow,true);
if(rows.shadow.sahAnyHit.hits!==rows.shadow.sah.hits)throw new Error('Any-hit visibility mismatch');
const report={scope:'Synthetic chamber-like fixture, CPU operation counters; not full game or GPU FPS',
 triangles:geometry.length,trees:Object.fromEntries(Object.entries(trees).map(([name,s])=>[name,{nodes:s.nodeCount,depth:s.maxDepth,packedBytes:s.packedBytes}])),rows};
mkdirSync('tests/generated',{recursive:true});writeFileSync('tests/generated/traversal-benchmark.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
