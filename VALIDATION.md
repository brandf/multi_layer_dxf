# Validation pack — run this when the real container STEP arrives

Goal: prove the pipeline on Brandon's real Top/Bottom model (Linear BRA-8),
not just on synthetic models. Do the steps in order; stop at the first
unexpected result and report it instead of pushing on.

## 0. What you need from your CAD export first

- Export **both parts in one STEP**, units **mm**. In Onshape: File >
  Export, or right-click the Part Studio > Export. The file must contain 2 solids.
- Rollback is **optional** since BRA-11 (2026-11-08): a finished STEP
  with the `post process` fillets works — the classifier recovers the
  prismatic shape and files the fillets into the post-processing plan.
  The real container was validated this way (fillet/BSpline intact).

## 1. Run the multi-part classifier

```bash
cd ~/workspace/multi_layer_dxf
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
  the CAD drawing — the 8-hole PCD and the central recess must
  look right.

## 4. Regressions (must stay green after any fix)

**Run through the CLI (V2.1).** The commands below are written in
their v1 direct-script form because that is what the expectations were
verified against — but the suite is run through `mldxf plan`, which is
a thin shell over the same scripts and must not move a single number
below. The mapping is mechanical: `step_to_vcarve.py X -o Y <flags>`
becomes `mldxf plan X -o Y <flags>` (the CLI inspects the STEP's solid
count, so a single-solid input takes the `step_to_vcarve.py` path and
a multi-solid input the `multi_part.py` path — `--auto` maps to
`--auto-orient` on the single-solid path); `multi_part.py X -o Y
<flags>` becomes `mldxf plan X -o Y <flags>`; the kookabus
`--mode check` run becomes `mldxf check X`. The one exception is the
`--no-toolplan` variant in the tool-plan step, which has no CLI flag
(the carried-over list in V2_SCOPE.md §2.2 does not include it) and
stays a direct-script check. The CLI run is verified two ways: the
three key inputs (real container, Kookabus, eight parts) are diffed
against fresh direct-v1 runs — manifest.json, manifest.txt and
report.md byte-for-byte except the two specified V2 additions (the
V2.4 `owned` flag on every tool in `tool_plan`, and the advisory
"Tool inventory" section in report.md — V2_SCOPE.md §4.4; ranking
and times unchanged), and the DXF by canonical entity+layer
signature (`mldxf_dxf.py`), never by bytes (DXF bytes are not
reproducible even v1-vs-v1 — ezdxf writes $TDCREATE/$TDUPDATE
timestamps, random $FINGERPRINTGUID/$VERSIONGUID, a timestamped
dictionary variable, and CLASS order swaps between processes;
wave 1, 2026-11-23) — and every expectation below is checked
against the CLI-produced job dirs.

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
# run). Suggested material 180 x 80 x 10 mm (was 200 x 80 x 10 —
# BRA-20 packs from plan A's 3/16 in profile tools: gap 14.5 mm,
# P02 at sheet x 94.5, not the 30.4 mm fit-rule-maximum gap);
# (2026-11-21: the old 74.5 was usable-area coords — the DXF was
# written at sheet (0,0) with no clamp margin, so "sheet x" was
# a lie; the margin fix makes the layout true sheet coords.)
# the spacing check verifies plan A profile tools (3/16 in both
# parts), and manifest spacing.profile_tools_from is "plan A".

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
# the merged tool-plan error narrowed from 8 blocking layers to 1:
# only P02_P02__POCKET_D0.60 (0.91 mm wide — the flat fit rule
# needed a tool <= 0.41 mm, smallest standard endmill is 0.50 mm).
# P01 and P03 get per-part plans (Plan A uses the 1.00 mm
# endmill).
# BRA-22 (2026-11-09, Brandon's decision: option 2): the fit-rule
# clearance is now proportional to the tool — min(0.5, 0.5 x tool
# dia) — so the 0.50 mm endmill fits the 0.913 mm groove and the
# merged job HAS a plan: Plan A EM 3/8 in + EM 0.50 mm, 2 changes,
# 215.1 min (B 2/2/221.0, C 7/8/222.8); layers 20, flags 190 (was
# 191 — only the TOOL PLAN flag is gone). (2026-11-21, tool cap:
# P03's 64 mm side caps the merged plan at 3/8 in; was EM 1/2 in
# / 212.1 min before the cap.)
# 191 — only the TOOL PLAN flag is gone); spacing packs from plan
# A, not the fit-rule maxima. Check-mode counts above are unchanged
# (classification only; no tool plan runs there).
#
# BRA-5 live test (2026-11-21, VCarve Pro V12.5, Brandon running the
# gadget): three real defects found by running the gadget, all fixed
# and re-verified by the full section-4 suite:
# (1) the clamp-margin offset applied only when --material was given
# — the DXF was written at sheet (0,0) with no clamp room and the
# profile cut at the sheet edge; the offset now always applies, so
# layout coords are true sheet coords (two_part P02 74.525 -> 94.525).
# (2) tool-size cap: the planner chose 1/2 in on a 46 mm part on
# cutting time alone — new rule, no endmill bigger than 1/6 of its
# own part's smallest footprint side, floored at 1/4 in (the floor
# keeps an 80x20 mm part at 1/4 in — without it eight_parts went
# 9.0 -> 13.5 min). Container Plan A is now 1/4 in, 5.9 min;
# Kookabus merged Plan A 3/8 in, 215.1 min. (3) the gadget called
# SelectVectorsOnLayer, which is not a VCarve global — it is a
# helper each gadget defines itself; the helper is now defined
# locally in the gadget (adapted from Vectric's
# Profile_Vectors_On_Layer sample), and the dead JoinVectors() call
# was removed (it does not exist in the V12 API either; DXF import
# already yields closed contours). Nov 22 follow-ups, gadget v0.5:
# (4) tabs: ProfileParameterData.UseTabs only USES tabs that already
# exist on the vectors — setting it alone creates none, and both
# profiles calculated with "No tabs defined on selected vectors" and
# no tabs. Tabs are now placed as real ToolpathTab objects via
# CadContour:InsertToolpathAtTabAtPoint (evenly spaced around each
# closed contour) before the profile toolpath is created. (5) tool
# flow: the up-front tool summary plus back-to-back dialogs made it
# easy to lose track of which dialog was for which tool — the gadget
# now names each tool first, then opens its dialog, and remembers
# each pick in the registry (ToolDBId defaults) so the next run
# reuses it without asking. The diameter-mismatch warning also read
# ToolDia raw: a correctly picked 1/4 in library tool reported 0.25
# (Tool.InMM false) and warned falsely — diameters are now compared
# in mm. The 8 toolpaths themselves were correct (profile offset and
# pocket raster spacing both match a 6.35 mm tool, not 0.25 mm).
# (6) island fit width (2026-11-22, filed in BACKLOG.md — Linear is at
# its free-plan limit): the step pocket's min_width came from the outer
# face bbox (46 mm), ignoring the rib island, so the planner assigned
# the 1/4 in tool to a 5.03 mm annulus and VCarve dropped the island
# and cleared the rib — the preview showed no lip. The island gap is
# now folded into min_width_mm (5.03 mm), so the step pocket takes
# the 1/8 in tool and Plan A is 3 tools / 7.0 min. (7) through cuts
# (2026-11-22): the profile cut depth was the hardcoded part height
# (9.5 mm in 10 mm stock — the part never freed). Profiles now set
# CutDepthFormula "z" (material thickness) so they cut through
# whatever stock the job uses; the manifest depth stays as fallback.
# (8) tabs, continued (2026-11-22): v0.6 placed 0 of 3 tabs on both
# profiles — the SDK spells the method two ways
# (InsertToolpathAtTabAtPoint in the method list,
# InsertToolpathTabAtPoint in the ToolpathTab description) and v0.6
# called one spelling inside a pcall that swallowed the failure. v0.7
# tries both spellings, calls the method on the contour GetContour()
# already returns (no cast needed), and returns the failure reason so
# the warning names it. Verified live: the preview shows both parts
# held in the sheet by tabs. (9) post-processing in the final dialog
# (2026-11-22, Brandon's request): the post-process plan lived in
# report.md but never reached the gadget, so the operator had no
# instructions after the cut. manifest.txt now carries `# post:
# [method] step (parts)` lines (one per unique POST-PROCESS flag,
# grouped across parts) and the gadget lists them under "After the
# CNC cut:" in its final dialog. For the real container that is the
# router-table roundover on both parts. Parts with no post-processing
# get no `# post:` lines and no dialog section. (10) tool labels
# (2026-11-22, Brandon, post-V1 streamlining): imperial endmills are
# labelled by their native size, compact — "1/4in" in the gadget's
# tool prompts and final dialog and in report.md's tool lists — not
# "6.35 mm" and not spelled out. Metric tools still display in mm.
# Tool ids and the ToolDBId remembering keyed on them are unchanged.

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
# (2026-11-22: a --config naming a file that does not exist now fails
# with "ERROR: config file not found" and exit 1 in both tools — it
# used to silently run with defaults, which made this gate look broken
# when the regression script typo'd the filename.)
# Single-pass plans are dropped (final radius 3.18 > 1.0).

# Real container (BRA-8, verified 2026-11-08; BRA-15 re-verified 2026-11-09;
# BRA-17 re-verified 2026-11-09; BRA-21 re-verified 2026-11-09):
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_out --auto
# expect: 2 parts, 8 layers, 6 flags (see §2). P01 facing pocket
# P01_P01__POCKET_D1.50 has 3 DXF circles (r 23.00 / 17.97 / 15.00);
# P02 facing pocket has 1 (r 18.00 counterbore). Bottom drills are
# surface drills START1.50 depending on POCKET_D1.50. Plan A (BRA-15):
# EM 1/8 in (the step pocket — its 5.03 mm annulus around the rib
# cannot take the 1/4 in tool) + Drill 2.25 + EM 1/4 in, 3 tools,
# 2 changes, est 7.0 min — cut order all pockets, both drills,
# profiles last. Orientation search (BRA-17, BRA-21):
# Bottom best +Z (score 8.1) over -Z (41.4); Top best -Z (4.8) over
# +Z (41.3) — the same flip the explicit parts.json gives; X/Y
# orientations score 145.0 (no_plan + flip + pocket penalties).
# Merged-job level (BRA-21): upright 9.6 vs flipped 46.1 — about
# 4.8x, the difficulty Brandon expects (flip 25 + 8 holes x 0.5 +
# 2 pockets x 5.0 + router_table 4, on top of 3.1 min of cutting).
# (2026-11-21, tool cap: the 9.6/46.1 figures were computed under
# the 1/2 in plan; per-part scores are now Bottom +Z 8.1 / Top -Z
# 4.8, flipped 41.4 / 41.3 — the ratio is penalty-dominated and
# still ~4.8x. Plan A is now 7.0 min, 3 tools: the step pocket takes
# the 1/8 in tool because its island annulus is 5.03 mm wide —
# 2026-11-22 island fix, see the BRA-5 note below.)
# Without --auto or parts.json the Top's pocket is now flagged
# POCKET NOT FROM TOP and gets no layer — 5 layers / 16 flags (not
# 4 / 1: corrected 2026-11-23, V2.10 — the old figure predated the
# HOLE NOT FROM TOP flag taxonomy; direct v1 gives the same 5/16,
# flags and layers byte-identical to the CLI). P01 keeps its 4
# layers, P02 keeps only its profile; the 16 flags are the --auto
# run's 6 plus 2x POCKET NOT FROM TOP plus 8x HOLE NOT FROM TOP.
# With --material 170x100x10 the X/Y orientations are pruned (height
# 46.00 > thickness 10.00); with --material 150x100x10 the run now
# PASSES (2026-11-21, tool cap: the default plan's 1/4 in profile
# tools need 46 + 17.7 + 46 = 109.7 mm of usable width and the sheet
# has 110 — it used to fail at PACKING, exit 1, because the 1/2 in
# tools needed 122.4 mm. 150x100x10 is now the smallest fitting
# sheet for the default plan; 170x100x10 still works and gives more
# room).
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
# — the correct orientation gives cleaner layers). Suggested
# material 600 x 100 x 15 mm (was 690 x 100 x 15 — BRA-20: gaps
# are 17.7 mm from plan A's 1/4 in profile tools, not 30.4 mm).
# The search runs the classifier up to 6 times per part, so this
# takes ~4 minutes.

# Material size, packing, clamp margin, pins (BRA-16, verified 2026-11-09;
# tool-dependent spacing verified 2026-11-09):
.venv/bin/python multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19
# expect: 8 parts, 22 layers, 4 flags (same classification as the
# no-material run); usable area 460 x 260 mm (500x300 minus 20 mm
# clamp margin); gaps are 17.7 mm (BRA-20: plan A cuts every
# profile with the 1/4 in endmill, 6.35 + 6.35 + 5 — was 30.4 mm
# from the 1/2 in fit-rule maxima before BRA-20); 6 parts in row 1
# (P06 unrotated, 80 x 20, at sheet x 388.5), P07 + P08 in row 2
# at sheet y 97.7 (usable y 77.7); manifest carries material,
# clamp_margin_mm, usable_area_mm, layout (per-part x/y/w/d/rotate_z
# + profile_tool_dia_mm), spacing (rule, gap_mm, web_min_mm,
# pin_clearance_mm, profile_tools_from "plan A", check) and
# suggested_material: null.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 170x100x10
# expect: 2 parts, 8 layers, 6 flags; X/Y orientations pruned
# (height 46.00 > thickness 10.00); Bottom at sheet (20, 20), Top at
# (83.7, 20) — 17.7 mm gap (was (96.4, 20) / 30.4 mm under the
# 1/2 in plan, before the 2026-11-21 tool cap).
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
# [(276.0, 24.0), (24.0, 176.0)] D6, keep-out radius 12.35 mm
# (= 6.35 mm profile tool + 3.0 mm pin radius + 3.0 mm clearance;
# was 18.7 mm under the 1/2 in plan, before the 2026-11-21 cap) —
# the widest-separated clear pair inside the usable area.
# Suggested sizes (no material given): two_part -> 180 x 80 x 10 mm;
# real container -> 150 x 90 x 10 mm (was 170 x 90, before the
# 2026-11-21 tool cap); eight parts -> 600 x 100 x 15 mm
# (packed bounds + 20 mm clamp margin, rounded up to 10 mm).
# Tool-dependent spacing (BRA-16, built 2026-11-09; BRA-20, built
# 2026-11-09): gaps are max(gap_mm, D_A + D_B + web_min_mm) from
# the CHOSEN plan's actual per-part profile tools (toolplan.
# plan_profile_tools), computed from the per-part classification
# pre-pass before packing; the chosen plan's real profile tools
# are re-checked against the packed gaps before anything is
# written. When no merged plan exists (a layer no standard tool
# fits — Kookabus), the per-part fit-rule maxima are used instead
# and manifest spacing.profile_tools_from says so. A 150x100x10
# sheet now FITS the real container with the default plan
# (2026-11-21, tool cap: the default plan's 1/4 in profile tools
# need 109.7 mm of usable width and the sheet has 110 — it used to
# need 122.4 mm with 1/2 in tools and fail). Bottom at sheet (20, 20),
# Top at (83.7, 20), gap 17.7 mm, Plan A Drill 2.25 + EM 1/4 in,
# 8 layers / 6 flags — the same result the small-tools config used
# to be needed for; the config (test/bra20_small_tools_config.json)
# is now redundant for this job. The threshold is still 6.35 mm
# (109.7 mm packed width).
#
# Pack from the chosen plan's actual profile tools (BRA-20,
# verified 2026-11-09):
.venv/bin/python multi_part.py test/two_part.step -o test/multi_out_bra20 --mode full
# expect: 2 parts, 5 layers, 1 flag; P02 at sheet x 94.525 (gap
# 14.525 mm — plan A cuts both profiles with a 3/16 in endmill);
# (2026-11-21: the old 74.525 was usable-area coords, before the
# clamp-margin fix made the layout true sheet coords.)
# suggested 180 x 80 x 10 mm; spacing.profile_tools_from "plan A".
.venv/bin/python multi_part.py test/eight_parts.step -o test/eight_parts_bra20_out --auto
# expect: 8 parts, 22 layers, 4 flags, Plan A 1 change / 9.0 min;
# gaps 17.7 mm (plan A 1/4 in everywhere); suggested 600 x 100 x 15 mm.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_bra20_150 --auto --material 150x100x10
# expect: PASSES (2026-11-21, tool cap) — packed layout 46.00 x
# 109.70 mm fits usable 110.00 x 60.00 mm (plan A, 1/4 in tools,
# gap 17.7 mm); 2 parts, 8 layers, 6 flags.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_bra20_150B --auto --material 150x100x10 --plan B
# expect: PASSES (2026-11-21, tool cap) — Plan B is EM3.17 +
# D2.25 + EM4.76, 7.8 min (corrected 2026-11-23, V2.10 — the old
# "EM 1/4 in + EM 1.59 mm" prose did not match the manifest),
# packed 109.70 mm fits usable 110.00 x 60.00 mm.
.venv/bin/python multi_part.py test/real_container.step -o test/real_container_bra20_small --auto --material 150x100x10 --config test/bra20_small_tools_config.json
# expect: passes — 2 parts, 8 layers, 6 flags; Bottom at sheet
# (20, 20), Top at (83.7, 20); Plan A Drill 2.25 + EM 1/4 in.
.venv/bin/python multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_bra20_out --mode full
# expect: no crash; layers 20, flags 190; the merged plan EXISTS
# (BRA-22, re-verified 2026-11-21 under the tool cap: Plan A EM
# 3/8 in + EM 0.50 mm, 2 changes, 215.1 min),
# so the packer uses plan A's profile tools and
# spacing.profile_tools_from is "plan A" — the fit-rule-maxima
# fallback only applies when no merged plan exists. No TOOL PLAN
# flag.

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

1. Install `vcarve/multi_layer_dxf.vgadget` via Gadgets > Install New Gadget
   (or copy `vcarve/multi_layer_dxf.lua` to
   `Public Documents\Vectric\VCarve Pro\Gadgets\multi_layer_dxf\`), restart VCarve.
2. Create a job with material size/thickness matching the manifest,
   Z-zero at top of material.
3. Gadgets > multi_layer_dxf, pick `test/real_container_out/manifest.txt`.
   The gadget imports the DXF named on the manifest's `# dxf:` line.
4. Expected: one toolpath per manifest line, drill -> pocket -> profile
   order, depths from the manifest. **Preview before posting G-code.**
5. If a call fails, the gadget reports which layer — note the exact
   error message and the VCarve version. The file picker is the
   documented `FileDialog()`; `GetFileName()` does not exist in the
   Vectric API, and neither does `JoinVectors()` (both confirmed
   against the V12 SDK, Nov 21). Vector selection is a local helper
   adapted from Vectric's Profile_Vectors_On_Layer sample.

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

## 7. Config model (V2.3, 2026-11-22 — machine + libraries)

The library/config model (`mldxf_config.py`, examples
`machine/tools/clamps/preferences.example.json`) is additive: no
manifest contract, DXF output, gadget, or existing Python tool
changed. The V2.1 `mldxf` CLI calls the module's loaders; until
it exists the module verifies on its own.

```bash
.venv/bin/python test_mldxf_config.py
# expect: 21 passed, 0 failed — "ALL V2.3 CONFIG CHECKS PASSED".
# The script loads the shipped examples, checks resolve_home with
# and without MLDXF_HOME, init_home into a temp home (copies all
# four files + validates them), the placeholder T-track refusal,
# empty tools.json (4 variants), and one deliberately broken file
# per named error, printing each exact message:
# - tool dia mismatch: "tools.json[0]: tool EM6.35: 'dia_mm' 6.0
#   does not match the diameter in its id (6.35 mm) — the id is
#   the diameter"
# - slot outside the bed: "machine.json: t_track.slots[0]: slot runs
#   at y=2000.0 mm, outside the bed (depth 1222.4 mm)"
# - overlapping slots: "machine.json: t_track.slots[0] and slots[2]
#   overlap — two x-axis slots at 150.0 mm and 154.0 mm with slot
#   width 8.0 mm"
# - missing file: "machine.json not found in <home> ... — run
#   'mldxf init' to create it from the shipped examples"
# - unknown/misspelled key: "preferences.json: unknown key(s):
#   clamp_margn_mm — check for a typo; unknown keys are rejected,
#   never ignored"
# - bad JSON: "clamps.json: invalid JSON: Expecting property name
#   enclosed in double quotes: line 1 column 2 (char 1)"
# - placeholder guard: "T-track slots are placeholders — measure
#   your bed and replace the placeholder slots in machine.json with
#   your real measurements" (loading the example machine passes;
#   only the guide-time assert_real_t_track refuses)
# - guide-time clamp check: "clamp 't-track-clamp' needs a T-track
#   slot to mount in, but machine 'onefinity-elite-foreman' has no
#   real T-track slot — its slots are placeholders ..."
# - inventory_mode other than advisory is rejected, not silently
#   treated as advisory
```

Validation rules (all fail loudly with a named `ConfigError`,
never silently default — the V1 rule):

- Home: `MLDXF_HOME`, else `%APPDATA%\multi_layer_dxf` on
  Windows, else `~/.config/multi_layer_dxf`; never the cwd.
- `machine.json`: bed 1222.4 × 1222.4 mm (Onefinity Elite
  (Masso) Foreman), controller `"masso"` informational in V2.
  Slot outside the bed or two same-axis slots overlapping is an
  error at load; crossing (x vs y) slots are a normal grid.
- `tools.json`: ids are the planner's (`EM6.35`, `D2.25`,
  `EM3.17` = the 3.175 mm 1/8 in tool, `EM9.53` = the 9.525 mm
  3/8 in tool — the two-decimal id truncates the true diameter,
  tolerated to 0.01 mm); `native_label` must agree with `dia_mm`
  (`"1/4in"` / `"2.25 mm"`). Empty file / `[]` / `{"tools": []}`
  is a valid empty inventory; a missing file is an error.
- `clamps.json`: only common methods (`t_track_clamp`, `tape`,
  `glue`, `screw`, `pin`, `vise`); the example is a template with
  `count: 0` everywhere — no clamp inventory is invented.
  `method: t_track_clamp` with `t_track: false` is an error at
  load; a `t_track: true` clamp with no real slot is an error at
  guide time only (`check_clamp_mountable`), not at load.
- `preferences.json`: accepts every key in `config.example.json`
  (same keys, same meaning) plus `post_method_overrides`,
  `max_drill_mm`, `stock_size_mm` (keys V1 code reads) and
  `inventory_mode` (`"advisory"` only in V2; absent defaults to
  advisory on the returned dict).
- `init_home` copies the four examples and validates them, and
  refuses to overwrite existing files.
- §4 regressions (§4 above) are untouched by this item — no
  pipeline code changed, so no §4 number moves.

## 8. V2 acceptance (V2.10, 2026-11-23 — V2_SCOPE.md §7)

V2 is done when all seven items hold. No partial credit. This
section is the acceptance record: the item, its criterion, and the
run evidence. Slots marked **TBD** are for the coordinator to fill
once the suite/parity workers report — nothing here is filled in
from a run that did not happen.

Reading rules for the evidence (V2_SCOPE.md §8 Q4, corrected in
wave 1): DXF bytes are NOT reproducible, even v1-vs-v1 — ezdxf
writes `$TDCREATE` / `$TDUPDATE` timestamps, random
`$FINGERPRINTGUID` / `$VERSIONGUID`, a timestamped dictionary
variable, and the CLASS order swaps between processes. Parity and
rerun therefore compare DXF by canonical entity+layer signature
(`mldxf_dxf.py`), never by bytes. `job.json` is likewise not
byte-identical across reruns for the nondeterministic files (DXFs,
exported per-part STEPs, per-part manifest.json files) — those are
compared by canonical DXF signature / timestamp-blanked STEP /
normalized JSON, and `job.json`'s `outputs` sha256 values stay
truthful per-run hashes. "Identical" below always means identical
under those comparison rules.

### Item 1 — §4 suite green

Criterion: the full 25-step §4 regression suite passes run through
`mldxf plan`, with the same numbers — container Plan A 3 tools /
7.0 min, Kookabus 215.1 min, eight_parts 9.0 min. The CLI is a
shell; it must not move a single §4 number.

- **Status: PASS — 2026-11-23, verified by the coordinator.**
- Suite log: `~/workspace/goals/onshape-to-vcarve-2-5d-automation/hidden_files/regress_v210_2026-11-23.log` (one end-to-end log, 2026-11-23; script `regress_v210_2026-11-23.sh` + `regress_v210_2026-11-23.py`). Log-wide tally 117 PASS / 3 FAIL; all 3 FAILs investigated with fresh direct-v1 discriminator runs and exonerated as harness/doc artifacts, not code regressions (below). 25/25 steps pass.
- Observed numbers: container Plan A **3 tools / 7.0 min** (EM3.17 + D2.25 + EM6.35); Kookabus **215.1 min** (Plan A EM9.53 + EM0.50, 2 changes, 20 layers / 190 flags); eight_parts **9.0 min** (Plan A 2 tools / 1 change, suggested 600×100×15); sections passed **25 / 25**.
- Any §4 number that moved, and why: **none.** The three logged FAILs: (S09) rotated-container DXF ≠ container DXF — the worker's strengthening check, not a §4 line; the two STEPs list solids in opposite order, so P01↔P02 swap; direct v1 rotated run DXF signature identical to the CLI rotated run (`a90f35da2a9f47a2` both sides — confirmed independently by the coordinator's own direct-v1 runs, 2026-11-23). (S10) beveled_sideways DXF ≠ unrotated beveled container — same, not a §4 line; the rotated-back solid sits +6.00 mm in x; direct v1 sideways run DXF signature identical to the CLI run (`bb7dd802d1bd2d91` both sides — confirmed independently by the coordinator's own direct-v1 runs). Both are pre-existing v1 behaviour; no §4 expectation covers them. (S14) no-`--auto` real container expected 4 layers / 1 flag, got 5 / 16 — a §4 line, but the §4 figure was stale: the behaviour is correct per §4's own prose (P01 keeps 4 layers, P02 keeps only its profile = 5; the 16 flags are the --auto run's 6 plus 2× POCKET NOT FROM TOP plus 8× HOLE NOT FROM TOP), and direct v1 gives the same 5/16, flags and layers byte-identical to the CLI (confirmed independently by the coordinator). §4 corrected 2026-11-23 (V2.10): no-`--auto` is 5 layers / 16 flags; plan B composition prose corrected to EM3.17 + D2.25 + EM4.76, 7.8 min.
- V2.4 named exception **confirmed by the coordinator**: the §4 byte-identity diff rule now carries it — the CLI adds `"owned": false` to every tool in `tool_plan` and appends a 6-line advisory "Tool inventory" section to report.md (specified V2.4 behaviour, V2_SCOPE.md §4.4; ranking/times unchanged). §4's diff wording updated to match.
- Runtime restart during the run (~08:17 UTC, during step 23): no suite process survived; steps 1–22 stood, steps 23–25 resumed in the same log with a recovery marker. The log's trailing "SUITE RESULT: 13/0" is the resumed portion's partial tally only; the true log-wide tally is 117 PASS / 3 FAIL above.

### Item 2 — CLI/UI parity

Criterion: for the same STEP + config snapshot, the job dir from
`mldxf plan` and the job dir from the web UI are identical except
`created_at` and `job_id` (and the §8 Q4 nondeterministic-file
exceptions above). If they differ, the UI is computing something —
find it and move it into the CLI.

- **Status: PASS — 2026-11-23, verified by the coordinator.**
- Parity run: `~/workspace/goals/onshape-to-vcarve-2-5d-automation/hidden_files/parity_2026-11-23/` (report.md, parity.py, parity.log, server.log), 2026-11-23. **169/169 checks, 6/6 jobs.** The single logged FAIL was a harness false positive (its orphan check used bare `pgrep -f server.ts`, which matched two unrelated AgentTS worker-servers; the coordinator confirmed those are AgentTS processes, not mldxf — no mldxf server process remains).
- Compared: job.json **identical modulo §8 Q4 exceptions** (`created_at`, `job_id`, `outputs` sha256 of nondeterministic files); manifest.txt **byte-identical**; DXF **signature-identical** (`mldxf_dxf.py`); report.md **identical**. Jobs: real container (`--auto`, Plan A 3 tools / 418.8 s on both sides), two_part, square, donut, beveled_container, eight_parts (`--auto`, Plan A 2 tools / 542.3 s on both sides). Container used CLI `--auto` / API `auto=true` (the UI default is auto OFF; auto passed explicitly through the API).
- Server smoke (same run): `mldxf serve` on scratch port 3891 — `/api/health` 200 (`cli_version: "2.0.0"`), `GET /` 200 HTML, `GET /api/jobs` 200; stopped cleanly by SIGTERM to the process group, port free immediately after.
- Wave-3 evidence on file (not the acceptance run): CLI parity 21/21, UI run of the real container = Plan A 3 tools / 7.0 min, recorded in CHANGELOG.md. Acceptance re-check above supersedes it.

### Item 3 — Rerun reproduces

Criterion: `mldxf rerun <job-dir>` reproduces the job (same
outputs, same hashes under the §8 Q4 comparison rules) from the
embedded inputs and config snapshot. A rerun with a different CLI
version warns on stderr and proceeds, recording the new
`cli_version` — that warning is expected after the 1.0.1 → 2.0.0
bump, not a failure.

- **Status: PASS — 2026-11-23, verified by the coordinator.**
- Rerun run: same parity run as item 2 (`hidden_files/parity_2026-11-23/report.md`, 2026-11-23) plus the hold-force rerun below.
- Compared: manifest.txt / report.md **byte-identical**; DXF signature **identical**; job.json **identical modulo `created_at` + nondeterministic `outputs` sha256**. (a) Plain CLI job: `mldxf rerun` rc=0, Plan A still 3 tools / 418.8 s. (b) Guided job: `mldxf guides` then `mldxf rerun` rc=0 — workholding clamps, recommendation, and provenance reproduce exactly; DXF signature identical including the GUIDE_CLAMP layer (`1056c0433b5b9999` before and after — the coordinator recomputed it independently on the guided job dir). (c) v1 job (copy of `test/real_container_out`): `mldxf rerun` rc=1 with named error `rerun_unavailable`, directory hash unchanged — fails up front, no partial job dir.
- Hold-force provenance rerun (open wave-4 item, closed here): fixture home with `hold_force_n: 400` on the T-track clamp → `mldxf guides` gives 2 clamps at (43,88)/(106.7,88), force_check `holds`, provenance records 400. Live home then mutated (400 → 999) and `mldxf rerun` run: replayed workholding exactly identical — clamps, force model, recommendation equal; replayed `hold_force_n` still 400, status still `holds`, provenance still records 400; DXF signature identical; plan still 3 tools / 7.0 min. The replay uses recorded provenance, not the live home. Log: `hidden_files/guides_v210_2026-11-23.log` (task 3, 8/8 checks).
- Wave-2 evidence on file (not the acceptance run): rerun reproduces a job — manifest/report byte-identical, DXF signature-identical, recorded in CHANGELOG.md.

### Item 4 — One live end-to-end job (Brandon)

Criterion: Brandon runs a real job through the web UI (drop STEP
→ review plan → download → gadget in VCarve → preview) and
confirms the loop works. V1's live test found real defects; V2's
will too — budget for the fix round.

- **Status: NOT DONE — awaiting Brandon. Do not mark done here.**
- Instructions for the run: `V2_LIVE_RUN.md` (goal files dir).
- Live-run report from Brandon: **TBD** (date, job, what worked,
  what did not).
- Fix round filed from the live run: **TBD** (BACKLOG.md heading /
  Linear key, or "none needed").

### Item 5 — Guides verified on the container

Criterion: the real container job gets clamp recommendations on
real T-track slots, with keep-out respected, and the guide layer
shows in the DXF.

- **Status: PARTIAL — verified on a test fixture, NOT on real
  slots.** No real T-track measurements exist yet: on Brandon's
  real (placeholder) home, guides correctly refuse with the named
  error `t_track_placeholder` — that refusal is the correct
  behaviour until he measures his slots (V2_SCOPE.md §10 Q1).
- V2.10 re-verification (2026-11-23, log `hidden_files/guides_v210_2026-11-23.log`, effective 31/31): fresh container job (`mldxf plan --auto --material 150x100x10`, Plan A 3 tools / 7.0 min) + `mldxf guides` on the wave-4 fixture home (verbatim copy — x-slot at y=88, x-slot at y=12, y-slot at x=140; t-track-clamp count 4, footprint 30×20, keep_out 5, no `hold_force_n`; TEST FIXTURE only) → **2× t-track-clamp at (43, 88) and (106.7, 88)** on the x-axis slot at y=88 mm, worst estimated force 2.58 N, holding force unknown ("verify by hand"), tape as the only alternative, glue absent — identical to wave 4. GUIDE_CLAMP layer present in the DXF with the two 30×20 footprint rects; non-guide DXF geometry unchanged by guides; plan/layout unchanged; report.md carries the Workholding guides section; provenance records the fixture machine + clamps. The single logged FAIL was a harness list-vs-tuple comparison bug (the printed rects are exactly the expected ones); re-verified directly against the on-disk DXF, rects == expected is True. Placeholder refusal re-verified: same job under the shipped-example home → exit 1, `t_track_placeholder`, job byte-identical.
- Wave-4 evidence on file: real container + clearly-marked test
  T-track fixture (not real measurements) → 2× t-track-clamp at
  (43, 88) and (106.7, 88) on the x-axis slot at y=88 mm, worst
  estimated force 2.58 N; independent checker ALL GUIDE CHECKS
  PASSED; refusals verified at CLI + HTTP; rerun of a guided job
  reproduces the workholding byte-identical; §4 number holds (Plan
  A 3 tools / 7.0 min). Recorded in CHANGELOG.md.
- Verification on Brandon's real slots: **TBD** (needs his
  measurements in `machine.json` first; then re-run `mldxf
  guides` on the container job and check the `GUIDE_CLAMP` layer
  in the DXF).
- Force model caveat (stays in the record): the force estimate is
  first-order only — `F = Kc·MRR/v_c`, `Kc = 30 N/mm²` (top of the
  published 10–30 range), labelled conservative and unvalidated
  everywhere it appears. It is not a validated physics model.

### Item 6 — Docs

Criterion: README (new quick start: `mldxf serve`), VALIDATION
(V2 acceptance added), CHANGELOG, VERSION 2.0.0.

- **Status: DONE by the V2.10 docs worker, 2026-11-23 (local
  only, nothing pushed).**
- README.md: V2 quick start added at the top (`mldxf serve` /
  `start.bat` → UI; `mldxf plan` for the CLI path); the stale
  "`mldxf serve` — not built yet" line corrected; the
  "byte-identical" claim corrected to the §8 Q4 signature rule;
  `server/` + `start.bat` + `mldxf_guides.py` + `mldxf_dxf.py`
  added to the Files list. V1 CLI usage kept documented; the
  gadget stays v1.0.1 (unchanged in V2).
- VALIDATION.md: this section (§8).
- CHANGELOG.md: v2.0.0 entry added, 2026-11-23, summarizing V2.1–
  V2.9; the wave build log kept below it.
- VERSION: 1.0.1 → 2.0.0. Runtime effect (verified by grep,
  2026-11-23): `mldxf.py` reads VERSION at import and stamps it
  into every v2 job as `job.json` → `cli_version`, prints it from
  `mldxf --version`, and passes it to the guides subprocess (lands
  in `workholding.provenance.guides_cli_version`); `server.ts`
  reads it at startup, logs it, and returns it from
  `GET /api/health` as `cli_version`. Consequence of the bump: jobs
  written under 1.0.1 warn on rerun under 2.0.0 ("different CLI
  version … rerunning with the current CLI") and proceed, recording
  `cli_version: "2.0.0"` — expected, by design. `mldxf --version`
  now prints `mldxf 2.0.0` (verified after the bump).
- Left as-is deliberately: `vcarve/multi_layer_dxf.lua` header
  (gadget v1.0.1 — unchanged in V2); `mldxf_config.py` "v1.0.1
  rule" docstring (historical). `server/package.json` version was
  "1.0.1" in the docs pass; the coordinator bumped it to "2.0.0"
  for consistency (2026-11-23) — it is the server package's own
  version, not read by the CLI.

### Item 7 — Release

Criterion: tag v2.0.0 + release page (the release policy:
labelling something V2 is a release).

- **Status: NOT DONE — V2.11, after acceptance.** No tag, no
  release, nothing pushed — the docs worker does not push, tag,
  or create releases.
- Tag / release page: **TBD**.

### §10 defaults in force for this acceptance (Brandon, Nov 22)

The four open questions' defaults, authorized as reasonable
assumptions until Brandon gives the real answers; the code keeps
them as config, not hardcoded:

1. T-track placeholders refuse to run the guides (named error,
   never a guess).
2. Jobs under `<MLDXF_HOME>/jobs/`.
3. Tool inventory informational (advisory, not constraining) —
   `preferences.json` `inventory_mode: "advisory"`, the only value
   V2 accepts.
4. 2D layout preview included in V2.

### What the docs worker verified directly (2026-11-23)

- `mldxf --help` lists all commands: plan, check, job, rerun,
  guides, machine, tools, clamps, preferences, serve, init.
- `mldxf serve` starts the Bun server: smoke test on port 3999,
  2026-11-23 ~07:00 PST — `GET /` HTTP 200 (UI HTML),
  `GET /api/jobs` returned the job list (8 job dirs scanned, all
  marked interrupted from earlier verification runs — expected:
  those runs ended without a completion marker). Server stopped
  cleanly afterwards; no `mldxf serve` / `server.ts` process left
  (the one remaining bun process was an unrelated AgentTS
  worker-server).
- The §4 suite and the parity sweep were NOT run by the docs
  worker — the suite worker and the parity worker own them (items
  1–3 above, filled in by the coordinator 2026-11-23).
