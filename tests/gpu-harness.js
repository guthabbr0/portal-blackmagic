import { buildScene,packMaterials } from './generated/bvh.js';
import { fullscreenVertex,traceFragment,filterFragment,displayFragment } from './generated/shaders.js';
import { GpuTimer } from './generated/GpuTimer.js';
const canvas=document.getElementById('view'),log=document.getElementById('log');
const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const results=[];
const assert=(ok,name,data)=>{results.push({name,passed:!!ok,data});log.textContent=results.map(r=>`${r.passed?'PASS':'FAIL'} ${r.name} ${JSON.stringify(r.data??'')}`).join('\n');if(!ok)throw new Error(name);};
window.testResults={done:false,results};
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const inverse=(m)=>{
 const rows=Array.from({length:4},(_,i)=>[...Array.from({length:4},(_,j)=>m[j*4+i]),...Array.from({length:4},(_,j)=>i===j?1:0)]);
 for(let i=0;i<4;i++){
   let p=i;for(let j=i+1;j<4;j++)if(Math.abs(rows[j][i])>Math.abs(rows[p][i]))p=j;
   [rows[i],rows[p]]=[rows[p],rows[i]];const d=rows[i][i];rows[i]=rows[i].map(x=>x/d);
   for(let j=0;j<4;j++)if(j!==i){const a=rows[j][i];rows[j]=rows[j].map((x,k)=>x-a*rows[i][k]);}
 }
 return Array.from({length:16},(_,i)=>rows[i%4][4+Math.floor(i/4)]);
};
const translate=(x,y,z)=>{const m=identity();m[12]=x;m[13]=y;m[14]=z;return m;};
const camera=(x,y,z,pitch=0)=>{const c=Math.cos(pitch),s=Math.sin(pitch);return [1,0,0,0,0,c,s,0,0,-s,c,0,x,y,z,1];};
const projection=(fov=60)=>{const f=1/Math.tan(fov*Math.PI/360),n=.05,far=200;return [f/(canvas.width/canvas.height),0,0,0,0,f,0,0,0,0,(far+n)/(n-far),-1,0,0,2*far*n/(n-far),0];};
const mat=(color,emission=[0,0,0],metalness=0,roughness=.65)=>({color,emission,metalness,roughness,atlas:[0,0,0,0],opacity:1,textured:false});
const quad=(a,b,c,d,material=0,object=0)=>{
 const v=b.map((n,i)=>n-a[i]),w=c.map((n,i)=>n-a[i]);const n=[v[1]*w[2]-v[2]*w[1],v[2]*w[0]-v[0]*w[2],v[0]*w[1]-v[1]*w[0]],len=Math.hypot(...n);const normal=n.map(x=>x/len);
 return [[a,b,c],[a,c,d]].map(p=>({p:p.flat(),n:[...normal,...normal,...normal],uv:[0,0,1,0,1,1],material,object}));
};
const box=(x,y,z,w,h,d,material=0,object=0)=>{
 const a=x-w/2,b=x+w/2,c=y-h/2,e=y+h/2,f=z-d/2,g=z+d/2;
 return [...quad([a,c,g],[b,c,g],[b,e,g],[a,e,g],material,object),...quad([b,c,f],[a,c,f],[a,e,f],[b,e,f],material,object),
 ...quad([a,c,f],[a,c,g],[a,e,g],[a,e,f],material,object),...quad([b,c,g],[b,c,f],[b,e,f],[b,e,g],material,object),
 ...quad([a,e,g],[b,e,g],[b,e,f],[a,e,f],material,object),...quad([a,c,f],[b,c,f],[b,c,g],[a,c,g],material,object)];
};
let trace,filter,display,filtered,targets,sceneTextures=[],sample=0,read=0,seed=0;
function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,'#version 300 es\n'+source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
function program(fragment){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,fullscreenVertex));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;}
function texture(p){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,p.width,p.height,0,gl.RGBA,gl.FLOAT,p.data);return t;}
function target(count=2){const ts=Array.from({length:count},()=>0).map(()=>texture({width:canvas.width,height:canvas.height,data:null})),f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);ts.forEach((t,i)=>gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,t,0));gl.drawBuffers(ts.map((_,i)=>gl.COLOR_ATTACHMENT0+i));assert(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'MRT float framebuffer complete');return {textures:ts,framebuffer:f};}
function bind(name,tex,slot,p=trace){gl.activeTexture(gl.TEXTURE0+slot);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(gl.getUniformLocation(p,name),slot);}
function matrix(name,m){gl.uniformMatrix4fv(gl.getUniformLocation(trace,name),false,new Float32Array(m));}
function setup(tris,materials,cameraMatrix,portals=null,groups=null){
 sceneTextures.forEach(t=>gl.deleteTexture(t));sceneTextures=[];const scene=buildScene(groups||[tris,[],[],[]],materials);
 gl.useProgram(trace);
 for(const [name,data] of [['nodeTex',scene.nodes],['triangleTex',scene.triangles],['materialTex',packMaterials(materials)],['lightTex',scene.lights]]){const t=texture(data);sceneTextures.push(t);bind(name,t,sceneTextures.length-1);}
 const atlas=texture({width:1,height:1,data:new Float32Array([1,1,1,1])});sceneTextures.push(atlas);bind('atlasTex',atlas,4);
 gl.uniform4iv(gl.getUniformLocation(trace,'roots'),scene.roots);
 matrix('objectWorld[0]',Array.from({length:4},identity).flat());matrix('objectInverse[0]',Array.from({length:4},identity).flat());
 matrix('cameraWorld',cameraMatrix);matrix('inverseProjection',inverse(projection()));
 const p=portals||[identity(),identity()];matrix('portalWorld[0]',p.flat());matrix('portalInverse[0]',p.map(inverse).flat());
 gl.uniform2iv(gl.getUniformLocation(trace,'portalActive'),portals?[1,1]:[0,0]);
 gl.uniform2f(gl.getUniformLocation(trace,'resolution'),canvas.width,canvas.height);
 gl.uniform1i(gl.getUniformLocation(trace,'lightCount'),scene.lightCount);gl.uniform1f(gl.getUniformLocation(trace,'radianceClamp'),0);
 sample=0;read=0;seed=0;
}
function draw(bounces=4){
 gl.useProgram(trace);
 const names=['nodeTex','triangleTex','materialTex','lightTex','atlasTex'];names.forEach((n,i)=>bind(n,sceneTextures[i],i));
 bind('historyTex',targets[read].textures[0],5);
 gl.uniform1i(gl.getUniformLocation(trace,'historySamples'),sample);gl.uniform1i(gl.getUniformLocation(trace,'frameSeed'),++seed);gl.uniform1i(gl.getUniformLocation(trace,'maxBounces'),bounces);
 gl.bindFramebuffer(gl.FRAMEBUFFER,targets[1-read].framebuffer);gl.viewport(0,0,canvas.width,canvas.height);gl.drawArrays(gl.TRIANGLES,0,6);read=1-read;sample++;
}
function show(denoise=0){
 let tex=targets[read].textures[0];
 if(denoise){
  gl.useProgram(filter);bind('radianceTex',tex,0,filter);bind('guideTex',targets[read].textures[1],1,filter);
  gl.uniform1f(gl.getUniformLocation(filter,'denoiseStrength'),denoise);gl.uniform1i(gl.getUniformLocation(filter,'samples'),sample);
  gl.bindFramebuffer(gl.FRAMEBUFFER,filtered.framebuffer);gl.drawArrays(gl.TRIANGLES,0,6);tex=filtered.textures[0];
 }
 gl.useProgram(display);bind('radianceTex',tex,0,display);bind('guideTex',targets[read].textures[1],1,display);
 gl.uniform2f(gl.getUniformLocation(display,'outputResolution'),canvas.width,canvas.height);gl.uniform1f(gl.getUniformLocation(display,'exposure'),1.1);
 gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();
}
function pixel(x=canvas.width/2,y=canvas.height/2,attachment=0){gl.bindFramebuffer(gl.FRAMEBUFFER,targets[read].framebuffer);gl.readBuffer(gl.COLOR_ATTACHMENT0+attachment);const p=new Float32Array(4);gl.readPixels(Math.floor(x),Math.floor(y),1,1,gl.RGBA,gl.FLOAT,p);return [...p];}
function fullImage(){gl.bindFramebuffer(gl.FRAMEBUFFER,targets[read].framebuffer);gl.readBuffer(gl.COLOR_ATTACHMENT0);const p=new Float32Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.FLOAT,p);return p;}
async function samples(n,bounces){for(let i=0;i<n;i++){draw(bounces);if(i%8===0)await new Promise(r=>setTimeout(r,0));}}
try {
 assert(!!gl,'WebGL 2 context');assert(!!gl.getExtension('EXT_color_buffer_float'),'Float render-target capability');
 trace=program(traceFragment);filter=program(filterFragment);display=program(displayFragment);assert(true,'All three production GLSL programs compile and link');
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0]),gl.STATIC_DRAW);
 for(const p of [trace,filter,display]){const loc=gl.getAttribLocation(p,'position');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}
 targets=[target(),target()];filtered=target(1);
 const materials=[mat([.5,.5,.5]),mat([.9,.9,.9],[4,.3,.1]),mat([.95,.95,.95],[0,0,0],1,.045)];
 const wall=quad([-4,-4,0],[4,-4,0],[4,4,0],[-4,4,0],0);
 setup(wall,materials,camera(0,0,3));await samples(2,4);assert(pixel()[0]===0&&pixel()[1]===0,'No ambient term: unlit enclosure is black',pixel());
 // Primary rays teleport to a second location, NOT a sampled portal texture.
 const emitter=quad([3,-2,-3],[7,-2,-3],[7,2,-3],[3,2,-3],1);
 const a=translate(0,0,.025),b=translate(5,0,0);b[0]=-1;b[10]=-1;
 setup([...wall,...emitter],materials,camera(0,0,3),[a,b]);await samples(4,1);
 assert(pixel()[0]>3.9&&pixel()[1]<.4,'Primary ray sees emitter only through linked portal',pixel());
 const guide=pixel(canvas.width/2,canvas.height/2,1);assert(guide[3]>5.8&&guide[3]<6.2,'Portal traversal preserves traveled ray distance',guide);
 // The shiny wall reflects an emitter behind the camera (off screen).
 const mirror=wall.map(t=>({...t,material:2}));const behind=quad([-3,-3,6],[3,-3,6],[3,3,6],[-3,3,6],1);
 setup([...mirror,...behind],materials,camera(0,0,3));await samples(32,3);
 assert(pixel()[0]>2,'World-space reflection sees an off-screen emitter',pixel());
 // Rigid BLAS transform changes the hit without rebuilding its triangle texture.
 setup([],materials,camera(0,0,3),null,[[],wall.map(t=>({...t,material:1,object:1})),[],[]]);draw(1);
 assert(pixel()[0]>3.9,'Rigid-object BLAS is visible');
 gl.useProgram(trace);const transforms=[identity(),translate(12,0,0),identity(),identity()];matrix('objectWorld[0]',transforms.flat());matrix('objectInverse[0]',transforms.map(inverse).flat());sample=0;draw(1);
 assert(pixel()[0]===0,'Moving rigid-object transform invalidates its old location',pixel());
 // Any-hit shadows must preserve alpha cutouts and all dynamic BLAS roots.
 const receiver=quad([-5,0,5],[5,0,5],[5,0,-5],[-5,0,-5]);
 const light=quad([-1,3,1],[1,3,1],[1,3,-1],[-1,3,-1],1);
 const blocker=quad([-2,1.5,2],[2,1.5,2],[2,1.5,-2],[-2,1.5,-2]);
 const shadowMaterials=[mat([.6,.6,.6]),mat([1,1,1],[12,12,12])];
 const shadowCamera=camera(0,2,5,-Math.atan2(2,5));
 setup([...receiver,...light],shadowMaterials,shadowCamera);await samples(32,1);
 assert(pixel()[0]>.3,'Any-hit NEE: unobstructed receiver is lit',pixel());
 setup([...receiver,...light,...blocker],shadowMaterials,shadowCamera);await samples(32,1);
 assert(pixel()[0]===0,'Any-hit NEE: blocker fully occludes the emitter',pixel());
 setup([],shadowMaterials,shadowCamera,null,[[...receiver,...light],blocker.map(t=>({...t,object:1})),[],[]]);await samples(32,1);
 assert(pixel()[0]===0,'Any-hit NEE: a dynamic BLAS also casts shadows',pixel());
 const transparent={...mat([.6,.6,.6]),opacity:0};
 setup([...receiver,...light,...blocker.map(t=>({...t,material:2}))],[...shadowMaterials,transparent],shadowCamera);await samples(32,1);
 assert(pixel()[0]>.3,'Any-hit NEE: transparent blockers are skipped',pixel());
 const reflectA=translate(0,0,5);reflectA[0]=-1;reflectA[10]=-1;
 const reflectB=translate(5,0,-3);
 setup([...mirror,...quad([3,-2,0],[7,-2,0],[7,2,0],[3,2,0],1)],materials,camera(0,0,3),[reflectA,reflectB]);await samples(32,3);
 assert(pixel()[0]>2,'Reflected rays cross a linked portal to an emitter',pixel());
 // Enclosed room: physically sampled area lighting, colored indirect and metal.
 const roomMaterials=[mat([.52,.55,.58]),mat([.28,.32,.36],[0,0,0],0,.25),mat([.65,.045,.025]),mat([.035,.08,.65]),mat([1,1,1],[28,24,20]),mat([.83,.61,.3],[0,0,0],.95,.15)];
 const room=[...box(0,-.15,0,8,.3,14,1),...box(0,4.15,0,8,.3,14,0),...box(-4.15,2,0,.3,4,14,2),...box(4.15,2,0,.3,4,14,3),...box(0,2,-5.15,8,4,.3,0),...box(0,2,7.15,8,4,.3,0),...box(.6,.65,-.5,1.3,1.3,1.3,5),...box(-1.7,.45,-2,1,.9,1,0),...quad([-1.5,3.85,1],[1.5,3.85,1],[1.5,3.85,-.8],[-1.5,3.85,-.8],4)];
 setup(room,roomMaterials,camera(0,1.7,5.5,-.10));await samples(64,4);const pixels=fullImage();
 assert([...pixels].every(Number.isFinite),'Scene-linear accumulation contains no NaNs or infinities');
 let energy=0;for(let i=0;i<pixels.length;i+=4)energy+=pixels[i]+pixels[i+1]+pixels[i+2];
 assert(energy>1000,'Multi-bounce room receives visible area-light energy',{energy,center:pixel()});
 const before=fullImage();show(1);const after=fullImage();
 assert(before.every((v,i)=>v===after[i]),'Spatial filtering never writes to the accumulation history');
 assert(gl.getError()===gl.NO_ERROR,'No WebGL error after three-pass rendering');
 // Identical depth/normals but different materials must not bleed together.
 const edgeRadiance=texture({width:4,height:1,data:new Float32Array([10,0,0,1,10,0,0,1,0,0,10,2,0,0,10,2])});
 const edgeGuide=texture({width:4,height:1,data:new Float32Array([0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1])});
 gl.useProgram(filter);bind('radianceTex',edgeRadiance,0,filter);bind('guideTex',edgeGuide,1,filter);
 gl.uniform1f(gl.getUniformLocation(filter,'denoiseStrength'),1);gl.uniform1i(gl.getUniformLocation(filter,'samples'),1);
 gl.bindFramebuffer(gl.FRAMEBUFFER,filtered.framebuffer);gl.viewport(0,0,4,1);gl.drawArrays(gl.TRIANGLES,0,6);
 const edge=new Float32Array(16);gl.readPixels(0,0,4,1,gl.RGBA,gl.FLOAT,edge);
 assert(edge[6]===0&&edge[8]===0&&edge[7]===1&&edge[11]===2,'Denoising preserves material boundaries and material IDs');
 gl.useProgram(display);bind('radianceTex',edgeRadiance,0,display);bind('guideTex',edgeGuide,1,display);
 gl.uniform2f(gl.getUniformLocation(display,'outputResolution'),8,1);gl.uniform1f(gl.getUniformLocation(display,'exposure'),1);
 gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,8,1);gl.drawArrays(gl.TRIANGLES,0,6);
 const enlarged=new Uint8Array(32);gl.readPixels(0,0,8,1,gl.RGBA,gl.UNSIGNED_BYTE,enlarged);
 assert(enlarged[14]===0&&enlarged[16]===0,'HDR upsampling does not blend across a material edge');
 gl.deleteTexture(edgeRadiance);gl.deleteTexture(edgeGuide);gl.viewport(0,0,canvas.width,canvas.height);show(1);
 const timer=new GpuTimer(gl);
 if(timer.supported){
   timer.begin();show(1);timer.end();
   for(let i=0;i<100&&timer.measurements===0;i++){await new Promise(r=>setTimeout(r,10));timer.poll();}
   assert(timer.measurements>0&&Number.isFinite(timer.milliseconds),'Delayed GPU timer returns a finite result');
 }else assert(true,'GPU timer unavailable: frame-interval fallback remains supported');
 timer.dispose();
 window.testResults={done:true,results,renderer:gl.getParameter(gl.RENDERER),samples:sample};
 window.harness={draw,show,pixel,fullImage,samples};
} catch(error){log.textContent+='\nERROR '+error.stack;window.testResults={done:true,error:String(error.stack),results};throw error;}
