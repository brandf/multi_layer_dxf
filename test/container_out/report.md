# container — multi-part VCarve report

- P01_Bottom: stock 100.0 x 100.0 x 12.0 mm, flip_x=False rot_z=0.0, layers 3
- P02_Top: stock 100.0 x 100.0 x 10.0 mm, flip_x=True rot_z=0.0, layers 2

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 1 manual change(s), est 5.4 min total (cutting 3.4 + changes 2.0). Times are estimates, not promises.
- T1: Drill 5.00 mm — feed 7.5 mm/s, plunge 7.5 mm/s, 20000 rpm, stepdown 2.5 mm, peck drilling
- T2: End Mill 1/2 in (12.70 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 5.08 mm
Cut order (tool changes marked):
- P01_Bottom__DRILL_D5.00_THRU (drill, drill): est 41 s — drill
  — change to T2 (End Mill 1/2 in (12.70 mm)) —
- P01_Bottom__POCKET_D6.00 (pocket, endmill): est 37 s — largest endmill that fits
- P02_Top__POCKET_D5.00 (pocket, endmill): est 32 s — largest endmill that fits
- P01_Bottom__PROFILE_THRU (profile, endmill): est 46 s — largest endmill that fits
- P02_Top__PROFILE_THRU (profile, endmill): est 46 s — largest endmill that fits
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 1 change(s), est 5.7 min — T1 Drill 5.00 mm, T2 End Mill 3/8 in (9.53 mm)
- Plan C: 2 tool(s), 1 change(s), est 6.1 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 1/2 in (12.70 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- none
