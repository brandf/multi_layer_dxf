#!/bin/bash
# BRA-16 tool-dependent spacing validation run (2026-11-09).
# VALIDATION.md section 4 + BRA-16 checks, with the spacing rule on:
# gaps are max(gap_mm, D_A + D_B + web_min), D from the planner fit
# rule, computed before packing; the chosen plan's real tools are
# re-checked against the packed gaps before anything is written.
# Run from ~/workspace/cnc-onshape-vcarve. Logs to stdout; each
# block prints its expectation first, then the measured result.
cd ~/workspace/cnc-onshape-vcarve || exit 1
P=.venv/bin/python
echo "=== 1. test_part (expect 8 layers, 6 holes, 3 pockets, 1 flag) ==="
$P step_to_vcarve.py test/test_part.step -o test/out --mode full 2>&1 | tail -2
echo "=== 2. machined (expect 9 layers, 8 holes, 4 pockets) ==="
$P step_to_vcarve.py test/machined.step -o test/machined_out --mode full 2>&1 | tail -2
echo "=== 3. two_part (expect 2 parts, 6 layers, 0 flags; suggested 200x80x10) ==="
$P multi_part.py test/two_part.step -o test/multi_out --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/multi_out/manifest.json')); print('suggested:', m['suggested_material']); print('spacing:', m['spacing'])"
echo "=== 4. kookabus check (expect no crash; layers 12/10/7, holes 18/5/7, flags 30/67/9) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_out --mode check 2>&1 | grep -E "^---|layers:|mode=check"
echo "=== 5. beveled_container (expect 3 layers, 8 holes, 1 pocket, 4 flags) ==="
$P step_to_vcarve.py test/beveled_container.step -o test/beveled_container_out --mode full 2>&1 | tail -2
echo "=== 6. beveled_plate (expect 3 layers, 1 hole, 1 pocket, 5 flags) ==="
$P step_to_vcarve.py test/beveled_plate.step -o test/beveled_plate_out --mode full 2>&1 | tail -2
echo "=== 7. rotated_container --auto (expect 2 parts, 5 layers, 0 flags) ==="
$P multi_part.py test/rotated_container.step -o test/rotated_out --auto --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/rotated_out/manifest.json')); print('suggested:', m['suggested_material'])"
echo "=== 8. beveled_sideways --auto-orient (expect 3 layers, 8 holes, 1 pocket) ==="
$P step_to_vcarve.py test/beveled_sideways.step -o test/beveled_sideways_out --auto-orient --mode full 2>&1 | tail -2
echo "=== 9. donut (expect 2 layers, 0 holes, 0 pockets, 1 flag) ==="
$P step_to_vcarve.py test/donut.step -o test/donut_out --mode full 2>&1 | tail -2
echo "=== 10. square (expect 3 layers, 1 hole, 1 pocket, 0 flags) ==="
$P step_to_vcarve.py test/square.step -o test/square_out --mode full 2>&1 | tail -2
echo "=== 11. square gate (expect finish variant, two POCKET_D5.00 lines) ==="
$P step_to_vcarve.py test/square.step -o test/square_gate_out --config test/square_config.json 2>&1 | tail -2
$P -c "print(open('test/square_gate_out/manifest.txt').read().count('POCKET_D5.00'))"
echo "=== 12. real container --auto (expect 2 parts, 8 layers, 6 flags, Plan A 2/5.6; suggested 170x90x10) ==="
$P multi_part.py test/real_container.step -o test/real_container_out --auto 2>&1 | tail -4
$P -c "
import json
m=json.load(open('test/real_container_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('tool plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans'] if p['id']=='A'])
print('suggested:', m['suggested_material'])
print('spacing:', m['spacing'])
import ezdxf
from collections import Counter
doc = ezdxf.readfile('test/real_container_out/real_container.dxf')
print('P01 facing pocket circles:', sum(1 for e in doc.modelspace() if e.dxf.layer=='P01_P01__POCKET_D1.50'))
print('P02 facing pocket circles:', sum(1 for e in doc.modelspace() if e.dxf.layer=='P02_P02__POCKET_D1.50'))
"
echo "=== 13. eight parts --auto (expect 8 parts, 22 layers, 4 flags, Plan A 1/9.0; suggested 690x100x15) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_out --auto 2>&1 | tail -3
$P -c "
import json
m=json.load(open('test/eight_parts_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('tool plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans'] if p['id']=='A'])
print('suggested:', m['suggested_material'])
print('spacing:', m['spacing'])
"
echo "=== 14. BRA-16: eight parts --auto --material 500x300x19 (expect fit; 6 parts row 1 with P06 rotated 90 deg, P07+P08 row 2) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19 2>&1 | tail -2
$P -c "
import json
m = json.load(open('test/eight_parts_bra16_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('material:', m['material'], 'usable:', m['usable_area_mm'], 'suggested:', m['suggested_material'])
for L in m['layout']: print(' ', L)
"
echo "=== 15. BRA-16: real container --material 150x100x10 (expect PACK FAILURE, named error, exit 1 — 1/2 in tools need 122.4 mm usable width, have 110) ==="
$P multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 150x100x10 >/tmp/mat150.log 2>&1
echo "exit=$?"
grep -E "ERROR|orient search" /tmp/mat150.log | head -4
echo "=== 15b. BRA-16: real container --material 170x100x10 (expect pass, prune, 2 orientations each) ==="
$P multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 170x100x10 2>&1 | grep -E "orient search|parts:" | head -5
echo "=== 16. BRA-16: real container --material 150x100x5 (expect named error, exit 1, no outputs) ==="
$P multi_part.py test/real_container.step -o test/real_container_small_out --auto --material 150x100x5 >/tmp/small16.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small16.log | head -3
ls test/real_container_small_out 2>&1 | head -2
echo "=== 17. BRA-16: two-sided pins on real container (expect 2 pins, keep-out 18.7 mm) ==="
$P multi_part.py test/real_container.step -o test/real_container_pins_out --auto --parts test/bra16_twosided.json --material 300x200x10 2>&1 | grep -E "registration pins|parts:" | head -3
$P -c "
import json
m = json.load(open('test/real_container_pins_out/manifest.json'))
print('pins:', m['registration_pins'])
print('layout:', m['layout'])
"
echo "=== 18. single-part material (expect pass 500x300x19; fail 30x30x5) ==="
$P step_to_vcarve.py test/test_part.step -o test/out_mat --mode full --material 500x300x19 2>&1 | tail -1
$P step_to_vcarve.py test/test_part.step -o test/out_small --mode full --material 30x30x5 >/tmp/single_small.log 2>&1; echo "exit=$?"; grep ERROR /tmp/single_small.log | head -2; ls test/out_small 2>&1 | head -2
echo "=== 19. tool plan (expect container_auto_out plans A/B/C 5.4/5.7/6.1) ==="
$P multi_part.py test/container.step -o test/container_auto_out --auto --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/container_auto_out/manifest.json')); print([(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])"
echo "=== DONE ==="
