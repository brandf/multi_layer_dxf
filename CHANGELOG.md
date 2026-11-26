# multi_layer_dxf — Changelog

## V3 (unpushed, 2026-11-24)

V3 is the in-house TypeScript toolpath generation + job model +
3D view + sim wave, on top of pushed V2 (commit `aa499634`).
Local only at this writing: no push, no tag, no release.

- **V3.4 — cut-simulation engine** (`ts/sim.ts`, `ts/tools.ts`,
  `ts/sim_verify.ts`, `mldxf sim --verify`): dexel stock, adaptive
  pitch (0.05 mm, 25M-column budget), analytic per-segment sweep,
  extensible tool profiles (flat / ball-nose / V-bit / bull-nose in
  one model). `mldxf sim --verify` writes the `sim` section into
  job.json + manifest.json on PASS only. The §5.4 target (≥50× real
  time CPU) is confirmed on all five reference jobs (container
  209×, real_container 252×, machined 206×, eight_parts 78×,
  Kookabus 3812×); the VCarve baseline is unmeasured (needs
  Brandon's machine/timing). The view gains a Simulate button
  showing the simmed stock mesh (`VIEW3D_VERSION` 2). The verifier
  caught nine generator defects (tabs destroyed, lead-in ramp
  ploughing, rough levels below tab height, pocket/profile
  diagonal-rapid retracts, single-ring sloped floor, narrow-notch
  fill + ring clipping, bore central pillar, filled-branch
  run-entry feed) — all fixed in `ts/toolpaths.ts`, verified by
  the verifier itself; see `docs-v3/sim.md`.

## v2.0.0 — 2026-11-23

V2: the V1 pipeline gains a headless CLI, a versioned job model,
a machine/library config model, and a local web UI on top of the
CLI — so a job can be prepared in the browser or from the command
line with identical results — while the VCarve gadget (v1.0.1)
stays the bridge into VCarve, unchanged. Nothing in V2 generates
toolpaths or G-code itself (that is V3). Local only at this writing:
no tag, no release page yet — that is V2.11, after V2.10
acceptance (see VALIDATION.md §8). The detailed per-wave build
log is kept below, under "V2 build log".

- **V2.1 — headless CLI `mldxf`** (`mldxf.py` + `mldxf.bat`): one
  entry point over the v1 scripts — `plan`, `check`, `job`,
  `rerun`, `guides`, `machine`, `tools`, `clamps`, `preferences`,
  `serve`, `init`. `--json` on every command (exactly one JSON
  object on stdout, progress on stderr); exit 0/1/2. A thin
  shell: no classifier or planner code rewritten, and the v1
  scripts keep working directly.
- **V2.2 — job model v2** (`job.json`): the v1 manifest's keys
  unchanged, plus `job_version` 2, `job_id`, `cli_version`,
  `created_at`, `source_step_sha256`, embedded `inputs/` (STEP
  copy, parts.json, resolved config snapshot), and `outputs` with
  a sha256 per file. `manifest.json` is a byte-identical copy of
  `job.json`; `manifest.txt` (the gadget contract) is frozen.
  `mldxf rerun` reproduces a job from its embedded inputs. DXF
  bytes are NOT reproducible (ezdxf timestamps/GUIDs) — parity
  and rerun compare DXF by canonical entity+layer signature
  (`mldxf_dxf.py`), and `job.json` is not byte-identical across
  reruns for the nondeterministic files (see V2_SCOPE.md §8 Q4).
- **V2.3 — config model** (`mldxf_config.py` + the four
  `*.example.json` files): machine profile (Onefinity Elite
  (Masso) Foreman, 1222.4 × 1222.4 mm bed), tool inventory, clamp
  inventory, preferences — in `MLDXF_HOME`, never the repo or the
  cwd. Strict, loud validation (named errors, never silent
  defaults). T-track slots in the shipped example are
  clearly-marked placeholders, not measurements.
- **V2.4 — inventory-aware display**: each tool in a plan carries
  `owned: true/false` from the snapshotted `tools.json`; the
  report and UI show owned tools first and mark not-owned ones.
  Advisory only — ranking is untouched, nothing hard-fails on a
  tool you do not own. An empty inventory behaves exactly as V1.
- **V2.5 — Bun server + JSON API** (`server/server.ts`,
  dependency-free, localhost-only): every endpoint 1:1 with a CLI
  command; async runs with SSE progress + cancel; jobs re-scanned
  on startup, interrupted jobs re-runnable from retained inputs.
  `mldxf serve` starts it; `start.bat` is the Windows
  double-click wrapper.
- **V2.6 — web UI: libraries + machine setup**: Tools, Clamps &
  machine (slot-list editor, placeholder warning), and
  Preferences tabs — validate-then-save, version bumps.
- **V2.7 — web UI: job prep**: drop a STEP or pick one on disk,
  set material/plan/auto/mode/min_tool/only, watch SSE progress,
  review plan / flags / post-processing / workholding, download
  DXF, manifest.txt, report.md, manifest.json, or the whole job
  as a zip.
- **V2.8 — web UI: jobs list + rerun + 2D layout preview**: past
  jobs newest first (v2 jobs Open + Rerun; v1 jobs read-only);
  2D SVG top view from `layout` + `workholding` — sheet outline,
  clamp-margin boundary, part rectangles at layout positions,
  clamp diamonds. Parts render as rectangles because `job.json`
  carries no per-part outline shape; drawing circles would invent
  geometry the CLI did not emit.
- **V2.9 — workholding guides** (`mldxf_guides.py` + `mldxf
  guides` + `POST /api/jobs/:id/guides`): keep-out first, support
  near the cuts, first-order loading forces (`F = Kc·MRR/v_c`,
  `Kc = 30 N/mm²` — top of the published 10–30 range, labelled
  conservative and unvalidated everywhere it appears),
  T-track slots only. Placeholders refuse with named errors, never
  a guess. Output: a `GUIDE_CLAMP` layer in the DXF, a
  `workholding` section in `job.json`, and a section in
  `report.md`. A rerun reproduces the guides from provenance.
- **§4 numbers hold**: container Plan A 3 tools / 7.0 min,
  Kookabus 215.1 min, eight_parts 9.0 min (acceptance re-check in
  progress — VALIDATION.md §8 items 1–3).
- **Still open (not in V2)**: the live end-to-end job (Brandon —
  see `V2_LIVE_RUN.md`); guides on his real T-track slots (needs
  his measurements — placeholders refuse until then); whether the
  UI should default auto-orient ON (it defaults OFF, so a default
  container run shows 6.4 min vs the §4 7.0 min); tool remembering
  on a second gadget run (unconfirmed since V1); BRA-6, BRA-13,
  BRA-19 (separate streams); the rename decision (end of V2).

## V2 build log (waves 1–4, local only, 2026-11-23)

Headless CLI `mldxf` — one entry point over the existing Python
pipeline (V2_SCOPE.md §2, BACKLOG.md V2.1). `mldxf.py` in the repo
root (`python3 mldxf.py` / `./mldxf.py`, plus `mldxf.bat` for Windows
double-click use) is a thin shell over `step_to_vcarve.py` /
`multi_part.py`: it inspects the STEP's solid count and runs the
single- or multi-solid path, carrying over the V1 flags (`--parts`,
`--mode`, `--only`, `--min-tool`, `--material`, `--plan`, `--auto`).
No classifier or planner code is rewritten; the v1 scripts keep
working directly, exactly as in v1.0.1. Commands: `plan`, `check`,
`job` (read-only, against the v1 manifest.json), `rerun` (reproduces a v2 job — V2.2, built
2026-11-23; still fails with the named error `rerun_unavailable`
on v1 jobs, which have no embedded inputs or config snapshot), `machine show/validate`, `tools list/validate`,
`clamps list/validate` (delegating to the V2.3 `mldxf_config.py`
module and its example files, which the parallel V2.3 worker built),
`serve` (starts the Bun web server — V2.5, built 2026-11-23), `init` (copies the shipped examples into
the resolved home dir). `--json` on every command: exactly one JSON
object on stdout, progress on stderr; exit 0/1/2 (success / user
error / internal error). A missing `--config` file is a hard error,
exit 1 (the V1 rule). Default job dir with no `-o` is
`<MLDXF_HOME>/jobs/<job-id>` (the settled §10 default). Verified by
the full VALIDATION.md §4 suite run through `mldxf plan` (see
VALIDATION.md §4 note) plus byte-diffs of CLI output against fresh
direct-v1 runs for the real container, Kookabus, and eight parts.
VERSION stays 1.0.1 — v2.0.0 is the V2.11 release, not this item.

Job model v2 + `mldxf rerun` (V2_SCOPE.md §3, BACKLOG.md V2.2).
`mldxf plan` now writes a versioned job dir: `job.json` (the v1
manifest's keys unchanged, plus job_version 2, job_id, cli_version,
created_at, source_step + source_step_sha256, inputs_embedded,
config_snapshot, machine_profile, workholding null for V2.9,
outputs with a sha256 per file), `manifest.json` as a
byte-identical copy of `job.json`, `inputs/` (input.step copy of
the source STEP by default, parts.json when --parts was used,
config.json = the resolved config snapshot), plus the v1
manifest.txt, job DXF, report.md, and per-part files. New flag:
`--no-embed` (no STEP copy; rerun then needs the original STEP
path). `mldxf rerun <job-dir>` replays a v2 job from its embedded
inputs + snapshot, in place via a temp sibling dir renamed into
place; a different CLI version warns on stderr and proceeds,
recording the new cli_version. v1 jobs still fail rerun with the
named error `rerun_unavailable`. `mldxf_dxf.py` is the one canonical
DXF signature (entity+layer, not bytes — ezdxf timestamps/GUIDs
make DXF bytes unreproducible). manifest.txt is unchanged
(byte-identical to the direct v1 run); the DXF keeps its v1
<stem>.dxf name. One honest limit, recorded in V2_SCOPE.md §8 Q4:
`outputs` records true per-run sha256 values, so job.json is not
byte-identical across reruns for the nondeterministic files
(DXFs, exported per-part STEPs) — those are compared by canonical
signature / timestamp-blanked STEP instead. VERSION stays 1.0.1.

Bun local server + JSON API (V2.5, BACKLOG.md V2.5).
`server/server.ts` (dependency-free, Bun's built-in server only),
`mldxf serve [--port N]`, `start.bat` (Windows double-click
launcher). Localhost-only, no auth in V2. Endpoints map 1:1 to the
CLI (`POST/GET /api/jobs`, `GET /api/jobs/:id`, SSE progress at
`/api/jobs/:id/events`, rerun, cancel, downloads incl. zip, library
CRUD for tools/clamps/machine/preferences). Runs are async with
streamed progress and cancel (kills the CLI process group, marks
the job interrupted); jobs re-scanned on startup with interrupted
jobs re-runnable from retained inputs; library edits are
validate-then-save through the real CLI with a version bump.
Verified by `server/verify_v25.py` (62/62): API/CLI parity on the
real container STEP, invalid library refusal, interrupted marking,
cancel, and v1/v2 rerun behaviour. Coordinator joint check
(`~/workspace/joint_v2_check.py`, 20/20) independently confirmed
server/CLI parity and API rerun of a server-created job. New CLI
command `mldxf preferences show|validate` (the API's preferences
endpoints previously had no CLI subcommand to map to; preferences
carry no `version`, so a preferences save bumps no version).
Known gap: rerun is a synchronous passthrough (a background 202
rerun is a possible V2.7/V2.8 follow-up). Coordinator fix: `mldxf
serve` now stops cleanly on SIGTERM as well as Ctrl-C — the Bun
server runs in its own process group and the CLI kills the group
(the first version orphaned `bun run server.ts` on SIGTERM; a
nested `proc.wait()` inside the signal handler then deadlocked
on Popen's non-reentrant `_waitpid_lock`, so the handler kills
the group directly and lets the SystemExit unwind out of the
outer wait instead).

Web UI: libraries + machine setup (V2.6) and job prep (V2.7),
inventory-aware plan display (V2.4). `server/public/` — the Tools,
Clamps & machine (slot-list editor, placeholder warning), and
Preferences tabs (validate-then-save, version bumps), and job prep
(STEP upload or disk path, material/plan/auto/mode/min_tool/only,
SSE progress with polled fallback + cancel, plan/flags/
post-processing/workholding display, owned-first tools, downloads
DXF/manifest.txt/report.md/manifest.json/zip). Tools in a plan carry
`owned: true/false` from the snapshotted tools.json, never the live
file; the report has an advisory section; ranking is untouched; an
empty inventory behaves exactly as V1. Verified 2026-11-23 (wave 3):
V2.6 37/37 API replay + 14/14 headless UI smoke; V2.7 49/49 HTTP
replay + 20/20 DOM + 11/11 live Chromium E2E; V2.4 31/31; CLI parity
21/21 (UI run of the real container = Plan A 3 tools / 7.0 min,
job.json identical modulo §8 Q4 exceptions, manifest.txt
byte-identical, DXF signature-identical). Note: the UI defaults
auto-orient OFF, so a default container run shows 6.4 min vs the
§4 7.0 min (which needs auto) — open question for Brandon whether
the UI should default auto ON.

Web UI: jobs list + rerun + 2D layout preview (V2.8, BACKLOG.md
V2.8). New `server/public/jobs.js` (`window.MldxfJobs`, Jobs tab):
past jobs newest first with plan summary and status; v2 jobs get
Open + Rerun, v1 jobs are read-only ("v1 — read-only, no rerun",
no rerun button); detail shows the plan (owned-first), parts,
material, cut order, flags, post-processing, workholding note,
downloads, and an "Open in Job prep" cross-link; rerun is the
synchronous passthrough, handling both the 200 in-place replay and
the 202 rerun-from-retained-inputs case. The 2D SVG preview renders
`layout` + `workholding` only — sheet outline, dashed clamp-margin
boundary, parts as their layout rectangles at their layout
positions, clamp positions as diamond markers when workholding is
present. No 3D, no mesh, no toolpath preview. Parts render as
rectangles because `job.json` carries no per-part outline shape;
drawing circles would invent geometry the CLI did not emit. Verified
2026-11-23 (wave 4): HTTP replay `server/verify_v28.py` 37/37; live
Chromium E2E `v28-e2e.ts` 29/29 on the clean re-run; wave-3
regression harnesses re-run green (verify_v25 62/62, verify_v24
31/31, verify_v23_joint 25/25).

Workholding guides (V2.9, BACKLOG.md V2.9, V2_SCOPE.md §6). New
`mldxf_guides.py` + `mldxf guides <job-dir> [--json]` (post-step on
a finished job; `mldxf plan` never runs guides and never fails on
placeholder T-track) + `POST /api/jobs/:id/guides` (1:1 with the
CLI) + the workholding section in `server/public/job-prep.js`
("No guides yet" with a Run guides button for v2 jobs; v1 jobs
read-only; refusals render as the tab's error alert). Keep-out
first (footprint + keep-out clears every profile/pocket outline and
drill point, reusing layout.py's spacing checks); support near the
cuts (profiles first, sheet-edge tie-break); first-order loading
forces `F = Kc·MRR/v_c`, `Kc = 30 N/mm²` (top of the published
10–30 range, labelled conservative and unvalidated everywhere it
appears); `hold_force_n` used when present, otherwise "holding
force unknown — verify by hand"; T-track slots only (clamp centre
on a slot, nearest slot coordinate to the ideal position);
placeholders refuse with named errors (`t_track_placeholder` /
`clamps_no_slot` / `guides_no_clamps` / `guides_unavailable`),
never a guess. Output: a `GUIDE_CLAMP` layer in the DXF, a
`workholding` section in `job.json` (clamps, alternatives,
force_model, provenance, recommendation), and a section in
`report.md`. **A rerun reproduces the guides**: `workholding.
provenance` records the exact machine/clamp inputs, and `mldxf
rerun` replays the guides from that provenance before the swap; a
job whose workholding lacks usable provenance fails the rerun up
front (`rerun_guides_unreplayable`) rather than silently dropping
guides. Verified 2026-11-23 (wave 4) on the real container with a
clearly-marked test T-track fixture (not real measurements): 2×
t-track-clamp at (43, 88) and (106.7, 88) on the x-axis slot at
y=88 mm, worst estimated force 2.58 N; independent checker ALL
GUIDE CHECKS PASSED; refusals verified at CLI + HTTP; rerun of a
guided job reproduces the workholding byte-identical; §4 number
holds (Plan A 3 tools / 7.0 min). No real T-track measurements
exist yet — on Brandon's real (placeholder) home, guides correctly
refuse until he measures his slots.

## v1.0.1 — 2026-11-22

Post-V1 streamlining, first item (Brandon): tool labels use the tool's
native designation, compact. An imperial endmill is now labelled
"1/4in" (not "6.35 mm", not "quarter-inch") in the gadget's tool
prompts and final dialog and in report.md's tool lists. Metric tools
(a 1.00 mm endmill, a 2.25 mm drill) still display in mm. The project
still works in mm throughout — geometry, planner math, manifest data
(the `# tool:` lines still carry the diameter in mm) — only the label
changed. Tool ids (EM6.35, D2.25) and the ToolDBId remembering keyed
on them are unchanged, so remembered tools still match.

## v1.0.0 — 2026-11-22

First release. STEP → layered DXF + manifest → VCarve Pro gadget → toolpaths.
Live-tested end to end in VCarve Pro V12.5 on the real two-part container
(Bottom + Top, Ø46 mm): 8 toolpaths, Plan A 3 tools / 2 changes / 7.0 min,
rib standing, profiles cutting through 10 mm stock, tabs holding both parts
in the sheet, tools remembered on the second run (unconfirmed — see below).

### What it does

- Any CAD (STEP, mm, Z-up) of a prismatic 2.5D part → one layered DXF +
  `manifest.json` + `manifest.txt` + `report.md`. Pockets, holes and
  profiles each land on their own layer with depths in the layer name;
  circles stay true circles.
- Multi-part scenes become one VCarve job: per-part CAM orientation search
  (all 6 axis-aligned orientations, scored by actual outcome), shelf
  packing with clamp margins and tool-dependent spacing, ranked tool plans
  from standard sizes (no personal tool library — Brandon reviews in
  report.md).
- The VCarve gadget (`vcarve/multi_layer_dxf.lua`, installed via the
  `.vgadget`) reads `manifest.txt`, imports the DXF, names each tool
  before its library dialog, remembers picks in the registry for the
  next run, creates drill / pocket / profile toolpaths in cut order,
  places real tabs on the profile vectors, and lists the
  post-processing steps in its final dialog.
- Beveled STEP recovery: accept a finished STEP with fillets, recover
  the prismatic shape, file non-prismatic faces into a post-processing
  plan (router table / hand router / CNC 3D / drill press).
- Slanted walls, floor fillets, countersinks, non-vertical holes,
  undercuts and true 3D surfaces are detected and flagged, never
  silently guessed.

### Proven in the live test (Nov 21–22, VCarve Pro V12.5)

- Gadget loads (`-- VECTRIC LUA SCRIPT` first line is required), picks
  the manifest with the real `FileDialog()` API, imports the DXF.
- Clamp-margin offset always applies; parts sit inside the margin
  whether or not `--material` was given.
- Tool cap: no endmill bigger than 1/6 of a part's smallest footprint
  side, floored at 1/4 in (a 1/2 in tool on a 46 mm part was "very large").
- Pocket fit width accounts for islands: the step pocket's 5.03 mm
  annulus takes the 1/8 in tool, so the rib stands.
- Fit-rule clearance is proportional for tiny tools (0.5 × tool dia,
  capped at 0.5 mm) — the Kookabus merged job has a plan.
- Through cuts use VCarve's `z` (material thickness) formula.
- Tabs are real ToolpathTab objects on the vectors (the SDK spells the
  method two ways; the gadget tries both).
- A `--config` naming a missing file fails loudly instead of silently
  running with defaults.

### Still open (not in v1)

- BRA-6: live-test the Onshape FeatureScript (`featurescript/CAM_Snapshot.fs`)
  in a real Onshape document.
- BRA-13: two-sided parts (flip setup with registration pins) — needs a
  real two-sided test part.
- BRA-19: direct STEP → toolpaths, eliminating VCarve for a subset of
  parts. Not built until the VCarve path is proven on real jobs.
- Tool remembering on a second run is implemented (ToolDBId registry
  defaults) but not yet confirmed live.
