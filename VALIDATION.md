# Validation pack — run this when the real container STEP arrives

Goal: prove the pipeline on Brandon's real Top/Bottom model (Linear BRA-8),
not just on synthetic models. Do the steps in order; stop at the first
unexpected result and report it instead of pushing on.

## 0. What you need from Onshape first

- In the Part Studio, drag the rollback bar to **just before the
  `post process` folder** (after Extrude 7 / Move face 1, before Fillet 1).
  The rounded outside edge is Fillet 1 — cutting the profile from the
  filleted model would undersize the part.
- Export **both parts in one STEP**, units **mm** (File > Export, or
  right-click the Part Studio > Export). The file must contain 2 solids.
- If the STEP comes from a Version instead, the version must be taken
  at the same rollback point.

## 1. Run the multi-part classifier

```bash
cd ~/workspace/cnc-onshape-vcarve
.venv/bin/python multi_part.py <real-container>.step -o test/real_container_out \
    --parts parts.container.json --mode full
```

`parts.container.json` assumes: Bottom first in the STEP (lowest bbox
min), Top second, Top flipped (`flip_x: true`). If the STEP's solid
order differs, the parts are labelled by bbox-min order — check the
report's part list and adjust the labels in `parts.json` if needed.

## 2. Check the report against the drawing (report.md)

Expected, from the Onshape drawing:

- **Bottom:** 8 small holes around the outer flange ring, large central
  circular recess with a step ring. So: 8 drill centres on one PCD,
  1 central pocket (check the step ring — it may show as a
  pocket-in-pocket with a start depth).
- **Top:** outer ring + inner circle, **no holes**. So: 0 holes,
  1 central pocket, profile only.
- **Both:** side by side in one job, inside facing up, Zmin = 0 for
  each part (bottom-aligned). Real diameters / depths / heights replace
  the Ø100 synthetic approximation — record the real numbers here.
- **Flags must be 0** for a clean run. Any flag means: read it, decide
  whether it is a real feature (e.g. the step ring) or a classifier
  miss, and fix the classifier before cutting.

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
# expect: no crash; layers 11 / 8 / 7, holes 18 / 5 / 7, flags 39 / 72 / 12
# (updated 2026-11-08 from 11 / 7 / 6 and 70 / 631 / 22: the
# wire-orientation fix changed containment results, and bottom-face
# outer circles now exclude P02's two D6.5 bosses from the hole list —
# they are bosses, not holes. Kookabus is a robustness sample, not
# ground truth; the check is "no crash, flags identify the
# non-prismatic features".)

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
