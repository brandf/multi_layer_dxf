# eight_parts — multi-part VCarve report

Material: none given — suggested 600 x 100 x 15 mm (packed layout + 20 mm clamp margin, rounded up to 10 mm).
Spacing (BRA-16 tool rule, BRA-20 plan-aware): gaps are max(10.0 mm, D_A + D_B + 5.0 mm web); profile tools from plan A: P01_P01 6.35 mm, P02_P02 6.35 mm, P03_P03 6.35 mm, P04_P04 6.35 mm, P05_P05 6.35 mm, P06_P06 6.35 mm, P07_P07 6.35 mm, P08_P08 6.35 mm. verified against plan A (profile tools P01_P01 6.35 mm, P02_P02 6.35 mm, P03_P03 6.35 mm, P04_P04 6.35 mm, P05_P05 6.35 mm, P06_P06 6.35 mm, P07_P07 6.35 mm, P08_P08 6.35 mm).
- P01_P01: stock 60.0 x 60.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 2, at (0.0, 0.0) [search: best +Z (+Z 0.8; -Z 0.8; +X 70.0; -X 70.0; +Y 70.0; -Y 70.0)]
- P02_P02: stock 60.0 x 60.0 x 15.0 mm, flip_x=False rot_z=0.0, layers 4, at (77.7, 0.0) [search: best +Z (+Z 2.9; -Z 32.1; +X 54.3; -X 54.3; +Y 54.3; -Y 54.3)]
- P03_P03: stock 70.0 x 50.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 3, at (155.4, 0.0) [search: best +Z (+Z 3.0; -Z 32.5; +Y 56.4; -Y 56.4; +X 56.6; -X 56.6)]
- P04_P04: stock 50.0 x 40.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 2, at (243.1, 0.0) [search: best +Z (+Z 0.7; -Z 0.7; +Y 9.5; +X 11.6; -Y 41.1; -X 41.2)]
- P05_P05: stock 40.0 x 40.0 x 6.0 mm, flip_x=False rot_z=0.0, layers 2, at (310.8, 0.0) [search: best +Z (+Z 0.2; -Z 0.2; +X 70.0; -X 70.0; +Y 70.0; -Y 70.0)]
- P06_P06: stock 80.0 x 20.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 3, at (368.5, 0.0) [search: best +Z (+Z 2.3; -Z 2.3; +X 34.9; -X 34.9; +Y 41.2; -Y 41.2)]
- P07_P07: stock 40.0 x 40.0 x 12.0 mm, flip_x=False rot_z=0.0, layers 3, at (466.2, 0.0) [search: best +Z (+Z 0.9; +Y 8.0; -Y 8.0; +X 11.0; -X 11.0; -Z 26.4)]
- P08_P08: stock 30.0 x 20.0 x 12.0 mm, flip_x=False rot_z=0.0, layers 3, at (523.9, 0.0) [search: best +X (+X 1.5; -X 31.1; +Y 37.0; -Y 37.0; +Z 37.3; -Z 42.3)]

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 1 manual change(s), est 9.0 min total (cutting 7.0 + changes 2.0). Times are estimates, not promises.
- T1: End Mill 1/8 in (3.17 mm) — feed 15.88 mm/s, plunge 5.29 mm/s, 20000 rpm, stepdown 1.587 mm, stepover 1.27 mm
- T2: End Mill 1/4 in (6.35 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 2.54 mm
Cut order (tool changes marked):
- P02_P02__DRILL_D6.00_THRU (drill, bore): est 30 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P03_P03__DRILL_D5.00_THRU (drill, bore): est 37 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P04_P04__DRILL_D6.00_THRU (drill, bore): est 18 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P06_P06__DRILL_D4.00_THRU (drill, bore): est 14 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P07_P07__DRILL_D6.00_THRU (drill, bore): est 12 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- P08_P08__DRILL_D5.00_THRU (drill, bore): est 11 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
  — change to T2 (End Mill 1/4 in (6.35 mm)) —
- P05_P05__DRILL_D12.00_THRU (drill, bore): est 4 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- P07_P07__DRILL_D12.00_D4.00 (drill, bore): est 3 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- P02_P02__POCKET_D5.00 (pocket, endmill): est 37 s — largest endmill that fits
- P02_P02__DRILL_D8.00_D6.00_START5.00 (drill, bore): est 3 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- P03_P03__POCKET_D4.00 (pocket, endmill): est 12 s — largest endmill that fits
- P08_P08__POCKET_D4.00 (pocket, endmill): est 5 s — largest endmill that fits
- P01_P01__PROFILE_THRU (profile, endmill): est 29 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P01_P01__THROUGH_CUT (profile, endmill): est 17 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P02_P02__PROFILE_THRU (profile, endmill): est 45 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P03_P03__PROFILE_THRU (profile, endmill): est 36 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P04_P04__PROFILE_THRU (profile, endmill): est 21 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P05_P05__PROFILE_THRU (profile, endmill): est 10 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P06_P06__PROFILE_THRU (profile, endmill): est 23 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P06_P06__THROUGH_CUT (profile, endmill): est 13 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P07_P07__PROFILE_THRU (profile, endmill): est 25 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P08_P08__PROFILE_THRU (profile, endmill): est 17 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 2 change(s), est 11.7 min — T1 End Mill 3/8 in (9.53 mm), T2 End Mill 1/8 in (3.17 mm)
- Plan C: 2 tool(s), 2 change(s), est 11.7 min — T1 End Mill 1/2 in (12.70 mm), T2 End Mill 1/8 in (3.17 mm)
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 3 change(s), est 14.3 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 1/4 in (6.35 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- [P01_P01] THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
- [P02_P02] DRILL FROM SURFACE: dia 8.00 at (107.70,30.00) opens on the Z 10.00 face — POCKET_D5.00 faces it down first (start depth 5.00 mm), then drill 6.00 mm from there
- [P06_P06] THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
- [P07_P07] COUNTERBORE THRU HOLE: dia 6.00 at (486.20,20.00) under D12.00 counterbore — treated as thru
