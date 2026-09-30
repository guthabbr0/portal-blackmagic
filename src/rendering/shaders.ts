/** GLSL ES 3.0, deliberately independent of Three shader chunks.
 * Integrator: triangle BVH + Lambert/GGX mixture + area-light NEE + power MIS.
 * Linear HDR is accumulated before denoising, exposure and display conversion.
 */
export const fullscreenVertex = `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const traceFragment = `
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 outRadiance;
layout(location = 1) out vec4 outGuide;
uniform sampler2D nodeTex, triangleTex, materialTex, lightTex, atlasTex, historyTex;
uniform ivec4 roots;
uniform mat4 objectWorld[4], objectInverse[4];
uniform mat4 portalWorld[2], portalInverse[2];
uniform ivec2 portalActive;
uniform mat4 cameraWorld, inverseProjection;
uniform vec2 resolution;
uniform int frameSeed, historySamples, maxBounces, lightCount;
uniform float radianceClamp;
const float PI = 3.141592653589793;
const float EPS = .00035;
uint rngState;
float randomFloat() {
  rngState = rngState * 747796405u + 2891336453u;
  uint word = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
  word = (word >> 22u) ^ word;
  return float(word) * (1.0 / 4294967296.0);
}
vec4 fetchData(sampler2D tex, int index) {
  int w = textureSize(tex, 0).x;
  return texelFetch(tex, ivec2(index % w, index / w), 0);
}
struct Hit { float t; int tri; int object; vec2 bary; int portal; float ring; };
struct Surface { vec3 color; vec3 emission; float metal; float rough; float alpha; };
vec2 getUV(int tri, vec2 bary) {
  vec4 b = fetchData(triangleTex, tri * 7 + 1);
  vec4 c = fetchData(triangleTex, tri * 7 + 2);
  vec4 d = fetchData(triangleTex, tri * 7 + 3);
  vec4 e = fetchData(triangleTex, tri * 7 + 4);
  vec4 f = fetchData(triangleTex, tri * 7 + 5);
  vec4 g = fetchData(triangleTex, tri * 7 + 6);
  return vec2(b.w, c.w) * (1.0-bary.x-bary.y) + vec2(d.w,e.w)*bary.x + vec2(f.w,g.x)*bary.y;
}
Surface getSurface(int tri, vec2 bary) {
  int mi = int(fetchData(triangleTex, tri*7).w) * 4;
  vec4 c = fetchData(materialTex,mi), e = fetchData(materialTex,mi+1);
  vec4 rect = fetchData(materialTex,mi+2), flags = fetchData(materialTex,mi+3);
  vec4 texel = vec4(1.0);
  if (flags.y > .5) texel = texture(atlasTex, rect.zw + clamp(getUV(tri,bary),0.0,1.0)*rect.xy);
  return Surface(c.rgb*texel.rgb, e.rgb*texel.rgb, c.a, e.a, flags.x*texel.a);
}
bool alphaVisible(int tri, int material, vec2 bary) {
  vec4 flags=fetchData(materialTex,material*4+3);
  if(flags.x<.5) return false;
  if(flags.y<.5) return true; // opaque geometry: do not fetch normals, UVs or atlas
  vec4 rect=fetchData(materialTex,material*4+2);
  return texture(atlasTex,rect.zw+clamp(getUV(tri,bary),0.0,1.0)*rect.xy).a*flags.x>=.5;
}
float boxNear(vec3 origin, vec3 dir, vec3 bmin, vec3 bmax, float limit) {
  float near=0.0, far=limit;
  for(int axis=0;axis<3;axis++) {
    // Exact parallel handling also preserves the sign of tiny negative directions.
    if(dir[axis]==0.0) {
      if(origin[axis]<bmin[axis] || origin[axis]>bmax[axis]) return 1e30;
    } else {
      float a=(bmin[axis]-origin[axis])/dir[axis], b=(bmax[axis]-origin[axis])/dir[axis];
      near=max(near,min(a,b)); far=min(far,max(a,b));
      if(far<near) return 1e30;
    }
  }
  return near;
}
bool traceObject(vec3 origin, vec3 dir, int object, bool anyHit, inout Hit hit) {
  int root=roots[object]; if(root<0) return false;
  vec3 o=(objectInverse[object]*vec4(origin,1.0)).xyz;
  vec3 d=(objectInverse[object]*vec4(dir,0.0)).xyz;
  vec4 lo=fetchData(nodeTex,root*2), hi=fetchData(nodeTex,root*2+1);
  if(boxNear(o,d,lo.xyz,hi.xyz,hit.t)>=hit.t) return false;
  int stack[64]; float distances[64]; int sp=0, idx=root;
  // The builder guarantees depth < 62 and leaves <= 6. Exhaust the hierarchy;
  // never discard pending nodes just because an arbitrary visit count elapsed.
  while(idx>=0 || sp>0) {
    if(idx<0) {
      --sp; idx=stack[sp];
      if(distances[sp]>=hit.t) { idx=-1; continue; }
    }
    lo=fetchData(nodeTex,idx*2); hi=fetchData(nodeTex,idx*2+1);
    int left=int(lo.w), right=int(hi.w);
    if(left>=0) {
      vec4 ll=fetchData(nodeTex,left*2), lh=fetchData(nodeTex,left*2+1);
      vec4 rl=fetchData(nodeTex,right*2), rh=fetchData(nodeTex,right*2+1);
      float a=boxNear(o,d,ll.xyz,lh.xyz,hit.t), b=boxNear(o,d,rl.xyz,rh.xyz,hit.t);
      if(a>b) { int ti=left; left=right; right=ti; float tf=a; a=b; b=tf; }
      if(b<hit.t) { stack[sp]=right; distances[sp]=b; ++sp; }
      idx=a<hit.t ? left : -1;
      continue;
    }
    int start=-left-1;
    for(int j=0;j<6;j++) {
      if(j>=right) break;
      int ti=start+j;
      vec4 first=fetchData(triangleTex,ti*7);
      vec3 e1=fetchData(triangleTex,ti*7+1).xyz-first.xyz;
      vec3 e2=fetchData(triangleTex,ti*7+2).xyz-first.xyz;
      vec3 p=cross(d,e2); float det=dot(e1,p);
      if(abs(det)<1e-9) continue;
      vec3 delta=o-first.xyz; float u=dot(delta,p)/det;
      if(u<0.0 || u>1.0) continue;
      vec3 q=cross(delta,e1); float v=dot(d,q)/det;
      if(v<0.0 || u+v>1.0) continue;
      float t=dot(e2,q)/det;
      if(t>EPS && t<hit.t && alphaVisible(ti,int(first.w),vec2(u,v))) {
        hit=Hit(t,ti,object,vec2(u,v),-1,0.0);
        if(anyHit) return true;
      }
    }
    idx=-1;
  }
  return false;
}
void tracePortals(vec3 o, vec3 d, inout Hit h) {
  for(int i=0;i<2;i++) {
    if(portalActive[i]==0) continue;
    vec3 po=(portalInverse[i]*vec4(o,1.0)).xyz;
    vec3 pd=(portalInverse[i]*vec4(d,0.0)).xyz;
    if(pd.z>=-1e-6 || po.z<=0.0) continue;
    float t=-po.z/pd.z;
    vec2 xy=(po+pd*t).xy/vec2(.86,1.31);
    float r=length(xy);
    if(t>EPS && t<h.t && r<1.10) h=Hit(t,-1,0,vec2(0.0),i,r);
  }
}
Hit closest(vec3 o, vec3 d, float limit) {
  Hit h=Hit(limit,-1,0,vec2(0.0),-1,0.0);
  for(int obj=0;obj<4;obj++) traceObject(o,d,obj,false,h);
  tracePortals(o,d,h);
  return h;
}
bool occluded(vec3 o, vec3 d, float limit) {
  Hit h=Hit(limit,-1,0,vec2(0.0),-1,0.0);
  // Straight-line NEE cannot sample a teleported path; openings block this
  // strategy. BSDF continuation still transports light through linked portals.
  tracePortals(o,d,h);
  if(h.portal>=0) return true;
  for(int obj=0;obj<4;obj++) if(traceObject(o,d,obj,true,h)) return true;
  return false;
}
void getNormals(Hit h, vec3 rd, out vec3 n, out vec3 gn) {
  int k=h.tri*7;
  vec3 a=fetchData(triangleTex,k).xyz;
  vec3 b=fetchData(triangleTex,k+1).xyz;
  vec3 c=fetchData(triangleTex,k+2).xyz;
  vec3 na=fetchData(triangleTex,k+3).xyz;
  vec3 nb=fetchData(triangleTex,k+4).xyz;
  vec3 nc=fetchData(triangleTex,k+5).xyz;
  mat3 transform=mat3(objectWorld[h.object]);
  gn=normalize(transform*cross(b-a,c-a));
  n=normalize(transform*(na*(1.0-h.bary.x-h.bary.y)+nb*h.bary.x+nc*h.bary.y));
  if(dot(n,gn)<0.0) n=-n;
  if(dot(gn,rd)>0.0) { gn=-gn; n=-n; }
  if(dot(n,-rd)<.0001) n=gn;
}
mat3 basis(vec3 n) {
  vec3 t=normalize(cross(abs(n.z)<.999 ? vec3(0,0,1):vec3(0,1,0),n));
  return mat3(t,cross(n,t),n);
}
float ggxD(float nh,float a) {
  float a2=a*a, k=nh*nh*(a2-1.0)+1.0;
  return a2/(PI*k*k);
}
float smithG1(float nv,float a) { return 2.0*nv/max(1e-8,nv+sqrt(a*a+(1.0-a*a)*nv*nv)); }
float specChance(Surface s) { return mix(.2,.95,s.metal); }
vec3 evaluate(Surface s,vec3 n,vec3 v,vec3 l,out float pdf) {
  float nl=dot(n,l), nv=dot(n,v); pdf=0.0;
  if(nl<=0.0 || nv<=0.0) return vec3(0);
  vec3 h=normalize(v+l); float nh=max(0.0,dot(n,h)), vh=max(.00001,dot(v,h));
  float a=max(.002,s.rough*s.rough), D=ggxD(nh,a);
  vec3 f0=mix(vec3(.04),s.color,s.metal);
  vec3 F=f0+(1.0-f0)*pow(1.0-vh,5.0);
  vec3 spec=F*(D*smithG1(nv,a)*smithG1(nl,a)/max(1e-8,4.0*nv*nl));
  vec3 diffuse=(1.0-F)*(1.0-s.metal)*s.color/PI;
  // Visible-normal GGX density, transformed from half-vector to direction.
  pdf=mix(nl/PI,D*smithG1(nv,a)/max(1e-8,4.0*nv),specChance(s));
  return diffuse+spec;
}
vec3 sampleDirection(Surface s,vec3 n,vec3 v) {
  float r1=randomFloat(),r2=randomFloat();
  float phi=2.0*PI*r1;
  if(randomFloat()<specChance(s)) {
    float a=max(.002,s.rough*s.rough);
    // Heitz visible-normal sampling: stretch the view, sample its visible
    // hemisphere projection, then unstretch the normal. This avoids sampling
    // back-facing microfacets and reduces grazing-angle variance.
    mat3 frame=basis(n);
    vec3 localV=transpose(frame)*v;
    vec3 stretched=normalize(vec3(a*localV.xy,localV.z));
    float lensq=dot(stretched.xy,stretched.xy);
    vec3 t1=lensq>1e-12 ? vec3(-stretched.y,stretched.x,0.0)/sqrt(lensq):vec3(1,0,0);
    vec3 t2=cross(stretched,t1);
    float diskX=sqrt(r2)*cos(phi), diskY=sqrt(r2)*sin(phi);
    diskY=mix(sqrt(max(0.0,1.0-diskX*diskX)),diskY,.5*(1.0+stretched.z));
    vec3 visible=diskX*t1+diskY*t2+sqrt(max(0.0,1.0-diskX*diskX-diskY*diskY))*stretched;
    vec3 h=frame*normalize(vec3(a*visible.xy,max(1e-6,visible.z)));
    return reflect(-v,h);
  }
  float r=sqrt(r2);
  return basis(n)*vec3(r*cos(phi),r*sin(phi),sqrt(1.0-r2));
}
float powerMIS(float a,float b) { return a*a/max(1e-20,a*a+b*b); }
vec3 directLight(Surface s,vec3 p,vec3 n,vec3 gn,vec3 v,bool sampleBsdf) {
  if(lightCount==0) return vec3(0);
  float xi=randomFloat(); int lo=0,hi=lightCount-1;
  for(int j=0;j<24;j++) { if(lo>=hi) break; int mid=(lo+hi)/2;
    if(fetchData(lightTex,mid).y<xi) lo=mid+1; else hi=mid;
  }
  int tri=int(fetchData(lightTex,lo).x), k=tri*7;
  vec4 meta=fetchData(triangleTex,k+6);
  mat4 transform=objectWorld[int(meta.z)];
  vec3 a=(transform*vec4(fetchData(triangleTex,k).xyz,1)).xyz;
  vec3 b=(transform*vec4(fetchData(triangleTex,k+1).xyz,1)).xyz;
  vec3 c=(transform*vec4(fetchData(triangleTex,k+2).xyz,1)).xyz;
  float sr=sqrt(randomFloat()),r=randomFloat(); vec2 bary=vec2(sr*(1.0-r),sr*r);
  vec3 lp=a*(1.0-bary.x-bary.y)+b*bary.x+c*bary.y;
  Surface light=getSurface(tri,bary);
  if(light.alpha<.5) return vec3(0);
  vec3 diff=lp-p; float d2=dot(diff,diff),dist=sqrt(d2); vec3 l=diff/dist;
  float nl=dot(n,l),cosLight=abs(dot(normalize(cross(b-a,c-a)),-l));
  if(nl<=0.0 || dot(gn,l)<=0.0 || cosLight<1e-6) return vec3(0);
  float pdfL=meta.y*d2/cosLight, pdfB; vec3 f=evaluate(s,n,v,l,pdfB);
  if(pdfL<1e-12) return vec3(0);
  // A local straight shadow ray cannot represent a path teleported to another
  // light. Apertures block this NEE strategy; BSDF paths through them remain
  // fully traced, and receive MIS weight 1 at the next emitter.
  vec3 shadowOrigin=p+gn*EPS*3.0;
  vec3 sd=lp-shadowOrigin; float sl=length(sd);
  if(occluded(shadowOrigin,sd/sl,sl-EPS*4.0)) return vec3(0);
  return light.emission*f*nl*(sampleBsdf ? powerMIS(pdfL,pdfB):1.0)/pdfL;
}
void main() {
  ivec2 pixel=ivec2(gl_FragCoord.xy);
  rngState=uint(pixel.x)*1973u+uint(pixel.y)*9277u+uint(frameSeed)*26699u+911u;
  vec2 jitter=vec2(randomFloat(),randomFloat())-.5;
  vec2 ndc=(gl_FragCoord.xy+jitter)/resolution*2.0-1.0;
  vec4 view=inverseProjection*vec4(ndc,1.0,1.0);
  vec3 rd=normalize((cameraWorld*vec4(normalize(view.xyz/view.w),0.0)).xyz);
  vec3 ro=cameraWorld[3].xyz;
  vec3 throughput=vec3(1),radiance=vec3(0);
  float previousPdf=0.0,guideDepth=0.0; vec3 guideNormal=vec3(0);
  int guideMaterial=0;
  int bounce=0,portalHops=0; bool previousNee=false; float primaryDistance=0.0;
  for(int event=0;event<32;event++) {
    if(bounce>=maxBounces) break;
    Hit h=closest(ro,rd,1e20);
    if(h.tri<0 && h.portal<0) break; // black external environment, no ambient GI
    vec3 p=ro+rd*h.t;
    if(bounce==0) primaryDistance+=h.t;
    if(h.portal>=0) {
      int i=h.portal,j=1-i;
      vec3 tint=i==0 ? vec3(.055,.58,1.0):vec3(1.0,.27,.035);
      if(h.ring>.95 || portalActive[j]==0) {
        radiance+=throughput*tint*(h.ring>.95 ? 9.0:.45);
        if(bounce==0) { guideDepth=primaryDistance; guideNormal=normalize(portalWorld[i][2].xyz); guideMaterial=-2-i; }
        break;
      }
      if(portalHops++>=8) break;
      vec3 localP=(portalInverse[i]*vec4(p,1)).xyz;
      vec3 localD=(portalInverse[i]*vec4(rd,0)).xyz;
      localP.x=-localP.x; localP.z=EPS*4.0;
      localD.x=-localD.x; localD.z=-localD.z;
      ro=(portalWorld[j]*vec4(localP,1)).xyz;
      rd=normalize((portalWorld[j]*vec4(localD,0)).xyz);
      previousNee=false; continue;
    }
    Surface s=getSurface(h.tri,h.bary); vec3 n,gn; getNormals(h,rd,n,gn);
    if(bounce==0) { guideNormal=n; guideDepth=primaryDistance; guideMaterial=int(fetchData(triangleTex,h.tri*7).w)+1; }
    float weight=1.0;
    if(previousNee) {
      float pdfA=fetchData(triangleTex,h.tri*7+6).y;
      float pdfL=pdfA*h.t*h.t/max(1e-6,abs(dot(gn,-rd)));
      weight=powerMIS(previousPdf,pdfL);
    }
    radiance+=throughput*s.emission*weight;
    // At the final permitted hit there is no competing BSDF continuation.
    // Giving NEE a MIS weight below one there would systematically lose light.
    radiance+=throughput*directLight(s,p,n,gn,-rd,bounce+1<maxBounces);
    if(bounce+1>=maxBounces) break;
    vec3 next=normalize(sampleDirection(s,n,-rd)); float pdf;
    vec3 f=evaluate(s,n,-rd,next,pdf);
    if(pdf<1e-10 || dot(gn,next)<=0.0) break;
    throughput*=f*max(0.0,dot(n,next))/pdf;
    if(bounce>=2) {
      float survive=clamp(max(throughput.r,max(throughput.g,throughput.b)),.05,.95);
      if(randomFloat()>survive) break; throughput/=survive;
    }
    previousPdf=pdf; previousNee=true; ro=p+gn*EPS*3.0; rd=next; bounce++;
  }
  if(any(isnan(radiance)) || any(isinf(radiance))) radiance=vec3(0);
  if(radianceClamp>0.0) radiance=min(radiance,vec3(radianceClamp));
  vec3 history=texelFetch(historyTex,pixel,0).rgb;
  // Never read undefined/old-resolution history into a fresh accumulation.
  vec3 accumulated=historySamples==0 ? radiance : mix(history,radiance,1.0/(float(historySamples)+1.0));
  // Unused HDR alpha stores an exact material ID for edge-aware filtering.
  // This metadata is never averaged into radiance or used as transparency.
  outRadiance=vec4(accumulated,float(guideMaterial));
  outGuide=vec4(guideNormal,guideDepth);
}
`;

/** Filter in linear HDR at the INTERNAL tracing resolution, not at display DPR.
 * Never feeds the accumulation history. Spatial denoising is a display aid, not GI.
 */
export const filterFragment = `
precision highp float;
precision highp sampler2D;
out vec4 outColor;
uniform sampler2D radianceTex,guideTex;
uniform float denoiseStrength;
uniform int samples;
void main() {
  ivec2 size=textureSize(radianceTex,0), center=ivec2(gl_FragCoord.xy);
  vec4 guide=texelFetch(guideTex,center,0);
  float material=texelFetch(radianceTex,center,0).a;
  vec3 sum=vec3(0); float weightSum=0.0;
  float strength=denoiseStrength*clamp(8.0/sqrt(float(samples)+1.0),.35,2.0);
  for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++) {
    ivec2 pt=clamp(center+ivec2(x,y),ivec2(0),size-1);
    vec4 g=texelFetch(guideTex,pt,0);
    vec4 c=texelFetch(radianceTex,pt,0);
    float w=exp(-float(x*x+y*y)/max(.25,2.0*strength*strength));
    w*=pow(max(0.0,dot(guide.xyz,g.xyz)),32.0);
    w*=exp(-abs(guide.w-g.w)/max(.04,guide.w*.015));
    if(x==0 && y==0) w=1.0;
    if(c.a!=material) w=0.0;
    sum+=c.rgb*w; weightSum+=w;
  }
  outColor=vec4(sum/max(weightSum,.0001),material);
}
`;

export const displayFragment = `
precision highp float;
precision highp sampler2D;
out vec4 outColor;
uniform sampler2D radianceTex,guideTex;
uniform vec2 outputResolution;
uniform float exposure;
vec3 filmic(vec3 x) {
  return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.0,1.0);
}
vec3 srgb(vec3 c) { return mix(12.92*c,1.055*pow(c,vec3(1.0/2.4))-.055,step(vec3(.0031308),c)); }
void main() {
  ivec2 size=textureSize(radianceTex,0);
  vec2 texel=gl_FragCoord.xy/outputResolution*vec2(size)-.5;
  ivec2 base=ivec2(floor(texel)), center=clamp(ivec2(floor(texel+.5)),ivec2(0),size-1);
  vec2 f=fract(texel); vec4 guide=texelFetch(guideTex,center,0);
  float material=texelFetch(radianceTex,center,0).a;
  vec3 sum=vec3(0); float weightSum=0.0;
  // Four-tap edge-aware HDR upsampling avoids nearest-neighbour blockiness.
  // Explicit fetches work without floating-point linear-filter extensions.
  for(int y=0;y<2;y++) for(int x=0;x<2;x++) {
    ivec2 pt=clamp(base+ivec2(x,y),ivec2(0),size-1);
    vec4 g=texelFetch(guideTex,pt,0);
    float w=(x==0 ? 1.0-f.x:f.x)*(y==0 ? 1.0-f.y:f.y);
    float normalWeight=guide.w==0.0 && g.w==0.0 ? 1.0 : pow(max(0.0,dot(guide.xyz,g.xyz)),16.0);
    w*=normalWeight*exp(-abs(guide.w-g.w)/max(.04,guide.w*.015));
    vec4 c=texelFetch(radianceTex,pt,0);
    if(c.a!=material) w=0.0;
    sum+=c.rgb*w; weightSum+=w;
  }
  vec3 value=weightSum>1e-6 ? sum/weightSum : texelFetch(radianceTex,center,0).rgb;
  outColor=vec4(srgb(filmic(max(vec3(0),value)*exposure)),1.0);
}
`;
