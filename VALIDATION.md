# Validation record: revision 1.1

Date: 2026-09-30.

This is the historical validation record from preparation of the v1.1 source package, before its GitHub publication. Deployment statements below describe that earlier check, not the current repository or production state. Consult the relevant commit status and Vercel deployment for current build results. Generated test reports are not committed; the supplied runners recreate them.

## Passed

**15 CPU/unit tests.** Six existing BVH/material tests plus nine new independent traversal/timer checks passed with Node 22.16.0. New tests compare closest hits against an independent plane-intersection/oriented-edge reference over 1200 arbitrary rays, and finite shadow visibility over another 1200 rays. They also check parallel/tiny-direction rays, construction immutability and limits, invalid inputs, any-hit termination, non-blocking query readiness, bounded queues, disjoint invalidation and missing-extension fallback.

**24 Chromium WebGL 2 harness checks.** The production GLSL strings and packed BVH data ran successfully in a headed Chromium process under Xvfb with software GL. The standalone test document was supplied directly to the page; no network navigation was used. Three shaders compile/link and floating-point framebuffers complete. Tests exercise portal primary rays, off-screen reflections, reflected portal traversal, rigid transforms, direct illumination, opaque/transparent/dynamic shadow blockers, finite accumulation, material-aware filtering/upsampling, unchanged raw history and a finite delayed timer-query result. No JavaScript page errors were recorded.

These are real WebGL checks, but use a dependency-free harness with direct GL calls. They are NOT a full React/Three.js integration test or a game playthrough.

**20 native EGL / OpenGL ES checks.** The same transport/filter shaders passed native checks on `OpenGL ES 3.2 Mesa 25.0.7-2`, `llvmpipe (LLVM 19.1.7, 256 bits)`. The visible-light fixture's red channel is approximately 0.8610; adding the blocker produces exactly 0. In the enclosed-room fixture, the total sampled RGB energy rises from approximately 30618 to 35559 when additional surface hits are allowed. This is a stochastic fixture result, not a target exposure or a game performance benchmark.

**Strict dependency-free TypeScript compilation.** `bvh.ts`, `shaders.ts` and `GpuTimer.ts` compile with strict checking and DOM types. All nine TS/TSX source files pass TypeScript syntax/transpilation diagnostics. The latter does not resolve external React/Three.js types.

**Deterministic operation-count comparison.** The median/SAH benchmark and early-out shadow queries agree on hit/miss outcomes for 9000 synthetic-fixture queries. Raw counters, scene size and tree-memory differences are in `tests/generated/traversal-benchmark.json`. They must not be described as an actual GPU speedup.

## Not verified

The full project dependencies could not be installed. `npm ci --offline --ignore-scripts` failed with `ENOTCACHED` for `yallist`; a network request also could not resolve the requested hostname. Consequently the complete project typecheck, Vite production bundle, React/Three.js render-pass integration and all five game chambers are NOT verified in this environment. No prebuilt `dist` is supplied.

No NVIDIA, AMD, Intel, Apple or mobile gaming-GPU performance measurement was made. No full-game before/after screenshot was captured. `browser-check.png` and `transport-validation.png` are diagnostic room fixtures, not images of the portal game.

The existing Vercel production deployment was observed in READY state through the connected tool. This does not establish graphics correctness, and this revised package had NOT been uploaded to production by the assistant at the time of that check.

## Reproduce

With project dependencies installed:

```bash
npm ci
npm run check
npm run benchmark
npm run dev
```

Optional shader checks require Python/numpy/Pillow for native EGL, or Python/Playwright/Chromium for browser checks. The native runner also requires a Linux EGL/ES driver. On headless Linux the browser runner needs an X server such as Xvfb:

```bash
npm run test:egl
npm run test:prepare
node tools/build-gpu-check.mjs
xvfb-run -a python tools/validate-browser.py
```

On another desktop, open `GPU-CHECK.html` or the deployed `/gpu-check.html` to run the standalone browser test. A browser without WebGL 2 should show a failed capability check rather than pretend to pass.

## Deployment acceptance checks still required

After replacing the project files and redeploying, verify the title screen, start/pause/inspect/resume, portal placement and linked views, cube pickup and shadows, door animation, all five chambers, resize, all presets, denoise toggling, capture and diagnostics export. Stationary samples should accumulate; camera/object/portal changes should restart history, while exposure changes should not. Use `?renderer=raster` to compare the explicitly labelled fallback. Inspect the browser console for shader/texture/FBO errors and confirm the Graphics panel's timings on the target GPU.
