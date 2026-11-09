# P02_P02 — VCarve report

Stock: 46.00 x 46.00 x 8.00 mm, Z -0.00..8.00

Layers (4):

- DRILL_D2.25_D1.55: drill, start 0.00, cut 1.55, 8 segments
- POCKET_D1.50: pocket, start 0.00, cut 1.50, 1 segments
- POCKET_D5.00_START1.50: pocket, start 1.50, cut 3.50, 1 segments
- PROFILE_THRU: profile, start 0.00, cut 8.00, 1 segments

Holes (8):
- blind_top D2.25 at (58.50,23.00) Z 6.45..8.00
- blind_top D2.25 at (64.50,8.50) Z 6.45..8.00
- blind_top D2.25 at (64.50,37.50) Z 6.45..8.00
- blind_top D2.25 at (79.00,2.50) Z 6.45..8.00
- blind_top D2.25 at (79.00,43.50) Z 6.45..8.00
- blind_top D2.25 at (93.50,8.50) Z 6.45..8.00
- blind_top D2.25 at (93.50,37.50) Z 6.45..8.00
- blind_top D2.25 at (99.50,23.00) Z 6.45..8.00

Pockets (2):
- floor Z 6.50, total depth 1.50, start 0.00, cut 1.50
- floor Z 3.00, total depth 5.00, start 1.50, cut 3.50

Post-processing plan (1 steps — features the prismatic blank does not have):
- [cnc_3d] sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge: Sculpted surface: 3D rough + finish from an STL in VCarve, or hand shaping.

Flags — read before cutting:
- PROFILE OUTLINE DIFFERS top vs bottom by 45% (top 1587 mm2, bottom 867 mm2) — profile taken from Z 8.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- POST-PROCESS [cnc_3d]: sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge — Sculpted surface: 3D rough + finish from an STL in VCarve, or hand shaping.
