// Export the exact production GLSL / BVH layouts for a headless OpenGL ES runner.
import {readFileSync,writeFileSync} from 'node:fs';
import {buildScene,packMaterials} from '../tests/generated/bvh.js';
import {fullscreenVertex,traceFragment,filterFragment,displayFragment} from '../tests/generated/shaders.js';
const source=readFileSync('tests/gpu-harness.js','utf8');
const helpers=source.slice(source.indexOf('const identity='),source.indexOf('let trace,'));
const {identity,translate,camera,projection,inverse,mat,quad,box}=new Function('canvas',helpers+'\nreturn {identity,translate,camera,projection,inverse,mat,quad,box};')({width:128,height:80});
const materials=[mat([.5,.5,.5]),mat([.9,.9,.9],[4,.3,.1]),mat([.95,.95,.95],[0,0,0],1,.045)];
const wall=quad([-4,-4,0],[4,-4,0],[4,4,0],[-4,4,0],0);
const emitter=quad([3,-2,-3],[7,-2,-3],[7,2,-3],[3,2,-3],1);
const a=translate(0,0,.025),b=translate(5,0,0);b[0]=-1;b[10]=-1;
const mirror=wall.map(t=>({...t,material:2}));const behind=quad([-3,-3,6],[3,-3,6],[3,3,6],[-3,3,6],1);
const roomMaterials=[mat([.52,.55,.58]),mat([.28,.32,.36],[0,0,0],0,.25),mat([.65,.045,.025]),mat([.035,.08,.65]),mat([1,1,1],[28,24,20]),mat([.83,.61,.3],[0,0,0],.95,.15)];
const room=[...box(0,-.15,0,8,.3,14,1),...box(0,4.15,0,8,.3,14,0),...box(-4.15,2,0,.3,4,14,2),...box(4.15,2,0,.3,4,14,3),...box(0,2,-5.15,8,4,.3,0),...box(0,2,7.15,8,4,.3,0),...box(.6,.65,-.5,1.3,1.3,1.3,5),...box(-1.7,.45,-2,1,.9,1,0),...quad([-1.5,3.85,1],[1.5,3.85,1],[1.5,3.85,-.8],[-1.5,3.85,-.8],4)];
function scene(name,groups,ms,cam,portals,transforms){
 const s=buildScene(groups,ms);const textures={nodeTex:s.nodes,triangleTex:s.triangles,materialTex:packMaterials(ms),lightTex:s.lights};
 for(const p of Object.values(textures))p.data=Array.from(p.data);
 const p=portals||[identity(),identity()],t=transforms||Array.from({length:4},identity);
 return {name,textures,roots:s.roots,lightCount:s.lightCount,cameraWorld:cam,inverseProjection:inverse(projection()),objectWorld:t.flat(),objectInverse:t.map(inverse).flat(),portalWorld:p.flat(),portalInverse:p.map(inverse).flat(),portalActive:portals?[1,1]:[0,0]};
}
const cases=[scene('black',[wall,[],[],[]],materials,camera(0,0,3)),scene('portal',[[...wall,...emitter],[],[],[]],materials,camera(0,0,3),[a,b]),scene('mirror',[[...mirror,...behind],[],[],[]],materials,camera(0,0,3)),scene('dynamic',[[],wall.map(t=>({...t,material:1,object:1})),[],[]],materials,camera(0,0,3)),scene('room',[room,[],[],[]],roomMaterials,camera(0,1.7,5.5,-.10))];
// The zero-alpha foreground must not hide the emissive wall behind it.
const alphaMs=[{...mat([1,1,1]),textured:true,atlas:[1,1,0,0]},materials[1]];
cases.push(scene('alpha',[[...wall,...quad([-4,-4,-1],[4,-4,-1],[4,4,-1],[-4,4,-1],1)],[],[],[]],alphaMs,camera(0,0,3)));
// A reflected ray must cross a portal before reaching an off-axis emitter.
const reflectA=translate(0,0,5);reflectA[0]=-1;reflectA[10]=-1;
const reflectB=translate(5,0,-3);
cases.push(scene('portalReflection',[[...mirror,...quad([3,-2,0],[7,-2,0],[7,2,0],[3,2,0],1)],[],[],[]],materials,camera(0,0,3),[reflectA,reflectB]));
// Direct visibility test: a ceiling blocker occludes the light, not the camera.
const shadowMaterials=[mat([.6,.6,.6]),mat([1,1,1],[12,12,12])];
const receiver=quad([-5,0,5],[5,0,5],[5,0,-5],[-5,0,-5]);
const light=quad([-1,3,1],[1,3,1],[1,3,-1],[-1,3,-1],1);
const blocker=quad([-2,1.5,2],[2,1.5,2],[2,1.5,-2],[-2,1.5,-2]);
const shadowCamera=camera(0,2,5,-Math.atan2(2,5));
cases.push(scene('visibleLight',[[...receiver,...light],[],[],[]],shadowMaterials,shadowCamera));
cases.push(scene('occludedLight',[[...receiver,...light,...blocker],[],[],[]],shadowMaterials,shadowCamera));
writeFileSync('tests/generated/gpu-scenes.json',JSON.stringify({width:128,height:80,fullscreenVertex,traceFragment,filterFragment,displayFragment,cases}));
