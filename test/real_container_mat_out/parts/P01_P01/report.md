# P01_P01 — VCarve report

Stock: 46.00 x 46.00 x 9.50 mm, Z 0.00..9.50

Material: none given — suggested 50 x 50 x 10 mm (footprint rounded up to 10 mm).

Layers (4):

- POCKET_D1.50: pocket, start 0.00, cut 1.50, 3 segments
- DRILL_D2.25_D1.55_START1.50: drill, start 1.50, cut 1.55, 8 segments
- POCKET_D6.50_START1.50: pocket, start 1.50, cut 5.00, 1 segments
- PROFILE_THRU: profile, start 0.00, cut 9.50, 1 segments

Holes (8):
- internal D2.25 at (22.50,43.00) Z 6.45..8.00
- internal D2.25 at (28.50,28.50) Z 6.45..8.00
- internal D2.25 at (28.50,57.50) Z 6.45..8.00
- internal D2.25 at (43.00,22.50) Z 6.45..8.00
- internal D2.25 at (43.00,63.50) Z 6.45..8.00
- internal D2.25 at (57.50,28.50) Z 6.45..8.00
- internal D2.25 at (57.50,57.50) Z 6.45..8.00
- internal D2.25 at (63.50,43.00) Z 6.45..8.00

Pockets (2):
- floor Z 8.00, total depth 1.50, start 0.00, cut 1.50
- floor Z 3.00, total depth 6.50, start 1.50, cut 5.00

Post-processing plan (1 steps — features the prismatic blank does not have):
- [router_table] sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge: Round over the outer edge on the router table after the CNC cut — pick a roundover bit close to the modelled profile; it does not have to match exactly. Alternative: CNC 3D instead: 3D rough + finish from an STL in VCarve — but this face is on the bottom of the stock, so that needs a two-sided setup (flip + registration).

Flags — read before cutting:
- PROFILE OUTLINE DIFFERS top vs bottom by 11% (top 969 mm2, bottom 867 mm2) — profile taken from Z 8.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- POST-PROCESS [router_table]: sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge — Round over the outer edge on the router table after the CNC cut — pick a roundover bit close to the modelled profile; it does not have to match exactly.
- DRILL FROM SURFACE: dia 2.25 at (22.50,43.00) opens on the Z 8.00 face — POCKET_D1.50 faces it down first (start depth 1.50 mm), then drill 1.55 mm from there
- POCKET ISLAND at floor Z 8.00 — a rib/boss rises above the floor inside the pocket outline; its outline is in the DXF as an island and the pocket clears around it (verify the island in VCarve)
