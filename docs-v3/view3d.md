# V3.3 — one three.js 3D view (toolpath display + layer planes + playback)

V3_SCOPE.md §4 + V3_BACKLOG.md V3.3. A single 3D view in the web
UI — no 2D toolpath view exists anywhere, by Brandon's decision
(the V2 2D sheet-layout preview is a different thing and is
untouched). This doc is the build record: what the view is, how
it is wired, and what it assumes.

## What the view shows

- The job's `toolpaths` as 3D paths: rapids faint (grey, 0.35
  opacity), feed moves solid, arcs as TRUE arcs (sampled from the
  move's centre + radius + sweep at 5° — the samples are the
  circle, not a stored polyline), colour by operation/tool
  (drill red, bore orange, pocket blue, profile green; a
  deterministic per-tool shade shift), current move highlighted
  during playback (bright progress line + tool cylinder at the
  tool tip + the operation row highlighted in the table below).
- The tool model on the path at the playback position: a simple
  cylinder of the operation's tool diameter (parsed from the tool
  id — `EM3.17` → 3.17 mm, `D2.25` → 2.25 mm; unknown ids fall
  back to 3.17 mm). V3.1 tools are flat endmills + drill, so the
  cylinder is the true tool shape for them; the general tool-shape
  model (ball-nose / V-bit / bull-nose) is V3.4's `ts/tools.ts`
  and drives the sim, though the view's tool mesh stays a
  cylinder.
- The layered DXF as one toggleable plane per DXF layer at its Z
  depth (per-layer checkboxes). Planes are line outlines at the
  layer's cut-top Z, coloured by operation. The Simulate button
  (V3.4, seekable in V3.5) runs the dexel cut-sim in the browser
  and shows the simmed stock as a mesh, replacing the wireframe
  stock box; the planes stay toggleable, lifted 0.15 mm while the
  stock is shown. V3.5: Simulate builds the delta log in the
  background (one chunk per macrotask, so the page stays
  responsive) and scrubbing / playback / op-jump then seek the
  shown stock to that move — the stock follows the tool, instead
  of always showing the final stock. The stock mesh rebuilds at
  most every 120 ms while scrubbing, and playback seeks it at
  most every 250 ms. The sim status names the backend honestly:
  "CPU backend (WebGPU unavailable in this browser)" when there
  is no WebGPU, "GPU simmed stock" + a background CPU seek build
  when there is (the GPU backend has no delta log — its writes
  are fire-and-forget atomicMin, not a recorded log).
- Playback: play/pause, scrub (move index), speed (1–32×), jump
  to operation, timeline (move i/N · operation · layer · tool ·
  cut time elapsed / total). Seeking is a move-index jump — never
  replay from the beginning. The checkpoint + delta design is the
  SIM's seeking (V3.5, docs-v3/sim_seek.md).

## Files

| File | What it is |
|---|---|
| `ts/view3d/model.ts` | Pure view logic (no DOM, no three.js): flatten the toolpaths section into one move list, true-arc sampling, durations, colours, tool diameters, layer-plane normalisation, the playback state machine. Unit-tested (`bun test ts/view3d/`). |
| `ts/view3d/entry.ts` | Browser entry. Imports three.js + OrbitControls; exposes `window.MldxfView3d = { mount, isWebGLAvailable, version }`. Builds the controls always; the three.js scene only when WebGL exists, else the fallback (message + toolpath list). Dispatches `view3d:move` on its container as playback moves. |
| `ts/view3d/build.ts` | The build step: `bun build` the entry (IIFE, minified) into `server/public/vendor/view3d.js`. Rebuilds only when missing/stale (any of entry/model/three newer than the bundle) unless `--force`. |
| `ts/geometry.ts` | Layer-geometry extractor (Bun): job.json + root DXF → per-layer loops + Z depths. Same DXF discovery rule and arc repair as the V3.1 generator, so the planes show the outlines the toolpaths were cut from. |
| `server/public/job-prep.js` | `mountView3d()` in `buildToolpaths()`: lazily loads the bundle once per page (v3 jobs only), mounts it above the operations table, highlights the operation row on `view3d:move`. A bundle that fails to load leaves a message, never a blank section. |
| `server/server.ts` | `GET /api/jobs/:id/geometry` (1:1 with `mldxf geometry --json`); ensures the bundle at startup (best-effort — a failed build never blocks the server). |
| `mldxf.py` | `mldxf geometry <job-dir> [--json]` (shell over `ts/geometry.ts`); `mldxf build-view3d [--force]`; `mldxf serve` builds the bundle before starting the server (best-effort, warned, never fatal). |

## Delivery (V3_SCOPE.md §4.5)

- three.js is vendored locally: `bun install three` pins it
  (three@0.187.0 — repo-root `package.json` + `bun.lock` are the
  pin). No CDN at runtime; the app is localhost-only and works
  with no network.
- The bundle is a build artifact, NOT checked in
  (`server/public/vendor/` is gitignored). It is built when
  missing/stale by `mldxf serve`, `mldxf build-view3d`, and the
  server at startup — so the double-click flow (`start.bat` →
  `mldxf serve`) works with nothing extra to run.
- The server stays dependency-free at runtime: it serves the
  bundle as a static file, exactly as it serves the rest of
  `server/public/`. The build step is IIFE (a classic script —
  an ESM bundle's trailing `export{...}` would be a SyntaxError
  under a plain `<script>` tag).
- Fallbacks: no WebGL → a message + the toolpath list; the CLI
  still generates toolpaths without any browser. A bundle that
  fails to load, or a geometry fetch that fails, degrades the
  same way (layer planes unavailable, toolpaths unaffected).

## Contracts the view relies on

- `GET /api/jobs/:id` returns the full job.json including the
  `toolpaths` section (v3 jobs only) — docs-v3/job_model_v3.md
  §11. The view throws on a section that is not version 1.
- `GET /api/jobs/:id/geometry` returns:
  `{ok, job_id, dxf, layers: [{layer, operation, part,
  z_top_mm, z_bottom_mm, loops: [{closed, points: [[x,y],...],
  area_mm2}], loop_count}], bounds: {x_min, x_max, y_min, y_max,
  z_min, z_max}}`. Points are sampled at 5° from the true DXF
  arcs (the plane is a line rendering; the toolpath arcs are the
  ones that stay first-class). `z_top_mm` is the CUT top (part
  z_top − start_depth) for every operation — note this differs
  from the toolpaths entry's `z_top_mm` for drill/bore, where the
  entry records the part top and the plane records where the cut
  starts (the hole mouth). `z_bottom_mm` is `floor_z` when the
  job records one, else `z_top_mm − cut_depth`.
- Timeline durations: feed moves at the operation's feed_mm_s
  (Z-only feeds at plunge_mm_s), arcs at feed_mm_s, rapids at a
  stated constant of 50 mm/s (rapids carry no feed in the move
  model). The timeline is a cut-time estimate for playback, not
  a machine cycle-time prediction.
- First move's start: the tool is assumed parked at clearance
  above the first move's end XY (the job's first move is always
  a rapid to (x, y, clearance)).

## Acceptance evidence (Nov 24, 2026)

- Reference job (8-layer real container,
  `~/workspace/v31-verify-home/jobs/20261124-160834-real-container/`):
  15 ops / 222 moves (67 rapid, 85 feed, 70 arc). The model
  flattens it exactly (stats recompute match); all 3,615 arc
  samples lie on their true circles (0 off-circle).
- Geometry endpoint on the same job: 8 layers, Z values match
  the toolpaths entries (pocket D1.50 9.5→8.0, drill START1.50
  8.0→6.45, profiles →0), bounds x 20–129.7, y 20–66, z 0–9.5.
- WebGL in headless Chromium on this VM: UNAVAILABLE with the
  E2E driver's `--disable-gpu` flags (so the driver exercises
  the no-WebGL fallback), AVAILABLE with `--use-angle=swiftshader`
  (WebGL 2.0) — the render probe (`server/run-view3d-probe.ts`)
  mounts the real view against the real container job under
  SwiftShader and asserts the canvas draws (non-blank pixels,
  scene object counts). See `hidden_files/v33_run.log` for the
  numbers.
- Harness: `bun test ts/view3d/` (model, 19 checks); DOM harness
  view checks (fallback + playback state machine + layer
  toggles); E2E driver view checks on the real v3 job;
  verify_v28 geometry checks. Battery at close (Nov 24, 2026):
  verify_v25 78/78, verify_v28 73/73, DOM harness 66/66, E2E
  driver 23/23, verify_v24 31/31, model tests 19/19, render
  probe 10/10 — 300 checks, 0 failures. Run log:
  `hidden_files/v33_run.log` (battery logs: `v33_verify_v25.log`,
  `v33_verify_v28.log`, `v33_dom.log`, `v33_e2e.log`,
  `v33_verify_v24.log`).

## Known limits (for V3.5, not this wave)

- No sim seeking — playback seeks by move index; the sim shows the
  FINAL stock only, and the sim's checkpoint + delta seeking is
  V3.5.
- Re-rendering the Job prep tab remounts the view (playback
  state resets) — the tab rebuilds the whole result section on
  every render, and the view follows that pattern.
- The tool is a cylinder for every tool — correct for all V3.1
  flat tools (flat endmill + drill); ball-nose / V-bit profiles
  are V3.4's tool model, and the view's tool mesh does not yet
  render them (V3.4 shows the simmed stock; the tool cylinder
  stays a cylinder).
