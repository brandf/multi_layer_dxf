#!/bin/bash
# BRA-22 remainder (2026-11-09, 20:31 run) — slow remainder of VALIDATION.md §4
# under the new proportional fit rule (clearance = min(0.5, 0.5*tool_dia)).
# Quick sections 1-10 already verified green post-change in
# bra22_quick_2026-11-09.log (20:10 run). Expectations that CHANGE under
# BRA-22 are marked [BRA-22]; everything else must match the pre-change
# baseline exactly.
cd ~/workspace/cnc-onshape-vcarve || exit 1
P=.venv/bin/python
echo "=== 11. eight_parts --auto (expect 8 parts, 22 layers, 4 flags, Plan A 1 change / 9.0 min, suggested 600x100x15) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_out --auto 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/eight_parts_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']][:1])
print('suggested:', m['suggested_material'])
print('flags:', m['flags'])
"
echo "=== 12. eight_parts BRA-16 material 500x300x19 (expect 8/22/4, usable 460x260, gaps 17.7, 6 in row 1 P06 at 388.5 unrotated, P07+P08 row 2 y 97.7, suggested null) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/eight_parts_bra16_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('material:', m['material'], 'usable:', m['usable_area_mm'], 'suggested:', m['suggested_material'])
print('spacing:', m['spacing'])
for L in m['layout']: print(' ', L)
"
echo "=== 13. BRA-16: real container --material 170x100x10 (expect Bottom (20,20), Top (96.4,20)) ==="
$P multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 170x100x10 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/real_container_mat_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
for L in m['layout']: print(' ', L)
"
echo "=== 14. BRA-16: real container --material 150x100x5 (expect named error, exit 1, no outputs) ==="
$P multi_part.py test/real_container.step -o test/real_container_small_out --auto --material 150x100x5 >/tmp/small22.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small22.log | head -3
ls test/real_container_small_out 2>&1 | head -2
echo "=== 15a. BRA-20: real container 150x100x10 plan A (expect exit 1, named packing error, no dir) ==="
$P multi_part.py test/real_container.step -o test/real_container_bra20_150 --auto --material 150x100x10 >/tmp/bra22a.log 2>&1
echo "plan A exit=$?"
grep -E "ERROR: packed" /tmp/bra22a.log | head -1
ls test/real_container_bra20_150 2>&1 | head -1
echo "=== 15b. BRA-20: real container 150x100x10 plan B (expect exit 1, named packing error, no dir) ==="
$P multi_part.py test/real_container.step -o test/real_container_bra20_150B --auto --material 150x100x10 --plan B >/tmp/bra22b.log 2>&1
echo "plan B exit=$?"
grep -E "ERROR: packed" /tmp/bra22b.log | head -1
ls test/real_container_bra20_150B 2>&1 | head -1
echo "=== 15c. BRA-20: real container 150x100x10 small-tools config (expect Bottom (20,20), Top (83.7,20), Plan A Drill 2.25 + EM 1/4 in) ==="
$P multi_part.py test/real_container.step -o test/real_container_bra20_small --auto --material 150x100x10 --config test/bra20_small_tools_config.json 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/real_container_bra20_small/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('layout:', [(L['name'], L['x_mm'], L['y_mm'], L['profile_tool_dia_mm']) for L in m['layout']])
print('plan A tools:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
"
echo "=== 16. BRA-16: test_part --material 500x300x19 passes; --material 30x30x5 exit 1, out dir empty ==="
$P step_to_vcarve.py test/test_part.step -o test/out_mat --mode full --material 500x300x19 2>&1 | tail -1
$P step_to_vcarve.py test/test_part.step -o test/out_small --mode full --material 30x30x5 >/tmp/small22b.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small22b.log | head -2
ls test/out_small 2>&1 | head -2
echo "=== 17. BRA-16: pins on real container (expect [(276.0, 24.0), (24.0, 176.0)] D6 keep-out 18.7) ==="
$P multi_part.py test/real_container.step -o test/real_container_pins_out --auto --parts test/bra16_twosided.json --material 300x200x10 2>&1 | grep -E "registration pins|parts:" | head -3
$P -c "
import json
m=json.load(open('test/real_container_pins_out/manifest.json'))
print('pins:', m['registration_pins'])
"
echo "=== 18. rotated_container --auto (expect 2 parts, 5 layers, 0 flags) ==="
$P multi_part.py test/rotated_container.step -o test/rotated_out --auto --mode full 2>&1 | tail -1
echo "=== 19. beveled_sideways --auto-orient (expect 3 layers, 8 holes, 1 pocket, same post-process plan as unrotated) ==="
$P step_to_vcarve.py test/beveled_sideways.step -o test/beveled_sideways_out --auto-orient --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/beveled_sideways_out/manifest.json'))
print('layers', len(m['layers']), 'holes', len(m.get('holes',[])), 'pockets', len(m.get('pockets',[])), 'flags', len(m['flags']))
print('post-process:', m.get('post_process'))
"
echo "=== 20. kookabus check mode (expect layers 8/7/5, holes 18/5/7, flags 39/82/29) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_out --mode check 2>&1 | tail -4
echo "=== 21. [BRA-22] kookabus full merged acceptance (expect layers 20, flags 190, Plan A EXISTS EM 1/2in + EM 0.50mm 2 changes 212.1 min, NO TOOL PLAN flag, spacing from plan A) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_bra22_out --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_bra22_out/manifest.json'))
print('layers:', len(m['layers']), 'flags:', len(m['flags']))
print('plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
print('TOOL PLAN flags:', [f for f in m['flags'] if 'TOOL PLAN' in f])
print('spacing:', m['spacing'])
"
echo "=== 22. [BRA-22] kookabus full BRA-20 output dir (expect same as 21: layers 20, flags 190, plan exists, spacing from plan A) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_bra20_out --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_bra20_out/manifest.json'))
print('layers:', len(m['layers']), 'flags:', len(m['flags']))
print('plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('spacing:', m['spacing'])
print('TOOL PLAN flags:', [f for f in m['flags'] if 'TOOL PLAN' in f])
"
echo "=== 23. kookabus P01/P03 per-part plans (pre-change baseline: P01 A (2,2,55.8) EM12.70+EM1.00; P03 A (3,2,9.9) D3.40+EM1.00+EM3.17 — record actuals, any change must trace to a pocket in [0.75,1.0) or [1.2,1.3) mm) ==="
$P step_to_vcarve.py test/external/kookabus_bra22_out/parts/P01_P01.step -o test/external/kookabus_p01_bra22 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_p01_bra22/manifest.json'))
print('P01 plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('P01 tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
"
$P step_to_vcarve.py test/external/kookabus_bra22_out/parts/P03_P03.step -o test/external/kookabus_p03_bra22 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/external/kookabus_p03_bra22/manifest.json'))
print('P03 plans:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])
print('P03 tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
"
echo "=== 24. BRA-20: two_part packs from plan A (expect P02 at sheet x 74.525, gap 14.5, suggested 180x80x10) ==="
$P multi_part.py test/two_part.step -o test/multi_out_bra20 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/multi_out_bra20/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('layout:', [(L['name'], L['x_mm'], L['profile_tool_dia_mm']) for L in m['layout']])
print('spacing:', m['spacing'])
print('suggested:', m['suggested_material'])
"
echo "=== 25. tool plan check (expect A (2,1,5.4) B (2,1,5.7) C (2,1,6.1)) ==="
$P multi_part.py test/container.step -o test/container_auto_out --auto --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/container_auto_out/manifest.json')); print([(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])"
echo "=== DONE ==="
