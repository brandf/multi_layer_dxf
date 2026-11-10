#!/bin/bash
# BRA-18 validation run (2026-11-09) — VALIDATION.md section 4 in
# full, with current (post-BRA-21) expectations, plus the BRA-18
# checks: the standard endmill set now includes metric fine
# endmills (1.0 / 0.8 / 0.5 mm), so Kookabus P01/P03 get plans
# while the merged job is still blocked by the single 0.91 mm
# pocket (see BRA-22). Every count must match VALIDATION.md
# except the Kookabus tool-plan error, which narrows from 8
# blocking layers to 1. Run from ~/workspace/cnc-onshape-vcarve.
cd ~/workspace/cnc-onshape-vcarve || exit 1
P=.venv/bin/python
ok() { echo "  => $*"; }

echo "=== 1. test_part (expect 8 layers, 6 holes, 3 pockets, 1 flag) ==="
$P step_to_vcarve.py test/test_part.step -o test/out --mode full 2>&1 | tail -2
echo "=== 2. machined (expect 9 layers, 8 holes, 4 pockets; THROUGH_CUT recovered, no NOT-in-DXF) ==="
$P step_to_vcarve.py test/machined.step -o test/machined_out --mode full 2>&1 | grep -E "^layers:|THROUGH FEATURE MERGED|NOT in the DXF"
echo "=== 3. two_part (expect 2 parts, 5 layers, 1 flag POCKET NOT FROM TOP; suggested 200x80x10) ==="
$P multi_part.py test/two_part.step -o test/multi_out --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/multi_out/manifest.json')); print('suggested:', m['suggested_material']); print('spacing:', m['spacing'])"
echo "=== 4. kookabus check (expect no crash; layers 8/7/5, holes 18/5/7, flags 39/82/29 in check mode; 122 for P02 in full mode) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_out --mode check 2>&1 | grep -E "^---|layers would be|mode=check"
echo "=== 5. beveled_container (expect 3 layers, 8 holes, 1 pocket, 4 flags) ==="
$P step_to_vcarve.py test/beveled_container.step -o test/beveled_container_out --mode full 2>&1 | tail -2
echo "=== 6. beveled_plate (expect 3 layers, 1 hole, 1 pocket, 5 flags) ==="
$P step_to_vcarve.py test/beveled_plate.step -o test/beveled_plate_out --mode full 2>&1 | tail -2
echo "=== 7. rotated_container --auto (expect 2 parts, 5 layers, 0 flags) ==="
$P multi_part.py test/rotated_container.step -o test/rotated_out --auto --mode full 2>&1 | tail -1
echo "=== 8. beveled_sideways --auto-orient (expect 3 layers, 8 holes, 1 pocket) ==="
$P step_to_vcarve.py test/beveled_sideways.step -o test/beveled_sideways_out --auto-orient --mode full 2>&1 | tail -2
echo "=== 9. donut (expect 2 layers, 0 holes, 0 pockets, 1 flag) ==="
$P step_to_vcarve.py test/donut.step -o test/donut_out --mode full 2>&1 | tail -2
echo "=== 10. square (expect 3 layers, 1 hole, 1 pocket, 0 flags; Plan A 1/4in 1.4 min; Plan D finish 3/16in) ==="
$P step_to_vcarve.py test/square.step -o test/square_out --mode full 2>&1 | tail -2
$P -c "
import json
m=json.load(open('test/square_out/manifest.json'))
print('square plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1), p['variant']) for p in m['tool_plan']['plans']])
print('square D tools:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][-1]['tools']])"
echo "=== 11. square gate (expect finish variant rough 1/4 + finish 1/16, two POCKET_D5.00 lines) ==="
$P step_to_vcarve.py test/square.step -o test/square_gate_out --config test/square_config.json 2>&1 | tail -2
grep -c "POCKET_D5.00" test/square_gate_out/manifest.txt
$P -c "
import json
m=json.load(open('test/square_gate_out/manifest.json'))
print('gate chosen:', m['tool_plan']['chosen'], [(p['id'], [(t['id'], t['name']) for t in p['tools']]) for p in m['tool_plan']['plans']])"
echo "=== 12. real container --auto (expect 2 parts, 8 layers, 6 flags, Plan A 2/5.6) ==="
$P multi_part.py test/real_container.step -o test/real_container_out --auto 2>&1 | tail -1
$P -c "
import json, ezdxf
m = json.load(open('test/real_container_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('tool plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']][:1])
print('tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
print('suggested:', m['suggested_material'])
doc = ezdxf.readfile('test/real_container_out/real_container.dxf')
print('P01 facing pocket circles:', sum(1 for e in doc.modelspace() if e.dxf.layer == 'P01_P01__POCKET_D1.50'))
print('P02 facing pocket circles:', sum(1 for e in doc.modelspace() if e.dxf.layer == 'P02_P02__POCKET_D1.50'))
for p in m['parts']:
    print(p['name'], 'orient:', p.get('orientation_search', {}).get('ranked', [])[:2] if p.get('orientation_search') else None)
"
echo "=== 13. eight parts --auto (expect 8 parts, 22 layers, 4 flags, Plan A 1/9.0) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_out --auto 2>&1 | tail -1
$P -c "
import json
m = json.load(open('test/eight_parts_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']), m['flags'])
print('tool plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']][:1])
print('suggested:', m['suggested_material'])
"
echo "=== 14. BRA-16: eight parts --auto --material 500x300x19 (expect usable 460x260, gaps 30.4) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19 2>&1 | tail -2
$P -c "
import json
m = json.load(open('test/eight_parts_bra16_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('material:', m['material'], 'usable:', m['usable_area_mm'], 'suggested:', m['suggested_material'])
for L in m['layout']: print(' ', L)
"
echo "=== 15. BRA-16: real container --material 170x100x10 (expect Bottom (20,20), Top (96.4,20)) ==="
$P multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 170x100x10 2>&1 | tail -1
$P -c "
import json
m = json.load(open('test/real_container_mat_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
for L in m['layout']: print(' ', L)
"
echo "=== 16. BRA-16: real container --material 150x100x5 (expect named error, exit 1, no outputs) ==="
$P multi_part.py test/real_container.step -o test/real_container_small_out --auto --material 150x100x5 >/tmp/small18.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small18.log | head -3
ls test/real_container_small_out 2>&1 | head -2
echo "=== 17. BRA-16: test_part --material 500x300x19 passes; --material 30x30x5 exit 1, out dir empty ==="
$P step_to_vcarve.py test/test_part.step -o test/out_mat --mode full --material 500x300x19 2>&1 | tail -1
$P step_to_vcarve.py test/test_part.step -o test/out_small --mode full --material 30x30x5 >/tmp/small18b.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small18b.log | head -2
ls test/out_small 2>&1 | head -2
echo "=== 18. BRA-16: pins on real container (expect [(276.0, 24.0), (24.0, 176.0)]) ==="
$P multi_part.py test/real_container.step -o test/real_container_pins_out --auto --parts test/bra16_twosided.json --material 300x200x10 2>&1 | grep -E "registration pins|parts:" | head -3
$P -c "
import json
m = json.load(open('test/real_container_pins_out/manifest.json'))
print('pins:', m['registration_pins'])
print('flags:', m['flags'])
"
echo "=== 19. tool plan check (expect A (2,1,5.4) B (2,1,5.7) C (2,1,6.1)) ==="
$P multi_part.py test/container.step -o test/container_auto_out --auto --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/container_auto_out/manifest.json')); print([(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])"
echo "=== 20. BRA-18: kookabus full (expect layers 20, flags 191, TOOL PLAN error lists ONLY P02_P02__POCKET_D0.60) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_out_full --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_out_full/manifest.json'))
print('layers:', len(m['layers']), 'flags:', len(m['flags']))
print('TOOL PLAN:', [f for f in m['flags'] if 'TOOL PLAN' in f])
"
echo "=== 21. BRA-18: kookabus P01/P03 per-part plans (expect 1.00 mm tool in Plan A) ==="
$P step_to_vcarve.py test/external/kookabus_out_full/parts/P01_P01.step -o test/external/kookabus_p01_bra18 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_p01_bra18/manifest.json'))
print('P01 plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('P01 tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])"
$P step_to_vcarve.py test/external/kookabus_out_full/parts/P03_P03.step -o test/external/kookabus_p03_bra18 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_p03_bra18/manifest.json'))
print('P03 plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('P03 tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])"
echo "=== DONE ==="
