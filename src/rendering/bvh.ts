/** Dependency-free triangle BVH and GPU texture packing.
 * The source meshes, not screen-space depth, are the ray-tracing geometry.
 * A separate BLAS is built for the room, cube, door and first-person device.
 * Moving a rigid object only changes its transform; it never rebuilds the room.
 * Static construction uses 16-bin surface-area heuristic (SAH) partitioning.
 * This remains an AABB BVH, not the papers' SOBB/UBVH or OptiX implementation.
 */
export type Triangle = {
  p: number[]; n: number[]; uv: number[];
  material: number; object: number;
};
export type TraceMaterial = {
  color: number[]; emission: number[]; metalness: number; roughness: number;
  atlas: number[]; opacity: number; textured: boolean;
};
export type PackedTexture = { data: Float32Array; width: number; height: number };
export type BuiltScene = {
  nodes: PackedTexture; triangles: PackedTexture; lights: PackedTexture;
  roots: number[]; triangleCount: number; lightCount: number; maxDepth: number;
  nodeCount: number; packedBytes: number; strategy: 'sah' | 'median';
};
type Node = { min: number[]; max: number[]; left: number; right: number };

export function packTexture(values: number[], width = 1024): PackedTexture {
  const texels = Math.max(1, Math.ceil(values.length / 4));
  width = Math.min(width, texels);
  const height = Math.ceil(texels / width);
  const data = new Float32Array(width * height * 4);
  data.set(values);
  return { data, width, height };
}

export function triangleArea(t: Triangle): number {
  const a = t.p, x = a[3] - a[0], y = a[4] - a[1], z = a[5] - a[2];
  const u = a[6] - a[0], v = a[7] - a[1], w = a[8] - a[2];
  return .5 * Math.hypot(y * w - z * v, z * u - x * w, x * v - y * u);
}

export type BuildOptions = { strategy?: 'sah' | 'median' };
export const BVH_MAX_LEAF = 6;
export const BVH_STACK_SIZE = 64;
const BIN_COUNT = 16;
type Primitive = { triangle: Triangle; min: number[]; max: number[]; center: number[] };
type Bounds = { min: number[]; max: number[]; count: number };
const emptyBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], count: 0 });
function extend(a: Bounds, b: { min: number[]; max: number[] }, count = 1) {
  if (!count) return;
  a.count += count;
  for (let k = 0; k < 3; k++) { a.min[k] = Math.min(a.min[k], b.min[k]); a.max[k] = Math.max(a.max[k], b.max[k]); }
}
function area(b: Bounds) {
  if (!b.count) return 0;
  const x = b.max[0] - b.min[0], y = b.max[1] - b.min[1], z = b.max[2] - b.min[2];
  return 2 * (x * y + y * z + z * x);
}
function splitSAH(prims: Primitive[], cmin: number[], cmax: number[]): Primitive[][] | null {
  let bestCost = Infinity, bestAxis = -1, bestBin = -1;
  for (let axis = 0; axis < 3; axis++) {
    const extent = cmax[axis] - cmin[axis];
    if (extent <= 1e-12) continue;
    const bins = Array.from({ length: BIN_COUNT }, emptyBounds);
    for (const p of prims) {
      const bin = Math.min(BIN_COUNT - 1, Math.floor((p.center[axis] - cmin[axis]) / extent * BIN_COUNT));
      extend(bins[bin], p);
    }
    const rightCost = Array(BIN_COUNT).fill(0), rightCount = Array(BIN_COUNT).fill(0);
    const right = emptyBounds();
    for (let i = BIN_COUNT - 1; i > 0; i--) {
      extend(right, bins[i], bins[i].count); rightCost[i] = area(right) * right.count; rightCount[i] = right.count;
    }
    const left = emptyBounds();
    for (let i = 0; i < BIN_COUNT - 1; i++) {
      extend(left, bins[i], bins[i].count);
      if (!left.count || !rightCount[i + 1]) continue;
      const cost = area(left) * left.count + rightCost[i + 1];
      if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestBin = i; }
    }
  }
  if (bestAxis < 0) return null;
  const left: Primitive[] = [], right: Primitive[] = [], extent = cmax[bestAxis] - cmin[bestAxis];
  for (const p of prims) {
    const bin = Math.min(BIN_COUNT - 1, Math.floor((p.center[bestAxis] - cmin[bestAxis]) / extent * BIN_COUNT));
    (bin <= bestBin ? left : right).push(p);
  }
  return left.length && right.length ? [left, right] : null;
}

export function buildScene(groups: Triangle[][], materials: TraceMaterial[], options: BuildOptions = {}): BuiltScene {
  const strategy = options.strategy ?? 'sah';
  const nodes: Node[] = [], ordered: Triangle[] = [], roots: number[] = [];
  let maxDepth = 0;
  if (groups.reduce((count, group) => count + group.length, 0) > 1000000) throw new Error('Scene exceeds the supported software-tracer primitive budget.');
  const build = (prims: Primitive[], depth: number): number => {
    // Construction guarantees traversal stack capacity; never silently drop a subtree.
    if (depth >= BVH_STACK_SIZE - 2) throw new Error('BVH depth exceeds the GPU traversal stack.');
    maxDepth = Math.max(maxDepth, depth);
    const bound = emptyBounds(), cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) {
      extend(bound, p);
      for (let a = 0; a < 3; a++) { cmin[a] = Math.min(cmin[a], p.center[a]); cmax[a] = Math.max(cmax[a], p.center[a]); }
    }
    const min = [...bound.min], max = [...bound.max];
    for (let a = 0; a < 3; a++) {
      const pad = Math.max(.00005, Math.abs(min[a]) * 2e-7, Math.abs(max[a]) * 2e-7);
      min[a] -= pad; max[a] += pad;
    }
    const index = nodes.length, node: Node = { min, max, left: 0, right: 0 };
    nodes.push(node);
    if (prims.length <= BVH_MAX_LEAF) {
      node.left = -(ordered.length + 1); node.right = prims.length;
      for (const p of prims) ordered.push(p.triangle);
    } else {
      // Reserve enough depth for balanced fallback, even for hostile SAH splits.
      let halves = strategy === 'sah' && depth < 32 ? splitSAH(prims, cmin, cmax) : null;
      if (!halves) {
        let axis = 0;
        for (let a = 1; a < 3; a++) if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;
        const sorted = [...prims].sort((a, b) => a.center[axis] - b.center[axis]);
        const middle = Math.floor(sorted.length / 2); halves = [sorted.slice(0, middle), sorted.slice(middle)];
      }
      node.left = build(halves[0], depth + 1); node.right = build(halves[1], depth + 1);
    }
    return index;
  };
  for (const group of groups) {
    const prims = group.map(triangle => {
      if (triangle.p.length !== 9 || triangle.n.length !== 9 || triangle.uv.length !== 6
        || ![...triangle.p, ...triangle.n, ...triangle.uv].every(Number.isFinite)
        || !Number.isInteger(triangle.material) || !materials[triangle.material]) throw new Error('Invalid triangle data.');
      const min = [0, 1, 2].map(a => Math.min(triangle.p[a], triangle.p[a + 3], triangle.p[a + 6]));
      const max = [0, 1, 2].map(a => Math.max(triangle.p[a], triangle.p[a + 3], triangle.p[a + 6]));
      const center = [0, 1, 2].map(a => (triangle.p[a] + triangle.p[a + 3] + triangle.p[a + 6]) / 3);
      return { triangle, min, max, center };
    });
    roots.push(prims.length ? build(prims, 1) : -1);
  }
  const nodeData = nodes.flatMap(n => [...n.min, n.left, ...n.max, n.right]);
  const weights = ordered.map(t => {
    const e = materials[t.material].emission;
    // The proposal need not know texture coverage: a zero-emission sampled texel
    // contributes zero. Using average coverage here only improves efficiency.
    return triangleArea(t) * (.2126 * e[0] + .7152 * e[1] + .0722 * e[2])
      * (materials[t.material].textured ? .12 : 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const lightData: number[] = [], triangleData: number[] = [];
  let cdf = 0;
  ordered.forEach((t, i) => {
    const a = t.p, n = t.n, uv = t.uv, area = triangleArea(t);
    const pdf = total > 0 && area > 0 ? weights[i] / total / area : 0;
    triangleData.push(
      a[0], a[1], a[2], t.material,
      a[3], a[4], a[5], uv[0],
      a[6], a[7], a[8], uv[1],
      n[0], n[1], n[2], uv[2],
      n[3], n[4], n[5], uv[3],
      n[6], n[7], n[8], uv[4],
      uv[5], pdf, t.object, 0,
    );
    if (weights[i] > 0) { cdf += weights[i] / total; lightData.push(i, cdf, 0, 0); }
  });
  if (lightData.length) lightData[lightData.length - 3] = 1; // avoid CDF roundoff
  const packed = { nodes: packTexture(nodeData), triangles: packTexture(triangleData), lights: packTexture(lightData) };
  return { ...packed, roots, triangleCount: ordered.length, lightCount: lightData.length / 4, maxDepth,
    nodeCount: nodes.length, packedBytes: Object.values(packed).reduce((sum, p) => sum + p.data.byteLength, 0), strategy };
}

export function packMaterials(materials: TraceMaterial[]): PackedTexture {
  return packTexture(materials.flatMap(m => [
    ...m.color, Math.min(1, Math.max(0, m.metalness)),
    ...m.emission, Math.min(1, Math.max(.045, m.roughness)),
    ...m.atlas,
    m.opacity, m.textured ? 1 : 0, 0, 0,
  ]));
}

/** CPU traversal with the same packed layout, for correctness tests and operation counts.
 * Counters are NOT GPU timings. The tests use an independent plane/edge oracle.
 */
export type TraceCounters = { boxes: number; triangles: number };
export type TraceQuery = { limit?: number; anyHit?: boolean; counters?: TraceCounters };
export function intersectPacked(scene: BuiltScene, root: number, origin: number[], direction: number[], query: TraceQuery = {}) {
  if (root < 0) return null;
  const ns = scene.nodes.data, ts = scene.triangles.data;
  const stats = query.counters ?? { boxes: 0, triangles: 0 };
  let distance = query.limit ?? Infinity, triangle = -1;
  const nearBox = (id: number) => {
    stats.boxes++;
    const node = id * 8; let near = 0, far = distance;
    for (let a = 0; a < 3; a++) {
      if (direction[a] === 0) {
        if (origin[a] < ns[node + a] || origin[a] > ns[node + 4 + a]) return Infinity;
      } else {
        const x = (ns[node + a] - origin[a]) / direction[a], y = (ns[node + 4 + a] - origin[a]) / direction[a];
        near = Math.max(near, Math.min(x, y)); far = Math.min(far, Math.max(x, y));
      }
      if (far < near) return Infinity;
    }
    return near;
  };
  const initial = nearBox(root);
  if (initial >= distance) return null;
  const stack: [number, number][] = [[root, initial]];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  while (stack.length) {
    const [id, near] = stack.pop()!; if (near >= distance) continue;
    const node = id * 8, left = ns[node + 3], right = ns[node + 7];
    if (left >= 0) {
      const a = nearBox(left), b = nearBox(right);
      if (a < b) { if (b < distance) stack.push([right, b]); if (a < distance) stack.push([left, a]); }
      else { if (a < distance) stack.push([left, a]); if (b < distance) stack.push([right, b]); }
      continue;
    }
    for (let i = -left - 1; i < -left - 1 + right; i++) {
      stats.triangles++;
      const k = i * 28, v = Array.from(ts.slice(k, k + 3));
      const e1 = [ts[k + 4] - v[0], ts[k + 5] - v[1], ts[k + 6] - v[2]];
      const e2 = [ts[k + 8] - v[0], ts[k + 9] - v[1], ts[k + 10] - v[2]];
      const p = cross(direction, e2), det = dot(e1, p);
      if (Math.abs(det) < 1e-9) continue;
      const delta = origin.map((a, j) => a - v[j]), u = dot(delta, p) / det;
      const q = cross(delta, e1), vcoord = dot(direction, q) / det, t = dot(e2, q) / det;
      if (u >= 0 && vcoord >= 0 && u + vcoord <= 1 && t > .00035 && t < distance) {
        distance = t; triangle = i; if (query.anyHit) return { distance, triangle };
      }
    }
  }
  return triangle < 0 ? null : { distance, triangle };
}
