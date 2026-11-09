# beveled_plate — VCarve report

Stock: 80.00 x 60.00 x 10.00 mm, Z 0.00..10.00

Layers (3):

- DRILL_D8.00_THRU: drill, start 0.00, cut 10.00, 1 segments
- POCKET_D4.00: pocket, start 0.00, cut 4.00, 4 segments
- PROFILE_THRU: profile, start 0.00, cut 10.00, 4 segments

Holes (1):
- thru D8.00 at (20.00,15.00) Z 0.00..10.00

Pockets (1):
- floor Z 6.00, total depth 4.00, start 0.00, cut 4.00

Post-processing plan (3 steps — features the prismatic blank does not have):
- [cnc_3d] fillet R2.00 mm at pocket floor (Z 6.00) (x4 faces): Cut the pocket-floor fillet on the CNC with a ball-nose 3D finish pass — a router table cannot reach a floor fillet. Or leave the corner sharp.
- [router_table] chamfer 45 deg, 2.00 mm tall at outer top edge (x4 faces): Chamfer the top outer edge on the router table after the CNC cut. Alternative: CNC: chamfer tool / V-bit.
- [drill_press] countersink semi-angle 45.0 deg at hole D8.00 at (20.00,15.00): Countersink the hole on the drill press after drilling. Alternative: CNC: chamfer tool.

Flags — read before cutting:
- COUNTERSUNK THRU HOLE: dia 8.00 at (20.00,15.00) under a 45 deg countersink — treated as thru
- PROFILE OUTLINE DIFFERS top vs bottom by 11% (top 4241 mm2, bottom 4783 mm2) — profile taken from Z 0.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- POST-PROCESS [cnc_3d]: fillet R2.00 mm at pocket floor (Z 6.00) (x4 faces) — Cut the pocket-floor fillet on the CNC with a ball-nose 3D finish pass — a router table cannot reach a floor fillet. Or leave the corner sharp.
- POST-PROCESS [router_table]: chamfer 45 deg, 2.00 mm tall at outer top edge (x4 faces) — Chamfer the top outer edge on the router table after the CNC cut.
- POST-PROCESS [drill_press]: countersink semi-angle 45.0 deg at hole D8.00 at (20.00,15.00) — Countersink the hole on the drill press after drilling.
