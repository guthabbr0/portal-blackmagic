import * as THREE from 'three';
import { PathTracer, DEFAULT_GRAPHICS, QUALITY, type GraphicsSettings, type GraphicsStats } from './rendering/PathTracer';

export type GameEvent = { type: 'hint' | 'level' | 'complete' | 'locked' | 'button'; text?: string; level?: number };
type Surface = { mesh: THREE.Mesh; width: number; height: number };
type Portal = { group: THREE.Group; surface: Surface | null; normal: THREE.Vector3; target: THREE.WebGLRenderTarget; material: THREE.ShaderMaterial; rim: THREE.Mesh; active: boolean };
type Box = { mesh: THREE.Mesh; box: THREE.Box3; kind?: string };

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const BLUE = new THREE.Color('#42c9ff');
const ORANGE = new THREE.Color('#ffae47');
const LEVELS = [
  { name: 'The First Principle', objective: 'Place the companion cube on the pressure button to unlock the exit.', hint: 'Look for the cube. Press E to pick it up, then E again to place it on the glowing button.', tag: 'OBJECTS & SWITCHES' },
  { name: 'A Way Through', objective: 'Connect the two white floor panels. Find the cube beyond the gap.', hint: 'Left click for a blue portal. Right click for an orange portal. Walk into one to come out the other.', tag: 'PORTAL TRAVERSAL' },
  { name: 'The Long Way Around', objective: 'Use portals or go around the divider. Bring the cube to the button.', hint: 'White panels accept portals. Dark walls do not. You can carry the cube through portals.', tag: 'SPATIAL THINKING' },
  { name: 'Terminal Velocity', objective: 'Fire a blue portal below, then drop into it. Your falling speed will launch you to the exit.', hint: 'The orange exit portal is behind you. Shoot blue on the white floor below, drop into it, then steer toward the raised exit platform.', tag: 'MOMENTUM' },
  { name: 'Final Examination', objective: 'Cross the gap, recover the cube, and activate the exit switch.', hint: 'Portal across the gap first. Pick up the cube on the other side and set it down on the button.', tag: 'FINAL TEST' },
];

const portalVertex = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const portalFragment = `uniform sampler2D viewTex; uniform vec2 viewResolution; uniform float time; uniform float linked; uniform vec3 tint; varying vec2 vUv;
void main(){ vec2 p=(vUv-.5)*2.; float r=length(p); float edge=1.-smoothstep(.88,1.,r); if(edge<.01) discard;
vec2 swirl=vec2(atan(p.y,p.x)/6.283+.5+time*.035, r*.55-time*.06);
vec3 energy=tint*(.16+.22*sin(r*20.-time*3.)+.12*sin(atan(p.y,p.x)*7.+time*2.));
vec3 scene=texture2D(viewTex,gl_FragCoord.xy/viewResolution).rgb;
vec3 color=mix(energy,scene,linked);
color+=tint*pow(r,5.)*.65;
gl_FragColor=vec4(color,edge);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(76, 1, .06, 180);
  portalCamera = new THREE.PerspectiveCamera(76, 1, .06, 180);
  clock = new THREE.Clock();
  player = V(0, 0, 10);
  velocity = V();
  yaw = 0;
  pitch = 0;
  level = 0;
  playing = false;
  locked = false;
  won = false;
  onGround = false;
  keys = new Set<string>();
  surfaces: Surface[] = [];
  solids: Box[] = [];
  portals: Portal[] = [];
  cube: THREE.Group | null = null;
  cubeVelocity = V();
  held = false;
  button: THREE.Group | null = null;
  buttonLight: THREE.PointLight | null = null;
  door: Box | null = null;
  doorY = 0;
  buttonActive = false;
  exitMarker: THREE.Group | null = null;
  gun = new THREE.Group();
  gunKick = 0;
  teleportCooldown = 0;
  particles: { mesh: THREE.Mesh; life: number; velocity: THREE.Vector3 }[] = [];
  onEvent: (event: GameEvent) => void;
  audio: AudioContext | null = null;
  time = 0;
  lastButtonState = false;
  tracer: PathTracer | null = null;
  graphics: GraphicsSettings = { ...DEFAULT_GRAPHICS };
  traceFailure = '';
  private renderScale = QUALITY.balanced.scale;
  private cssWidth = 1;
  private cssHeight = 1;
  private fps = 0;
  private frameMs = 33;
  private lastFrameTime = 0;
  private adaptElapsed = 0;
  private tuningUntil = 0;
  private shadowLights: THREE.SpotLight[] = [];
  private fallbackAmbient = new THREE.AmbientLight('#d4e4ef', .12);
  private destroyed = false;


  constructor(container: HTMLElement, onEvent: (event: GameEvent) => void) {
    this.onEvent = onEvent;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false; // one shadow-map update per frame, not per portal view
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.cssWidth = Math.max(1, container.clientWidth); this.cssHeight = Math.max(1, container.clientHeight);
    this.camera.aspect = this.cssWidth / this.cssHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.graphics.exposure;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#0b1119');
    this.scene.fog = null; // no unlit fog overlay washing out contact and bounce lighting
    this.camera.rotation.order = 'YXZ';
    this.portalCamera.rotation.order = 'YXZ';
    // This explicitly labelled readability fill exists only in the raster renderer.
    // The path tracer has a black environment and integrates real emissive geometry.
    this.fallbackAmbient.userData.persistent = true;
    this.scene.add(this.fallbackAmbient);
    try {
      const saved = JSON.parse(localStorage.getItem('portal-graphics-v1') || '{}');
      if (saved.mode === 'path' || saved.mode === 'raster') this.graphics.mode = saved.mode;
      if (typeof saved.quality === 'string' && Object.prototype.hasOwnProperty.call(QUALITY, saved.quality)) this.graphics.quality = saved.quality;
      if (typeof saved.exposure === 'number' && Number.isFinite(saved.exposure)) this.graphics.exposure = THREE.MathUtils.clamp(saved.exposure, .3, 2.5);
      if (typeof saved.denoise === 'boolean') this.graphics.denoise = saved.denoise;
      if (typeof saved.adaptive === 'boolean') this.graphics.adaptive = saved.adaptive;
    } catch { /* Storage can be unavailable in a sandbox or private mode. */ }
    const requestedRenderer = new URLSearchParams(location.search).get('renderer');
    if (requestedRenderer === 'raster' || requestedRenderer === 'path') this.graphics.mode = requestedRenderer;
    this.renderScale = QUALITY[this.graphics.quality].scale;
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.contextRestored);
    this.makePortals();
    this.makeGun();
    this.loadLevel(0);
    this.tracer = new PathTracer(this.renderer);
    this.renderer.debug.onShaderError = (gl, _program, vertex, fragment) => {
      throw new Error(`GPU shader could not compile: ${gl.getShaderInfoLog(vertex) || ''} ${gl.getShaderInfoLog(fragment) || ''}`);
    };
    try {
      this.tracer.setScene(this.scene, this.camera, this.cube, this.door?.mesh || null, this.gun, this.portals);
    } catch (error) { this.failTracing(error); }
    if (!this.tracer.supported) this.graphics.mode = 'raster';
    this.configureGraphics({});
    this.animate();
  }

  mat(color: string, metalness = 0, roughness = .65, emissive?: string, intensity = 0) {
    return new THREE.MeshStandardMaterial({ color, metalness, roughness, emissive: emissive || '#000000', emissiveIntensity: intensity });
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, collide = false, kind?: string, material?: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || this.mat(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    if (collide) this.solids.push({ mesh, box: new THREE.Box3().setFromObject(mesh), kind });
    return mesh;
  }

  light(x: number, y: number, z: number, color: string, intensity: number, distance: number) {
    const l = new THREE.PointLight(color, intensity, distance, 2);
    l.position.set(x, y, z);
    this.scene.add(l);
    return l;
  }

  label(text: string, x: number, y: number, z: number, scale = 1, rotation = 0, color = '#b8d0de') {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = color; ctx.font = '600 84px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(text, 512, 158);
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5.8 * scale, 1.45 * scale), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z); mesh.rotation.y = rotation; this.scene.add(mesh);
    return mesh;
  }

  // Portalable panels are separate raycast surfaces placed just in front of solid architecture.
  surface(x: number, y: number, z: number, w: number, h: number, normal: THREE.Vector3, floor = false) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat(floor ? '#c3cbd0' : '#d3dce0', .05, .85));
    mesh.position.set(x, y, z);
    mesh.quaternion.setFromUnitVectors(V(0, 0, 1), normal);
    mesh.userData.portalSurface = true;
    this.scene.add(mesh);
    this.surfaces.push({ mesh, width: w, height: h });
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)), new THREE.LineBasicMaterial({ color: '#87939b', transparent: true, opacity: .48 }));
    outline.position.copy(mesh.position).addScaledVector(normal, .007);
    outline.quaternion.copy(mesh.quaternion); this.scene.add(outline);
    return mesh;
  }

  makePortals() {
    [BLUE, ORANGE].forEach((color) => {
      const hdrPortals = !!this.renderer.extensions.get('EXT_color_buffer_float');
      const target = new THREE.WebGLRenderTarget(512, 288, { type: hdrPortals ? THREE.HalfFloatType : THREE.UnsignedByteType });
      const material = new THREE.ShaderMaterial({ vertexShader: portalVertex, fragmentShader: portalFragment, transparent: true, side: THREE.DoubleSide, depthWrite: false,
        uniforms: { viewTex: { value: target.texture }, viewResolution: { value: new THREE.Vector2() }, time: { value: 0 }, linked: { value: 0 }, tint: { value: color } } });
      const group = new THREE.Group();
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.72, 2.62), material);
      face.position.z = .035; group.add(face);
      const rim = new THREE.Mesh(new THREE.RingGeometry(.91, 1.025, 80), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .92, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      rim.scale.set(.88, 1.35, 1); rim.position.z = .054; group.add(rim);
      const halo = new THREE.Mesh(new THREE.RingGeometry(.94, 1.13, 80), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .16, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.set(.88, 1.35, 1); halo.position.z = .049; group.add(halo);
      const glow = new THREE.PointLight(color, 3.5, 5); glow.position.z = .28; group.add(glow);
      group.visible = false; this.scene.add(group);
      this.portals.push({ group, surface: null, normal: V(0, 0, 1), target, material, rim, active: false });
    });
  }

  makeGun() {
    const dark = this.mat('#15232d', .85, .27), white = this.mat('#e5e9e8', .28, .27), blue = this.mat('#52cfff', .1, .2, '#3bbfff', 2.5);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(.14, .21, .75, 16), white); body.rotation.x = Math.PI / 2; body.position.set(.05, -.04, -.42); this.gun.add(body);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.165, .165, .37, 16), dark); core.rotation.x = Math.PI / 2; core.position.set(.05, -.04, -.48); this.gun.add(core);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(.169, .169, .18, 16), blue); glow.rotation.x = Math.PI / 2; glow.position.set(.05, -.04, -.48); this.gun.add(glow);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(.145, .025, 8, 24), dark); muzzle.position.set(.05, -.04, -.83); this.gun.add(muzzle);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(.027, .037, .63, 8), dark);
      arm.position.set(.05 + s * .16, -.025, -.73); arm.rotation.y = s * .19; this.gun.add(arm);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(.044, 8, 8), white); tip.position.set(.05 + s * .23, -.025, -1.04); this.gun.add(tip);
    }
    const grip = new THREE.Mesh(new THREE.BoxGeometry(.17, .34, .19), dark); grip.position.set(.05, -.28, -.16); grip.rotation.x = -.35; this.gun.add(grip);
    this.gun.position.set(.48, -.39, -.52); this.camera.add(this.gun); this.scene.add(this.camera);
  }

  addArchitecture(height: number, pit = false) {
    const wall = '#63717a', floor = '#68757b', dark = '#303b45';
    const floorMat = this.mat(floor, 0, .24); // coated dielectric, not a metal concrete floor
    this.box(0, height + .2, 0, 18, .4, 28, dark, true);
    this.box(-9.2, height / 2, 0, .4, height, 28, wall, true);
    this.box(9.2, height / 2, 0, .4, height, 28, wall, true);
    this.box(0, height / 2, 14.2, 18, height, .4, wall, true);
    this.box(0, height / 2, -14.2, 18, height, .4, wall, true);
    if (pit) {
      this.box(0, -.25, 8.2, 18, .5, 11.6, floor, true, 'floor', floorMat);
      this.box(0, -.25, -8.2, 18, .5, 11.6, floor, true, 'floor', floorMat);
      this.box(0, -7, 0, 18, .5, 4.8, dark, true);
      this.surface(0, .014, 5, 5, 5.2, V(0, 1, 0), true);
      this.surface(0, .014, -5, 5, 5.2, V(0, 1, 0), true);
    } else {
      this.box(0, -.25, 0, 18, .5, 28, floor, true, 'floor', floorMat);
      this.surface(-3.5, .014, 4.4, 4.4, 5.2, V(0, 1, 0), true);
      this.surface(3.5, .014, -3.5, 4.4, 5.2, V(0, 1, 0), true);
    }
    this.surface(-9 + .025, 3, 3, 8, 5.2, V(1, 0, 0));
    this.surface(9 - .025, 3, -3, 8, 5.2, V(-1, 0, 0));
    this.surface(0, 3, 14 - .025, 7, 5.2, V(0, 0, -1));
    for (let z = -12; z <= 12; z += 3) {
      this.box(-8.82, .08, z, .1, .12, 2.6, '#58b9d0', false, undefined, this.mat('#304c54', .4, .3, '#4ec8e6', .8));
      this.box(8.82, .08, z, .1, .12, 2.6, '#58b9d0', false, undefined, this.mat('#304c54', .4, .3, '#4ec8e6', .8));
      this.box(0, height - .12, z, 18, .18, .12, '#647681');
    }
    // Visible finite emitters drive the path tracer. Shadowed spotlights are
    // only inexpensive raster proxies positioned at those very same fixtures.
    for (const x of [-4.8, 4.8]) for (const z of [8, -1.5, -11.8]) {
      const tint = x > 0 && z === 8 ? '#ffe2bc' : '#e1efff';
      this.box(x, height - .22, z, 3.5, .25, 1.5, '#26313a', false, undefined, this.mat('#26313a', .75, .26));
      const diffuser = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.25), this.mat('#ffffff', 0, .5, tint, 80 * height / 8));
      diffuser.position.set(x, height - .36, z); diffuser.rotation.x = Math.PI / 2;
      this.scene.add(diffuser);
      const lamp = new THREE.SpotLight(tint, 750 * (height / 8) ** 2, 55, Math.PI * .46, .6, 2);
      lamp.position.set(x, height - .42, z);
      lamp.target.position.set(x, 0, z);
      lamp.castShadow = true;
      lamp.shadow.mapSize.set(1024, 1024); lamp.shadow.camera.near = .1; lamp.shadow.camera.far = 55;
      lamp.shadow.bias = -.00015; lamp.shadow.normalBias = .025;
      this.scene.add(lamp, lamp.target); this.shadowLights.push(lamp);
    }
    // Fine grid lines make the chamber scale legible without cluttering the scene.
    for (let x = -9; x <= 9; x += 3) {
      const line = this.box(x, .018, 0, .025, .015, 28, '#172632'); (line.material as THREE.MeshStandardMaterial).color.set('#35424b');
    }
    for (let z = -14; z <= 14; z += 3) {
      const line = this.box(0, .018, z, 18, .015, .025, '#172632'); (line.material as THREE.MeshStandardMaterial).color.set('#35424b');
    }
  }

  addCube(x: number, y: number, z: number) {
    const cube = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(.88, .88, .88), this.mat('#b5c0c5', .35, .43)); cube.add(body);
    const frameMat = this.mat('#667983', .65, .32);
    for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
      const dims = [1.01, 1.01, 1.01]; dims[a] = .075;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(dims[0], dims[1], dims[2]), frameMat);
      panel.position.setComponent(a, s * .47); cube.add(panel);
    }
    for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
      const face = new THREE.Mesh(new THREE.CircleGeometry(.29, 32), this.mat('#d2e8ed', .1, .35, '#56c9e9', .9));
      face.position.setComponent(a, s * .513);
      face.quaternion.setFromUnitVectors(V(0, 0, 1), V().setComponent(a, s)); cube.add(face);
      const icon = new THREE.Mesh(new THREE.RingGeometry(.11, .145, 4), new THREE.MeshBasicMaterial({ color: '#5ab9d3', side: THREE.DoubleSide }));
      icon.position.setComponent(a, s * .52);
      icon.quaternion.copy(face.quaternion); icon.rotation.z = Math.PI / 4; cube.add(icon);
    }
    cube.position.set(x, y, z); this.scene.add(cube); this.cube = cube; this.cubeVelocity.set(0, 0, 0);
  }

  addButton(x: number, y: number, z: number) {
    const group = new THREE.Group(); group.position.set(x, y, z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(.87, .94, .18, 32), this.mat('#18242b', .7, .4)); base.position.y = .09; group.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.67, .055, 10, 36), new THREE.MeshBasicMaterial({ color: '#f4a44d' })); ring.rotation.x = Math.PI / 2; ring.position.y = .19; group.add(ring);
    const center = new THREE.Mesh(new THREE.CylinderGeometry(.52, .58, .14, 32), this.mat('#aa5c35', .35, .35, '#d4712f', .8)); center.position.y = .18; group.add(center);
    this.scene.add(group); this.button = group;
    this.buttonLight = this.light(x, y + .4, z, '#f78e3e', 7, 4);
    this.label('WEIGHTED SWITCH', x, y + .35, z - 1.45, .45, 0, '#9eafbb');
  }

  addExit(y = 0) {
    this.box(-5.2, y + 2.4, -10, 7.6, 4.8, .6, '#34414b', true);
    this.box(5.2, y + 2.4, -10, 7.6, 4.8, .6, '#34414b', true);
    this.box(0, y + 4.4, -10, 2.8, .8, .6, '#34414b', true);
    const doorMesh = this.box(0, y + 1.9, -10, 2.8, 3.8, .48, '#778791', true, 'door', this.mat('#72848e', .65, .38));
    this.door = this.solids[this.solids.length - 1]; this.doorY = y + 1.9;
    this.box(-1.5, y + 1.9, -9.62, .12, 3.9, .16, '#5ed7fc', false, undefined, this.mat('#6cc9e4', .2, .3, '#3bccf4', 1.5));
    this.box(1.5, y + 1.9, -9.62, .12, 3.9, .16, '#5ed7fc', false, undefined, this.mat('#6cc9e4', .2, .3, '#3bccf4', 1.5));
    this.label('EXIT', 0, y + 4.65, -9.65, .53, 0, '#aee6f2');
    const marker = new THREE.Group(); marker.position.set(0, y, -12);
    const mat = new THREE.MeshBasicMaterial({ color: '#8ce9d2', transparent: true, opacity: .75 });
    const circle = new THREE.Mesh(new THREE.RingGeometry(.85, 1.02, 32), mat); circle.rotation.x = -Math.PI / 2; circle.position.y = .035; marker.add(circle);
    this.scene.add(marker); this.exitMarker = marker;
    void doorMesh;
  }

  loadLevel(n: number) {
    this.level = Math.max(0, Math.min(4, n)); this.won = false; this.held = false; this.keys.clear();
    for (const child of [...this.scene.children]) if (child !== this.camera && !child.userData.persistent && !this.portals.some(p => p.group === child)) { this.disposeObject(child); this.scene.remove(child); }
    this.shadowLights = [];
    this.solids = []; this.surfaces = []; this.cube = null; this.button = null; this.buttonLight = null; this.door = null; this.buttonActive = false; this.lastButtonState = false;
    for (const p of this.portals) { p.group.visible = false; p.active = false; p.surface = null; }
    for (const p of this.particles) this.scene.remove(p.mesh); this.particles = [];
    this.velocity.set(0, 0, 0); this.yaw = 0; this.pitch = -.06; this.teleportCooldown = 0;
    if (this.level === 3) {
      this.addArchitecture(17);
      // High starting shelf, low catch floor, and a raised receiving platform.
      this.box(0, 11.75, 10.8, 7, .5, 6.4, '#8a989e', true, 'floor');
      this.box(0, 2.95, -10.7, 7.4, .5, 6.5, '#899aa3', true, 'floor');
      const exitFace = this.surface(0, 12.8, 13.96, 5, 4.8, V(0, 0, -1));
      const floorFace = this.surface(0, .025, 2.2, 5.2, 5.2, V(0, 1, 0), true);
      this.addExit(3.2);
      this.placePortal(1, this.surfaces.find(s => s.mesh === exitFace)!, V(0, 12.8, 13.96), false);
      this.player.set(0, 12, 11.7);
      this.label('MOMENTUM IS PRESERVED', 0, 15.4, 13.94, .67, Math.PI, '#d3e7ea');
      this.light(0, 9, 4, '#ff9d49', 70, 12);
      void floorFace;
    } else {
      const pit = this.level === 1 || this.level === 4;
      this.addArchitecture(8, pit);
      if (this.level === 2) {
        this.box(-3.5, 2.5, .2, 11, 5, .55, '#36434d', true);
        this.box(6.5, 2.5, .2, 5, 5, .55, '#36434d', true);
        this.surface(0, 2.6, .52, 4.2, 4.6, V(0, 0, 1));
        this.surface(0, 2.6, -.12, 4.2, 4.6, V(0, 0, -1));
        this.label('THINK WITH PORTALS', 0, 6.6, -.3, .7, 0, '#afced9');
      }
      this.addExit();
      this.player.set(0, .03, 10.5);
      if (this.level === 0) { this.addCube(-3.5, .52, 5.5); this.addButton(3.5, 0, -4); }
      if (this.level === 1) { this.addCube(-3.5, .52, -5.5); this.addButton(3.5, 0, -6.5); }
      if (this.level === 2) { this.addCube(-4, .52, 6); this.addButton(4, 0, -5.5); }
      if (this.level === 4) { this.addCube(-3.5, .52, -5); this.addButton(3.5, 0, -6.5); this.label('FINAL EXAMINATION', 0, 6.6, -9.6, .66, 0, '#afced9'); }
    }
    this.updateCamera();
    this.scene.traverse(node => {
      if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshStandardMaterial) {
        node.castShadow = node.receiveShadow = true;
      }
    });
    this.gun.traverse(node => { if (node instanceof THREE.Mesh) node.castShadow = false; });
    if (this.tracer) {
      try { this.tracer.setScene(this.scene, this.camera, this.cube, this.door?.mesh || null, this.gun, this.portals); }
      catch (error) { this.failTracing(error); }
      this.configureGraphics({});
    }
    this.onEvent({ type: 'level', level: this.level });
    this.onEvent({ type: 'hint', text: LEVELS[this.level].hint });
  }

  placePortal(index: number, surface: Surface, point: THREE.Vector3, effects = true) {
    const p = this.portals[index];
    const inverse = surface.mesh.quaternion.clone().invert();
    const local = point.clone().sub(surface.mesh.position).applyQuaternion(inverse);
    local.x = THREE.MathUtils.clamp(local.x, -surface.width / 2 + 1.05, surface.width / 2 - 1.05);
    local.y = THREE.MathUtils.clamp(local.y, -surface.height / 2 + 1.48, surface.height / 2 - 1.48);
    local.z = 0;
    const world = local.applyQuaternion(surface.mesh.quaternion).add(surface.mesh.position);
    const other = this.portals[1 - index];
    if (other.active && other.surface === surface) {
      const gap = world.clone().sub(other.group.position).applyQuaternion(inverse);
      if ((gap.x / 1.88) ** 2 + (gap.y / 2.85) ** 2 < 1) {
        if (effects) { this.sound('fail'); this.onEvent({ type: 'hint', text: 'Leave space between the two portal openings.' }); }
        return;
      }
    }
    p.normal.set(0, 0, 1).applyQuaternion(surface.mesh.quaternion);
    p.group.position.copy(world).addScaledVector(p.normal, .032);
    p.group.quaternion.copy(surface.mesh.quaternion);
    p.group.visible = true; p.active = true; p.surface = surface;
    if (effects) { this.sound(index === 0 ? 'blue' : 'orange'); this.burst(p.group.position, index === 0 ? BLUE : ORANGE, 15); this.gunKick = .18; }
  }

  shoot(index: number) {
    if (!this.playing || !this.locked || this.won) return;
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = ray.intersectObjects(this.surfaces.map(s => s.mesh), false);
    if (!hits.length || hits[0].distance > 48) { this.sound('fail'); this.onEvent({ type: 'hint', text: 'Aim at a white panel. Dark surfaces cannot hold portals.' }); return; }
    const hit = hits[0];
    const obstruction = ray.intersectObjects(this.solids.map(s => s.mesh), false)[0];
    if (obstruction && obstruction.distance < hit.distance - .08) { this.sound('fail'); return; }
    const surface = this.surfaces.find(s => s.mesh === hit.object)!;
    const normal = V(0, 0, 1).applyQuaternion(surface.mesh.quaternion);
    if (normal.dot(ray.ray.direction) > -.08) { this.sound('fail'); return; }
    this.placePortal(index, surface, hit.point);
  }

  interact() {
    if (!this.playing || !this.locked || !this.cube) return;
    if (this.held) {
      this.held = false;
      if (this.button && Math.hypot(this.cube.position.x - this.button.position.x, this.cube.position.z - this.button.position.z) < 1.25 && this.cube.position.y < 2.3) {
        this.cube.position.set(this.button.position.x, this.button.position.y + .66, this.button.position.z);
        this.cubeVelocity.set(0, 0, 0);
      } else this.cubeVelocity.copy(this.camera.getWorldDirection(V())).multiplyScalar(2.6);
      this.sound('drop');
    } else if (this.cube.position.distanceTo(this.camera.position) < 3.4) {
      this.held = true; this.cubeVelocity.set(0, 0, 0); this.sound('pickup');
    } else this.onEvent({ type: 'hint', text: 'Move closer to the companion cube, then press E.' });
  }

  sound(type: string) {
    try {
      this.audio ||= new AudioContext();
      if (this.audio.state === 'suspended') this.audio.resume();
      const now = this.audio.currentTime;
      const osc = this.audio.createOscillator(); const gain = this.audio.createGain();
      osc.connect(gain); gain.connect(this.audio.destination);
      const settings: Record<string, [number, number, number, OscillatorType]> = {
        blue: [750, 260, .34, 'sine'], orange: [430, 170, .34, 'sine'], fail: [110, 75, .14, 'sawtooth'],
        pickup: [240, 530, .17, 'sine'], drop: [350, 140, .14, 'triangle'], button: [360, 780, .45, 'sine'],
        teleport: [190, 820, .36, 'sawtooth'], win: [470, 980, .7, 'sine']
      };
      const [start, end, duration, waveform] = settings[type] || settings.fail;
      osc.type = waveform; osc.frequency.setValueAtTime(start, now); osc.frequency.exponentialRampToValueAtTime(end, now + duration);
      gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(type === 'teleport' ? .055 : .085, now + .018);
      gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      osc.start(now); osc.stop(now + duration + .02);
    } catch { /* Audio is optional when browser autoplay is restricted. */ }
  }

  burst(pos: THREE.Vector3, color: THREE.Color, count: number) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.025 + Math.random() * .045, 6, 6), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending }));
      mesh.position.copy(pos); this.scene.add(mesh);
      this.particles.push({ mesh, life: .4 + Math.random() * .5, velocity: V((Math.random() - .5) * 5, (Math.random() - .5) * 5, (Math.random() - .5) * 5) });
    }
  }

  portalNear(position: THREE.Vector3, solid: Box) {
    if (!this.portals.every(p => p.active)) return false;
    return this.portals.some(p => {
      if (!p.surface) return false;
      const local = position.clone().sub(p.group.position).applyQuaternion(p.group.quaternion.clone().invert());
      if (Math.abs(local.x) > .72 || Math.abs(local.y) > 1.1 || Math.abs(local.z) > 1.15) return false;
      return solid.box.distanceToPoint(p.group.position) < .65;
    });
  }

  checkPortal(objectPosition: THREE.Vector3, prevPosition: THREE.Vector3, velocity: THREE.Vector3, player: boolean) {
    if (this.teleportCooldown > 0 || !this.portals.every(p => p.active)) return false;
    const offset = player ? V(0, .86, 0) : V();
    const center = objectPosition.clone().add(offset), oldCenter = prevPosition.clone().add(offset);
    for (let i = 0; i < 2; i++) {
      const a = this.portals[i], b = this.portals[1 - i];
      const relative = center.clone().sub(a.group.position);
      const oldDistance = oldCenter.clone().sub(a.group.position).dot(a.normal);
      const distance = relative.dot(a.normal);
      const local = relative.clone().applyQuaternion(a.group.quaternion.clone().invert());
      const threshold = player ? .55 : .42;
      if (oldDistance > threshold && distance <= threshold && local.x ** 2 / .72 ** 2 + local.y ** 2 / 1.1 ** 2 < 1 && velocity.dot(a.normal) < -.5) {
        const rotation = b.group.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI)).multiply(a.group.quaternion.clone().invert());
        const through = V(local.x, local.y, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI)).applyQuaternion(b.group.quaternion);
        const newCenter = b.group.position.clone().add(through).addScaledVector(b.normal, player ? 1.35 : .67);
        objectPosition.copy(newCenter.sub(offset));
        velocity.applyQuaternion(rotation).multiplyScalar(this.level === 3 ? 1.18 : 1);
        if (player) {
          const dir = this.camera.getWorldDirection(V()).applyQuaternion(rotation).normalize();
          this.yaw = Math.atan2(-dir.x, -dir.z);
          this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -.98, .98));
          if (a.normal.y > .8 && Math.abs(b.normal.y) < .2) {
            // A floor-to-wall launch should leave the player looking along the flight path.
            this.yaw = Math.atan2(-velocity.x, -velocity.z);
            this.pitch = -.06;
          }
          this.sound('teleport'); this.burst(b.group.position, i === 0 ? ORANGE : BLUE, 20);
        }
        this.teleportCooldown = .42;
        return true;
      }
    }
    return false;
  }

  collide(position: THREE.Vector3, previous: THREE.Vector3, radius: number, height: number, velocity: THREE.Vector3, isPlayer: boolean) {
    let grounded = false;
    for (const solid of this.solids) {
      if (solid.kind === 'door' && this.buttonActive && solid.mesh.position.y > this.doorY + 3.3) continue;
      if (this.portalNear(position.clone().add(V(0, isPlayer ? .86 : 0, 0)), solid)) continue;
      const b = solid.box;
      const minX = position.x - radius, maxX = position.x + radius, minY = position.y, maxY = position.y + height, minZ = position.z - radius, maxZ = position.z + radius;
      if (maxX <= b.min.x || minX >= b.max.x || maxY <= b.min.y || minY >= b.max.y || maxZ <= b.min.z || minZ >= b.max.z) continue;
      if (previous.y >= b.max.y - .08 && velocity.y <= 0 && position.y < b.max.y) {
        position.y = b.max.y; velocity.y = 0; grounded = true;
      } else if (previous.y + height <= b.min.y + .06 && velocity.y > 0) {
        position.y = b.min.y - height; velocity.y = 0;
      } else {
        const dx1 = b.max.x - minX, dx2 = maxX - b.min.x, dz1 = b.max.z - minZ, dz2 = maxZ - b.min.z;
        const xPush = dx1 < dx2 ? dx1 : -dx2, zPush = dz1 < dz2 ? dz1 : -dz2;
        if (Math.abs(xPush) < Math.abs(zPush)) { position.x += xPush; velocity.x = 0; }
        else { position.z += zPush; velocity.z = 0; }
      }
    }
    return grounded;
  }

  updateCamera() {
    this.camera.position.copy(this.player).add(V(0, 1.63, 0));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  update(dt: number) {
    this.time += dt; this.teleportCooldown = Math.max(0, this.teleportCooldown - dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.life -= dt; p.mesh.position.addScaledVector(p.velocity, dt); p.velocity.multiplyScalar(1 - dt * 2);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life * 1.7);
      if (p.life <= 0) { this.scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); this.particles.splice(i, 1); }
    }
    this.portals.forEach((p, i) => { p.material.uniforms.time.value = this.time; p.material.uniforms.linked.value = this.portals[1 - i].active ? 1 : 0; p.rim.scale.set(.88 + Math.sin(this.time * 4) * .012, 1.35 + Math.sin(this.time * 4) * .012, 1); });
    this.gunKick = Math.max(0, this.gunKick - dt * 1.5);
    this.gun.position.z = -.52 + this.gunKick;
    const walking = this.playing && this.locked && Math.hypot(this.velocity.x, this.velocity.z) > .2;
    this.gun.position.y = -.39 + (walking ? Math.sin(this.time * 7) * .009 : 0);
    if (!this.playing || !this.locked || this.won) { this.updateCamera(); return; }
    const forward = V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = V(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const input = V();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) input.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) input.sub(forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) input.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) input.sub(right);
    if (input.lengthSq() > 0) input.normalize();
    const speed = this.level === 3 ? 9.5 : 7.5;
    const accel = this.onGround ? 13 : 4.5;
    const carryingMomentum = !this.onGround && Math.hypot(this.velocity.x, this.velocity.z) > speed + 1;
    if (carryingMomentum) {
      // Air steering is gentle so a fast portal exit keeps its launch velocity.
      this.velocity.x += input.x * 4 * dt;
      this.velocity.z += input.z * 4 * dt;
      this.velocity.x *= 1 - dt * .12;
      this.velocity.z *= 1 - dt * .12;
    } else {
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, input.x * speed, accel, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, input.z * speed, accel, dt);
    }
    if ((this.keys.has('Space')) && this.onGround) { this.velocity.y = 8.2; this.onGround = false; this.sound('pickup'); }
    this.velocity.y -= 22 * dt;
    const old = this.player.clone();
    this.player.addScaledVector(this.velocity, dt);
    const teleported = this.checkPortal(this.player, old, this.velocity, true);
    if (!teleported) this.onGround = this.collide(this.player, old, .33, 1.78, this.velocity, true);
    else this.onGround = false;
    if (this.player.y < -5 || Math.abs(this.player.x) > 16 || this.player.z > 17) { this.sound('fail'); this.loadLevel(this.level); return; }
    this.updateCamera();
    if (this.cube) {
      if (this.held) {
        const target = this.camera.position.clone().addScaledVector(this.camera.getWorldDirection(V()), 2.15).add(V(0, -.28, 0));
        this.cube.position.lerp(target, Math.min(1, dt * 17));
        this.cube.rotation.y += dt * .9;
        this.cubeVelocity.set(0, 0, 0);
      } else {
        const prev = this.cube.position.clone();
        this.cubeVelocity.y -= 22 * dt;
        this.cubeVelocity.x *= Math.max(0, 1 - dt * 3);
        this.cubeVelocity.z *= Math.max(0, 1 - dt * 3);
        this.cube.position.addScaledVector(this.cubeVelocity, dt);
        const cubeTeleported = this.checkPortal(this.cube.position, prev, this.cubeVelocity, false);
        if (!cubeTeleported) {
          const cubeFeet = this.cube.position.clone().sub(V(0, .48, 0));
          const prevFeet = prev.clone().sub(V(0, .48, 0));
          if (this.collide(cubeFeet, prevFeet, .45, .96, this.cubeVelocity, false)) this.cubeVelocity.y = 0;
          this.cube.position.copy(cubeFeet.add(V(0, .48, 0)));
        }
        if (this.cube.position.y < -5) { this.cube.position.set(-3.5, .52, this.level === 0 ? 5.5 : -5.5); this.cubeVelocity.set(0, 0, 0); }
      }
    }
    if (this.button && this.cube) {
      const dx = this.cube.position.x - this.button.position.x, dz = this.cube.position.z - this.button.position.z;
      this.buttonActive = !this.held && Math.hypot(dx, dz) < .68 && Math.abs(this.cube.position.y - (this.button.position.y + .65)) < .5;
      if (this.buttonActive !== this.lastButtonState) {
        this.lastButtonState = this.buttonActive;
        if (this.buttonActive) { this.sound('button'); this.onEvent({ type: 'button', text: 'EXIT UNLOCKED' }); }
        else this.onEvent({ type: 'button', text: 'SWITCH INACTIVE' });
      }
      const ring = this.button.children[1] as THREE.Mesh;
      (ring.material as THREE.MeshBasicMaterial).color.set(this.buttonActive ? '#6df3c7' : '#f4a44d');
      if (this.buttonLight) { this.buttonLight.color.set(this.buttonActive ? '#6df3c7' : '#f78e3e'); this.buttonLight.intensity = this.buttonActive ? 13 : 7; }
    } else this.buttonActive = true;
    if (this.door) {
      const targetY = this.doorY + (this.buttonActive ? 4.15 : 0);
      this.door.mesh.position.y = Math.abs(this.door.mesh.position.y - targetY) < .0001 ? targetY : THREE.MathUtils.damp(this.door.mesh.position.y, targetY, 5, dt);
      this.door.box.setFromObject(this.door.mesh);
    }
    if (this.player.z < -10.6 && Math.abs(this.player.x) < 1.6 && this.buttonActive && (!this.door || this.door.mesh.position.y > this.doorY + 3.2)) {
      this.sound('win'); this.won = true; this.onEvent({ type: this.level === 4 ? 'complete' : 'level', level: this.level + 1 });
    }
  }

  renderPortals() {
    if (!this.portals.every(p => p.active)) return;
    this.gun.visible = false;
    for (let i = 0; i < 2; i++) {
      const a = this.portals[i], b = this.portals[1 - i];
      const rotation = b.group.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI)).multiply(a.group.quaternion.clone().invert());
      this.portalCamera.position.copy(this.camera.position).sub(a.group.position).applyQuaternion(rotation).add(b.group.position);
      this.portalCamera.quaternion.copy(rotation).multiply(this.camera.quaternion);
      this.portalCamera.projectionMatrix.copy(this.camera.projectionMatrix);
      this.portalCamera.updateMatrixWorld(true);
      // Oblique near-plane clipping removes the wall behind the destination.
      const plane = new THREE.Plane(b.normal.clone(), -b.normal.dot(b.group.position)).applyMatrix4(this.portalCamera.matrixWorldInverse);
      const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const e = this.portalCamera.projectionMatrix.elements;
      const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;
      this.portalCamera.projectionMatrixInverse.copy(this.portalCamera.projectionMatrix).invert();
      this.portals.forEach(p => p.group.visible = false);
      this.renderer.setRenderTarget(a.target);
      this.renderer.render(this.scene, this.portalCamera);
      this.renderer.setRenderTarget(null);
      this.portals.forEach(p => p.group.visible = p.active);
    }
    this.gun.visible = true;
  }

  configureGraphics(change: Partial<GraphicsSettings>) {
    const qualityChanged = change.quality !== undefined && change.quality !== this.graphics.quality;
    this.graphics = { ...this.graphics, ...change };
    if ((!this.tracer?.supported || this.traceFailure) && this.graphics.mode === 'path') this.graphics.mode = 'raster';
    if (qualityChanged || change.adaptive !== undefined || this.renderScale > QUALITY[this.graphics.quality].scale) this.renderScale = QUALITY[this.graphics.quality].scale;
    this.renderer.toneMappingExposure = this.graphics.exposure;
    if (!this.traceFailure) {
      try { this.tracer?.configure(this.graphics, this.renderScale, this.cssWidth, this.cssHeight); }
      catch (error) { this.failTracing(error); }
    }
    const size = this.graphics.quality === 'economy' ? 512 : this.graphics.quality === 'balanced' ? 1024 : 1536;
    for (const lamp of this.shadowLights) {
      if (lamp.shadow.mapSize.x !== size) {
        lamp.shadow.mapSize.set(size, size); lamp.shadow.map?.dispose(); lamp.shadow.map = null;
      }
    }
    const portalScale = this.graphics.quality === 'economy' ? .35 : this.graphics.quality === 'balanced' ? .55 : .85;
    const drawingSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const p of this.portals) {
      p.target.setSize(Math.max(128, Math.round(this.cssWidth * portalScale)), Math.max(128, Math.round(this.cssHeight * portalScale)));
      p.material.uniforms.viewResolution.value.copy(drawingSize);
    }
    try { localStorage.setItem('portal-graphics-v1', JSON.stringify(this.graphics)); } catch { /* optional */ }
  }

  autoTune() {
    if (!this.tracer?.supported || this.traceFailure) return;
    this.configureGraphics({ mode: 'path', quality: 'balanced', adaptive: true });
    this.renderScale = QUALITY.balanced.scale;
    this.tracer.reset(); this.adaptElapsed = 0; this.frameMs = 33;
    this.tuningUntil = performance.now() + 5000;
    this.onEvent({ type: 'hint', text: 'Auto tune is measuring this scene for five seconds. The resolution adapts toward a 30 fps frame budget.' });
  }

  getGraphicsStats(): GraphicsStats {
    const rasterSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      mode: this.graphics.mode, samples: this.graphics.mode === 'path' ? this.tracer?.samples || 0 : 0,
      bounces: this.graphics.mode === 'path' ? QUALITY[this.graphics.quality].bounces : 0,
      width: this.graphics.mode === 'path' ? this.tracer?.width || 0 : rasterSize.x,
      height: this.graphics.mode === 'path' ? this.tracer?.height || 0 : rasterSize.y,
      fps: Math.round(this.fps), triangles: this.tracer?.triangleCount || 0, lights: this.tracer?.lightCount || 0,
      supported: !!this.tracer?.supported && !this.traceFailure,
      reason: this.traceFailure || this.tracer?.reason || '',
      tuning: performance.now() < this.tuningUntil, scale: this.renderScale,
      traceMs: this.tracer?.traceTimer.milliseconds ?? null, postMs: this.tracer?.postTimer.milliseconds ?? null,
      timerSamples: this.tracer?.traceTimer.measurements ?? 0,
      timingAvailable: !!this.tracer?.traceTimer.supported && !!this.tracer?.postTimer.supported,
      nodes: this.tracer?.nodeCount ?? 0, packedBytes: this.tracer?.packedBytes ?? 0,
      buildMs: this.tracer?.buildMs ?? 0,
    };
  }

  private failTracing(error: unknown) {
    this.traceFailure = error instanceof Error ? error.message : String(error);
    console.error('Path tracing unavailable; using the explicitly labelled raster fallback.', error);
    this.graphics.mode = 'raster'; this.renderer.setRenderTarget(null);
    this.onEvent({ type: 'hint', text: 'This GPU could not run the path tracer. Fast lighting is active; details are in Graphics.' });
  }

  private contextLost = () => {
    this.playing = false; this.keys.clear(); document.exitPointerLock?.();
    this.tracer?.traceTimer.reset(); this.tracer?.postTimer.reset();
    this.onEvent({ type: 'hint', text: 'Graphics context lost. Waiting for the browser to restore it.' });
  };
  private contextRestored = () => {
    // Restored render targets contain no usable accumulated history.
    this.tracer?.restoreContext(); this.lastFrameTime = 0;
    this.onEvent({ type: 'hint', text: 'Graphics context restored. Resume to continue testing.' });
  };

  private renderFrame() {
    if (this.renderer.getContext().isContextLost()) return;
    if (this.graphics.mode === 'path' && this.tracer?.supported && !this.traceFailure) {
      try { this.tracer.render(); }
      catch (error) { this.failTracing(error); this.renderFrame(); }
    } else {
      this.renderer.shadowMap.needsUpdate = true;
      this.renderPortals(); this.renderer.render(this.scene, this.camera);
    }
  }

  saveDiagnostics() {
    const stats = this.getGraphicsStats();
    const report = {
      revision: '1.1.0-sah', chamber: this.level + 1, settings: this.graphics, stats,
      timing: stats.timingAvailable ? 'Delayed WebGL GPU queries; means of recent samples' : 'GPU queries unavailable; frame-interval fallback',
      architecture: 'Static merged AABB BVH plus separate rigid cube, door and device BVHs; 16-bin SAH',
      notes: ['Not UBVH or hardware RT', 'Packed bytes exclude atlas and render targets', 'Stationary frames accumulate; movement resets history'],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'portal-blackmagic-diagnostics.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  saveFrame() {
    this.renderFrame();
    this.renderer.domElement.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `portal-${this.graphics.mode}-chamber-${this.level + 1}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  animate = () => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const elapsed = this.lastFrameTime ? now - this.lastFrameTime : 16.7;
    this.lastFrameTime = now;
    if (elapsed < 1000) { this.frameMs = this.frameMs * .92 + elapsed * .08; this.fps = 1000 / this.frameMs; }
    const dt = Math.min(this.clock.getDelta(), .035);
    this.update(dt);
    this.renderFrame();
    // Prefer delayed GPU timestamps; use presented-frame intervals only when
    // timers are unavailable. Query polling never waits for the GPU.
    // Skip idle sample-capped frames and hidden tabs; neither is a useful benchmark.
    const tracing = this.graphics.mode === 'path' && this.tracer && this.tracer.samples < QUALITY[this.graphics.quality].samples;
    if (tracing && !document.hidden && this.graphics.adaptive && this.graphics.quality !== 'reference') {
      const traceMs = this.tracer!.traceTimer.milliseconds, postMs = this.tracer!.postTimer.milliseconds;
      const timers = this.tracer!.traceTimer.supported && this.tracer!.postTimer.supported;
      if (timers && (traceMs === null || postMs === null || this.tracer!.traceTimer.measurements < 8)) return;
      const measuredMs = timers ? traceMs! + postMs! : this.frameMs;
      this.adaptElapsed += Math.min(elapsed, 500);
      if (this.adaptElapsed > 1400) {
        this.adaptElapsed = 0;
        const max = QUALITY[this.graphics.quality].scale;
        const next = measuredMs > 36 ? Math.max(.22, this.renderScale * .82)
          : measuredMs < 23 ? Math.min(max, this.renderScale * 1.08) : this.renderScale;
        if (Math.abs(next - this.renderScale) > .015) {
          this.renderScale = next;
          try { this.tracer!.configure(this.graphics, this.renderScale, this.cssWidth, this.cssHeight); }
          catch (error) { this.failTracing(error); }
        }
      }
    }
  };
  frame = 0;

  resize(width: number, height: number) {
    this.cssWidth = Math.max(1, width); this.cssHeight = Math.max(1, height);
    this.camera.aspect = this.cssWidth / this.cssHeight; this.camera.updateProjectionMatrix();
    this.portalCamera.aspect = this.camera.aspect; this.portalCamera.updateProjectionMatrix();
    this.renderer.setSize(this.cssWidth, this.cssHeight);
    this.configureGraphics({});
  }

  mouseMove(dx: number, dy: number) {
    if (!this.locked || !this.playing) return;
    this.yaw -= dx * .0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * .0022, -1.52, 1.52);
  }

  private disposeObject(root: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    root.traverse(node => {
      if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
        geometries.add(node.geometry);
        for (const m of (Array.isArray(node.material) ? node.material : [node.material])) materials.add(m);
      }
      if (node instanceof THREE.SpotLight || node instanceof THREE.PointLight) node.shadow?.map?.dispose();
    });
    for (const material of materials) {
      const map = (material as THREE.MeshStandardMaterial).map;
      if (map) textures.add(map); material.dispose();
    }
    geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose());
  }

  destroy() {
    this.destroyed = true; cancelAnimationFrame(this.frame);
    this.tracer?.dispose(); this.disposeObject(this.scene);
    this.portals.forEach(p => p.target.dispose());
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.contextRestored);
    this.renderer.dispose(); this.renderer.domElement.remove();
    if (this.audio) void this.audio.close();
  }
}

export { LEVELS };
