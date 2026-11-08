# test_part — VCarve report

Stock: 100.00 x 80.00 x 12.00 mm, Z 0.00..12.00

Layers (8):

- DRILL_D8.00_D5.00: drill, start 0.00, cut 5.00, 1 segments
- DRILL_D6.00_THRU: drill, start 0.00, cut 12.00, 4 segments
- DRILL_D10.00_THRU: drill, start 0.00, cut 12.00, 1 segments
- POCKET_D4.00: pocket, start 0.00, cut 4.00, 5 segments
- POCKET_D6.00: pocket, start 0.00, cut 6.00, 4 segments
- POCKET_D9.00_START6.00: pocket, start 6.00, cut 3.00, 4 segments
- THROUGH_CUT: profile, start 0.00, cut 12.00, 4 segments
- PROFILE_THRU: profile, start 0.00, cut 12.00, 4 segments

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

Flags — read before cutting:
- THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
