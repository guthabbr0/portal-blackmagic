# Revision 1.1 update

Start with [REVISION-1.1.md](REVISION-1.1.md), [VALIDATION.md](VALIDATION.md) and [DEPLOY.md](DEPLOY.md). This repository contains the v1.1 project source; build, deployment and full-game validation are separate from source publication.

# Portal / Blackmagic lighting edition

An actual GPU path-tracing renderer added to the supplied five-chamber portal puzzle game. This is the **modified game source**, not a precompiled game or a claim of RTX hardware acceleration.

The ray-traced mode does not use ambient lighting, screen-space reflections, or a guessed color-bleeding overlay to produce indirect light. It intersects rays with the chamber's triangles and linked portal apertures. The separate Fast mode is explicitly labelled raster lighting.

## Run the game

Use Node.js 22.12 or newer. From this directory:

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. Use a desktop browser with WebGL 2 and pointer lock enabled. Internet access is needed to install the existing npm dependencies; the renderer itself does not call an AI service or download a lighting model.

To check and build:

```sh
npm run check
```

The existing single-file Vite build configuration is retained. A successful `npm run build` creates `dist/index.html`. Compiled output is not committed to this repository. Dependency installation and the full browser application could not be validated in the source-package preparation environment. See `VALIDATION.md` for exactly what was tested and `DEPLOY.md` for the Git deployment layout.

## See the new lighting

Start on **Balanced**, enter a chamber and press **G**. The simulation pauses in a clear inspection view. Stop changing the view and watch the sample counter increase. Select **High** or **Reference** to inspect the unclamped result. Reference also disables the display denoiser and adaptive resolution when selected.

Press **T** to compare the two renderers. The on-screen badge always identifies the active renderer; Fast is not passed off as ray tracing. Press **P**, or the PNG button in Graphics, to save the rendered canvas without the HTML interface.

Original controls remain: WASD to move, mouse to look, Space to jump, E to pick up/drop, left/right click for blue/orange portals, R to restart, Escape to pause. White panels accept portal placement; chamber four intentionally starts with an orange portal for its momentum puzzle. The level selection and original five-chamber layout are retained.

## What changed

**Light transport.** A custom GLSL ES 3 path tracer performs world-space ray/triangle intersections against BVHs. It uses a Lambert/GGX material mixture, visible-normal GGX sampling, sampled emissive triangle lights, shadow visibility tests, power-heuristic multiple importance sampling and Russian roulette. Surface color, metalness, roughness and emission come from the actual Three.js meshes. Text labels are preserved in an alpha-tested atlas rather than becoming opaque rectangles.

**Room lighting.** The blanket hemisphere/directional illumination was removed. Six visible ceiling fixtures provide finite-area emission. Their area and position determine the traced highlights and penumbrae. The floor is treated as a coated dielectric, not metallic concrete. Emissive signage and trim can contribute light. The traced environment is black; light blocked by geometry is not replaced with a generic ambient term.

**Reflections and indirect light.** Camera, reflected and diffuse-continuation rays query scene geometry, including objects outside the camera's view. The cube, moving door and first-person device each have a separate local BVH, so their rigid transforms can change without rebuilding the entire chamber. The room BVH is rebuilt when a chamber is loaded.

**Linked portals.** Apertures are analytic ellipses placed using the game's portal transforms. Rays that cross a linked aperture emerge in the destination coordinate frame with their direction transformed. Portal crossings do not consume surface-bounce budget; a separate limit prevents infinite portal loops. The Fast renderer's projected portal texture coordinates and destination near-plane clipping were also changed.

**Accumulation and presentation.** HDR radiance is averaged in floating-point ping-pong targets. Camera, rigid-object, material or portal changes invalidate the history. There is no averaging of stale frames after movement and no temporal reprojection. Exposure and the optional normal/depth/material-guided spatial filter are display operations; the filmic curve and sRGB conversion happen after accumulation. The dark gameplay overlay was removed. Idle weapon bobbing was stopped so a stationary view can actually accumulate samples.

**Controls and performance.** Graphics settings are remembered locally. Adaptive resolution uses delayed GPU timings where available and presented frame intervals otherwise, with a minimum scale of 0.22 and an approximately 33 ms frame budget. Measure / Auto tune starts a five-second measurement period on Balanced; adaptation remains active while its checkbox is enabled. It does not infer capability from a vendor badge or promise a particular frame rate.

**Fast fallback.** Shadowed spotlights at the ceiling fixtures approximate their lighting in the raster renderer, with a small, explicitly acknowledged ambient readability fill. This mode does not compute traced GI or world-space ray-traced reflections. Shadow maps update once per frame rather than once per portal view. Unsupported floating-point targets or a tracer failure switch to Fast with a visible reason.

## Quality presets

| Preset | Base resolution scale* | Surface-hit budget | Maximum accumulated samples/pixel | Radiance clamp | Intended use |
| --- | ---: | ---: | ---: | ---: | --- |
| Economy | 0.35 | 2 | 128 | 40 | Lower tracing cost |
| Balanced | 0.55 | 4 | 256 | 80 | Initial interactive setting |
| High | 0.85 | 6 | 512 | Off | Higher-quality inspection |
| Reference | 1.00 | 8 | 1024 | Off | Stationary inspection; slower |

\* Relative to CSS viewport size, not device-pixel ratio. Adaptive mode can lower the scale. Internal tracing resolution is capped at 1920 × 1200 while preserving aspect ratio. The interface reports the real dimensions. Sampling stops at the preset cap until the scene changes.

## Important limits

This is **GPU software ray tracing in WebGL 2**, not integration with DXR, Vulkan RT, NVIDIA RTX APIs or a hardware ray-query extension. Hardware performance has not been benchmarked. Moving views start again at one sample per pixel and can look grainy, especially around small bright sources. The display filter is a small spatial filter, not a production temporal or neural denoiser.

Reference is the name of the highest inspection preset, **not** a claim of an unbiased, fully converged ground-truth renderer. The finite surface-hit and portal-hop budgets truncate paths. Economy/Balanced additionally clamp radiance outliers, which introduces bias. The GGX material model is an opaque single-scattering approximation with roughness floored at 0.045; it does not model spectral dispersion, transmission, participating media, subsurface scattering or full microfacet multiple scattering.

Direct light sampling uses ordinary straight shadow rays. A shadow ray intersecting a portal is rejected by that local strategy. **BSDF continuation paths still travel through portals**, and emitter hits after a portal use MIS weight one because that path had no competing local light-sampling strategy. There is no portal-aware virtual-light sampler: light seen only through a small portal can converge slowly. Analytic portal rims are emissive when hit, but are not in the triangle light CDF. Portal loops stop after eight successful crossings.

The tracer supports the materials and rigid geometry used by this game, not arbitrary Three.js scenes. It does not handle skinned meshes, morph targets, multi-material meshes, normal maps, non-rigid root scaling or general blended transparency. Additive particles, faint line overlays and animated portal swirl decoration are omitted from tracing. Alpha-tested canvas labels are supported. The Fast renderer retains some of the original presentation effects and point-light proxies, so the two modes are not numerically identical references.

The original gameplay physics are retained, apart from preventing overlapping portal placement and presentation-related adjustments. This patch is not a full physics rewrite or a completion test of every chamber.

## Files to inspect

- `src/rendering/bvh.ts`: triangle packing, emissive-light proposal and BVH builder.
- `src/rendering/shaders.ts`: ray intersection, portal traversal, transport and display shaders.
- `src/rendering/PathTracer.ts`: Three.js scene extraction, GPU resources and history invalidation.
- `src/Game.ts`: lighting fixtures, backend switching and game integration.
- `src/GraphicsPanel.tsx`: controls and honest backend/capability reporting.
- `VALIDATION.md`: executed checks and remaining integration checks.

No additional runtime package was introduced. The dependency versions and lockfile resolution from the supplied project are retained.

## Reproduce the transport checks

The BVH/material unit tests require only Node:

```sh
npm test
```

After installing the development dependencies, regenerate the browser test modules and standalone diagnostic:

```sh
npm run test:prepare
node tools/build-gpu-check.mjs
```

Serve the directory locally and open `tests/browser.html` in a WebGL 2 browser. It exercises the production shader strings and BVH packer without loading Three.js or React. The generated `GPU-CHECK.html` is the same harness with its modules inlined; it is a **renderer diagnostic, not the game**. The build also generates `public/gpu-check.html` for deployment.

The optional native Linux validation runner requires Python, NumPy, Pillow, libEGL and an OpenGL ES 3 driver:

```sh
node tools/export-test-scenes.mjs
python tools/validate-egl.py
```

Its fixtures include off-screen reflections, a reflected ray through a portal, alpha masking, an occluded area light and indirect illumination. Generated test images are diagnostic rooms, not screenshots of the game. Native EGL validation does not establish WebGL driver compatibility or full-app correctness.

## Technical references

The transport implementation uses established sampling methods, not an LLM's guessed lighting values. Primary descriptions of the underlying methods:

- Pharr, Jakob and Humphreys, *Physically Based Rendering*, fourth edition, Roughness Using Microfacet Theory, especially visible-normal sampling: <https://www.pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory>.
- Heitz, Sampling the GGX Distribution of Visible Normals, *Journal of Computer Graphics Techniques* 7(4), 2018: <https://jcgt.org/published/0007/04/01/>.

These references explain the methods; they do not validate this particular application. All scene light strengths and material values remain artist-selected parameters.
