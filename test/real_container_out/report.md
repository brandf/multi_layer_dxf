# real_container — multi-part VCarve report

Material: none given — suggested 170 x 90 x 10 mm (packed layout + 20 mm clamp margin, rounded up to 10 mm).
Spacing (BRA-16 tool rule): gaps are max(10.0 mm, D_A + D_B + 5.0 mm web); profile tools: P01_P01 12.70 mm, P02_P02 12.70 mm. verified against plan A (profile tools P01_P01 12.70 mm, P02_P02 12.70 mm).
- P01_P01: stock 46.0 x 46.0 x 9.5 mm, flip_x=False rot_z=0.0, layers 4, at (0.0, 0.0) [search: best +Z (+Z 6.9; -Z 41.4; +X 145.0; -X 145.0; +Y 145.0; -Y 145.0)]
- P02_P02: stock 46.0 x 46.0 x 8.0 mm, flip_x=False rot_z=0.0, layers 4, at (76.4, 0.0) [search: best -Z (-Z 4.7; +Z 41.3; +X 145.0; -X 145.0; +Y 145.0; -Y 145.0)]

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 2 tool(s), 2 manual change(s), est 5.6 min total (cutting 1.6 + changes 4.0). Times are estimates, not promises.
- T1: End Mill 1/2 in (12.70 mm) — feed 30.0 mm/s, plunge 10.0 mm/s, 20000 rpm, stepdown 3.0 mm, stepover 5.08 mm
- T2: Drill 2.25 mm — feed 4.0 mm/s, plunge 4.0 mm/s, 20000 rpm, stepdown 1.125 mm, peck drilling
Cut order (tool changes marked):
- P01_P01__POCKET_D1.50 (pocket, endmill): est 6 s — largest endmill that fits
- P01_P01__POCKET_D6.50_START1.50 (pocket, endmill): est 9 s — largest endmill that fits
- P02_P02__POCKET_D1.50 (pocket, endmill): est 4 s — largest endmill that fits
- P02_P02__POCKET_D5.00_START1.50 (pocket, endmill): est 7 s — largest endmill that fits
  — change to T2 (Drill 2.25 mm) —
- P01_P01__DRILL_D2.25_D1.55_START1.50 (drill, drill): est 13 s — drill
- P02_P02__DRILL_D2.25_D1.55 (drill, drill): est 13 s — drill
  — change to T1 (End Mill 1/2 in (12.70 mm)) —
- P01_P01__PROFILE_THRU (profile, endmill): est 23 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- P02_P02__PROFILE_THRU (profile, endmill): est 18 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 2 tool(s), 2 change(s), est 5.7 min — T1 End Mill 3/8 in (9.53 mm), T2 Drill 2.25 mm
- Plan C: 2 tool(s), 2 change(s), est 5.9 min — T1 End Mill 1/2 in (12.70 mm), T2 End Mill 1/16 in (1.59 mm)
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Flags — read before cutting:
- [P01_P01] PROFILE OUTLINE DIFFERS top vs bottom by 11% (top 969 mm2, bottom 867 mm2) — profile taken from Z 8.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- [P01_P01] POST-PROCESS [router_table]: sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge — Round over the outer edge on the router table after the CNC cut — pick a roundover bit close to the modelled profile; it does not have to match exactly.
- [P01_P01] DRILL FROM SURFACE: dia 2.25 at (2.50,23.00) opens on the Z 8.00 face — POCKET_D1.50 faces it down first (start depth 1.50 mm), then drill 1.55 mm from there
- [P01_P01] POCKET ISLAND at floor Z 8.00 — a rib/boss rises above the floor inside the pocket outline; its outline is in the DXF as an island and the pocket clears around it (verify the island in VCarve)
- [P02_P02] PROFILE OUTLINE DIFFERS top vs bottom by 45% (top 1587 mm2, bottom 867 mm2) — profile taken from Z 8.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- [P02_P02] POST-PROCESS [router_table]: sculpted surface GeomAbs_SurfaceType.GeomAbs_BSplineSurface at outer bottom edge — Round over the outer edge on the router table after the CNC cut — pick a roundover bit close to the modelled profile; it does not have to match exactly.
