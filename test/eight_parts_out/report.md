# eight_parts — multi-part VCarve report

- P01_P01: stock 60.0 x 60.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 2 [auto: axis Z 100%, openings +0 vs -0 mm2, flip=False, ambiguous=False]
- P02_P02: stock 60.0 x 60.0 x 15.0 mm, flip_x=False rot_z=0.0, layers 4 [auto: axis Z 64%, openings +1586 vs -0 mm2, flip=False, ambiguous=False]
- P03_P03: stock 70.0 x 50.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 3 [auto: axis Z 73%, openings +600 vs -0 mm2, flip=False, ambiguous=False]
- P04_P04: stock 50.0 x 40.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 2 [auto: axis Z 69%, openings +0 vs -0 mm2, flip=False, ambiguous=False]
- P05_P05: stock 40.0 x 40.0 x 6.0 mm, flip_x=False rot_z=0.0, layers 2 [auto: axis Z 100%, openings +0 vs -0 mm2, flip=False, ambiguous=False]
- P06_P06: stock 80.0 x 20.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 3 [auto: axis Z 53%, openings +0 vs -0 mm2, flip=False, ambiguous=False]
- P07_P07: stock 40.0 x 40.0 x 12.0 mm, flip_x=False rot_z=0.0, layers 3 [auto: axis Z 64%, openings +85 vs -0 mm2, flip=False, ambiguous=False]
- P08_P08: stock 12.0 x 20.0 x 30.0 mm, flip_x=False rot_z=0.0, layers 3 [auto: axis X 49%, openings +0 vs -0 mm2, flip=False, ambiguous=True]

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 3 manual change(s), est 13.7 min total (cutting 7.7 + changes 6.0). Times are estimates, not promises.
- T1: End Mill 1/8 in (3.17 mm) — feed 15.88 mm/s, plunge 5.29 mm/s, 20000 rpm, stepdown 1.587 mm, stepover 1.27 mm
- T2: End Mill 1/4 in (6.35 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 2.54 mm
Cut order (tool changes marked):
- P02_P02__DRILL_D6.00_THRU (drill, bore): est 30 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P03_P03__DRILL_D5.00_THRU (drill, bore): est 37 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P04_P04__DRILL_D6.00_THRU (drill, bore): est 18 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P06_P06__DRILL_D4.00_THRU (drill, bore): est 14 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P07_P07__DRILL_D6.00_THRU (drill, bore): est 12 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
  — change to T2 (End Mill 1/4 in (6.35 mm)) —
- P05_P05__DRILL_D12.00_THRU (drill, bore): est 4 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- P07_P07__DRILL_D12.00_D4.00 (drill, bore): est 3 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
  — change to T1 (End Mill 1/8 in (3.17 mm)) —
- P08_P08__POCKET_D7.50 (pocket, endmill): est 14 s — largest endmill that fits
- P08_P08__POCKET_D22.50_START7.50 (pocket, endmill): est 29 s — largest endmill that fits
  — change to T2 (End Mill 1/4 in (6.35 mm)) —
- P02_P02__POCKET_D5.00 (pocket, endmill): est 37 s — largest endmill that fits
- P02_P02__DRILL_D8.00_D6.00_START5.00 (drill, bore): est 3 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- P03_P03__POCKET_D4.00 (pocket, endmill): est 12 s — largest endmill that fits
- P01_P01__PROFILE_THRU (profile, endmill): est 29 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P01_P01__THROUGH_CUT (profile, endmill): est 17 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P02_P02__PROFILE_THRU (profile, endmill): est 45 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P03_P03__PROFILE_THRU (profile, endmill): est 36 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P04_P04__PROFILE_THRU (profile, endmill): est 21 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P05_P05__PROFILE_THRU (profile, endmill): est 10 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P06_P06__PROFILE_THRU (profile, endmill): est 23 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P06_P06__THROUGH_CUT (profile, endmill): est 13 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P07_P07__PROFILE_THRU (profile, endmill): est 25 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P08_P08__PROFILE_THRU (profile, endmill): est 31 s — largest endmill that fits — tabs x2 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 3 change(s), est 16.8 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 3/16 in (4.76 mm)
- Plan C: 2 tool(s), 6 change(s), est 20.1 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 1/2 in (12.70 mm)
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 8 change(s), est 44.1 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 1/16 in (1.59 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- [P01_P01] THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
- [P02_P02] DRILL FROM SURFACE: dia 8.00 at (100.00,30.00) opens on the Z 10.00 face — POCKET_D5.00 faces it down first (start depth 5.00 mm), then drill 6.00 mm from there
- [P06_P06] THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
- [P07_P07] COUNTERBORE THRU HOLE: dia 6.00 at (440.00,20.00) under D12.00 counterbore — treated as thru
- [P08_P08] AUTO-ORIENT AMBIGUOUS — classified as-is: no dominant prismatic axis (best X 49% of face area) — part is not clearly 2.5D along one axis
- [P08_P08] POST-PROCESS [decision_needed]: fillet R2.50 mm at face at (476.0,10.0), Z 7.50 — No automatic call — decide CNC vs post-process by hand for this feature.
