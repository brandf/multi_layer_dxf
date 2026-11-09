# donut — VCarve report

Stock: 100.00 x 100.00 x 10.00 mm, Z 0.00..10.00

Layers (2):

- THROUGH_CUT: profile, start 0.00, cut 10.00, 1 segments
- PROFILE_THRU: profile, start 0.00, cut 10.00, 1 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 1 tool(s), 0 manual change(s), est 1.2 min total (cutting 1.2 + changes 0.0). Times are estimates, not promises.
- T1: End Mill 1/2 in (12.70 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 5.08 mm
Cut order (tool changes marked):
- THROUGH_CUT (profile, endmill): est 29 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
- PROFILE_THRU (profile, endmill): est 46 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 1 tool(s), 0 change(s), est 1.2 min — T1 End Mill 3/8 in (9.53 mm)
- Plan C: 1 tool(s), 0 change(s), est 1.2 min — T1 End Mill 1/4 in (6.35 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (0):

Pockets (0):

Post-processing plan (0 steps — features the prismatic blank does not have):
- none — part is fully prismatic

Flags — read before cutting:
- THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
