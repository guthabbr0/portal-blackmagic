"""Optional headless validation of the production GLSL on Linux Mesa EGL.
Run `node tools/prepare-tests.mjs && node tools/export-test-scenes.mjs` first.
Requires Python, numpy, Pillow, libEGL and a software or hardware ES 3 driver.
This is not a WebGL/browser integration test or a gaming-GPU benchmark.
"""
import ctypes as C
import json
import os
from pathlib import Path
import numpy as np
from PIL import Image

os.environ.setdefault('EGL_PLATFORM','surfaceless')
os.environ.setdefault('LIBGL_ALWAYS_SOFTWARE','1')
ROOT=Path(__file__).resolve().parents[1]
data=json.loads((ROOT/'tests/generated/gpu-scenes.json').read_text())
W,H=data['width'],data['height']
egl=C.CDLL('libEGL.so.1')
ptr=C.c_void_p; I=C.c_int; U=C.c_uint; F=C.c_float; IP=C.POINTER(I); UP=C.POINTER(U)
def efn(name,result,args):
    f=getattr(egl,name);f.restype=result;f.argtypes=args;return f
getdisplay=efn('eglGetDisplay',ptr,[ptr]);init=efn('eglInitialize',U,[ptr,IP,IP])
dpy=getdisplay(None);major=I();minor=I();assert init(dpy,C.byref(major),C.byref(minor))
choose=efn('eglChooseConfig',U,[ptr,IP,C.POINTER(ptr),I,IP]);config=ptr();num=I()
attrs=(I*13)(0x3024,8,0x3023,8,0x3022,8,0x3033,1,0x3040,0x40,0x3021,8,0x3038)
assert choose(dpy,attrs,C.byref(config),1,C.byref(num)) and num.value
assert efn('eglBindAPI',U,[U])(0x30A0)
ctx=efn('eglCreateContext',ptr,[ptr,ptr,ptr,IP])(dpy,config,None,(I*3)(0x3098,3,0x3038));assert ctx
assert efn('eglMakeCurrent',U,[ptr,ptr,ptr,ptr])(dpy,None,None,ctx)
addr=efn('eglGetProcAddress',ptr,[C.c_char_p])
def gl(name,result,args):
    p=addr(name.encode());assert p,name;return C.CFUNCTYPE(result,*args)(p)
GetString=gl('glGetString',C.c_char_p,[U]);GetError=gl('glGetError',U,[])
CreateShader=gl('glCreateShader',U,[U]);ShaderSource=gl('glShaderSource',None,[U,I,C.POINTER(C.c_char_p),IP]);CompileShader=gl('glCompileShader',None,[U]);GetShaderiv=gl('glGetShaderiv',None,[U,U,IP]);GetShaderInfoLog=gl('glGetShaderInfoLog',None,[U,I,IP,C.c_char_p])
CreateProgram=gl('glCreateProgram',U,[]);AttachShader=gl('glAttachShader',None,[U,U]);LinkProgram=gl('glLinkProgram',None,[U]);GetProgramiv=gl('glGetProgramiv',None,[U,U,IP]);GetProgramInfoLog=gl('glGetProgramInfoLog',None,[U,I,IP,C.c_char_p]);UseProgram=gl('glUseProgram',None,[U])
GenTextures=gl('glGenTextures',None,[I,UP]);BindTexture=gl('glBindTexture',None,[U,U]);TexParameteri=gl('glTexParameteri',None,[U,U,I]);TexImage2D=gl('glTexImage2D',None,[U,I,I,I,I,I,U,U,ptr]);ActiveTexture=gl('glActiveTexture',None,[U])
GenFramebuffers=gl('glGenFramebuffers',None,[I,UP]);BindFramebuffer=gl('glBindFramebuffer',None,[U,U]);FramebufferTexture2D=gl('glFramebufferTexture2D',None,[U,U,U,U,I]);DrawBuffers=gl('glDrawBuffers',None,[I,UP]);CheckFramebufferStatus=gl('glCheckFramebufferStatus',U,[U]);ReadBuffer=gl('glReadBuffer',None,[U]);ReadPixels=gl('glReadPixels',None,[I,I,I,I,U,U,ptr])
GenVertexArrays=gl('glGenVertexArrays',None,[I,UP]);BindVertexArray=gl('glBindVertexArray',None,[U]);GenBuffers=gl('glGenBuffers',None,[I,UP]);BindBuffer=gl('glBindBuffer',None,[U,U]);BufferData=gl('glBufferData',None,[U,C.c_ssize_t,ptr,U]);GetAttribLocation=gl('glGetAttribLocation',I,[U,C.c_char_p]);EnableVertexAttribArray=gl('glEnableVertexAttribArray',None,[U]);VertexAttribPointer=gl('glVertexAttribPointer',None,[U,I,U,U,I,ptr])
GetUniformLocation=gl('glGetUniformLocation',I,[U,C.c_char_p]);Uniform1i=gl('glUniform1i',None,[I,I]);Uniform1f=gl('glUniform1f',None,[I,F]);Uniform2f=gl('glUniform2f',None,[I,F,F]);Uniform2iv=gl('glUniform2iv',None,[I,I,IP]);Uniform4iv=gl('glUniform4iv',None,[I,I,IP]);UniformMatrix4fv=gl('glUniformMatrix4fv',None,[I,I,U,C.POINTER(F)])
Viewport=gl('glViewport',None,[I,I,I,I]);DrawArrays=gl('glDrawArrays',None,[U,I,I]);Finish=gl('glFinish',None,[])
results=[]
def check(ok,name,details=None):
    result={'name':name,'passed':bool(ok),'details':details};results.append(result);print(('PASS' if ok else 'FAIL'),name,details or '',flush=True)
    assert ok,name

def shader(kind,source):
    s=CreateShader(kind);b=('#version 300 es\n'+source).encode();ShaderSource(s,1,(C.c_char_p*1)(b),None);CompileShader(s);ok=I();GetShaderiv(s,0x8B81,C.byref(ok))
    if not ok.value:
        message=C.create_string_buffer(32768);GetShaderInfoLog(s,len(message),None,message);raise RuntimeError(message.value.decode())
    return s

def program(fragment):
    p=CreateProgram();AttachShader(p,shader(0x8B31,data['fullscreenVertex']));AttachShader(p,shader(0x8B30,fragment));LinkProgram(p);ok=I();GetProgramiv(p,0x8B82,C.byref(ok))
    if not ok.value:
        message=C.create_string_buffer(32768);GetProgramInfoLog(p,len(message),None,message);raise RuntimeError(message.value.decode())
    return p

def texture(width,height,values=None,byte=False):
    t=U();GenTextures(1,C.byref(t));BindTexture(0x0DE1,t.value)
    for prop,val in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812F),(0x2803,0x812F)]:TexParameteri(0x0DE1,prop,val)
    array=np.asarray(values,dtype=np.uint8 if byte else np.float32) if values is not None else None
    TexImage2D(0x0DE1,0,0x8058 if byte else 0x8814,width,height,0,0x1908,0x1401 if byte else 0x1406,None if array is None else array.ctypes.data)
    return t.value

def target(count=2,byte=False):
    ts=[texture(W,H,byte=byte) for _ in range(count)];f=U();GenFramebuffers(1,C.byref(f));BindFramebuffer(0x8D40,f.value)
    for i,t in enumerate(ts):FramebufferTexture2D(0x8D40,0x8CE0+i,0x0DE1,t,0)
    DrawBuffers(count,(U*count)(*[0x8CE0+i for i in range(count)]))
    check(CheckFramebufferStatus(0x8D40)==0x8CD5,'Float MRT / display framebuffer complete')
    return f.value,ts

def loc(p,n):return GetUniformLocation(p,n.encode())
def bind(p,name,t,slot):
    ActiveTexture(0x84C0+slot);BindTexture(0x0DE1,t);Uniform1i(loc(p,name),slot)
def matrix(name,m):
    array=(F*len(m))(*m);UniformMatrix4fv(loc(trace,name),len(m)//16,0,array)

def setup(case):
    global sample,read,scene
    sample=0;read=0;scene=[];UseProgram(trace)
    for name,t in case['textures'].items():scene.append((name,texture(t['width'],t['height'],t['data'])))
    alpha=0 if case['name']=='alpha' else 1
    scene.append(('atlasTex',texture(1,1,[1,1,1,alpha])))
    Uniform4iv(loc(trace,'roots'),1,(I*4)(*case['roots']))
    for name in ['cameraWorld','inverseProjection','objectWorld','objectInverse','portalWorld','portalInverse']:
        matrix(name+('[0]' if name in ['objectWorld','objectInverse','portalWorld','portalInverse'] else ''),case[name])
    Uniform2iv(loc(trace,'portalActive'),1,(I*2)(*case['portalActive']))
    Uniform1i(loc(trace,'lightCount'),case['lightCount']);Uniform2f(loc(trace,'resolution'),W,H);Uniform1f(loc(trace,'radianceClamp'),0)

def draw(n,bounces):
    global sample,read
    UseProgram(trace)
    for i,(name,t) in enumerate(scene):bind(trace,name,t,i)
    for _ in range(n):
        bind(trace,'historyTex',targets[read][1][0],5)
        Uniform1i(loc(trace,'historySamples'),sample);Uniform1i(loc(trace,'frameSeed'),sample+1);Uniform1i(loc(trace,'maxBounces'),bounces)
        BindFramebuffer(0x8D40,targets[1-read][0]);Viewport(0,0,W,H);DrawArrays(0x0004,0,6);read=1-read;sample+=1
    Finish()

def pixels(attachment=0):
    BindFramebuffer(0x8D40,targets[read][0]);ReadBuffer(0x8CE0+attachment);p=np.zeros((H,W,4),dtype=np.float32);ReadPixels(0,0,W,H,0x1908,0x1406,p.ctypes.data);return p

def center(attachment=0):return pixels(attachment)[H//2,W//2].tolist()

version=GetString(0x1F02).decode();renderer=GetString(0x1F01).decode();print(version,renderer,flush=True)
try:
    trace=program(data['traceFragment']);filter_program=program(data['filterFragment']);display=program(data['displayFragment']);check(True,'All three production GLSL ES 3 shaders compile and link')
    vao=U();GenVertexArrays(1,C.byref(vao));BindVertexArray(vao.value);buffer=U();GenBuffers(1,C.byref(buffer));BindBuffer(0x8892,buffer.value)
    vs=np.array([-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0],dtype=np.float32);BufferData(0x8892,vs.nbytes,vs.ctypes.data,0x88E4)
    for p in [trace,filter_program,display]:
        a=GetAttribLocation(p,b'position');EnableVertexAttribArray(a);VertexAttribPointer(a,3,0x1406,0,0,None)
    targets=[target(),target()];output=target(1,True);filtered=target(1)
    cases={s['name']:s for s in data['cases']}
    setup(cases['black']);draw(2,4);check(center()[:3]==[0,0,0],'No ambient term: unlit geometry stays black',center())
    setup(cases['portal']);draw(4,1);check(center()[0]>3.9 and center()[1]<.4,'Primary rays traverse linked portal to an off-axis emitter',center());check(5.8<center(1)[3]<6.2,'Portal ray distance is preserved',center(1))
    setup(cases['mirror']);draw(64,3);check(center()[0]>2,'World-space reflection reaches emitter behind camera',center())
    setup(cases['dynamic']);draw(1,1);check(center()[0]>3.9,'Dynamic BLAS identity hits its emissive geometry',center())
    UseProgram(trace);world=cases['dynamic']['objectWorld'].copy();world[16+12]=12;inv=cases['dynamic']['objectInverse'].copy();inv[16+12]=-12;matrix('objectWorld[0]',world);matrix('objectInverse[0]',inv);sample=0;draw(1,1);check(center()[0]==0,'Rigid transform updates without rebuilding geometry; fresh history does not ghost',center())
    setup(cases['portalReflection']);draw(64,3);check(center()[0]>2,'Reflected rays traverse a portal before reaching an off-axis emitter',center())
    setup(cases['visibleLight']);draw(64,1);check(center()[0]>.3,'Area-light next-event sampling illuminates an unobstructed receiver',center())
    setup(cases['occludedLight']);draw(64,1);check(center()[0]==0,'Geometry blocks direct light: no shadow leak through an occluder',center())
    setup(cases['alpha']);draw(2,1);check(center()[0]>3.9,'Transparent label texels do not occlude surfaces',center())
    setup(cases['room']);draw(32,1);direct=pixels();setup(cases['room']);draw(128,4);indirect=pixels()
    check(np.isfinite(indirect).all(),'HDR accumulation remains finite')
    check(float(indirect[:,:,:3].sum())>1000,'Finite emissive area lights illuminate enclosed room',{'energy':float(indirect[:,:,:3].sum()),'center':center()})
    # The 1-bounce estimator uses weight 1 on NEE. Additional surface bounces
    # should add indirect energy, rather than a global ambient constant.
    d=float(direct[:,:,:3].sum());i=float(indirect[:,:,:3].sum());check(i>d*1.03,'Additional geometric bounces add measurable indirect energy',{'direct':d,'multiBounce':i,'ratio':i/d})
    before=pixels().copy()
    UseProgram(filter_program);bind(filter_program,'radianceTex',targets[read][1][0],0);bind(filter_program,'guideTex',targets[read][1][1],1)
    Uniform1f(loc(filter_program,'denoiseStrength'),1);Uniform1i(loc(filter_program,'samples'),sample)
    BindFramebuffer(0x8D40,filtered[0]);Viewport(0,0,W,H);DrawArrays(0x0004,0,6);Finish()
    check(np.array_equal(before,pixels()),'Internal-resolution denoising preserves raw accumulation')
    UseProgram(display);bind(display,'radianceTex',filtered[1][0],0);bind(display,'guideTex',targets[read][1][1],1);Uniform2f(loc(display,'outputResolution'),W,H);Uniform1f(loc(display,'exposure'),1.1);Uniform1f(loc(display,'denoiseStrength'),1);Uniform1i(loc(display,'samples'),sample)
    BindFramebuffer(0x8D40,output[0]);Viewport(0,0,W,H);DrawArrays(0x0004,0,6);Finish();check(GetError()==0,'No GL error after transport and display filtering')
    ReadBuffer(0x8CE0);img=np.zeros((H,W,4),dtype=np.uint8);ReadPixels(0,0,W,H,0x1908,0x1401,img.ctypes.data);Image.fromarray(img[::-1]).resize((W*4,H*4)).save(ROOT/'tests/generated/transport-validation.png')
except Exception as error:
    results.append({'name':'exception','passed':False,'details':str(error)});raise
finally:
    report={'driver':renderer,'api':version,'scope':'Production shader/BVH transport tests via native EGL; not full-app WebGL tests','results':results}
    (ROOT/'tests/generated/egl-results.json').write_text(json.dumps(report,indent=2))
