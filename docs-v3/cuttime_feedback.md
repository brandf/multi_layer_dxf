# Cut-time feedback (V3.14): feeding the simulator's motion time back into the plan estimate

Status: implemented 2026-11-25 (V3.14). The plan estimate now models
the moves the toolpath generator actually emits; the toolpath motion
time is recorded on every v3 job and shown next to the estimate.

## 1. The gap (acceptance §6.1, recorded 2026-11-25)

The plan's per-layer cutting estimate understated generated motion on
every reference job: machined +1.9%, real container +14.8%, fresh
container +24.0%, Kookabus +33.6%, eight_parts +55.7%. The motion time
comes from the tool's own duration model (`ts/view3d/model.ts`
`flattenToolpaths`: feed/plunge per move, arcs by true length, rapids
at 50 mm/s) — the same model the 3D view's playback timeline uses.

The first hypothesis — a per-rapid or per-ring traversal allowance —
does not fit. Fitted corrections (least squares over the 63 layers of
the five jobs) all fail somewhere: a single rapid coefficient (2.46
s/rapid) fixes Kookabus to -3.8% but blows the small jobs up to
+46–54%; per-operation coefficients do worse (machined +173% under a
per-operation rapid fit). The residual is not noise around one
mechanism. It is four different mechanisms, one per operation, each
with its own size — and each is deterministic from the generator's
own code, not a coefficient to fit. That is why this wave models the
generator instead of fitting the gap.

## 2. Where the residual lives (per layer, five jobs)

Splitting each layer's motion into rapid / feed / arc seconds shows
the structure (cuttime `--per-layer`; totals over the five jobs:
residual 4,585 s, of which rapids are 914 s — 20%):

| operation | residual | mechanism |
|---|---|---|
| drill | +57 s (+126–184% per layer) | every peck re-plunges from clearance at plunge rate |
| bore | +1,916 s (machined −44%, Kookabus +676%) | helical descents over the FULL depth, plus pillar-clearing helices |
| pocket | +683 s (−18% to +175% per layer) | MRR model; see §5 — no simple correction holds |
| profile | +1,929 s (+33–134% per layer) | per-level plunges from clearance, once per contour |

### 2.1 Drill: the re-plunge

The generator pecks by tool diameter from the stock top, retracting
to clearance between pecks (`buildDrill`). Every peck's feed therefore
covers the air gap plus the depth reached by that peck — for the
container's magnet holes (1.55 mm deep, starting 1.50 mm down, 2.25 mm
drill) that is 2 pecks × ~1.9 s of plunge-rate feed per hole, where the
old estimate charged one 0.39 s plunge per hole. The old estimate also
pecked by stepdown (2 pecks) while the generator pecks by diameter
(also 2 here, by luck), and used the cut depth where the generator
uses start + cut depth. Verified exactly: the model reproduces the
container drill layer's 30.6 s of feed to the tenth.

### 2.2 Bore: the helix stack

The generator never plunges a bore: it orbits while descending, pitch
= stepdown per revolution, over the FULL depth (start + cut — a hole
opening on a pocket floor helices down through the pocket void, at
feed rate), then one full circle at the bottom; when the orbit radius
exceeds the tool radius the central pillar is cleared by further
full-depth helices at tiled radii. The old estimate charged one hole
circumference per pass plus a full-depth plunge that never happens —
so it overcounted shallow bores with a slow plunge (machined: motion
37.6 s vs estimate 66.8 s) and undercounted deep ones by 5–7×
(Kookabus D2.90: 6 holes × 4 helices × 79 revolutions = 1,249.9 s vs
an estimate of 32.1 s). The new model mirrors the generator helix for
helix (same rev count, same radii, same air feed-down per helix) and
reproduces every bore layer to within 0.5–11 s (worst case: the first
rapid-in of a single-hole layer on a wide multi-part sheet, which the
planner cannot see — see §6).

### 2.3 Profile: the per-level plunge

The generator retracts to clearance between contours and levels, then
feeds down to the previous level before traversing the contour — one
plunge per level per contour, at plunge rate, over the clearance gap
plus the depth already cut. On the Kookabus through-cut (EM0.50,
plunge 2.67 mm/s, clearance 14.9 mm above the part) that is 176
plunges averaging 7.4 s each: 1,378 s of the layer's 1,703.6 s of feed,
where the old estimate charged 1.0 s per pass. The contour itself the
old estimate had right (perimeter × passes) — except that an outer
profile's contour is the loop offset outward by the tool radius, which
grows its perimeter by exactly 2π×toolR (Steiner), and through-cuts
are centred, so no growth there. The level-0 lead-in ramp on outer
profiles is extra feed (ramp length); through-cuts ramp along the slot
itself, so no extra length there. Tabs add one more full contour (the
tabbed bottom traversal) plus the lifts over the tab spans.

### 2.4 Pocket: no simple correction holds

The MRR model (area × depth / (feed × stepover × stepdown)) is right
to ~6% on broad unfilled pockets, but pockets have three regimes the
planner cannot see from the est dict, and a single correction cannot
cover them:

- **Filled pockets (parent with a notched outline).** When a pocket's
  outline carries narrow slots (a child pocket's opening), the
  generator fills the notches, splits every ring into runs around the
  ledges, and traverses each run TWICE per level (ramp + flat) with a
  clearance entry per run. Kookabus P01 D18.80: 44 runs × 7 levels =
  308 clearance entries; motion 1,984.2 s vs estimate 721.5 s
  (+175%). The planner has no filled flag and no run count.
- **Narrow slots.** A 1.6 mm slot's rings are ~2 perimeters, not
  area/stepover. Kookabus P01 D13.80 (two 1.6 mm slots, 13.8 mm deep):
  motion 5,760.7 s vs estimate 6,712.0 s (−14%). The est carries
  min_width_mm but the ring count needs the loop geometry.
- **Island annuli.** A pocket with a rib island clears the annulus,
  not the island's area — but the ring length around an island is
  longer than (area − island)/stepover suggests, so subtracting the
  island area overshoots (container P01 D1.50: would move the
  residual from −16 s to −32 s). Tried and rejected on the numbers.

A blanket pocket factor would wreck the broad pockets that are
already right. The pocket estimate is therefore UNCHANGED in V3.14;
the remainder below is almost entirely pockets, and the follow-up is
classifier-side pocket-geometry flags (a `filled` flag + run count, a
ring count for narrow pockets) — not a planner fit. See §7.

## 3. The model (what changed)

### 3.1 Motion time, headless

- `ts/view3d/model.ts`: `summarizeMotion(flat)` now also returns
  per-layer rapid/feed/arc seconds alongside the counts, so the
  calibration can see WHERE the time goes, not just how much.
- `ts/cuttime.ts` (new): `bun ts/cuttime.ts <job-dir> [--json]
  [--per-layer]` prints one JSON object (`motion_time_s`,
  `motion_by_tool`, `motion_by_operation`, move/operation counts;
  per-layer entries with `--per-layer`). It never writes the job.
  The 3D view, the generator's recorded section, and this tool all
  use the one model in `model.ts`.
- `ts/toolpaths.ts`: the generator attaches `motion_time_s` (0.1 s),
  `motion_by_tool`, and `motion_by_operation` to the section it
  generates.
- `ts/validate_job.ts`: a `toolpaths.motion` check recomputes the
  motion from the moves (tolerance 0.15 s, covering the 0.1 s
  rounding); a job without the fields passes with a "pre-V3.14 job"
  note.
- `mldxf.py`: the toolpaths step records motion in `job.json`;
  `mldxf job` and `report.md` show the plan estimate AND the
  toolpath motion time side by side, labelled honestly (estimate vs
  measured-from-toolpaths), with the motion-by-tool breakdown; the
  report carries a `## Toolpaths (V3.14)` section. Rerun compares
  toolpaths by identity on the moves only (motion is derived data)
  and refreshes the report section.

### 3.2 The planner's estimators (`toolplan.py`)

`_est_drill`, `_est_bore`, `_est_profile`, and `_est_finish` now
mirror `ts/toolpaths.ts` move for move. Shared inputs, all already
in the planner's hands or added by this wave:

- **Full depth** = `start_depth + cut_depth` (the generator works
  from the stock top, not the cut top) for drill pecks and bore
  helices.
- **Clearance gap** = (max part `z_top` + 5 mm) − this part's `z_top`
  — the generator's clearance rule, replicated. `plan_tools` takes
  an optional `part_z_top={part: z_top}` (wired through
  `multi_part.py` for merged jobs); single-part callers omit it and
  the gap is exactly 5 mm.
- **Loop count** = `est["loop_count"]` (new classifier field in
  `step_to_vcarve.py`: each merged profile feature is one closed
  loop — one through-cut slot, one profile wire — so the merge count
  is the contour count; 1 when absent). Profiles need it for the
  per-level plunges/rapids; pockets do not use it.
- **Centre order**: drill/bore inter-hole traverses are computed
  from the layer's `centres`, sorted by (x, y) exactly as the
  generator sorts them.
- **Approach traverses** (horizontal rapids between contour starts)
  are the one estimated quantity: a nominal 10 mm each. The planner
  cannot see where loops start. Validated: the residual it leaves is
  ≤0.2 s per rapid on the references.

Per operation, the new formulas (all in `toolplan.py`, with the
generator behaviour cited in comments):

- **Drill**: pecks = ceil(full depth / tool dia); per peck, feed =
  (gap + depth reached)/plunge and retract = (gap + depth
  reached)/50; plus inter-hole traverses/50.
- **Bore**: revs = ceil(full depth / stepdown); helices at radii
  rh, then toolR + k·0.8·dia while rh > toolR; each helix =
  (revs+1) full circles at feed + one air feed-down (gap/plunge);
  plus inter-helix traverses, the final retract, and inter-hole
  traverses. Falls back to the old formula only when there is no
  room for a helix (unreachable: the fitting gate forbids it).
- **Profile**: contour traversals = (perimeter + 2π·toolR if outer)
  × levels / feed; entry plunges = (gap − 0.5)/plunge on level 0
  plus (gap + li·stepdown)/plunge per later level, × contours;
  rapids = one vertical retract per contour per level + one nominal
  approach per contour per level; level-0 lead-in ramp on outer
  profiles only; tabbed bottom traversal = one more contour + lifts
  (2 × tab count × thickness / plunge) + a reposition per contour
  when there is more than one loop. Levels stop at the tab height
  when the layer takes tabs (same guard as the generator:
  thickness < cut depth).
- **Finish**: two contour traversals (helical descent + planar
  revolution) at feed, one air feed-down and one approach rapid per
  loop; the contour perimeter is offset by ±2π·toolR by operation
  (outward for outer profiles, inward for pocket walls, none for
  through-cuts). No reference job exercises a finish pass; the
  formula mirrors the generator and is unvalidated on motion data.
- **Pocket**: unchanged (MRR model). See §2.4.

## 4. Calibration: the fitted models that were tried and rejected

Least squares over the 63 per-layer (estimate, motion) pairs of the
five jobs, run by `hidden_files/v314_calibrate.py`:

| model | per-layer RMS | verdict |
|---|---|---|
| raw (no correction) | 313.6 s | — |
| M1: est + a·rapid (a = 2.46 s/rapid) | 261.0 s | fixes Kookabus (−3.8%) but wrecks the small jobs (+46–54%) |
| M2: + a·rapid + b·passes | 246.2 s | machined −46.8%, eight_parts −68.4% |
| M3: + intercept | 241.7 s | small jobs +145–222% |
| M4: per-operation a_op·rapid | 213.7 s | machined +172.9% (bore coefficient 22.2 s/rapid is nonsense) |
| M5: per-operation multiplicative k_op | 252.5 s | machined +133.2% |

None closes the gap: every fitted model is dominated by Kookabus's
giant layers and breaks the small jobs, because the residual is
mechanism, not coefficient. The mechanistic model of §3.2 is the
correction instead — no fitted coefficient anywhere in it except the
documented 10 mm nominal approach traverse.

## 5. Results (regenerated jobs — the definitive check)

All five jobs regenerated from their STEP inputs with the new
classifier + planner (`~/workspace/v314-jobs/`; the frozen references
in `v31-jobs/` / `v310-home/` are untouched). Layers are identical
except `est["loop_count"]` on profiles (Kookabus P02 THROUGH_CUT
correctly counts 4); motion is reproduced exactly on every job whose
chosen plan did not change. Chosen-plan cutting estimate vs motion:

| Job | old est | motion | old resid | new est | new resid | ranking |
|---|---|---|---|---|---|---|
| fresh container | 178.8 s | 222.3 s | +24.3% | 224.1 s | −0.8% | unchanged A>B>C |
| real container | 146.0 s | 167.1 s | +14.5% | 182.9 s | −9.5% | unchanged A>B>C |
| machined | 224.5 s | 228.8 s | +1.9% | 218.6 s | +4.5% | unchanged (B/C by 0.2 s) |
| eight_parts | 464.0 s | 722.4 s | +55.7% | 620.8 s | +14.1% | unchanged A>B>C>D |
| Kookabus (drill plan, now A) | 12,409.3 s (was C) | 14,989.1 s | — | 14,324.0 s | +4.4% | **FLIPPED, confirmed by motion** |

Note (Nov 26, 2026 — layout change): the two container motions
moved with the layout, not the estimator — fresh 221.7 → 222.3 s,
real 167.6 → 167.1 s — because the parts moved +1.35 mm and the
rapid traverses changed length. The estimates are untouched
(224.1 / 182.9 s), the rankings are unchanged, and §1 keeps the
Nov 25 values as recorded. The frozen references in `v31-jobs/` /
`v310-home/` and acceptance §6.1 keep the old motions as history.

Per-layer RMS over the 63 layers: 313.6 s → 200.6 s. By operation
(new model): drill 0.3 s, bore 4.8 s, profile 3.2 s, pocket 347.3 s.
Every drill/bore/profile layer is within 13 s of its motion time;
the remaining overall RMS is two pocket outliers (D18.80 +1,262.7 s,
D13.80 −951.3 s — §2.4). The machined job's old +1.9% was a
cancellation (bore −29.2 s + profile +28.0 s); its new +4.5% is the
honest remainder (profile +1.8 s, pockets +4.8 s, bores −1.1 s).

### 5.1 The Kookabus ranking flip (confirmed by motion, not just estimate)

The old estimate ranked the bore plan first (12,904.1 s) over the
drill plan (13,369.3 s) because it charged bores one circumference
per pass over the cut depth only. The new estimate ranks the drill
plan first (15,284.0 s) over the bore plan (16,476.3 s) — same three
tool sets, same per-layer tool assignments, only the order (and
therefore the letters) changed. Both plans' motions were then
measured directly: drill plan 14,989.1 s, bore plan 16,922.8 s
(reproduced exactly from the frozen job: 75,922 moves, 335
operations). The drill plan is genuinely 1,933.7 s (32.2 min) faster
— drilling the D2.90 holes takes ~44 s each against ~200 s each to
bore them through 19.6 mm of air with a 0.50 mm endmill. The estimate
now agrees with motion on the order; the old one had it backwards.
The machined B/C order is unchanged but the margin is 0.2 s — a tie
in practice, and the two plans differ only in which endmill bores
the holes.

## 6. What the model still does not know (known limits)

- **First rapid-in per layer (~0–9 s).** The planner cannot see
  where the previous operation ended, so the first approach rapid
  of each layer is unmodelled. Largest on wide multi-part sheets
  (eight_parts P01 profile +9.7 s; single-hole bores up to +8.7 s).
- **Approach traverses: nominal 10 mm each.** The planner cannot
  see where loops start. Validated: it leaves ≤0.2 s per rapid on
  the references.
- **Pockets.** Unchanged (MRR); the remainder is pockets (§2.4).
  Follow-up is classifier-side pocket-geometry flags (a `filled`
  flag + run count, a ring count for narrow pockets), not a planner
  fit.
- **Finish passes.** Formula corrected (§3.2) but no reference job
  exercises one; unvalidated on motion data.
- **Validator rounding bound.** The Kookabus regen caught a real
  bug: the `toolpaths.motion` check allowed 0.15 s on the
  breakdowns' SUM, but independently rounded parts drift by up to
  0.05 s each (7 tools, 0.2 s). The bound is now 0.05 × part count
  + 0.01; per-part checks stay at 0.15 s.

## 7. What still needs the live cut to settle

Motion time is the toolpath clock, not a machine measurement. The
live cut (Foreman dry run, then a real cut) settles: whether the
machine's rapids actually run at 50 mm/s, whether plunge/feed rates
hold under load, and acceleration — the model assumes instant
velocity changes, so short moves never reach programmed feed on a
real machine. The estimate-vs-motion residual (now 1–14% per job,
pockets aside) is the right size to be tested against machine time;
before V3.14 the estimate was off by up to 56% and could not even
frame the question.

One live-cut-adjacent finding is recorded here, not fixed here: the
generator helices bores down through cleared air at feed rate
(Kookabus D2.90: 1,190 s of arcs, most of it through the 18.8 mm
pocket void). A generator fix — rapid down through cleared air to
near the floor, helix only the cut depth — would cut bore time
several-fold, and the estimator would follow it automatically (it
mirrors the generator). That is a generator change with its own
verification, not part of this wave.

Unchanged from V3.10 and still Brandon-blocked: the live cut /
Foreman dry run itself, the walkthrough re-render, the two Onefinity
Masso `.pp` files, the GPU ≥500× sim measurement, and the rename
decision (V3.11).

## 8. Settling the number (2026-11-25, design-loop round-6 unblocker)

**464.1 s / 7.7 min is the intended calibrated Plan A total for the
fresh container** — cutting 224.1 s (calibrated estimate) + 2 manual
changes × 120 s. The old 418.8 s / 7.0 min was the pre-V3.14 MRR
estimate (cutting 178.8 s); it is a historical record now, not the
current number. Stale assertions of it were updated to 464.1 s /
7.7 min in `verify_v24.py`, `server/verify_v28.py` (V3.14 wave),
`verify_v23_joint.py`, the walkthrough caption in
`server/run-screenshots.ts`, and the v3.0.0 release-notes draft. The
frozen acceptance job's own recorded total stays 7.0 min, and
`docs-v3/acceptance.md` §6.1 is untouched — both are the record of
the gap as found, not the current estimate.

**The stored-vs-recomputed motion mismatch the design loop reported
(`toolpaths.motion: motion_time_s is 221.7, recomputed 212.8`) is
real, reproducible on the final tree, and the recomputation is
CORRECT — the earlier note in this section calling it a transient
mid-edit artifact was wrong and is corrected here.** The mismatch
comes from the V3.8 moved-toolpaths check, not from any stored
reference job: the check shifts one feed endpoint +5 mm in x, and
the following helical arc's start moves with it while its end
stays, so the arc's sweep collapses 2π → 0. Flat-move debug on the
reference container: the arc goes 134.54 mm / 8.47 s → 1.5 mm /
0.09 s, the shifted feed 0.95 s → 0.45 s, total −8.9 s — exactly
221.7 → 212.8 s. The stored 221.7 s is stale for the edited
toolpaths; 212.8 s is what the edited toolpaths genuinely take.
No stored job needs regenerating and no recomputation was wrong.

The actual bug was precedence in `mldxf gcode --verify`: V3.14's
motion check (correct) fires before the V3.8 round-trip check, so
a moved job failed `toolpaths_invalid` (rc=2) and the stamp never
flipped — breaking V3.8's contract (refuse with
`gcode_unverified`, flip the stamp to verified:false). The TS
driver itself was never wrong: it returns `gcode_unverified`
directly; the Python stamp-sync publish re-validated the job and
died on the stale motion first.

**Fix (same wave, `mldxf.py` only):** `_refresh_toolpaths_motion()`
recomputes the derived motion fields via `bun ts/cuttime.ts
--json` (read-only) and stores them on the in-memory job before
the validating publish, at both gcode publish sites (the
`--verify` stamp sync and a fresh post). On the moved job:
rc=1 `gcode_unverified`, masso-mm stamp flips to verified:false,
motion refreshes 221.7 → 212.8 s, job validates 19/19. When the
moves themselves are broken, cuttime fails and the stale fields
are left alone, so validation still fails honestly. The full
battery was re-run on the quiet final tree after the fix to close
this out.
