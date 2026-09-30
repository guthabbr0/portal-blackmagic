# Portal Blackmagic 1.1: traversal, filtering and diagnostics

Prepared 2026-09-30. This is a source revision of the uploaded Vercel package. Source publication and production deployment are separate; see DEPLOY.md and the relevant commit/deployment status for the latter.

## What changed

### 16-bin surface-area-heuristic AABB construction

`src/rendering/bvh.ts` now evaluates 16-bin partitions on all three axes instead of always splitting the longest centroid axis at its median. The previous median builder remains selectable through `buildScene(..., { strategy: 'median' })` for controlled comparisons. Small leaves, depth limits, coordinate validation and a balanced fallback prevent malformed or excessively deep trees.

The static room remains merged once, while the cube, moving door and portal device retain separate local-space trees. Moving these rigid objects changes their transforms, not the room geometry. This is a small fixed collection of BLAS roots, not Disney's full instance hierarchy/change-category system.

### Visibility traversal and material fetches

Direct-light shadow segments now use an any-hit traversal. The first valid opaque blocker ends the query, including blockers in the moving-object trees. Alpha cutouts and portal openings retain their previous visibility semantics. A straight next-event-estimation shadow segment is not treated as a portal-transport path; actual BSDF paths still cross linked portals.

Closest-hit traversal visits nearer children first and retains the entry distances of deferred children. It no longer silently stops after an arbitrary number of node visits. Construction enforces the stack/leaf limits used by the shader. Opaque candidate intersections no longer fetch the full material, all interpolated normals and texture coordinates simply to check opacity. Parallel AABB-ray handling no longer changes a tiny negative ray component into a positive component.

These are algorithmic changes, not a promise of improved frame time on every GPU. The traversal stack uses additional distance storage; real-device timing is needed to evaluate register and memory tradeoffs.

### Separate internal-resolution HDR filtering and display

The previous display shader applied its 25-tap filter at every output pixel. The new pipeline has three programs:

1. Trace and accumulate scene-linear radiance at the internal resolution.
2. Optionally denoise at that same internal resolution, into a separate HDR target.
3. Perform four-tap, edge-aware HDR upsampling, exposure, tone mapping and sRGB output at display resolution.

Normal, depth and material-ID checks preserve boundaries. Material IDs use the previously unused alpha component of the HDR radiance texture; they are metadata, not physical opacity. They are not averaged into radiance. Display filtering never writes into the raw accumulation history, and exposure changes still do not reset it. The filtered result is cached once sampling has stopped.

This is spatial denoising, not temporal reprojection, a neural denoiser, extra light transport, or a replacement for more samples. Moving cameras still restart the history. Light reaching a surface only through a small portal may still be noisy.

The extra RGBA32F filter target uses 16 additional bytes per internal pixel. At the existing maximum internal size of 1920 by 1200, that is 36.864 MB. It is allocated even when filtering is disabled; this can be optimized later. The graphics panel's packed-memory figure excludes all render targets and the texture atlas.

### Timing and startup diagnostics

`GpuTimer.ts` uses non-blocking `EXT_disjoint_timer_query_webgl2` queries where available. It never waits for a query result. Queues are bounded, disjoint results are discarded, and queries are reset on resize/context restoration. Separate trace and post-processing estimates appear in Graphics. Adaptive resolution uses these delayed GPU estimates when available, with a presented-frame-interval fallback otherwise. No benchmark is inferred from a GPU model name.

Scene node count, CPU scene preparation time and packed geometry/BVH storage are reported. Graphics also exports a diagnostics JSON file locally; no report is sent to a server.

The entry document contains a visible startup message and recovery links instead of an empty root. `?renderer=raster` explicitly overrides saved settings for a Fast-mode launch. Both modes still require WebGL 2. Float framebuffers are checked for completeness. Pointer-lock startup handles both Promise-returning and older void-returning implementations, plus synchronous failures.

`/gpu-check.html` is a standalone diagnostic page generated into Vite's public output. It contains the same GLSL/BVH logic and does not depend on React, Three.js, npm downloads or external assets once opened. It renders a test room, NOT a chamber from the game.

## What the supplied papers support

**Bauer and Li, A Hybrid BVH Structure for Interactive GPU Ray Tracing, 2026**, sections 2.1 and 2.2: repeated instances use a two-level representation; non-instanced geometry is placed into separate Mega-BLASes according to Fully-Static, Dynamic-Vertex and Dynamic-Topology history. The paper's section 4 notes temporary memory costs and a possible one-frame delay when an object changes category. Those details matter for interactive games.

The applicable design principle here is to avoid rebuilding static room geometry for a moving cube. This revision retains that principle. It does not implement OptiX flags, a general instance acceleration structure, vertex-deformation refitting or the paper's history-based category migration.

**Kacerik and Bittner, UBVH: Unified Bounding Volume and Scene Geometry Representation for Ray Tracing, 2025**, sections 3 to 5: skewed oriented bounding boxes represent both internal bounds and leaf triangles; suitable triangle pairs share an encoding. Their Vulkan implementation and evaluations target substantially larger scenes. Section 5.1 discusses construction and memory costs; section 5.2 discusses precision and the absence of a comparison against compressed layouts.

This revision does NOT implement UBVH, SOBB conversion, triangle-pair encoding or a reproduction of the paper's experiments. Its reported speedups are not used as forecasts for this game. A UBVH experiment should be a separate backend with intersection-equivalence tests and matched measurements, not a rename of this AABB implementation.

## Measured result and tradeoff

`npm run benchmark` constructs a deterministic synthetic chamber-like fixture with 1428 triangles, NOT the actual game level. Both trees use the same updated CPU traversal; only median versus SAH construction differs. It traces 3000 camera rays, 3000 arbitrary secondary rays and 3000 finite shadow segments.

| Operation count | Median AABB | SAH AABB |
| --- | ---: | ---: |
| Camera ray box tests | 426454 | 74928 |
| Camera ray triangle tests | 284725 | 14118 |
| Secondary ray box tests | 283726 | 74130 |
| Secondary ray triangle tests | 157015 | 12380 |
| Shadow segment triangle tests, closest-hit | 178013 | 3902 |

On the same SAH tree and the same shadow segments, early-exit any-hit reduces triangle tests from 3902 to 2167. All visibility results agree. This does not measure shader execution time, GPU occupancy, memory latency, denoising cost or complete game frame rate.

The SAH tree is deeper and larger: 779 nodes at depth 13 versus 511 nodes at depth 9. Packed node/triangle/light storage rises from 180208 to 196624 bytes in this fixture. The builder and extra filter target have real memory costs; reduced intersection counts do not mean every resource cost decreased.

## Files to inspect

- `src/rendering/bvh.ts`: construction, packed layout and CPU traversal oracle.
- `src/rendering/shaders.ts`: transport, visibility, HDR filter and display.
- `src/rendering/GpuTimer.ts`: delayed query lifecycle.
- `src/rendering/PathTracer.ts`: Three.js render-pass integration.
- `tests/optimizations.test.mjs`: independent plane/edge reference and timer mocks.
- `tests/generated/`: numerical test results and fixture images, recreated by the supplied runners rather than committed.
- `VALIDATION.md`: passed checks and explicitly unverified parts.
