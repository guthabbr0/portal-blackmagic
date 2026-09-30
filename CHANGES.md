# Latest changes: 1.1

SAH AABB construction, any-hit shadows, internal-resolution material-guided HDR filtering, asynchronous GPU timers and startup diagnostics. See [REVISION-1.1.md](REVISION-1.1.md) for scope and tradeoffs.

## Earlier renderer work

# Change map

## Original game retained

The five chambers, original layouts, first-person controls, pickup/drop interaction, puzzle logic, sound code and general interface are retained. This is not a replacement tech demo. `GPU-CHECK.html` is a separate diagnostic only.

## Renderer additions

`src/rendering/bvh.ts`, `shaders.ts` and `PathTracer.ts` add a world-space software path tracer. Dynamic cube, door and device geometry use rigid local acceleration structures. Visible emission supplies lighting. Camera and continuation rays can cross the portal pair.

`src/GraphicsPanel.tsx` adds renderer selection, four quality presets, exposure, display denoising, adaptive resolution, sample/dimension/FPS reporting and a PNG button. `App.tsx` connects the panel and introduces the clear inspection state and G/T/P shortcuts.

## Changes in Game.ts

Replaced the hemisphere/directional illumination with visible ceiling emitters plus explicitly raster-only proxy lights. Enabled fallback shadows and one shadow update per frame. Changed the floor to a dielectric material. Synchronized portal target sizes with quality, corrected projected portal UVs, added destination clipping and avoided overlapping portal placement on the same panel.

Added correct initial camera aspect setup, stopped stationary weapon bobbing, snapped settled door motion, cleared stale movement keys on pointer unlock, reset trace history after graphics-context restoration, and disposed old chamber geometry/material resources on reload. Float-target-incompatible devices use byte portal targets in Fast mode.

## What was not “fixed” by relabelling

The original file already used aim-point raycasts for portal placement. That is different from ray-traced rendering; this patch does not claim otherwise. The preplaced orange portal in chamber four remains intentional puzzle setup. A directional light's position is not inherently a rendering error; this indoor lighting design was changed to finite visible fixtures instead.

The patch does not add SSR and call it ray tracing. It also does not claim complete physical simulation: the existing movement/teleport gameplay behavior remains, while rendering approximations and performance limits are documented in README.md.

## Build and verification

No runtime dependencies were added. The supplied dependency versions and package resolutions are unchanged. Test and validation scripts, the standalone GPU diagnostic and the full validation report were added. There is no precompiled build in this source archive; the full application integration checks remain to be run locally as described in VALIDATION.md.
