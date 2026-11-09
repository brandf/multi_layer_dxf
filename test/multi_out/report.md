# two_part — multi-part VCarve report

- P01_bottom: stock 60.0 x 40.0 x 10.0 mm, flip_x=False rot_z=0.0, layers 3
- P02_lid: stock 60.0 x 40.0 x 8.0 mm, flip_x=True rot_z=0.0, layers 3

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 1 tool(s), 0 manual change(s), est 2.1 min total (cutting 2.1 + changes 0.0). Times are estimates, not promises.
- T1: End Mill 3/16 in (4.76 mm) — feed 23.81 mm/s, plunge 7.94 mm/s, 20000 rpm, stepdown 2.381 mm, stepover 1.905 mm
Cut order (tool changes marked):
- P01_bottom__DRILL_D6.00_THRU (drill, bore): est 6 s — bore with End Mill 3/16 in (4.76 mm) (no drill in this plan)
- P02_lid__DRILL_D8.00_THRU (drill, bore): est 6 s — bore with End Mill 3/16 in (4.76 mm) (no drill in this plan)
- P01_bottom__POCKET_D4.00 (pocket, endmill): est 17 s — largest endmill that fits
- P02_lid__POCKET_D3.00 (pocket, endmill): est 13 s — largest endmill that fits
- P01_bottom__PROFILE_THRU (profile, endmill): est 47 s — largest endmill that fits
- P02_lid__PROFILE_THRU (profile, endmill): est 38 s — largest endmill that fits
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 1 change(s), est 3.2 min — T1 End Mill 3/16 in (4.76 mm), T2 End Mill 1/2 in (12.70 mm)
- Plan C: 2 tool(s), 1 change(s), est 3.3 min — T1 End Mill 3/16 in (4.76 mm), T2 End Mill 3/8 in (9.53 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- none
