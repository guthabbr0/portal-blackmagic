import assert from 'node:assert/strict';
import { buildScene, intersectPacked, packMaterials, triangleArea } from '../src/rendering/bvh.ts';
const material = { color: [.5,.5,.5], emission: [0,0,0], metalness: 0, roughness: .5, atlas: [0,0,0,0], opacity: 1, textured: false };
const triangle = (z, materialIndex=0, object=0) => ({p:[-1,-1,z,1,-1,z,0,1,z],n:[0,0,1,0,0,1,0,0,1],uv:[0,0,1,0,.5,1],material:materialIndex,object});
let checks=0;
function test(name,fn){ fn(); checks++; console.log(`PASS ${name}`); }
test('Empty room and missing dynamic objects',()=>{
 const s=buildScene([[],[],[],[]],[material]); assert.deepEqual(s.roots,[-1,-1,-1,-1]); assert.equal(intersectPacked(s,-1,[0,0,1],[0,0,-1]),null);
});
test('Nearest hit, miss, and parallel ray',()=>{
 const s=buildScene([[triangle(-5),triangle(0)],[],[],[]],[material]);
 assert.equal(intersectPacked(s,s.roots[0],[0,0,3],[0,0,-1]).distance,3);
 assert.equal(intersectPacked(s,s.roots[0],[4,0,3],[0,0,-1]),null);
 assert.equal(intersectPacked(s,s.roots[0],[0,0,3],[1,0,0]),null);
 assert.equal(intersectPacked(s,s.roots[0],[0,0,-2],[0,0,-1]).distance,3);
});
test('Separate rigid-object roots preserve object IDs',()=>{
 const s=buildScene([[triangle(0)], [triangle(2,0,1)],[],[]],[material]);
 assert.equal(intersectPacked(s,s.roots[0],[0,0,3],[0,0,-1]).distance,3);
 const h=intersectPacked(s,s.roots[1],[0,0,3],[0,0,-1]);assert.equal(h.distance,1);assert.equal(s.triangles.data[h.triangle*28+26],1);
});
test('Area-light CDF and per-area PDF are normalized',()=>{
 const s=buildScene([[triangle(0),triangle(1,1),triangle(2,1)],[],[],[]],[material,{...material,emission:[5,5,5]}]);
 assert.equal(s.lightCount,2);assert.equal(s.lights.data[5],1);
 let mass=0;for(let i=0;i<s.triangleCount;i++) mass+=s.triangles.data[i*28+25]*2;
 assert.ok(Math.abs(mass-1)<1e-6);assert.equal(triangleArea(triangle(0)),2);
});
test('GPU material rows preserve scene-linear HDR, clamp only material bounds',()=>{
 const p=packMaterials([{...material,emission:[300,150,50],metalness:2,roughness:0}]);
 assert.equal(p.data[4],300);assert.equal(p.data[3],1);assert.ok(Math.abs(p.data[7]-.045)<1e-6);
});
test('BVH ordering matches per-triangle brute force across 500 rays',()=>{
 let seed=7;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 const tris=Array.from({length:800},()=>{const t=triangle(rand()*20-10);const x=rand()*20-10,y=rand()*20-10;t.p=t.p.map((v,i)=>v+(i%3===0?x:i%3===1?y:0));return t;});
 const s=buildScene([tris,[],[],[]],[material]);assert.ok(s.maxDepth<40);
 for(let i=0;i<500;i++){
   const o=[rand()*20-10,rand()*20-10,20];let best=Infinity;
   for(const t of tris){const h=intersectPacked(buildScene([[t]],[material]),0,o,[0,0,-1]);if(h)best=Math.min(best,h.distance);}
   const hit=intersectPacked(s,s.roots[0],o,[0,0,-1]);
   assert.ok(best===Infinity?hit===null:hit&&Math.abs(hit.distance-best)<1e-5);
 }
});
console.log(`${checks} BVH/material tests passed.`);
