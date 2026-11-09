# P02_P02 — VCarve report

Stock: 60.00 x 60.00 x 15.00 mm, Z 0.00..15.00

Layers (4):

- DRILL_D6.00_THRU: drill, start 0.00, cut 15.00, 2 segments
- POCKET_D5.00: pocket, start 0.00, cut 5.00, 6 segments
- DRILL_D8.00_D6.00_START5.00: drill, start 5.00, cut 6.00, 1 segments
- PROFILE_THRU: profile, start 0.00, cut 15.00, 4 segments

Holes (3):
- thru D6.00 at (80.00,10.00) Z 0.00..15.00
- internal D8.00 at (100.00,30.00) Z 4.00..10.00
- thru D6.00 at (120.00,50.00) Z 0.00..15.00

Pockets (1):
- floor Z 10.00, total depth 5.00, start 0.00, cut 5.00

Post-processing plan (0 steps — features the prismatic blank does not have):
- none — part is fully prismatic

Flags — read before cutting:
- DRILL FROM SURFACE: dia 8.00 at (100.00,30.00) opens on the Z 10.00 face — POCKET_D5.00 faces it down first (start depth 5.00 mm), then drill 6.00 mm from there
