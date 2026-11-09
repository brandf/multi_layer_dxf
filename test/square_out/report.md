# square — VCarve report

Stock: 80.00 x 60.00 x 10.00 mm, Z 0.00..10.00

Layers (3):

- DRILL_D10.00_THRU: drill, start 0.00, cut 10.00, 1 segments
- POCKET_D5.00: pocket, start 0.00, cut 5.00, 4 segments
- PROFILE_THRU: profile, start 0.00, cut 10.00, 4 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 1 tool(s), 0 manual change(s), est 1.4 min total (cutting 1.4 + changes 0.0). Times are estimates, not promises.
- T1: End Mill 1/4 in (6.35 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 2.54 mm
Cut order (tool changes marked):
- DRILL_D10.00_THRU (drill, bore): est 6 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- POCKET_D5.00 (pocket, endmill): est 37 s — largest endmill that fits
- PROFILE_THRU (profile, endmill): est 41 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 1 tool(s), 0 change(s), est 2.5 min — T1 End Mill 3/16 in (4.76 mm)
- Plan C: 2 tool(s), 1 change(s), est 3.1 min — T1 Drill 10.00 mm, T2 End Mill 1/2 in (12.70 mm)
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 2 change(s), est 5.8 min — T1 End Mill 1/4 in (6.35 mm), T2 End Mill 3/16 in (4.76 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (1):
- thru D10.00 at (65.00,30.00) Z 0.00..10.00

Pockets (1):
- floor Z 5.00, total depth 5.00, start 0.00, cut 5.00

Post-processing plan (0 steps — features the prismatic blank does not have):
- none — part is fully prismatic

Flags — read before cutting:
- none
