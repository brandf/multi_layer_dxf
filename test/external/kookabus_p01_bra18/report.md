# P01_P01 — VCarve report

Stock: 139.00 x 105.50 x 21.80 mm, Z 0.00..21.80

Material: none given — suggested 140 x 110 x 22 mm (footprint rounded up to 10 mm).

Layers (8):

- POCKET_D18.80: pocket, start 0.00, cut 18.80, 16 segments
- DRILL_D2.90_D0.80_START18.80: drill, start 18.80, cut 0.80, 6 segments
- POCKET_D2.40: pocket, start 0.00, cut 2.40, 4 segments
- POCKET_D9.70: pocket, start 0.00, cut 9.70, 4 segments
- POCKET_D11.30: pocket, start 0.00, cut 11.30, 4 segments
- POCKET_D12.20: pocket, start 0.00, cut 12.20, 4 segments
- POCKET_D13.80: pocket, start 0.00, cut 13.80, 8 segments
- PROFILE_THRU: profile, start 0.00, cut 21.80, 8 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 2 manual change(s), est 55.8 min total (cutting 51.8 + changes 4.0). Times are estimates, not promises.
- T1: End Mill 1/2 in (12.70 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 5.08 mm
- T2: End Mill 1.00 mm — feed 8.0 mm/s, plunge 2.67 mm/s, 20000 rpm, stepdown 0.5 mm, stepover 0.4 mm
Cut order (tool changes marked):
- POCKET_D18.80 (pocket, endmill): est 543 s — largest endmill that fits
  — change to T2 (End Mill 1.00 mm) —
- DRILL_D2.90_D0.80_START18.80 (drill, bore): est 18 s — bore with End Mill 1.00 mm (no drill in this plan)
- POCKET_D2.40 (pocket, endmill): est 61 s — largest endmill that fits
- POCKET_D9.70 (pocket, endmill): est 92 s — largest endmill that fits
- POCKET_D11.30 (pocket, endmill): est 391 s — largest endmill that fits
- POCKET_D12.20 (pocket, endmill): est 173 s — largest endmill that fits
- POCKET_D13.80 (pocket, endmill): est 1692 s — largest endmill that fits
  — change to T1 (End Mill 1/2 in (12.70 mm)) —
- PROFILE_THRU (profile, endmill): est 135 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 3 tool(s), 3 change(s), est 57.5 min — T1 End Mill 1/2 in (12.70 mm), T2 Drill 2.90 mm, T3 End Mill 1.00 mm
- Plan C: 2 tool(s), 2 change(s), est 58.7 min — T1 End Mill 3/8 in (9.53 mm), T2 End Mill 1.00 mm
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 2 change(s), est 2644.9 min — T1 End Mill 1.00 mm, T2 End Mill 0.80 mm
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (18):
- blind_bottom D3.40 at (25.50,26.75) Z 0.00..1.45
- blind_bottom D3.40 at (25.50,78.75) Z 0.00..1.45
- internal D2.90 at (32.50,6.50) Z 2.20..3.00
- internal D2.90 at (32.50,63.50) Z 2.20..3.00
- internal D2.90 at (33.25,77.90) Z 2.20..3.00
- internal D2.90 at (33.25,93.20) Z 2.20..3.00
- internal D4.00 at (91.00,13.50) Z 3.00..10.20
- internal D7.00 at (91.00,13.50) Z 3.00..10.20
- internal D4.00 at (91.00,56.50) Z 3.00..10.20
- internal D7.00 at (91.00,56.50) Z 3.00..10.20
- internal D2.90 at (105.75,77.90) Z 2.20..3.00
- internal D2.90 at (105.75,93.20) Z 2.20..3.00
- blind_bottom D3.40 at (113.50,26.75) Z 0.00..1.45
- blind_bottom D3.40 at (113.50,78.75) Z 0.00..1.45
- internal D4.00 at (132.00,13.50) Z 3.00..10.20
- internal D7.00 at (132.00,13.50) Z 3.00..10.20
- internal D4.00 at (132.00,56.50) Z 3.00..10.20
- internal D7.00 at (132.00,56.50) Z 3.00..10.20

Pockets (7):
- floor Z 19.40, total depth 2.40, start 0.00, cut 2.40
- floor Z 12.10, total depth 9.70, start 0.00, cut 9.70
- floor Z 10.50, total depth 11.30, start 0.00, cut 11.30
- floor Z 9.60, total depth 12.20, start 0.00, cut 12.20
- floor Z 8.00, total depth 13.80, start 0.00, cut 13.80
- floor Z 8.00, total depth 13.80, start 0.00, cut 13.80
- floor Z 3.00, total depth 18.80, start 0.00, cut 18.80

Post-processing plan (3 steps — features the prismatic blank does not have):
- [router_table] fillet R1.00 mm at outer bottom edge (x8 faces): Round over the bottom outer edge on the router table (flip the part over) after the CNC cut. Alternative: CNC: roundover bit in the spindle.
- [cnc_3d] chamfer 90 deg, 2.20 mm tall at pocket floor (Z 3.00) (x24 faces): Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.
- [cnc_3d] chamfer 45 deg, 1.55 mm tall at pocket floor (Z 3.00) (x4 faces): Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.

Flags — read before cutting:
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (4.00,4.00) r=1.00 span=90deg Z 3.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (4.00,4.00) r=4.00 span=90deg Z 1.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (4.00,101.50) r=1.00 span=90deg Z 3.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (4.00,101.50) r=4.00 span=90deg Z 1.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (135.00,4.00) r=1.00 span=90deg Z 3.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (135.00,4.00) r=4.00 span=90deg Z 1.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (135.00,101.50) r=1.00 span=90deg Z 3.00..21.80
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (135.00,101.50) r=4.00 span=90deg Z 1.00..21.80
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 2.20, depth 2.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 15.00, depth 15.00 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 17.50, depth 17.50 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 21.20, depth 21.20 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- PROFILE OUTLINE DIFFERS top vs bottom by 90% (top 1365 mm2, bottom 14172 mm2) — profile taken from Z 0.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- VERTICAL WALLS EXTEND 1.00 mm BEYOND PROFILE — edge fillet/chamfer on both top and bottom, profile may be undersized; check the wall footprint before cutting
- POST-PROCESS [router_table]: fillet R1.00 mm at outer bottom edge (x8 faces) — Round over the bottom outer edge on the router table (flip the part over) after the CNC cut.
- POST-PROCESS [cnc_3d]: chamfer 90 deg, 2.20 mm tall at pocket floor (Z 3.00) (x24 faces) — Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.
- POST-PROCESS [cnc_3d]: chamfer 45 deg, 1.55 mm tall at pocket floor (Z 3.00) (x4 faces) — Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.
- HOLE NOT FROM TOP (blind_bottom): dia 3.40 at (25.50,26.75) Z 0.00..1.45 — no toolpath emitted
- HOLE NOT FROM TOP (blind_bottom): dia 3.40 at (25.50,78.75) Z 0.00..1.45 — no toolpath emitted
- HOLE NOT FROM TOP (blind_bottom): dia 3.40 at (113.50,26.75) Z 0.00..1.45 — no toolpath emitted
- HOLE NOT FROM TOP (blind_bottom): dia 3.40 at (113.50,78.75) Z 0.00..1.45 — no toolpath emitted
- DRILL FROM SURFACE: dia 2.90 at (32.50,6.50) opens on the Z 3.00 face — POCKET_D18.80 faces it down first (start depth 18.80 mm), then drill 0.80 mm from there
- HOLE NOT FROM TOP (internal): dia 4.00 at (91.00,13.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 4.00 at (91.00,56.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 4.00 at (132.00,13.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 4.00 at (132.00,56.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 7.00 at (91.00,13.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 7.00 at (91.00,56.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 7.00 at (132.00,13.50) Z 3.00..10.20 — no toolpath emitted
- HOLE NOT FROM TOP (internal): dia 7.00 at (132.00,56.50) Z 3.00..10.20 — no toolpath emitted
- POCKET INNER WIRE at floor Z 3.00 (island / hole through floor) — check report, inner wire not auto-tooled
- POCKET INNER WIRE at floor Z 3.00 (island / hole through floor) — check report, inner wire not auto-tooled
- POCKET INNER WIRE at floor Z 3.00 (island / hole through floor) — check report, inner wire not auto-tooled
- POCKET INNER WIRE at floor Z 3.00 (island / hole through floor) — check report, inner wire not auto-tooled
