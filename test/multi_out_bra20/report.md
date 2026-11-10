# two_part — multi-part VCarve report

Material: none given — suggested 180 x 80 x 10 mm (packed layout + 20 mm clamp margin, rounded up to 10 mm).
Spacing (BRA-16 tool rule, BRA-20 plan-aware): gaps are max(10.0 mm, D_A + D_B + 5.0 mm web); profile tools from plan A: P01_P01 4.76 mm, P02_P02 4.76 mm. verified against plan A (profile tools P01_P01 4.76 mm, P02_P02 4.76 mm).
- P01_P01: stock 60.0 x 40.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 3, at (0.0, 0.0)
- P02_P02: stock 60.0 x 40.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 2, at (74.5, 0.0)

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 1 tool(s), 0 manual change(s), est 1.9 min total (cutting 1.9 + changes 0.0). Times are estimates, not promises.
- T1: End Mill 3/16 in (4.76 mm) — feed 23.81 mm/s, plunge 7.94 mm/s, 20000 rpm, stepdown 2.381 mm, stepover 1.905 mm
Cut order (tool changes marked):
- P01_P01__DRILL_D6.00_THRU (drill, bore): est 6 s — bore with End Mill 3/16 in (4.76 mm) (no drill in this plan)
- P02_P02__DRILL_D8.00_THRU (drill, bore): est 6 s — bore with End Mill 3/16 in (4.76 mm) (no drill in this plan)
- P01_P01__POCKET_D4.00 (pocket, endmill): est 17 s — largest endmill that fits
- P01_P01__PROFILE_THRU (profile, endmill): est 47 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- P02_P02__PROFILE_THRU (profile, endmill): est 38 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 1 change(s), est 3.2 min — T1 Drill 6.00 mm, T2 End Mill 1/4 in (6.35 mm)
- Plan C: 2 tool(s), 1 change(s), est 3.2 min — T1 End Mill 3/16 in (4.76 mm), T2 End Mill 1/4 in (6.35 mm)
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 2 change(s), est 5.3 min — T1 End Mill 1/2 in (12.70 mm), T2 End Mill 3/16 in (4.76 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- [P02_P02] POCKET NOT FROM TOP (cavity opens downward): floor Z 3.00, depth 3.00 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
