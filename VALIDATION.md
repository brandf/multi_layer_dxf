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
doc = ezdxf.readfile('test/real_container_out/container.dxf')
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
# expect: 2 parts, 6 layers, 0 flags

.venv/bin/python multi_part.py test/external/kookabus-03-enclosure.step \
    -o test/external/kookabus_out --mode check
# expect: no crash; post-BRA-14 layers 12 / 10 / 7, holes 18 / 5 / 7,
# flags 30 / 67 / 9 (107 total, incl. 4 POCKET ISLAND flags — bosses
# rising from pocket floors, plausible on an enclosure). Pre-BRA-14
# numbers were 11 / 8 / 7 and 39 / 72 / 12: BRA-14's surface drills
# added layers and its hole-floor fix removed bogus pockets and their
# flags. Kookabus is a robustness sample, not ground truth; the check
# is "no crash, flags identify the non-prismatic features".)

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
# expect: same as parts.container.json — Bottom no flip, Top flip,
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

# Real container (BRA-8, verified 2026-11-08; BRA-15 re-verified 2026-11-09):
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_out --auto
# expect: 2 parts, 8 layers, 6 flags (see §2). P01 facing pocket
# P01_P01__POCKET_D1.50 has 3 DXF circles (r 23.00 / 17.97 / 15.00);
# P02 facing pocket has 1 (r 18.00 counterbore). Bottom drills are
# surface drills START1.50 depending on POCKET_D1.50. Plan A (BRA-15):
# Drill 2.25 + EM 1/2", 2 changes, est 5.6 min — cut order all pockets,
# both drills, profiles last.

# Eight unrelated parts (generalisation, verified 2026-11-08;
# BRA-15 re-verified 2026-11-09):
.venv/bin/python multi_part.py test/eight_parts.step -o test/eight_parts_out --auto
# expect: 8 parts, 22 layers, 6 flags. 7 of 8 classify exactly
# right (L-bracket, disc, pocketed plate, slot bar, counterbore
# block, donut, stepped plate with surface drill). The sideways
# block (modelled on its side, prismatic axis along X) is flagged
# AUTO-ORIENT AMBIGUOUS (X share 49% vs the 50% dominant
# threshold) and classified as-is — flagged, never silently
# re-oriented. Plan A (BRA-15): 2 tools, 1 change, est 9.7 min
# (was 3 changes / 13.7 min before the tool-grouped orderer).

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
