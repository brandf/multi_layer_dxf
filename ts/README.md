# ts/ — V3 TypeScript toolpath generation

New V3 code is TypeScript (V3_SCOPE.md §3.5: Bun is needed for the
web work anyway, and one language beats two). This directory holds
the in-house toolpath generator (V3.1). It is separate from `server/`
(the Python web server) and from the Python pipeline scripts on
purpose: the generator reads ONLY job-dir files and never touches
Python internals, the classifier, the planner, or the layout code,
so the TS/Python boundary is a file contract (job.json + the job
DXF), not an import.

## Files

- `offset.ts` — geometry only: minimal DXF text parser, loop
  assembly (with the classifier arc-span repair), and the hand-rolled
  polygon offsetter (Candidate B). See `docs-v3/offset_spike.md`
  for the verdict, the rules this code proves, and the known limits.
  No I/O, no job model.
- `toolpaths.ts` — the generator. Run with Bun:
  `bun ts/toolpaths.ts <job-dir> [--json]`. Prints exactly one JSON
  object on stdout (progress on stderr), exit 0/1/2 with named
  errors. It does NOT write job.json: the Python CLI
  (`mldxf toolpaths`) merges the printed `toolpaths` section into
  job.json and bumps `job_version` to 3.
- `cuttime.ts` — the headless cut-time reader (V3.14). Run with Bun:
  `bun ts/cuttime.ts <job-dir> [--json] [--per-layer]`. Prints
  exactly one JSON object on stdout (`motion_time_s`,
  `motion_by_tool`, `motion_by_operation`, move/operation counts),
  exit 0/1 with named errors. It reads a v3 job's toolpaths section
  and sums every move's duration under the model in
  `view3d/model.ts` (feed at the operation's `feed_mm_s`, Z-only
  feed at `plunge_mm_s`, arcs by true length, rapids at 50 mm/s) —
  the same model the 3D view's playback timeline uses, so the
  number here, the number the generator records in the section, and
  the number the view shows are one number, not three. With
  `--per-layer` it also carries one entry per layer (motion seconds
  plus rapid/feed/arc seconds and move counts) — the data the
  calibration in `docs-v3/cuttime_feedback.md` fits against. It
  never writes the job.

## Contract

Input (job dir): `job.json` (v2: layers with `est` geometry, chosen
plan, `cut_order`, tabs; parts with `z_top`; config snapshot) and
the job's root DXF (layer outlines at Z depths).

Output (the `toolpaths` section in job.json):

```json
{
  "version": 1,
  "generator": "ts/toolpaths.ts",
  "plan": "A",
  "clearance_z_mm": 14.5,
  "z_model": "Z=0 at bottom of stock; cut-bottom Z = z_top - start_depth - cut_depth",
  "cut_order": ["drill", "pocket", "profile"],
  "operations": [ { ...one per plan layer per pass... } ],
  "skipped": [ {"layer": ..., "loop": ..., "reason": ..., "detail": ...} ],
  "stats": {"operations": N, "moves": M, "rapid": R, "feed": F, "arc": A}
}
```

One entry per plan layer per pass, in `cut_order` (drill, pocket,
profile), stable within an operation by plan order:

```json
{
  "operation": "drill" | "bore" | "pocket" | "profile",
  "layer": "P01_P01__POCKET_D1.50",
  "tool_id": "EM3.17",
  "feed_mm_s": 15.88, "plunge_mm_s": 5.29, "spindle_rpm": 20000,
  "pass": {"kind": "rough" | "finish", "stepdown_index": 0 | null},
  "z_mm": 8.0, "z_top_mm": 9.5, "z_bottom_mm": 8.0,
  "tabs": {"count": 3, "length_mm": 5.0, "thickness_mm": 1.0,
           "positions": [{"loop": 0, "s_mm": 27.41}] } | null,
  "moves": [ ... ],
  "skipped": [ {"loop": 0, "reason": "tool_too_large", "detail": "..."} ],
  "notes": []
}
```

- `pass.kind` `"rough"` = a stepdown level pass (pockets and
  profiles cut one level per entry); `"finish"` = the single
  full-depth contour, emitted only where the plan calls for one
  (`allowance_mm > 0`). `stepdown_index` counts the Z level (0 =
  first/top); `null` for drill/bore (one entry spans the hole) and
  for finish passes (one contour spans all depths).
- `z_mm` is the entry's cutting Z (level Z; hole bottom for
  drill/bore; `null` for finish spans).
- `tabs` is set only on the bottom profile pass. `positions` are
  arc-length positions of the tab centres along the contour, so the
  count/length can be checked against `manifest.txt` `# tabs:`.
- `skipped` records loops the tool cannot fit (no offset ring at
  tool radius) with reason `tool_too_large` — a recorded skip,
  never a silent omission. `skipped` on the section aggregates
  every entry's skips.

## Move model

```json
{"t": "rapid", "x": 20.0, "y": 20.0, "z": 14.5}
{"t": "feed",  "x": 20.0, "y": 20.0, "z": 8.0}
{"t": "arc",   "x": 20.0, "y": 20.0, "z": 8.0, "i": -21.4, "j": 0.0, "cw": false}
```

- Coordinates are job coords in mm, Z=0 at the bottom of stock.
  All numbers are rounded to 0.001 mm (deterministic output).
- `rapid` is always at or above the clearance plane.
- `arc` is first-class: `(x, y, z)` is the end point, `(i, j)` is the
  centre offset from the arc's start point, `cw` is the direction
  (`true` = G2 clockwise, `false` = G3 counter-clockwise). An arc
  whose end Z differs from its start Z is a helical arc (G2/G3 with
  Z) — ramps and bore entries. A planar arc has equal Zs.
- Feed-rate mapping (for the post-processor, V3.2+): Z-only feed
  moves use `plunge_mm_s`; XY feed moves and arcs use `feed_mm_s`.

## Operations

- **drill** (kind `drill`): peck cycle. Peck depth defaults to one
  tool diameter (no peck depth exists in the config). Pecks start
  at the stock top (safe whatever order the pockets run in) and
  retract to clearance between pecks; the final peck ends exactly
  at the hole bottom (`z_top - start_depth - cut_depth`).
- **bore** (kind `bore`, operation `drill`, tool = endmill): helical
  entry from the stock top (pitch = the tool's stepdown per
  revolution), then one full circular pass at the bottom. Never a
  straight plunge. Fails with `bore_too_small` if the bore diameter
  leaves no room for a helix with the planned tool.
- **pocket**: contour-parallel clearing at each stepdown level
  (rings at stepover spacing from the wall, outermost first, ramp
  entry along the first ring of each level) + finish contour where
  the plan calls for one. Islands are respected: rings stop when
  they would come closer than tool radius (+ allowance) to an
  island, and each island gets its own contour (outward offset,
  CW). Nested outer loops (an island ring's inner disc) are cleared
  as their own region — the tool retracts to clearance between
  disjoint regions, never feeding through material at depth.
  Rough+finish variant: rough rings leave `allowance_mm` on the
  walls; the finish entry is one full-depth contour (helical
  descent over one revolution, then one planar revolution at the
  bottom) at exactly tool radius.
- **profile**: offset outward by tool radius for an outer profile
  (CW, climb), centred for a through-cut slot (CCW). Stepdown
  passes with ramp entry (lead-in from outside the part for outer
  profiles; ramp along the slot start for through-cuts; helical
  descent along the contour for later levels). Tabs apply ONLY on
  the bottom pass: the tool rides `tab_thickness` high over each
  tab span. Never a straight plunge into solid stock.
  The contour is rotated to start at its farthest (convex extreme)
  point, where the level-0 lead-in ramp lands (`rotateLoopStart`
  in `toolpaths.ts`): the ramp must land at the contour start, or
  the first arc's `i,j` is computed from a start the tool never
  reaches — a real gouge the independent checker caught on the
  P01/P02 container profiles (the arc swept a different circle
  and dipped to 0.13 mm from the outline). The rotation splits the
  segment containing the farthest point and reorders the loop;
  every level then starts at the same point.
- **finish pass**: single full-depth contour where the plan calls
  for one (see pocket/profile above).

## Feeds, speeds, stepdown, stepover

From the chosen plan's tool entries (`tool_plan.plans[<chosen>]`),
which are the config snapshot's `toolplan` values resolved per
tool (V1 defaults stay). The config snapshot's `toolplan` section
(`config_snapshot.config_file.contents.toolplan`) carries the
defaults (`finish_allowance_mm`, `tabs`, `stepdown_mm`,
`stepover_pct`) the planner used.

## Z model and clearance

- Z=0 at the bottom of stock. `z_top` per part from job.json.
  Layer `start_depth`/`cut_depth` are depths below the part top.
- `clearance_z_mm` = max part `z_top` + 5.0 mm. No clearance plane
  exists in the config (only `pin_clearance_mm`), so the generator
  defines and records this value in the section.
- Rapids are always at `clearance_z_mm`. Feed-downs to a pocket
  top pass through air (start_depth 0) or the already-cleared
  upper pocket (start_depth > 0, plan order).

## Determinism

Same job + same config snapshot → identical toolpaths: all
coordinates rounded to 0.001 mm, centres sorted by (x, y), entries
in a fixed cut order, no timestamps, no randomness. Re-running
`mldxf toolpaths` on a v3 job recomputes from the plan + DXF and
produces byte-identical toolpaths (verified by diffing two runs).

## Known limits (see docs-v3/offset_spike.md)

- Outward offsets of notched/tiny pocket outlines can be rejected
  by the offsetter's guards; the generator never uses outward
  offsets for pockets.
- Erosion of discretised-spline loops can self-intersect at tight
  bends; the ring sequence ends there and the first failed offset
  is recorded (the generator does not silently leave a ridge — but
  it does not yet split the remaining core; through-cuts, which use
  centred passes, are unaffected).
- A loop narrower than the tool produces no ring and is recorded
  as `tool_too_large` in `skipped`.
- The classifier's DXF ARC spans can be frame-mirrored; the
  generator carries the repair (see offset_spike.md). That is a
  classifier defect — V3.1 does not fix the classifier.

## V3.3 — layer geometry + the 3D view (docs-v3/view3d.md)

- `geometry.ts` — layer geometry for the 3D view. Run with Bun:
  `bun ts/geometry.ts <job-dir> [--json]`. Reads job.json +
  the job's root DXF (same discovery rule and arc repair as the
  generator) and prints one JSON object: one entry per job layer
  (`layer`, `operation`, `part`, `z_top_mm` = part z_top −
  start_depth, `z_bottom_mm` = floor_z or z_top − cut_depth,
  `loops` as sampled points, `loop_count`) + `bounds`. Read-only;
  the CLI shell is `mldxf geometry`, the API is
  GET /api/jobs/:id/geometry.
- `view3d/model.ts` — the view's pure logic (flatten, true-arc
  sampling, durations, colours, playback state machine). Tested
  with `bun test ts/view3d/` — no DOM, no three.js.
- `view3d/entry.ts` — the browser entry (three.js + OrbitControls,
  `window.MldxfView3d.mount`). Bundled by `view3d/build.ts` into
  `server/public/vendor/view3d.js` (IIFE, minified; a build
  artifact, never checked in). three@0.187.0, pinned by the
  repo-root package.json + bun.lock.

## V3.4 — cut-simulation engine (docs-v3/sim.md)

- `sim.ts` — dexel stock (one Float32Array of column top heights),
  adaptive pitch (0.05 mm, doubling to a 25M-column budget; the
  pitch actually used is recorded), analytic per-segment sweep
  (flat tools: exact endpoint minimum; profiled tools: ternary
  search), `dexelToMesh` (top + skirts + bottom quad, adaptive
  stride, ≤120k verts). Browser-safe (no node imports) — the V3.3
  view imports it directly.
- `tools.ts` — the tool model: a tool is profile data (`r(z)` +
  `h(r)`). Flat, ball-nose, V-bit, bull-nose in one model;
  `profileForPlanTool` / `toolTableFromPlan` map plan tools to
  profiles (unknown kind throws, never guesses).
- `sim_verify.ts` — the headless verifier. Run with Bun:
  `bun ts/sim_verify.ts <job-dir>`. Prints one JSON object
  (per-layer probes, global no-gouge scan, timing), exit 0 pass /
  1 `sim_mismatch` / 2 internal error. The CLI shell is
  `mldxf sim --verify`, which merges the `sim` section into
  job.json + manifest.json on PASS only (validated before
  publishing, the `cmd_toolpaths` pattern). `SIM_VERIFY_DEBUG=1`
  prints the failing probes, gouge samples, and histograms.
- Tests: `bun test ts/sim.test.ts` (22 tests: profiles, pocket /
  drill / arc / tab sims, pitch selection, determinism, unknown
  tool throws, raster-helper regressions).
- `view3d/entry.ts` gains the Simulate button (same engine,
  operation by operation, awaiting between ops) and the simmed
  stock mesh; `view3d/build.ts` staleness inputs gained `sim.ts` /
  `tools.ts`; `VIEW3D_VERSION` "1" → "2".

## V3.5 — faster-than-real-time + rewind/seek (docs-v3/sim_seek.md, docs-v3/sim_gpu.md)

- `sim_seek.ts` — delta log + sparse checkpoints: per move-chunk
  (~30 s cut time) the columns lowered with their pre- and
  post-chunk heights (exact Float32, one entry per column per
  chunk); checkpoints every 5 min of cut time on chunk
  boundaries. `seekTo` reverts/applies whole chunks and
  re-simulates at most one chunk — a seeked grid is bit-identical
  to a fresh sim. `serializeSeekData` / `parseSeekData` (binary
  `sim/delta.bin` v1, deterministic), `checkpointIndex` (the
  job.json `sim.checkpoints` object), `loadSeekDataIfFresh`
  (refuses a log built for different toolpaths), `stockStats`,
  `gridsEqual`, steppable builder (`createSeekBuilder` /
  `stepSeekBuilder` / `buildSeekDataAsync`, one chunk per
  macrotask) for the view. `sim.ts` gains the recorder hook
  (`DeltaRecorder`, zero cost without one).
- `sim_verify.ts` builds the seek data in its single sim run and
  writes `sim/delta.bin` on PASS only; the `sim` section's
  `checkpoints` is the index (was `null` before V3.5).
- `sim_seek_cli.ts` — `bun ts/sim_seek_cli.ts <job-dir> --move N
  | --time T`: seeks from 0 (loading the log when fresh, else
  rebuilding in memory) and prints one JSON object with the stock
  stats and the seek report. Read-only. The CLI shell is
  `mldxf sim --seek --move N | --time T`.
- `sim_gpu.ts` — the WebGPU backend: the same dexel buffer layout
  as the CPU backend (Float32Array, row-major), one workgroup per
  packed segment (WGSL, 256 invocations striding the footprint
  bbox), column writes via `atomicMin` on `bitcast<u32>` (order
  preserving for non-negative floats). `packSegments` walks
  exactly the segments `simulateRange` sweeps (same `sampleMove`,
  same skip rules, same `colOf` bbox, clamped to the grid);
  `simulateGpu` dispatches in ≤65,535-segment chunks with one
  submit per chunk. `requestGpuDevice` throws a named error when
  there is no WebGPU — never a fake device. `compareGrids`
  reports exact-equality stats; acceptance is the verification
  tolerance (pitch + 0.05 mm).
- `view3d/entry.ts` — Simulate builds the seek data (async) and
  the stock follows scrub / playback / op-jump (`seekStockTo`,
  mesh rebuild throttled to 120 ms, playback seeks to 250 ms);
  the sim status names the backend honestly (CPU fallback when
  there is no WebGPU; GPU headline sim + background CPU seek
  build when there is). `view3d/build.ts` staleness inputs gained
  `sim_seek.ts` / `sim_gpu.ts`; `VIEW3D_VERSION` "2" → "3".
- Tests: `bun test ts/sim_seek.test.ts` (13 tests: chunk tiling,
  exact seek at every chunk boundary + random moves, backward /
  forward, clamping, binary round-trip + corruption refusal,
  checkpoint-index shape, `moveAtTime`, `stockStats`, stale-log
  refusal, zero-move job, real-container exactness) and
  `bun test ts/sim_gpu.test.ts` (16 tests: profile mapping,
  pack/unpack round-trip, skip rules, arc packing, sub-range
  packing, shader-source + bitcast-order properties,
  `compareGrids`, banded-verdict cases, Bun has no WebGPU,
  real-container packing).
- Probes: `server/run-webgpu-sim-probe.ts` runs the CPU + GPU
  backends on the container job in headless Chromium (SwiftShader
  WebGPU behind `--enable-unsafe-webgpu`) and compares the grids.
  See docs-v3/sim_gpu.md for the WebGPU-availability finding and
  the measured numbers.

## V3.6 — G-code export + native post-processors (docs-v3/gcode.md)

- `posts/common.ts` — post core: `postJob` walks the job's
  toolpath moves, converts coordinates (Z=0 at stock bottom →
  machine Z-zero top of material: `machineZ = jobZ − stockTop`),
  enforces machine limits (refuses with `post_limit_exceeded`,
  never clamps), and calls the post's hooks (header, tool change,
  rapid, linear, arc, plunge, spindle, coolant, footer). Feeds
  come from the operations (Z-only feed → plunge feed, XY/arc →
  cutting feed); rapids carry no F.
- `posts/masso.ts` (`MASSO_MM`, `MASSO_INCH`), `posts/grbl.ts`
  (`GRBL`), `posts/template.ts` (`TEMPLATE`, the worked example
  for a third machine) — Masso uses `T<n> M6` manual change, no
  G43, no canned cycles (drills are explicit pecks; Masso G83
  support is proven from the docs but not emitted — see
  `docs-v3/gcode.md` §5); GRBL uses an M0 pause (no M6).
  Registry: `posts/index.ts` (default `masso-mm`).
- `gcode_parse.ts` — the parser: exactly what the posts emit
  (G0/G1/G2/G3, I/J arcs, modal words, M0/M3/M5/T+M6/M30),
  nothing else (canned cycles, G43, G28 etc. are named
  `gcode_parse_unsupported` refusals).
- `gcode_verify.ts` — round-trip comparison: both sims on the
  same stock/pitch; the verdict is a 3×3 band test plus a
  largest-mismatch-cluster bar of 3 (inch rounding + chord-phase
  grazing flips are isolated singles; a real 0.06 mm shift
  clusters 22 — calibrated, see `docs-v3/gcode.md` §7).
- `gcode.ts` — Bun driver (`bun ts/gcode.ts <job-dir> --post
  <id> [--json]`): posts, writes `gcode/<job-id>-<post-id>.nc`,
  parses back, round-trips; exit 0 verified, 1 named failure
  (incl. `gcode_unverified` — file written, entry recorded
  unverified), 2 internal. The CLI shell is `mldxf gcode`
  (post selection `--post` > job profile > machine.json >
  `masso-mm`; entry merged into job.json + manifest.json,
  validated before publishing); the API is
  POST /api/jobs/:id/gcode.
- Tests: `bun test ts/gcode.test.ts` (20 tests: headers, Z and
  inch conversion, tool changes, limit refusals, parser
  round-trip + refusals). The full round-trip sim comparison
  runs against real jobs through the CLI, not here.

## Typecheck

Canonical check (no execution, no network):

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Config: repo-root `tsconfig.json` (`lib` ESNext + DOM,
`types: ["bun"]`, `strict`, `allowImportingTsExtensions`,
`noEmit`). Dev dependencies: `typescript`, `@types/bun`,
`@types/node`, `@types/three` (three@0.187 ships no bundled
types). Added 2026-11-24 to end the recurring `bun --check`
complaints (missing node/console/three types).

Do NOT use `bun --check` as the typecheck: it typechecks, and
then it EXECUTES any file that passes — verified 2026-11-24
(`bun --check` on a clean scratch file printed its top-level
log; on `ts/validate_job.ts` it ran the CLI and printed its
usage error; on `ts/view3d/build.ts` it rebuilt the bundle). On
`server/server.ts` that would start the server. `tsc --noEmit`
checks without running anything.
