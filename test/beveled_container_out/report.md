# beveled_container — VCarve report

Stock: 100.00 x 100.00 x 12.00 mm, Z 0.00..12.00

Layers (3):

- DRILL_D5.00_THRU: drill, start 0.00, cut 12.00, 8 segments
- POCKET_D6.00: pocket, start 0.00, cut 6.00, 1 segments
- PROFILE_THRU: profile, start 0.00, cut 12.00, 1 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 1 manual change(s), est 4.0 min total (cutting 2.0 + changes 2.0). Times are estimates, not promises.
- T1: Drill 5.00 mm — feed 7.5 mm/s, plunge 7.5 mm/s, 20000 rpm, stepdown 2.5 mm, peck drilling
- T2: End Mill 1/2 in (12.70 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 5.08 mm
Cut order (tool changes marked):
- DRILL_D5.00_THRU (drill, drill): est 41 s — drill
  — change to T2 (End Mill 1/2 in (12.70 mm)) —
- POCKET_D6.00 (pocket, endmill): est 33 s — largest endmill that fits
- PROFILE_THRU (profile, endmill): est 46 s — largest endmill that fits
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 1 change(s), est 4.2 min — T1 Drill 5.00 mm, T2 End Mill 3/8 in (9.53 mm)
- Plan C: 2 tool(s), 1 change(s), est 4.5 min — T1 Drill 5.00 mm, T2 End Mill 1/4 in (6.35 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (8):
- thru D5.00 at (-42.00,0.00) Z 0.00..12.00
- thru D5.00 at (-29.70,-29.70) Z 0.00..12.00
- thru D5.00 at (-29.70,29.70) Z 0.00..12.00
- thru D5.00 at (-0.00,-42.00) Z 0.00..12.00
- thru D5.00 at (0.00,42.00) Z 0.00..12.00
- thru D5.00 at (29.70,-29.70) Z 0.00..12.00
- thru D5.00 at (29.70,29.70) Z 0.00..12.00
- thru D5.00 at (42.00,0.00) Z 0.00..12.00

Pockets (1):
- floor Z 6.00, total depth 6.00, start 0.00, cut 6.00

Post-processing plan (3 steps — features the prismatic blank does not have):
- [cnc_3d] fillet R2.00 mm at pocket floor (Z 6.00): Cut the pocket-floor fillet on the CNC with a ball-nose 3D finish pass — a router table cannot reach a floor fillet. Or leave the corner sharp.
- [hand_router] chamfer 45 deg, 2.00 mm tall at pocket top edge (floor Z 6.00): Chamfer the pocket's top edge with a handheld router (bearing-guided bit). Alternative: CNC: chamfer tool.
- [router_table] fillet R3.00 mm at outer top edge: Round over the top outer edge on the router table after the CNC cut. Alternative: CNC: roundover bit in the spindle, or a ball-nose 3D finish pass.

Flags — read before cutting:
- PROFILE OUTLINE DIFFERS top vs bottom by 12% (top 6627 mm2, bottom 7500 mm2) — profile taken from Z 0.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- POST-PROCESS [cnc_3d]: fillet R2.00 mm at pocket floor (Z 6.00) — Cut the pocket-floor fillet on the CNC with a ball-nose 3D finish pass — a router table cannot reach a floor fillet. Or leave the corner sharp.
- POST-PROCESS [hand_router]: chamfer 45 deg, 2.00 mm tall at pocket top edge (floor Z 6.00) — Chamfer the pocket's top edge with a handheld router (bearing-guided bit).
- POST-PROCESS [router_table]: fillet R3.00 mm at outer top edge — Round over the top outer edge on the router table after the CNC cut.
