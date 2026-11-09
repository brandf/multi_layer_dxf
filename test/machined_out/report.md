# machined — VCarve report

Stock: 120.00 x 80.00 x 14.00 mm, Z 0.00..14.00

Layers (9):

- DRILL_D8.00_D5.00: drill, start 0.00, cut 5.00, 1 segments
- DRILL_D12.00_D3.00: drill, start 0.00, cut 3.00, 1 segments
- DRILL_D5.00_THRU: drill, start 0.00, cut 14.00, 4 segments
- DRILL_D6.00_THRU: drill, start 0.00, cut 14.00, 1 segments
- POCKET_D3.00: pocket, start 0.00, cut 3.00, 4 segments
- POCKET_D5.00: pocket, start 0.00, cut 5.00, 6 segments
- POCKET_D9.00_START5.00: pocket, start 5.00, cut 4.00, 4 segments
- THROUGH_CUT: profile, start 0.00, cut 14.00, 4 segments
- PROFILE_THRU: profile, start 0.00, cut 14.00, 8 segments

Holes (8):
- thru D5.00 at (-50.00,-30.00) Z 0.00..14.00
- thru D5.00 at (-50.00,30.00) Z 0.00..14.00
- blind_bottom D5.00 at (-45.00,-28.00) Z 0.00..4.00
- blind_top D8.00 at (0.00,-28.00) Z 9.00..14.00
- thru D6.00 at (35.00,-20.00) Z 0.00..14.00
- blind_top D12.00 at (35.00,-20.00) Z 11.00..14.00
- thru D5.00 at (50.00,-30.00) Z 0.00..14.00
- thru D5.00 at (50.00,30.00) Z 0.00..14.00

Pockets (4):
- floor Z 11.00, total depth 3.00, start 0.00, cut 3.00
- floor Z 9.00, total depth 5.00, start 0.00, cut 5.00
- floor Z 8.00, total depth 6.00, start 0.00, cut 6.00 — SUPPRESSED, no toolpath (non-vertical walls)
- floor Z 5.00, total depth 9.00, start 5.00, cut 4.00

Flags — read before cutting:
- NON-PRISMATIC / REVIEW: surface type GeomAbs_SurfaceType.GeomAbs_BSplineSurface, centre Z 11.05 (area 139.8 mm2, centre (10.0, 20.52084970183144, 11.04611455525064))
- NON-PRISMATIC / REVIEW: surface type GeomAbs_SurfaceType.GeomAbs_BSplineSurface, centre Z 11.07 (area 91.0 mm2, centre (21.48350378206738, 28.0, 11.070804389338019))
- NON-PRISMATIC / REVIEW: surface type GeomAbs_SurfaceType.GeomAbs_BSplineSurface, centre Z 11.05 (area 139.8 mm2, centre (10.0, 35.47915029816856, 11.04611455525064))
- NON-PRISMATIC / REVIEW: surface type GeomAbs_SurfaceType.GeomAbs_BSplineSurface, centre Z 11.07 (area 91.0 mm2, centre (-1.4835037820673818, 28.0, 11.070804389338019))
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (-52.00,-32.00) r=8.00 span=90deg Z 0.00..14.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (-52.00,32.00) r=8.00 span=90deg Z 0.00..14.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (52.00,-32.00) r=8.00 span=90deg Z 0.00..14.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (52.00,32.00) r=8.00 span=90deg Z 0.00..14.00
- COUNTERBORE THRU HOLE: dia 6.00 at (35.00,-20.00) under D12.00 counterbore — treated as thru
- THROUGH FEATURE MERGED WITH POCKET on top face — recovered from bottom face as THROUGH_CUT (verify the outline in VCarve)
- HOLE NOT FROM TOP (blind_bottom): dia 5.00 at (-45.00,-28.00) Z 0.00..4.00 — no toolpath emitted
- POCKET SUPPRESSED (non-vertical walls, no toolpath): floor Z 8.00, depth 6.00 — surface type GeomAbs_SurfaceType.GeomAbs_BSplineSurface, centre Z 11.05
- THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
