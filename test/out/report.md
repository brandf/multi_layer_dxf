# test_part — VCarve report

Stock: 100.00 x 80.00 x 12.00 mm, Z 0.00..12.00

Layers (8):

- DRILL_D6.00_THRU: drill, start 0.00, cut 12.00, 4 segments
- DRILL_D8.00_D5.00: drill, start 0.00, cut 5.00, 1 segments
- DRILL_D10.00_THRU: drill, start 0.00, cut 12.00, 1 segments
- POCKET_D4.00: pocket, start 0.00, cut 4.00, 5 segments
- POCKET_D6.00: pocket, start 0.00, cut 6.00, 4 segments
- POCKET_D9.00_START6.00: pocket, start 6.00, cut 3.00, 4 segments
- THROUGH_CUT: profile, start 0.00, cut 12.00, 4 segments
- PROFILE_THRU: profile, start 0.00, cut 12.00, 4 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 1 manual change(s), est 4.3 min total (cutting 2.3 + changes 2.0). Times are estimates, not promises.
- T1: Drill 6.00 mm — feed 9.0 mm/s, plunge 9.0 mm/s, 20000 rpm, stepdown 3.0 mm, peck drilling
- T2: End Mill 1/4 in (6.35 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 2.54 mm
Cut order (tool changes marked):
- DRILL_D6.00_THRU (drill, drill): est 16 s — drill
  — change to T2 (End Mill 1/4 in (6.35 mm)) —
- DRILL_D8.00_D5.00 (drill, bore): est 3 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- DRILL_D10.00_THRU (drill, bore): est 6 s — bore with End Mill 1/4 in (6.35 mm) (no drill in this plan)
- POCKET_D4.00 (pocket, endmill): est 10 s — largest endmill that fits
- POCKET_D6.00 (pocket, endmill): est 33 s — largest endmill that fits
- POCKET_D9.00_START6.00 (pocket, endmill): est 5 s — largest endmill that fits
- THROUGH_CUT (profile, endmill): est 14 s — largest endmill that fits — tabs x2 (5.0 x 1.0 mm)
- PROFILE_THRU (profile, endmill): est 52 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 1 tool(s), 0 change(s), est 4.4 min — T1 End Mill 3/16 in (4.76 mm)
- Plan C: 2 tool(s), 1 change(s), est 4.5 min — T1 End Mill 3/16 in (4.76 mm), T2 End Mill 1/4 in (6.35 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (6):
- thru D6.00 at (-35.00,-25.00) Z 0.00..12.00
- thru D6.00 at (-35.00,25.00) Z 0.00..12.00
- blind_top D8.00 at (0.00,-25.00) Z 7.00..12.00
- thru D10.00 at (25.00,-20.00) Z 0.00..12.00
- thru D6.00 at (35.00,-25.00) Z 0.00..12.00
- thru D6.00 at (35.00,25.00) Z 0.00..12.00

Pockets (3):
- floor Z 8.00, total depth 4.00, start 0.00, cut 4.00
- floor Z 6.00, total depth 6.00, start 0.00, cut 6.00
- floor Z 3.00, total depth 9.00, start 6.00, cut 3.00

Post-processing plan (0 steps — features the prismatic blank does not have):
- none — part is fully prismatic

Flags — read before cutting:
- THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
