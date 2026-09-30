# Deploy portal-blackmagic from this repository

Project source and configuration are at the repository root. The user connected `guthabbr0/portal-blackmagic` to the existing Vercel project named `portal-blackmagic`. Keep the production branch set to `main` and the Root Directory at the repository root, not `src` or a nested `portal-blackmagic` directory.

The supplied `vercel.json` sets:

| Setting | Value |
| --- | --- |
| Framework | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

Use a Vercel Node.js version satisfying `package.json`'s engine requirement. The build automatically generates `/gpu-check.html` from the checked-in test sources, and Vite bundles the game. `vite-plugin-singlefile` embeds the game JavaScript and CSS in the generated HTML. Do not serve the unbuilt `src` folder as static output.

No server, API key, database or environment secret is required by this game. Local deployment metadata, environment files, dependencies, compiled output and generated test reports are intentionally excluded from Git.

## Local checks

```bash
npm ci
npm run check
npm run benchmark
npm run dev
```

The historical validation report is in `VALIDATION.md`. A successful repository push is not evidence of a successful deployment or a complete game playthrough; inspect the Vercel build and the deployed application separately.

## After deployment

Open `/gpu-check.html` for the independent shader/BVH fixture. Open `/?renderer=raster` to explicitly select Fast lighting, overriding saved preferences. In the game, the Graphics panel's **Save diagnostics JSON** button records settings, resolution, timings and BVH statistics locally.

Verify the title screen, start/pause/inspect/resume, portal placement, linked views, cube pickup, shadows, moving door, all five chambers, resize, presets, denoising, PNG capture and diagnostics export. Stationary views should accumulate samples; camera, object and portal changes should reset them. Exposure changes should preserve accumulated samples.
