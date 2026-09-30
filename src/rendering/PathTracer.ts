import * as THREE from 'three';
import { buildScene, packMaterials, type PackedTexture, type Triangle, type TraceMaterial } from './bvh';
import { fullscreenVertex, traceFragment, filterFragment, displayFragment } from './shaders';
import { GpuTimer } from './GpuTimer';

export type RenderMode = 'path' | 'raster';
export type Quality = 'economy' | 'balanced' | 'high' | 'reference';
export type GraphicsSettings = {
  mode: RenderMode; quality: Quality; exposure: number; denoise: boolean; adaptive: boolean;
};
export const QUALITY: Record<Quality, { scale: number; bounces: number; samples: number; clamp: number }> = {
  economy: { scale: .35, bounces: 2, samples: 128, clamp: 40 },
  balanced: { scale: .55, bounces: 4, samples: 256, clamp: 80 },
  high: { scale: .85, bounces: 6, samples: 512, clamp: 0 },
  reference: { scale: 1, bounces: 8, samples: 1024, clamp: 0 },
};
export const DEFAULT_GRAPHICS: GraphicsSettings = {
  mode: 'path', quality: 'balanced', exposure: 1.1, denoise: true, adaptive: true,
};
export type GraphicsStats = {
  mode: RenderMode; samples: number; bounces: number; width: number; height: number;
  fps: number; triangles: number; lights: number; supported: boolean; reason: string;
  tuning: boolean; scale: number;
  traceMs: number | null; postMs: number | null; timerSamples: number; timingAvailable: boolean;
  nodes: number; packedBytes: number; buildMs: number;
};
export type PortalState = { group: THREE.Group; active: boolean };
type SupportedMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;

/** Browser GPU software ray tracing, NOT DXR/RTX hardware ray-tracing APIs.
 * No screen-space fallback is hidden in this class. Every displayed path-traced
 * pixel comes from world-space ray/triangle and ray/portal intersections.
 */
export class PathTracer {
  readonly supported: boolean;
  readonly reason: string;
  samples = 0;
  triangleCount = 0;
  lightCount = 0;
  nodeCount = 0;
  packedBytes = 0;
  buildMs = 0;
  readonly traceTimer: GpuTimer;
  readonly postTimer: GpuTimer;
  width = 1;
  height = 1;
  private seed = 0;
  private traceScene = new THREE.Scene();
  private filterScene = new THREE.Scene();
  private displayScene = new THREE.Scene();
  private quadCamera = new THREE.Camera();
  private quadGeometry = new THREE.PlaneGeometry(2, 2);
  private traceMaterial: THREE.RawShaderMaterial;
  private filterMaterial: THREE.RawShaderMaterial;
  private filteredTarget: THREE.WebGLRenderTarget | null = null;
  private filterDirty = true;
  private displayMaterial: THREE.RawShaderMaterial;
  private targets: THREE.WebGLRenderTarget[] = [];
  private readIndex = 0;
  private packedTextures: THREE.DataTexture[] = [];
  private atlas: THREE.CanvasTexture | null = null;
  private sourceMaterials: SupportedMaterial[] = [];
  private descriptors: TraceMaterial[] = [];
  private materialTexture: THREE.DataTexture | null = null;
  private dynamicRoots: (THREE.Object3D | null)[] = [null, null, null, null];
  private camera: THREE.PerspectiveCamera | null = null;
  private portals: PortalState[] = [];
  private scene: THREE.Scene | null = null;
  private snapshot: number[] = [];
  private settings: GraphicsSettings = { ...DEFAULT_GRAPHICS };
  private outputSize = new THREE.Vector2();
  private readonly portalOffset = new THREE.Matrix4().makeTranslation(0, 0, .035);

  constructor(private renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    this.traceTimer = new GpuTimer(gl); this.postTimer = new GpuTimer(gl);
    this.supported = !!renderer.extensions.get('EXT_color_buffer_float')
      && gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 2;
    this.reason = this.supported ? '' : 'Path tracing needs WebGL 2 and floating-point render targets. Fast lighting is active.';
    const matrices = () => Array.from({ length: 4 }, () => new THREE.Matrix4());
    this.traceMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: fullscreenVertex, fragmentShader: traceFragment,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        nodeTex: { value: null }, triangleTex: { value: null }, materialTex: { value: null },
        lightTex: { value: null }, atlasTex: { value: null }, historyTex: { value: null },
        roots: { value: new THREE.Vector4(-1, -1, -1, -1) },
        objectWorld: { value: matrices() }, objectInverse: { value: matrices() },
        portalWorld: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
        portalInverse: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
        portalActive: { value: new THREE.Vector2() },
        cameraWorld: { value: new THREE.Matrix4() }, inverseProjection: { value: new THREE.Matrix4() },
        resolution: { value: new THREE.Vector2(1, 1) }, frameSeed: { value: 0 }, historySamples: { value: 0 },
        maxBounces: { value: 4 }, lightCount: { value: 0 }, radianceClamp: { value: 80 },
      },
    });
    this.filterMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: fullscreenVertex, fragmentShader: filterFragment,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { radianceTex: { value: null }, guideTex: { value: null },
        denoiseStrength: { value: 1 }, samples: { value: 1 } },
    });
    this.displayMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: fullscreenVertex, fragmentShader: displayFragment,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        radianceTex: { value: null }, guideTex: { value: null }, outputResolution: { value: new THREE.Vector2(1, 1) },
        exposure: { value: 1.1 },
      },
    });
    const traceQuad = new THREE.Mesh(this.quadGeometry, this.traceMaterial);
    const filterQuad = new THREE.Mesh(this.quadGeometry, this.filterMaterial);
    const displayQuad = new THREE.Mesh(this.quadGeometry, this.displayMaterial);
    traceQuad.frustumCulled = filterQuad.frustumCulled = displayQuad.frustumCulled = false;
    this.traceScene.add(traceQuad); this.filterScene.add(filterQuad); this.displayScene.add(displayQuad);
  }

  private makeTexture(p: PackedTexture) {
    if (p.width > this.renderer.capabilities.maxTextureSize || p.height > this.renderer.capabilities.maxTextureSize) {
      throw new Error('The scene exceeds this GPU’s texture-size limit.');
    }
    const tex = new THREE.DataTexture(p.data, p.width, p.height, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    this.packedTextures.push(tex);
    return tex;
  }

  private descriptor(m: SupportedMaterial, atlas: number[]): TraceMaterial {
    const standard = m instanceof THREE.MeshStandardMaterial;
    const emission = standard ? m.emissive.clone().multiplyScalar(m.emissiveIntensity) : m.color.clone();
    return {
      color: m.color.toArray(), emission: emission.toArray(),
      metalness: standard ? m.metalness : 0, roughness: standard ? m.roughness : .65,
      opacity: m.opacity, atlas, textured: !!m.map,
    };
  }

  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    cube: THREE.Group | null, door: THREE.Mesh | null, gun: THREE.Group, portals: PortalState[]) {
    if (!this.supported) return;
    const started = performance.now();
    this.scene = scene; this.camera = camera; this.portals = portals;
    this.dynamicRoots = [null, cube, door, gun];
    scene.updateMatrixWorld(true);
    const excluded = new Set<THREE.Object3D>(portals.map(p => p.group));
    const materials: SupportedMaterial[] = [], materialIds = new Map<THREE.Material, number>();
    const groups: Triangle[][] = [[], [], [], []];
    const dynamicSet = new Set<THREE.Object3D>(this.dynamicRoots.filter((v): v is THREE.Object3D => !!v));
    const collect = (root: THREE.Object3D, object: number, base: THREE.Matrix4, staticPass: boolean) => {
      const visit = (node: THREE.Object3D) => {
        if (excluded.has(node) || node.userData.noPathTrace || (staticPass && dynamicSet.has(node))) return;
        if (node instanceof THREE.Mesh && !Array.isArray(node.material)
          && (node.material instanceof THREE.MeshStandardMaterial || node.material instanceof THREE.MeshBasicMaterial)) {
          const mat = node.material;
          // Additive burst particles and very faint overlay halos are presentation FX.
          if (mat.opacity >= .5 && mat.blending !== THREE.AdditiveBlending) {
            if (!materialIds.has(mat)) { materialIds.set(mat, materials.length); materials.push(mat); }
            const mi = materialIds.get(mat)!;
            const geometry = node.geometry;
            const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
            const index = geometry.getIndex();
            const matrix = base.clone().multiply(node.matrixWorld);
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
            const count = index ? index.count : pos.count;
            const start = geometry.drawRange.start || 0;
            const end = Math.min(count, start + geometry.drawRange.count);
            for (let i = start; i + 2 < end; i += 3) {
              const t: Triangle = { p: [], n: [], uv: [], material: mi, object };
              for (let j = 0; j < 3; j++) {
                const v = index ? index.getX(i + j) : i + j;
                t.p.push(...new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(matrix).toArray());
                t.n.push(...(normal ? new THREE.Vector3().fromBufferAttribute(normal, v).applyMatrix3(normalMatrix).normalize() : new THREE.Vector3(0, 1, 0)).toArray());
                t.uv.push(uv ? uv.getX(v) : 0, uv ? uv.getY(v) : 0);
              }
              groups[object].push(t);
            }
          }
        }
        for (const child of node.children) visit(child);
      };
      visit(root);
    };
    collect(scene, 0, new THREE.Matrix4(), true);
    this.dynamicRoots.forEach((root, i) => {
      if (root) collect(root, i, root.matrixWorld.clone().invert(), false);
    });

    // All source textures are local canvas labels. A padded atlas preserves
    // their transparency, rather than tracing opaque text rectangles.
    const mapped = materials.filter(m => m.map);
    const tileW = 1028, tileH = 260;
    const cols = Math.max(1, Math.min(2, Math.floor(this.renderer.capabilities.maxTextureSize / tileW)));
    const canvas = document.createElement('canvas');
    canvas.width = mapped.length ? tileW * cols : 2;
    canvas.height = mapped.length ? Math.ceil(mapped.length / cols) * tileH : 2;
    if (canvas.width > this.renderer.capabilities.maxTextureSize || canvas.height > this.renderer.capabilities.maxTextureSize) throw new Error('Too many label textures for the path-tracing atlas.');
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const rects = new Map<SupportedMaterial, number[]>();
    mapped.forEach((m, i) => {
      const x = i % cols * tileW + 2, y = Math.floor(i / cols) * tileH + 2;
      context.drawImage(m.map!.image as CanvasImageSource, x, y, 1024, 256);
      rects.set(m, [1024 / canvas.width, 256 / canvas.height, x / canvas.width, 1 - (y + 256) / canvas.height]);
    });
    this.packedTextures.forEach(t => t.dispose()); this.packedTextures = [];
    this.atlas?.dispose(); this.atlas = new THREE.CanvasTexture(canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = this.atlas.magFilter = THREE.LinearFilter;
    this.sourceMaterials = materials;
    this.descriptors = materials.map(m => this.descriptor(m, rects.get(m) || [0, 0, 0, 0]));
    const packed = buildScene(groups, this.descriptors);
    this.triangleCount = packed.triangleCount; this.lightCount = packed.lightCount;
    this.nodeCount = packed.nodeCount; this.packedBytes = packed.packedBytes;
    const u = this.traceMaterial.uniforms;
    u.nodeTex.value = this.makeTexture(packed.nodes);
    u.triangleTex.value = this.makeTexture(packed.triangles);
    u.lightTex.value = this.makeTexture(packed.lights);
    this.materialTexture = this.makeTexture(packMaterials(this.descriptors));
    u.materialTex.value = this.materialTexture;
    u.atlasTex.value = this.atlas;
    u.roots.value.fromArray(packed.roots); u.lightCount.value = packed.lightCount;
    this.buildMs = performance.now() - started;
    this.traceTimer.reset(); this.postTimer.reset();
    this.reset(); this.snapshot = [];
  }

  configure(settings: GraphicsSettings, scale: number, cssWidth: number, cssHeight: number) {
    if (!this.supported) return;
    const preset = QUALITY[settings.quality];
    const width = Math.max(32, Math.round(cssWidth * scale));
    const height = Math.max(24, Math.round(cssHeight * scale));
    // Bound reference-mode VRAM use on 4K/5K displays; the UI reports exact size.
    const reduction = Math.min(1, 1920 / width, 1200 / height);
    this.resize(Math.round(width * reduction), Math.round(height * reduction));
    if (preset.bounces !== this.traceMaterial.uniforms.maxBounces.value
      || preset.clamp !== this.traceMaterial.uniforms.radianceClamp.value) this.reset();
    if (settings.denoise !== this.settings.denoise) this.filterDirty = true;
    this.settings = { ...settings };
    this.traceMaterial.uniforms.maxBounces.value = preset.bounces;
    this.traceMaterial.uniforms.radianceClamp.value = preset.clamp;
    // Exposure and spatial filtering are display-only and do not invalidate samples.
    this.displayMaterial.uniforms.exposure.value = settings.exposure;

  }

  private resize(width: number, height: number) {
    if (this.targets.length && width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.targets.forEach(t => t.dispose()); this.filteredTarget?.dispose();
    this.traceTimer.reset(); this.postTimer.reset();
    this.targets = [0, 1].map(() => new THREE.WebGLRenderTarget(width, height, {
      count: 2, format: THREE.RGBAFormat, type: THREE.FloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    }));
    this.filteredTarget = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat, type: THREE.FloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    // Extension presence alone does not prove the requested framebuffer works.
    const previous = this.renderer.getRenderTarget(), gl = this.renderer.getContext();
    try {
      for (const target of [...this.targets, this.filteredTarget]) {
        this.renderer.setRenderTarget(target);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Floating-point framebuffer incomplete. Use the Fast renderer.');
        }
      }
    } finally { this.renderer.setRenderTarget(previous); }
    this.traceMaterial.uniforms.resolution.value.set(width, height);
    this.readIndex = 0; this.reset();
  }

  reset() { this.samples = 0; this.filterDirty = true; }

  restoreContext() {
    this.traceTimer.restore(); this.postTimer.restore(); this.reset();
  }

  private sync() {
    if (!this.scene || !this.camera) return;
    this.scene.updateMatrixWorld(true); this.camera.updateMatrixWorld(true);
    const u = this.traceMaterial.uniforms, state: number[] = [];
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    u.inverseProjection.value.copy(this.camera.projectionMatrixInverse);
    state.push(...this.camera.matrixWorld.elements, ...this.camera.projectionMatrix.elements);
    this.dynamicRoots.forEach((root, i) => {
      const world = u.objectWorld.value[i] as THREE.Matrix4;
      if (root) world.copy(root.matrixWorld); else world.identity();
      (u.objectInverse.value[i] as THREE.Matrix4).copy(world).invert();
      state.push(...world.elements);
    });
    this.portals.forEach((p, i) => {
      const world = u.portalWorld.value[i] as THREE.Matrix4;
      world.copy(p.group.matrixWorld).multiply(this.portalOffset);
      (u.portalInverse.value[i] as THREE.Matrix4).copy(world).invert();
      u.portalActive.value.setComponent(i, p.active ? 1 : 0);
      state.push(p.active ? 1 : 0, ...world.elements);
    });
    // Updating colors/intensities doesn't require rebuilding the geometry BVH.
    // The existing light CDF stays a valid importance-sampling proposal.
    if (this.materialTexture) {
      const old = this.materialTexture.image.data as Float32Array;
      let dirty = false;
      const write = (index: number, value: number) => {
        const rounded = Math.fround(value);
        if (old[index] !== rounded) { old[index] = rounded; dirty = true; }
      };
      // Update the existing buffer in place; avoid repacking every material and
      // allocating a complete padded texture on every presentation frame.
      this.sourceMaterials.forEach((m, i) => {
        const k = i * 16, standard = m instanceof THREE.MeshStandardMaterial;
        write(k, m.color.r); write(k + 1, m.color.g); write(k + 2, m.color.b);
        write(k + 3, standard ? Math.min(1, Math.max(0, m.metalness)) : 0);
        write(k + 4, standard ? m.emissive.r * m.emissiveIntensity : m.color.r);
        write(k + 5, standard ? m.emissive.g * m.emissiveIntensity : m.color.g);
        write(k + 6, standard ? m.emissive.b * m.emissiveIntensity : m.color.b);
        write(k + 7, standard ? Math.min(1, Math.max(.045, m.roughness)) : .65);
        write(k + 12, m.opacity);
      });
      if (dirty) { this.materialTexture.needsUpdate = true; this.reset(); }
    }
    if (state.length !== this.snapshot.length || state.some((n, i) => Math.abs(n - this.snapshot[i]) > 1e-6)) {
      this.snapshot = state; this.reset();
    }
  }

  render() {
    if (!this.supported || !this.camera || !this.targets.length) return;
    this.traceTimer.poll(); this.postTimer.poll();
    this.sync();
    if (this.samples < QUALITY[this.settings.quality].samples) {
      const read = this.targets[this.readIndex], write = this.targets[1 - this.readIndex];
      const u = this.traceMaterial.uniforms;
      u.historyTex.value = read.textures[0];
      u.historySamples.value = this.samples;
      u.frameSeed.value = ++this.seed;
      this.traceTimer.begin();
      try {
        this.renderer.setRenderTarget(write);
        this.renderer.render(this.traceScene, this.quadCamera);
      } finally { this.traceTimer.end(); }
      this.readIndex = 1 - this.readIndex; this.samples++; this.filterDirty = true;
    }
    const target = this.targets[this.readIndex], display = this.displayMaterial.uniforms;
    this.postTimer.begin();
    try {
      if (this.settings.denoise && this.filterDirty && this.filteredTarget) {
        const filter = this.filterMaterial.uniforms;
        filter.radianceTex.value = target.textures[0]; filter.guideTex.value = target.textures[1];
        filter.samples.value = this.samples;
        this.renderer.setRenderTarget(this.filteredTarget);
        this.renderer.render(this.filterScene, this.quadCamera); this.filterDirty = false;
      }
      display.radianceTex.value = this.settings.denoise && this.filteredTarget ? this.filteredTarget.texture : target.textures[0];
      display.guideTex.value = target.textures[1];
      this.renderer.getDrawingBufferSize(this.outputSize); display.outputResolution.value.copy(this.outputSize);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.displayScene, this.quadCamera);
    } finally { this.postTimer.end(); }
  }

  dispose() {
    this.targets.forEach(t => t.dispose()); this.packedTextures.forEach(t => t.dispose());
    this.atlas?.dispose(); this.traceMaterial.dispose(); this.filterMaterial.dispose(); this.displayMaterial.dispose(); this.quadGeometry.dispose();
    this.filteredTarget?.dispose(); this.traceTimer.dispose(); this.postTimer.dispose();
    this.sourceMaterials = []; this.descriptors = []; this.dynamicRoots = [];
  }
}
