# V3.4 — cut-simulation engine (docs-v3/sim.md)

Dexel stock + extensible tool profiles + CPU backend, a headless
verifier (`mldxf sim --verify`), and the simmed stock in the V3.3
3D view. The engine is `ts/sim.ts`, the tool model `ts/tools.ts`,
the verifier `ts/sim_verify.ts`, the tests `ts/sim.test.ts`.

## Why dexel (V3_SCOPE.md §5.2)

Voxel at 0.05 mm pitch on the container sheet is 1.08B cells
dense; dexel is 5.4M columns / 21.6 MB — one Float32Array of top
heights, one height per (x, y) column. The dexel's one blind spot,
overhangs, cannot occur in a 2.5D prismatic job (every cut is a
vertical tool moving in Z), so nothing is lost. The stock is a 2D
grid of vertical columns; a move lowers every column under the
tool footprint to the tool envelope's height at that column.

## Stock placement

Stock top = max part `z_top`, NOT `suggested_material.thickness`.
The thickness is a purchase suggestion for nominal sheet; the
whole pipeline assumes stock top = part top. Sheet XY comes from
`suggested_material` x/y; the origin is (0,0) when the geometry
fits inside the (0,0)-anchored sheet, otherwise the sheet shifts
minimally to contain the geometry (the machined plate is a single
part centred on the origin, x −60..60 on a 120×80 sheet). The
verifier passes the DXF geometry bounds (`loaded.bounds`) to
`prepareSim`; the view passes the geometry API's bounds. Without
bounds the old (0,0) behaviour is kept.

## Adaptive pitch

Start 0.05 mm, double until the column count is ≤ 25M (~100 MB).
The pitch actually used is recorded as `sim.pitch_mm`; a coarse
flag is set when the pitch is coarser than smallest-tool-diameter/10
(Kookabus: 0.05 mm would need 28.2M columns, so pitch 0.1 mm,
7.05M columns, `pitch_coarse: true` — the scope's named case).
The pitch floor is a reporting rule, not a second constraint: on a
job where the floor would bust the budget, the budget wins and
the sim says so (`pitch_coarse` + `coarse_reason`).

## Sweep — analytic per segment, not disc-stamping

For each column under a segment, the cut height is the minimum
over the segment of z(t) + h(d(t)), where h is the tool profile's
envelope height at radius d(t). That function is convex in t, so
flat tools take the exact endpoint minimum (one quadratic solve
via `toolInterval`) and profiled tools use ternary search (16
iterations). Rapids are simulated like any move (a rapid at
clearance never reaches stock; a rapid below stock top gouges and
is caught). A segment is skipped outright when its lowest tip Z
is ≥ stock top (clearance rapids are ~free).

Fast path (spike-driven): level flat segments use a
membership-only test (closest approach squared, no sqrt, no
per-column call, 1/dd hoisted to a multiply). Arc sampling is
sagitta-bounded: `arcStepDeg(radius, pitch)` = clamp(sqrt(2·pitch/R)
in degrees, [0.5, 10]) — chord sagitta ≤ pitch/4. The sim and the
verifier share the sampling rule, so the verifier's capsule
rasterisation samples exactly the chords the sim swept.

## Tool model (ts/tools.ts)

A tool is data — a profile `r(z)` (radius vs height above the tip)
+ its inverse `h(r)` (envelope height above the tip at radius r).
Flat (`h = 0`), ball-nose (`h = R − sqrt(R² − r²)`), V-bit
(`h = r / tan(θ/2)`, diameter = max usable), bull-nose (flat middle
+ torus fillet; rc = 0 normalises to flat, rc = R to ball-nose).
A new tool type is new profile data, not a new engine. Plan tools
map via `profileForPlanTool` / `toolTableFromPlan`: V3.1 kinds
`endmill` / `drill` → flat (a drill peck cuts a flat-bottomed hole
in the dexel model); `ball-nose` / `v-bit` / `bull-nose` plug in
from inventory shape data when it exists (scope §11.5); an unknown
kind or tool throws, never guesses. Flutes/helix/stickout are NOT
in the sim (they do not affect the stock model). The model is
shared by the generator, the sim, and the posts.

## The `sim` section (docs-v3/job_model_v3.md §6.2)

Written by `mldxf sim --verify` on PASS only, into job.json +
manifest.json (byte-identical, canonical form, validated before
publishing — the `cmd_toolpaths` pattern). A failing verification
writes nothing. No timestamps: a re-run on an unchanged job
produces a byte-identical section.

```json
{
  "stock": {"x_min": 0, "y_min": 0, "x_mm": 150, "y_mm": 90,
            "top_mm": 9.5, "suggested_thickness_mm": 10},
  "pitch_mm": 0.05, "pitch_coarse": false, "coarse_reason": null,
  "checkpoints": null
}
```

`checkpoints` is null until V3.5 lands the delta log. The
validator shape-checks the section (`job.sim`): `stock` with
finite numbers, `pitch_mm` positive finite, `pitch_coarse` a
boolean with a matching `coarse_reason`, `checkpoints` null or an
object; a malformed section is `sim_invalid`.

## The verifier (ts/sim_verify.ts)

`mldxf sim --verify <job-dir>` — one JSON object on stdout, exit
0 pass / 1 `sim_mismatch` or named load error / 2 internal error.
Steps: load the DXF geometry (`loadJobGeometry`) → `prepareSim`
with the geometry bounds → `simulateAll` (timed) → build the
intended-floor map F (Float32Array, init stock top) → probes →
global no-gouge scan.

F construction: pockets = even-odd fill of non-skipped closed
loops (islands are holes automatically), with spans and row range
expanded by pitch/2 (the chord polygon sits a sagitta inside the
true loop; over-covering is one-sided safe); drill/bore = discs
(centre = centroid of sampled loop points, r = mean distance);
profile kerf = toolpath capsule rasterisation (feed/arc moves
only — rapids excluded, else the no-stray-cut check is erased
under rapid paths), outer profiles minus outline spans,
through-cuts as-is; tab zones via `F = max(F, thickness)`; skipped
loops never covered (uncut by design, must stay at stock height);
uncovered columns keep F = stock top.

Probes (cut deep enough, one-sided, fail when simmed height >
floor + tol): pocket interiors on a 0.5 mm grid, inset by tool
radius + 2·pitch from every wall, capped 2000/layer; drill/bore
centres + 4 points at r/2; bottom-pass toolpath points subsampled
~2 mm, expected = max(move Z, F at the probe point) — a probe on
a z=0 move inside a tab's disc reads the tab height, not the
floor, and F already encodes the tabs. Tab atoms get a two-sided
probe (the tab must EXIST at the tab height — a one-sided probe
passes when the tab is cut away to 0, which is exactly the failure
the old generator had).

Global no-gouge (one-sided the other way): every column simmed
≥ F − tol. Unreachable material (pocket corners) passes by design.

Tolerance: `pitch_mm + 0.05 mm`, stated in the output.

Boundary-position tolerance: a column within (sagitta + pitch/2)
= 0.0375 mm of a loop wall is excused from the no-gouge count as
chord-sampling uncertainty (both the sim's toolpath chords and the
verifier's fill chords sag inward by up to the sagitta, so the two
disagree by up to a sagitta at a boundary). Excused columns are
counted separately as `boundary_columns` and reported, never
silently dropped. This cannot hide a real defect: a real gouge
cuts columns millimetres from any wall. Control run: the verifier
on the pre-fix container toolpaths still FAILS (1,166 gouge + 2
failed tab probes; only 32 excused).

`SIM_VERIFY_DEBUG=1` prints per-layer covered counts, failing
probe locations, failing tab probes, tab-atom counts, gouge
samples, histograms, boundary-column counts, and (when the gouge
count is ≤ 50) every gouge column. Env-gated, kept for diagnosis.

## Spike — CPU speed vs the §5.4 target (≥50× real time)

Measured 2026-11-24 (`~/workspace/v34-spike/spike_sim.ts`). The
first measurement FAILED the target (container 25×, eight_parts
16×) — per-column sqrt + function calls over arc-chord revisits.
Fixed by (1) the level-flat fast path, (2) sagitta-bounded
adaptive arc sampling, (3) hoisting 1/dd to a multiply. Second
measurement CONFIRMED the target, not revised: container 126×,
real_container 117×, machined 430×, eight_parts 118×, Kookabus
8552×. Slowest observed run anywhere: container run 1, 5.1 s =
82× — still clears 50×. Real time = plan `total_seconds` (incl.
tool changes).

Latest verifier runs (2026-11-24, after all generator fixes):
container 2.0 s / 209×, real_container 1.5 s / 252×, machined
1.7 s / 206×, eight_parts 7.5 s / 78×, kookabus 3.4 s / 3812×.
All clear 50× (slowest eight_parts 78×).

VCarve baseline NOT measured — VCarve runs on Brandon's Windows
laptop (scope §11.4); no VCarve number claimed or faked. Still
needs Brandon's machine/timing.

## Ball-nose + V-bit proof

Synthetic 20×20×10 stock, pitch 0.1, one 6 mm pass at tip z=5:
flat EM6 groove flat at 5.000 across; ball-nose 6 mm round floor
5.000/5.154/5.720/7.063 (matches h(r) at the probed column
centres); V-bit 90° V groove 5.050/5.950/6.950/7.850 (matches
h(r)=r). Same moves, different stock — the profile plugs in.
These are unit tests in `ts/sim.test.ts` (22 tests: profiles,
pocket/drill/arc/tab sims, pitch selection, determinism, unknown
tool throws, and the raster-helper regressions below). Brandon has
not said which ball-nose / V-bit tools he owns (scope §11.5), so
no particular tool is claimed as his — the proof uses synthetic
tool definitions.

## View integration (V3.3 view, ts/view3d/entry.ts)

The Simulate button runs the same engine in the browser
(`prepareSim` with the geometry API's bounds, then
`simulateRange` per operation, awaiting between ops so the page
stays responsive) and shows the simmed stock as a mesh from
`dexelToMesh` (adaptive stride, ≤120k verts, top + skirts +
bottom quad; DoubleSide material to sidestep skirt winding). The
wireframe stock box hides while the stock is shown; the layer
planes stay toggleable, lifted +0.15 mm in Z while the stock is
shown to avoid z-fighting. Playback and the tool cylinder are
unchanged. The sim shows the FINAL stock — per-move sim state is
V3.5. `VIEW3D_VERSION` bumped "1" → "2"; `ts/view3d/build.ts`
staleness inputs gained `sim.ts`/`tools.ts`. The render probe
(`server/view3d-probe.html`) clicks Simulate and asserts the
stock mesh appears (pitch 0.05 on the container) and the layer
toggles still work with it shown.

## Generator defects the verifier caught (and fixed, ts/toolpaths.ts)

V3.4's acceptance ("simmed stock matches the intended geometry")
cannot be met while the toolpaths themselves destroy the intended
geometry, so these were fixed in V3.4 rather than weakening the
verifier to ignore them. Each fix is verified by the verifier
itself. The plan/manifest is unchanged by all of them (tab
positions/lengths/thickness, lead-in intent, and levels' z_mm
semantics are preserved); only the moves change.

1. **Tabs destroyed by the generator.** The tab span centreline
   simmed at h=0 along its entire length. Two causes: (a)
   `tabbedContourMoves` lifted/dropped exactly at the span
   boundaries, so the tool disc (R=3.175) at the lift/drop points
   (at z=0) reached 3.175 mm into the 5 mm span from each end —
   the two end discs overlap and cut the whole span to 0. Fix:
   `extendTabSpans` extends each span by one tool radius on both
   sides. (b) The bottom pass's helical descent went to zBot=0,
   cutting tab spans in the second half of the contour below the
   1.0 mm tab height. Fix: a `bottomZ` floor on the bottom pass
   with tabs (max(levelZ, zBot + thickness)).
2. **Lead-in ramp ploughing across the part.** The lead-in
   re-computed `farthestPoint` on the rotated contour, but the
   rotation's arc-split shifts the sampled centroid by ~0.35 mm,
   flipping the argmax to the opposite side — 65 mm ramps across
   the parts instead of 12.7 mm approaches. Fix: compute the
   approach direction from the contour's actual `start`.
3. **Rough levels cut below the tab height.** The stepdown levels
   [6.5, 3.5, 0.5, 0] cut the whole kerf (including the tab spans)
   to 0.5 before the bottom pass starts, so the tabs could never be
   1.0 mm. Fix: when tabs are in use, end the rough levels at the
   tab height (`roughBot = zBot + thickness`). Guarded by a
   `useTabs` flag (tabs only when `zBot + thickness < zTop`).
4. **Pocket diagonal-rapid retract.** An inter-region rapid rose
   while moving horizontally, dragging the tool across the island
   at z=8–9.5 and cutting a tapered groove. Fix: retract
   vertically to clearance at the current XY before the horizontal
   rapid to the next region's start.
5. **Single-ring pocket sloped floor** (eight_parts P07). The last
   level is a ramp only — it descends around the loop and never
   traverses at a flat floor, leaving a 0.28 mm sloped floor. Fix:
   on the bottom level, when there is exactly one ring, add a
   planar traversal after the ramp.
6. **Narrow-notch fill + ring clipping** (Kookabus P01 pocket).
   The loop has two 1.6 mm slots facing each other across a 12 mm
   bridge; `offsetLoop` at d=−8.5725 returns null (the slots' end
   walls cross), so the pocket interior was never cut. Fix:
   `fillNarrowSlots` fills narrow rectangular notches (three
   consecutive line segments, concave turns — a convex protrusion
   is a boss and is NOT filled) and `mergeCollinear` merges the
   resulting collinear wall segments. But filling over-cut the
   ledges (the slots ARE the D13.80 pocket, floor 8), so `ringRuns`
   splits each ring into the runs inside the original notched
   region. The erosion test was first `distToLoop >= toolR` (the
   disc overhang) — but that drops the bridge run (a 12×1.6 mm
   strip of D18.80 floor reachable only by a run whose disc sits
   0.9 mm from the slot walls, over-cutting only same-floor
   material). Fix: test the disc against the ledge rectangles
   (`fillNarrowSlots` returns them), not the whole region
   boundary. And the 2.48 mm bridge window yielded a single dense
   point at the 2 mm step, dropped as a 1-point run — fix: bisect
   the keep-test crossing so runs get exact entry/exit points.
7. **Bore central pillar** (Kookabus drills). A helical bore with
   EM0.50 in a 3.4 mm hole orbits at rh = 1.45 mm and its disc
   reaches inward only to 1.2 mm, leaving a central pillar of
   radius 1.2 mm running the full depth. Fix: after the wall pass,
   when `rh > toolR`, add helical clearing descents at radii
   tiling the central disc, each followed by a flat circular pass
   at zBot to flatten the helical ramp.
8. **Profile diagonal-rapid retract** (Kookabus P02 through-cut).
   Same defect class as (4) but in `buildProfile`: a diagonal
   rapid between through-cut contours gouged 3,844 columns. Fix:
   vertical retract to clearance at the current XY before the
   horizontal rapid to the approach/start point.
9. **Filled-branch run-entry feed** (Kookabus D18.80). The entry
   feed always went to prevZ, but non-first runs traverse at
   levelZ — so every non-first run's first segment descended
   diagonally prevZ→levelZ, leaving a ramp remnant (19 probes at
   h=3.17–3.58). Fix: the entry feed goes to `firstRun ? prevZ :
   levelZ`.

Latent, NOT fixed: the finish pass (allowance > 0) traverses at
zBot and would destroy tabs. No reference job has a profile finish
op, so it does not affect V3.4 acceptance; a V3.1 follow-up.

## Verifier / sim bugs fixed

- **Kerf outline subtraction removed.** The profile kerf was
  rasterised minus the outline spans; the offset contour sits
  exactly one tool radius outside the loop, so the capsule never
  goes inside the part except for the chord-sagitta strip — and the
  sim genuinely cuts that strip. Subtracting the outline removed
  exactly the strip the sim cuts and manufactured a false gouge
  around every circular profile.
- **`fillDisc` used the x-helper for the row range.** `fillDisc`
  called `colsInSpan` for the rows, so on a negative-origin grid
  the disc was filled ~400 rows off (machined: the D12 hole filled
  at y ∈ [−6,+6] instead of [−26,−14]). Fix: `indicesInSpan`
  with `colsInSpan` / `rowsInSpan` wrappers.
- **Floating-point boundary in `indicesInSpan`.** When a span edge
  lands exactly on a column centre, `(a−origin)/pitch` can come out
  an epsilon above the integer and the bare `ceil` drops the column
  the sim's distance test keeps. Fix: ±1e-9 slack in index units.
- **`toolInterval` tangent-dust branch invented a graze past the
  segment end.** When the discriminant is a tiny negative, the
  branch clamped t into [0,1] and returned [t,t] — for a column
  whose closest approach on the infinite line is past the endpoint,
  this treated the endpoint as grazed and cut the column to the
  endpoint's Z. Fix: return null when the unclamped t is outside
  [0,1].
- **`capsuleRowInterval` edge-row null.** For a horizontal segment
  the tube branch is skipped (dy=0), and the endpoint-disc
  threshold fails by floating-point noise, so the row exactly R
  from the segment returned null — a 672-column gouge along a
  through-cut's edge row. Fix: 1e-9 slack on the endpoint-disc
  threshold.
- **Tab-atom middle.** The middle was `atom[floor(len/2)]` — a line
  segment samples to 2 points, so that is the segment's END (the
  drop point, cut to the floor). Fix: the point at half the atom's
  arclength (interpolated).
- **Tab-atom length filter.** Only probe atoms with arclength ≥
  half the tab's `length_mm` — the helical descent and the tabbed
  traversal's boundary splits leave hairline level fragments at
  the tab height (0.02–0.06 mm) that are not tabs.
- **Bottom-pass probe expectation.** Changed to max(move Z, F at
  the probe point), because a probe on a z=0 move inside a tab's
  disc reads the tab height, not the floor, and F already encodes
  the tabs.

## Acceptance evidence (2026-11-24, after all fixes)

| Job | Probes failed | Gouge | Boundary | Sim time | Ratio vs plan |
|---|---|---|---|---|---|
| container (real) | 0 / 6618 | 0 | 14 | 2.0 s | 209× |
| real_container | 0 / 3509 | 0 | 8 | 1.5 s | 252× |
| machined | 0 / 3628 | 0 | 0 | 1.7 s | 206× |
| eight_parts | 0 / 3285 | 0 | 0 | 7.5 s | 78× |
| kookabus | 0 / 2874 | 0 | 36 | 3.4 s | 3812× |

`mldxf sim --verify` on all five writes the `sim` section into
job.json + manifest.json (byte-identical). The §5.4 target (≥50×
real time CPU) is confirmed on every reference job, slowest
eight_parts 78×.

## V3.4 fix round — ring-run entries must ramp, never plunge (2026-11-24)

Fix 9's entry feed (non-first runs straight down to levelZ) was a
straight plunge into solid at a fresh XY: the independent checker
flagged 136 on Kookabus (134 on the D18.80 pocket, 2 on D0.60),
all `vertical feed 26.8 -> levelZ`. The sim could not see it — a
plunge inside the pocket removes material that is supposed to be
removed anyway, so no gouge and the floor probes pass. It is a
tool-safety defect (a straight 3 mm plunge, above all with the
0.50 mm tool), which is exactly what the checker's no-straight-
plunge rule exists to catch. Root cause, verified by reproducing
the checker result first: fix 6 (narrow-notch fill + ringRuns)
created the ring runs — V3.1 never cut the D18.80 region at all,
so it had no entries to flag — and fix 9 gave every non-first run
a vertical entry feed to levelZ.

The fix (ts/toolpaths.ts, filled branch of `buildPocket` only;
the unfilled branch already ramps and passes): every run now
feeds vertically only to entryZ, ramps down the run to the level,
then traverses the run flat at the level. entryZ is the higher of
the floor the previous level cut (prevZ) and one stepdown above
this level, capped at the stock top — the feed is always through
open space (the previous level cleared the pocket to prevZ, and
entryZ >= prevZ), and it never ends below the nominal previous
level. The two agree except on a partial final step (D18.80:
levels end 3.8 -> 3.0; D0.60: 11.4 -> 11.3), where feeding to
prevZ ends below the nominal previous level and reads as a
plunge — two of the 136 flags were exactly that (D18.80 si=6
26.8 -> 3.8 at the first run's start; D0.60 si=2 26.8 -> 11.4 at
the strip run's start). The flat traversal after the ramp is
needed on every run, not just the first: the ramp alone leaves a
sloped floor, and only the first run's slope used to be flattened
by the inner rings' overlap. The single-ring bottom-level flatten
block in the filled branch is removed as redundant — every run
already ends flat. The checker is untouched: the gate stays
independent, and the generator now passes it as written.

Same round, second issue: D0.60 loops 4 and 9. Fix 6 changed
their fit — raw `offsetLoop(-0.25)` is null for both (V3.1
correctly skipped them as tool_too_large), but fillNarrowSlots
fills their comb notches (loop 4: two 0.32–0.39 mm inter-finger
gaps; loop 9: two 0.39–0.47 mm notches) and the filled loops
offset. Loop 9 is genuinely cuttable and stays cut: the kept run
is the ring's left edge down a 0.533 mm channel (left wall
292.319, tooth walls 292.852) that the 0.50 mm tool fits with
0.033 mm play, and a disc-over-cut measurement against the
original outline (checker Soup, 0.01 mm centre steps, 720-point
discs) finds max 0.0066 mm — sampling slack inside ringRuns'
0.01 keep-test tolerance, vs 0.0002 mm on the known-good loop 3
control, and 8x below the 0.04 mm/side the fit question
hypothesised. Loop 4 is NOT cuttable: its filled rings clip to
no run at all (every ring point fails the keep test), so it was
silently neither cut nor skipped. `buildPocket` now computes each
filled loop's runs once (Z-independent, reused at every level)
and records a filled loop with rings but no runs as skipped /
tool_too_large ("filled-loop rings clip to no cuttable run") —
the D0.60 skipped list is back to 9 loops (0,1,2,4,5,6,7,8,10),
loop 9 cut, loop 3 cut as in V3.1.

Results after the fix (toolpaths regenerated for all five jobs):
checker PASS 0 failures on all five (Kookabus was 136);
`mldxf sim --verify` PASS on all five, 0 failed probes, 0 gouge.
Move counts: Kookabus 66,765 -> 75,922 (+9,157, the flat
traversals); eight_parts 1,101 -> 1,154 (+53, it has a filled
pocket too); reference container, real_container and machined
unchanged (14/220, 10/158, 19/419) — no harness reference
updates needed. Kookabus sim 8.8 s / 1465x (was 3.4 s; still far
above the 50x target).

## V3.5 — seekable sim + GPU backend (2026-11-24)

- **Delta log + checkpoints** (docs-v3/sim_seek.md): `mldxf sim
  --verify` now builds the seek data in its single sim run and
  writes `sim/delta.bin` on PASS; `sim.checkpoints` carries the
  index (was `null`). Worst seek 359 ms across the five reference
  jobs (Kookabus log 330.8 MB, within the ≤ 500 MB budget);
  every seeked grid is bit-identical to a fresh sim. Headless
  seeking: `mldxf sim --seek --move N | --time T`. One defect
  found by test and fixed in the wave: a chunk spanning two
  checkpoint intervals pushed two checkpoints at the same move
  (the builder now checkpoints once per chunk end).
- **GPU backend** (docs-v3/sim_gpu.md): WebGPU compute shader,
  same dexel layout as the CPU backend, one workgroup per packed
  segment, `atomicMin` on `bitcast<u32>`. WebGPU IS available in
  this VM's headless Chromium (Dawn/SwiftShader behind
  `--enable-unsafe-webgpu`) — the earlier "cannot run here"
  finding was wrong; the probe driver's flags expose
  `navigator.gpu`. SwiftShader is software, so its 7–13× on the
  container is a software-renderer number, not a GPU result —
  the ≥500× target still needs a real GPU (Brandon's Windows
  laptop; the probe is ready to run there). CPU/GPU equality is
  proven under the band+cluster criterion (the G-code round-trip's
  criterion): 120,493 columns differ by < 0.01 mm (f32 ulp noise),
  3 isolated boundary-graze flips (a column centre ~2 nm inside
  the envelope in f64, ~3.5 nm outside it in f32 — no f32
  implementation can decide it the same way), banded result raw 2
  / after-band 0 / maxCluster 0 → PASS. The raw max-abs-diff
  verdict was the wrong bar and was replaced, not the backend.
- **GPU fallback in the view** (in-wave fix, 2026-11-24, found
  by the V3 walkthrough worker): `runSim()` took the GPU branch
  whenever `navigator.gpu` existed, so a browser with
  `navigator.gpu` present but `requestAdapter()` returning null
  threw out of `simulateGpu()` and the catch reported "Sim
  failed" — even though the CPU backend would work fine.
  `runSim()` now calls `runGpuSim()` / `runCpuSim()`; a
  GPU-path throw falls back to the CPU backend with the status
  "Simulated on CPU — WebGPU unavailable: \<reason\> · seek
  ready (...)" instead of "Sim failed". A CPU-path failure is
  still a genuine "Sim failed". What `isWebGpuAvailable()`
  gates is unchanged; the fallback is for the throw path only.
  Covered by 4 new view3d-probe checks (a no-adapter fake
  `navigator.gpu` is stubbed in, Simulate is re-run, backend /
  seek-ready / status / final stock are asserted).
  `VIEW3D_VERSION` "3" → "4".

## Known limits

- No new API endpoint for the sim (the view runs the engine
  in-browser; the headless verifier is the CLI). Deliberate
  non-goal.
- The finish pass destroys tabs (see above) — V3.1 follow-up.
- Per-move sim state is V3.5 (done — the view seeks the stock,
  the CLI seeks headlessly; see above).
- GPU backend correctness vs the CPU backend is proven under the
  band+cluster criterion (docs-v3/sim_gpu.md); the ≥500× GPU
  target is unmeasured (needs a real GPU — Brandon's Windows
  laptop).
- VCarve baseline unmeasured (needs Brandon's machine/timing).
