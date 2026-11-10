# P03_P03 — VCarve report

Stock: 100.00 x 64.00 x 9.00 mm, Z 0.00..9.00

Material: none given — suggested 100 x 70 x 9 mm (footprint rounded up to 10 mm).

Layers (5):

- DRILL_D3.40_D0.40: drill, start 0.00, cut 0.40, 4 segments
- POCKET_D4.20: pocket, start 0.00, cut 4.20, 8 segments
- DRILL_D5.00_D3.00: drill, start 0.00, cut 3.00, 3 segments
- THROUGH_CUT: profile, start 0.00, cut 9.00, 8 segments
- PROFILE_THRU: profile, start 0.00, cut 9.00, 8 segments

Tool plan (recommendations from standard sizes — review against your VCarve library):
Tool plan A (chosen, fastest estimate): 3 tool(s), 2 manual change(s), est 9.9 min total (cutting 5.9 + changes 4.0). Times are estimates, not promises.
- T1: Drill 3.40 mm — feed 5.1 mm/s, plunge 5.1 mm/s, 20000 rpm, stepdown 1.7 mm, peck drilling
- T2: End Mill 1.00 mm — feed 8.0 mm/s, plunge 2.67 mm/s, 20000 rpm, stepdown 0.5 mm, stepover 0.4 mm
- T3: End Mill 1/8 in (3.17 mm) — feed 15.88 mm/s, plunge 5.29 mm/s, 20000 rpm, stepdown 1.587 mm, stepover 1.27 mm
Cut order (tool changes marked):
- DRILL_D3.40_D0.40 (drill, drill): est 2 s — drill
  — change to T2 (End Mill 1.00 mm) —
- POCKET_D4.20 (pocket, endmill): est 174 s — largest endmill that fits
  — change to T3 (End Mill 1/8 in (3.17 mm)) —
- DRILL_D5.00_D3.00 (drill, bore): est 9 s — bore with End Mill 1/8 in (3.17 mm) (no drill in this plan)
- THROUGH_CUT (profile, endmill): est 43 s — largest endmill that fits — tabs x3 (5.0 x 1.0 mm)
- PROFILE_THRU (profile, endmill): est 127 s — largest endmill that fits — tabs x4 (5.0 x 1.0 mm)
Fallback plans (same DXF, run manifest_plan_<id>.txt instead):
- Plan B: 3 tool(s), 2 change(s), est 10.0 min — T1 Drill 5.00 mm, T2 End Mill 1.00 mm, T3 End Mill 1/8 in (3.17 mm)
- Plan C: 2 tool(s), 2 change(s), est 10.0 min — T1 End Mill 1/8 in (3.17 mm), T2 End Mill 1.00 mm
- Plan D (two-pass finish — sharper pocket corners): 2 tool(s), 2 change(s), est 24.3 min — T1 End Mill 1.00 mm, T2 End Mill 0.80 mm
Review the tools against your VCarve library before cutting — the gadget asks you to pick each one from the library, or uses the recommendation above if you cancel.

Holes (7):
- blind_top D3.40 at (344.80,6.00) Z 8.60..9.00
- blind_top D3.40 at (344.80,58.00) Z 8.60..9.00
- blind_top D5.00 at (351.80,42.75) Z 6.00..9.00
- blind_top D5.00 at (352.55,57.15) Z 6.00..9.00
- blind_top D5.00 at (425.05,57.15) Z 6.00..9.00
- blind_top D3.40 at (432.80,6.00) Z 8.60..9.00
- blind_top D3.40 at (432.80,58.00) Z 8.60..9.00

Pockets (2):
- floor Z 4.80, total depth 4.20, start 0.00, cut 4.20
- floor Z 4.80, total depth 4.20, start 0.00, cut 4.20

Post-processing plan (17 steps — features the prismatic blank does not have):
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (342.3,7.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (347.3,7.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (342.3,4.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (347.3,4.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (430.3,7.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (435.3,7.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (430.3,4.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (435.3,4.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (342.3,59.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (347.3,59.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (342.3,56.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (347.3,56.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (430.3,59.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (435.3,59.4), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (430.3,56.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [decision_needed] chamfer 90 deg, 2.60 mm tall at face at (435.3,56.6), Z 7.30: No automatic call — decide CNC vs post-process by hand for this feature.
- [cnc_3d] chamfer 45 deg, 1.50 mm tall at pocket floor (Z 4.80): Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.

Flags — read before cutting:
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (342.80,4.00) r=4.00 span=90deg Z 6.00..9.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (342.80,60.00) r=4.00 span=90deg Z 6.00..9.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (434.80,4.00) r=4.00 span=90deg Z 6.00..9.00
- PARTIAL CYLINDER (fillet / rounded wall, not a hole): centre (434.80,60.00) r=4.00 span=90deg Z 6.00..9.00
- POCKET NOT FROM TOP (cavity opens downward): floor Z 3.30, depth 3.30 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 6.00, depth 6.00 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 8.60, depth 8.60 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 8.60, depth 8.60 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 8.60, depth 8.60 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- POCKET NOT FROM TOP (cavity opens downward): floor Z 8.60, depth 8.60 from the bottom face — no toolpath emitted; cut from the other side after a flip (BRA-13) or as post-processing
- PROFILE OUTLINE DIFFERS top vs bottom by 99% (top 6386 mm2, bottom 69 mm2) — profile taken from Z 6.00 face; an edge fillet/chamfer is in the post-processing plan, not in the DXF
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (342.3,7.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (347.3,7.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (342.3,4.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (347.3,4.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (430.3,7.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (435.3,7.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (430.3,4.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (435.3,4.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (342.3,59.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (347.3,59.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (342.3,56.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (347.3,56.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (430.3,59.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (435.3,59.4), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (430.3,56.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [decision_needed]: chamfer 90 deg, 2.60 mm tall at face at (435.3,56.6), Z 7.30 — No automatic call — decide CNC vs post-process by hand for this feature.
- POST-PROCESS [cnc_3d]: chamfer 45 deg, 1.50 mm tall at pocket floor (Z 4.80) — Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.
- THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening
