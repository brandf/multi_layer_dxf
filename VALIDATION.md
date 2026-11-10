# Validation pack — run this when the real container STEP arrives

Goal: prove the pipeline on Brandon's real Top/Bottom model (Linear BRA-8),
not just on synthetic models. Do the steps in order; stop at the first
unexpected result and report it instead of pushing on.

## 0. What you need from Onshape first

- Export **both parts in one STEP**, units **mm** (File > Export, or
  right-click the Part Studio > Export). The file must contain 2 solids.
- Rollback is **optional** since BRA-11 (2026-11-08): a finished STEP
  with the `post process` fillets works — the classifier recovers the
  prismatic shape and files the fillets into the post-processing plan.
  The real container was validated this way (fillet/BSpline intact).

## 1. Run the multi-part classifier

```bash
cd ~/workspace/cnc-onshape-vcarve
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_out --auto
```

`--auto` orients each part (prismatic axis to Z, inside up) and lays
them out side by side, bottom-aligned. `parts.container.json` is the
manual equivalent (Bottom first, Top `flip_x: true`).

**Verified on the real STEP (2026-11-08, BRA-8): 2 parts, 8 layers,
6 flags.** The part is Ø46 mm, not the Ø100 of the synthetic
approximation. Bottom 9.5 mm tall, Top 8.0 mm tall.

## 2. Check the report against the drawing (report.md)

Verified against the real STEP (face-level probe + point-inside
checks), superseding the drawing-based expectations:

- **Both parts:** 8× Ø2.25 blind holes, 1.55 mm deep, on a Ø41 PCD,
  opening on the **mating/step faces** (not Ø5 through holes in the
  Bottom flange as the drawing first suggested). Bottom's holes open
  on the Z 8.00 flange face (bottoming Z 6.45); Top's open on its
  mating face (bottoming Z 9.55 scene). Both are drilled after the
  facing pocket — Bottom's are surface drills
  (`DRILL_D2.25_D1.55_START1.50`, depends on POCKET_D1.50).
- **Bottom:** Ø30 central pocket, 6.5 mm deep from the top face
  (floor Z 3.0), reached through the 1.50 mm facing pocket
  (POCKET_D1.50, floor Z 8.00). The mating **rib** (r15..18, rising
  1.5 mm above the step face) is an island in the facing pocket —
  see §2a.
- **Top:** Ø30 central pocket, 5.0 mm deep (floor Z 3.0 local),
  through the 1.50 mm facing pocket, which is the Ø36 counterbore
  the Bottom's rib plugs into. No island (the Top has the recess,
  the Bottom has the rib). 0.03 mm radial clearance: Bottom rib
  r=17.97 vs Top counterbore r=18.00 (the Move-face clearance).
- **Both outsides** are largely a BSpline rounded surface (only a
  2 mm-tall r=23 cylindrical band + Ø34 flat end disc are
  prismatic). **Decided 2026-11-08 (Brandon): round it over on the
  router table** — pick a roundover bit close to the modelled
  profile; it does not have to match exactly, it's wood, not high
  precision machining. The plan now defaults a sculpted surface at
  an outer edge to `router_table` and keeps CNC 3D as the listed
  alternative — and the alternative says why it costs more: this
  face is on the bottom of the stock, so CNC 3D would need a
  two-sided setup (flip + registration, BRA-13). Post-processing is
  a hell of a lot faster here, which is the point.
- **The 8 holes are magnet pockets (Brandon, 2026-11-08):** the
  magnets sit in the Ø2.25 × 1.55 mm blind holes so the two parts
  stick together — that's why they're so tiny. Drilled at exactly
  Ø2.25, so the magnets need to fit that bore (a hair under means
  glue; exactly 2.25 means press fit). Polarity matters at assembly:
  the 8 magnets in each part must face so they attract, not repel.
- **Flags (6, all understood):** 2× PROFILE OUTLINE DIFFERS (real —
  the BSpline roundover makes top/bottom outlines differ 11% / 45%),
  2× POST-PROCESS [cnc_3d] BSpline, 1× DRILL FROM SURFACE
  (informational), 1× POCKET ISLAND (Bottom rib, handled — see §2a).

### 2a. Island check (the rib)

P01's facing pocket layer `P01_P01__POCKET_D1.50` must contain
**three circles**: r=23.00 (Ø46 outer), r=17.97 (Ø36 island — the
rib's outer edge), r=15.00 (Ø30 child outline, re-opening the cut
inside the rib). Cut regions: annulus Ø36..Ø46 + disc inside Ø30;
the rib Ø30..Ø36 is preserved. Verify with ezdxf (see §3) — if the
layer has only one circle, the rib would be machined away. The Top's
facing pocket correctly has one circle (Ø36, the counterbore).

## 3. Check the DXF

```bash
.venv/bin/python -c "
import ezdxf
from collections import Counter
doc = ezdxf.readfile('test/real_container_out/real_container.dxf')
print(Counter(e.dxf.layer for e in doc.modelspace()))
"
```

- Layer count should match the report. Drill layers must have one
  circle per hole centre. Pocket layers must be closed loops.
- Open the DXF in VCarve (or any DXF viewer) and eyeball it against
  the Onshape drawing — the 8-hole PCD and the central recess must
  look right.

## 4. Regressions (must stay green after any fix)

```bash
.venv/bin/python step_to_vcarve.py test/test_part.step -o test/out --mode full
# expect: 8 layers, 6 holes, 3 pockets, 1 flag (through slot)

.venv/bin/python step_to_vcarve.py test/machined.step -o test/machined_out --mode full
# expect: 9 layers, 8 holes, 4 pockets, THROUGH_CUT = full 26x8 slot
# (-48..-22, 18..26), no "NOT in the DXF" flag

.venv/bin/python multi_part.py test/two_part.step -o test/multi_out --mode full
# expect: 2 parts, 5 layers, 1 flag — P02's pocket opens downward
# (floor Z 3.00, depth 3.00 from the bottom face), so post-BRA-21
# it is flagged POCKET NOT FROM TOP with no layer instead of being
# emitted as a top pocket. The old 6 layers / 0 flags expectation
# was pre-BRA-21, when that pocket was wrongly emitted; the new
# numbers are the corrected behaviour (verified 2026-11-09, BRA-18
# run). Suggested material still 200 x 80 x 10 mm; the spacing
# check verifies plan A profile tools (3/16 in both parts).

.venv/bin/python multi_part.py test/external/kookabus-03-enclosure.step \
    -o test/external/kookabus_out --mode check
# expect: no crash; post-BRA-21 layers 8 / 7 / 5, holes 18 / 5 / 7.
# Flags in a FULL-mode run are 39 / 122 / 29 per part (190 total
# + 1 TOOL PLAN flag = 191 combined). In --mode check the counts
# are 39 / 82 / 29: check mode writes no DXF, so P02's 40 SPLINE /
# NON-ARC EDGE discretisation notes (emitted when DXF entities are
# written) do not appear there. Same classification either way.
# Was 12 / 10 / 7 layers and 30 / 67 / 9 flags (106 total) before
# BRA-21: 25 downward-opening pockets are now flagged POCKET NOT
# FROM TOP instead of emitted as top pockets (9 wrong pocket layers
# removed, 29 -> 20), which also exposes 5 through-cuts and 21
# post-process items (16 decision_needed + 5 drill_press) that were
# hidden behind those pockets, plus 40 spline-discretisation notes
# on the new through-cut layers; the 4 POCKET ISLAND flags are gone
# (they were artifacts of reading those pockets upside-down).
# The old numbers were wrong, not a regression. Kookabus is a
# robustness sample, not ground truth; the check is "no crash,
# flags identify the non-prismatic features".)
# BRA-18 (2026-11-09): the standard endmill set now includes
# metric fine endmills (1.0 / 0.8 / 0.5 mm). In a full-mode run
# the merged tool-plan error narrows from 8 blocking layers to 1:
# only P02_P02__POCKET_D0.60 (0.91 mm wide — the fit rule needs a
# tool <= 0.41 mm, smallest standard endmill is now 0.50 mm).
# P01 and P03 get per-part plans (Plan A uses the 1.00 mm
# endmill); the merged job still has no plan. Whether to go below
# 0.5 mm is BRA-22, awaiting Brandon's decision — do not extend
# silently. Check-mode counts above are unchanged (classification
# only; no tool plan runs there).

.venv/bin/python step_to_vcarve.py test/beveled_container.step -o test/beveled_container_out --mode full
# expect: 3 layers, 8 holes, 1 pocket, PROFILE_THRU is CIRCLE r=50
# (true profile, not the filleted top), post-process plan =
# [R3 outer fillet -> router_table, pocket chamfer 45 deg -> hand_router,
#  R2 floor fillet -> cnc_3d], 4 flags

.venv/bin/python step_to_vcarve.py test/beveled_plate.step -o test/beveled_plate_out --mode full
# expect: 3 layers, 1 hole (D8 countersunk, still thru), 1 pocket,
# no spurious THROUGH_CUT, post-process =
# [chamfer -> router_table, countersink -> drill_press,
#  floor fillet R2 -> cnc_3d], 5 flags

.venv/bin/python multi_part.py test/rotated_container.step -o test/rotated_out --auto --mode full
# expect: same as parts.container.json — Bottom +Z, Top -Z (the STEP
# was rotated 90 deg about X, so the search finds +Y for both parts),
# 2 parts, 5 layers, 0 flags

.venv/bin/python step_to_vcarve.py test/beveled_sideways.step -o test/beveled_sideways_out --auto-orient --mode full
# expect: axis X detected, rotated back, 3 layers, 8 holes, 1 pocket,
# same post-process plan as the unrotated beveled container

.venv/bin/python step_to_vcarve.py test/donut.step -o test/donut_out --mode full
# expect: 2 layers, 0 holes, 0 pockets, 1 flag (standard through-cut
# verification flag) — THROUGH_CUT (Ø60 hole, tabs x4) + PROFILE_THRU
# (Ø100, tabs x4), 1 tool, 0 changes. The doughnut proves the tabs
# rule: the centre disc is a slug, not sawdust.

.venv/bin/python step_to_vcarve.py test/square.step -o test/square_out --mode full
# expect (BRA-14): 3 layers, 1 hole, 1 pocket, 0 flags; the square
# pocket's corner_radius_mm = 0.0 (sharp corners detected). Plan A is
# a single 1/4" endmill, est 1.4 min; Plan D is a finish variant
# (rough 1/4" + finish 3/16", corners to R2.38). manifest.txt must
# carry two POCKET_D5.00 lines only when a finish plan is chosen.
.venv/bin/python step_to_vcarve.py test/square.step -o test/square_gate_out \
    --config test/square_config.json
# expect (gate, max_corner_radius_mm = 1.0): chosen plan is a finish
# variant (rough 1/4" + finish 1/16", corners to R0.79); manifest.txt
# has two POCKET_D5.00 lines, `...|0.5|rough` then `...|0.0|finish`.
# Single-pass plans are dropped (final radius 3.18 > 1.0).

# Real container (BRA-8, verified 2026-11-08; BRA-15 re-verified 2026-11-09;
# BRA-17 re-verified 2026-11-09; BRA-21 re-verified 2026-11-09):
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_out --auto
# expect: 2 parts, 8 layers, 6 flags (see §2). P01 facing pocket
# P01_P01__POCKET_D1.50 has 3 DXF circles (r 23.00 / 17.97 / 15.00);
# P02 facing pocket has 1 (r 18.00 counterbore). Bottom drills are
# surface drills START1.50 depending on POCKET_D1.50. Plan A (BRA-15):
# Drill 2.25 + EM 1/2", 2 changes, est 5.6 min — cut order all pockets,
# both drills, profiles last. Orientation search (BRA-17, BRA-21):
# Bottom best +Z (score 6.9) over -Z (41.4); Top best -Z (4.7) over
# +Z (41.3) — the same flip the explicit parts.json gives; X/Y
# orientations score 145.0 (no_plan + flip + pocket penalties).
# Merged-job level (BRA-21): upright 9.6 vs flipped 46.1 — about
# 4.8x, the difficulty Brandon expects (flip 25 + 8 holes x 0.5 +
# 2 pockets x 5.0 + router_table 4, on top of 3.1 min of cutting).
# Without --auto or parts.json the Top's pocket is now flagged
# POCKET NOT FROM TOP and gets no layer (4 layers / 1 flag) instead
# of being cut into the Top's outside face. With
# --material 170x100x10 the X/Y orientations are pruned (height
# 46.00 > thickness 10.00); with --material 150x100x10 the run now
# fails at PACKING (named error, exit 1) instead: the 1/2 in profile
# tools need 46 + 30.4 + 46 = 122.4 mm of usable width and the sheet
# only has 110 — the old 10 mm gap would have let the two profile
# cuts overlap. 170x100x10 is the smallest fitting sheet for the
# default plan (or a smaller clamp margin / smaller profile tool).
# With --material 150x100x5 the run fails with a named error
# (smallest dimension 9.50 > 5.00), exit 1.

# Eight unrelated parts (generalisation, verified 2026-11-08;
# BRA-15 re-verified 2026-11-09; BRA-17 re-verified 2026-11-09;
# BRA-21 re-verified 2026-11-09 — winners unchanged):
.venv/bin/python multi_part.py test/eight_parts.step -o test/eight_parts_out --auto
# expect: 8 parts, 22 layers, 4 flags. All 8 classify exactly
# right, including the sideways block (modelled on its side,
# prismatic axis along X): the search orients it to +X (score 1.5
# over -X 31.1, +Z 37.3 — the wrong orientations score worse after
# BRA-21, correctly: their pockets open downward and are flagged)
# and reads it as POCKET_D4.00 + DRILL_D5.00_THRU + PROFILE_THRU,
# 0 flags. The old AUTO-ORIENT AMBIGUOUS flag and the spurious
# fillet flag from the as-is classification are both gone. The 4
# remaining flags are the informational ones: 2x THROUGH CUT, 1x
# DRILL FROM SURFACE, 1x COUNTERBORE THRU HOLE. Plan A: 2 tools,
# 1 change, est 9.0 min (was 1 change / 9.7 min under the heuristic
# — the correct orientation gives cleaner layers). The search runs
# the classifier up to 6 times per part, so this takes ~4 minutes.

# Material size, packing, clamp margin, pins (BRA-16, verified 2026-11-09;
# tool-dependent spacing verified 2026-11-09):
.venv/bin/python multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19
# expect: 8 parts, 22 layers, 4 flags (same classification as the
# no-material run); usable area 460 x 260 mm (500x300 minus 20 mm
# clamp margin); gaps are max(10, 12.7 + 12.7 + 5) = 30.4 mm (every
# part's profile tool is the 1/2 in endmill); 6 parts in row 1
# (P06 rotated 90 deg, 20 x 80, at sheet x 452.0), P07 + P08 in row 2
# at sheet y 130.4 (usable y 110.4); manifest carries material,
# clamp_margin_mm, usable_area_mm, layout (per-part x/y/w/d/rotate_z
# + profile_tool_dia_mm), spacing (rule, gap_mm, web_min_mm,
# pin_clearance_mm, check) and suggested_material: null.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 170x100x10
# expect: 2 parts, 8 layers, 6 flags; X/Y orientations pruned
# (height 46.00 > thickness 10.00); Bottom at sheet (20, 20), Top at
# (96.4, 20) — 30.4 mm gap.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_small_out --auto --material 150x100x5
# expect: exit 1, named error ("no orientation fits material
# 150.0 x 100.0 x 5.0 mm: smallest part dimension 9.50 mm; ..."),
# and NO test/real_container_small_out directory is created —
# nothing is written on a fit failure.
.venv/bin/python step_to_vcarve.py test/test_part.step -o test/out_mat --mode full --material 500x300x19
# expect: passes, 8 layers, 6 holes, 3 pockets, 1 flag (same as the
# no-material run); manifest carries material + suggested null.
.venv/bin/python step_to_vcarve.py test/test_part.step -o test/out_small --mode full --material 30x30x5
# expect: exit 1, "ERROR: part does not fit material 30.0 x 30.0 x
# 5.0 mm: height 12.00 mm > material thickness 5.00 mm", and the
# out dir stays empty (no DXF/manifest written).
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_pins_out --auto --parts test/bra16_twosided.json --material 300x200x10
# expect: 2 parts, 8 layers, 6 flags; manifest registration_pins =
# [(276.0, 24.0), (24.0, 176.0)] D6, keep-out radius 18.7 mm
# (= 12.7 mm profile tool + 3.0 mm pin radius + 3.0 mm clearance) —
# the widest-separated clear pair inside the usable area.
# Suggested sizes (no material given): two_part -> 200 x 80 x 10 mm;
# real container -> 170 x 90 x 10 mm; eight parts -> 690 x 100 x 15 mm
# (packed bounds + 20 mm clamp margin, rounded up to 10 mm).
# Tool-dependent spacing (BRA-16, built 2026-11-09): gaps are
# max(gap_mm, D_A + D_B + web_min_mm) from the per-part profile tools
# (planner fit rule, computed before packing); the chosen plan's real
# profile tools are re-checked against the packed gaps before
# anything is written. A 150x100x10 sheet no longer fits the real
# container with the default 1/2 in plan (needs 122.4 mm usable
# width, has 110) — see the 170x100x10 check above. The layout is
# computed for the per-part fit-rule maxima, which bound every
# plan's tools from above, so it is valid for the chosen plan and
# every fallback; a future step could pack from the chosen plan's
# actual tools instead (tighter when the plan uses a smaller
# endmill) — not built, see the BRA-16 issue comment 2026-11-09.

# Tool plan (BRA-12) — check manifest.json tool_plan, not just layers:
.venv/bin/python -c "import json; m=json.load(open('test/container_auto_out/manifest.json')); print([(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])"
# expect: [('A', 2, 1, 5.4), ('B', 2, 1, 5.7), ('C', 2, 1, 6.1)] — A is
# Drill 5.00 + End Mill 1/2 in; C is the all-bore fallback (no drill).
# manifest.txt must carry # tool lines (T1 drill, T2 endmill, distinct
# numbers) and # tabs lines for both PROFILE_THRU layers, and
# manifest_plan_B.txt / _C.txt must exist in the same folder.
# --plan B must write plan B as manifest.txt; --no-toolplan must write
# the old 4-field manifest.txt with no tool_plan in manifest.json.
```

## 5. VCarve gadget test (BRA-5, on Windows)

1. Copy `vcarve/Onshape25D.lua` to
   `Public Documents\Vectric\VCarve Pro\Gadgets\Onshape25D\`, restart VCarve.
2. Create a job with material size/thickness matching the manifest,
   Z-zero at top of material.
3. Gadgets > Onshape25D, pick `test/real_container_out/manifest.txt`.
   The gadget imports the DXF named on the manifest's `# dxf:` line.
4. Expected: one toolpath per manifest line, drill -> pocket -> profile
   order, depths from the manifest. **Preview before posting G-code.**
5. If a call fails, the gadget reports which layer — note the exact
   error message and the VCarve version; the two least-certain calls
   are `GetFileName()` and `JoinVectors()` (see the gadget header).

## 6. FeatureScript test (BRA-6, in Onshape)

1. Feature Studio > paste `featurescript/CAM_Snapshot.fs` > Add custom
   feature in the container Part Studio.
2. Insert it just before the `post process` folder, Body = Bottom,
   Cut from = Top, label = Bottom. Repeat for Top with Cut from =
   Bottom (its pocket opens downward in the scene).
3. Expected: one internal sketch per Z level, named CAM_PROFILE_THRU /
   CAM_POCKET_D<depth>; computed parameters list Z levels, Z cylinders,
   and non-prismatic faces (should be 0 at this rollback point —
   Fillet 1 is downstream, Move face 1 is prismatic).
4. If sketch creation errors, note the exact call in the message —
   the UNVERIFIED-marked calls in the file are the prime suspects —
   and fall back to the CAM_Prismatic duplicate-part design in the
   file header.
