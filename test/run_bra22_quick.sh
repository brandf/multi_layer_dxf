#!/bin/bash
# BRA-22 quick regressions (2026-11-09) — fast single/two-part checks.
# Full suite (eight_parts, rotated, beveled_sideways, kookabus check) runs next hour.
cd ~/workspace/cnc-onshape-vcarve || exit 1
P=.venv/bin/python
echo "=== 1. test_part (expect 8 layers, 6 holes, 3 pockets, 1 flag) ==="
$P step_to_vcarve.py test/test_part.step -o test/out --mode full 2>&1 | tail -1
echo "=== 2. machined (expect 9 layers, 8 holes, 4 pockets; THROUGH_CUT recovered) ==="
$P step_to_vcarve.py test/machined.step -o test/machined_out --mode full 2>&1 | grep -E "^layers:|THROUGH FEATURE MER" | head -3
echo "=== 3. two_part (expect 2 parts, 5 layers, 1 flag; P02 at x 74.525, gap 14.5) ==="
$P multi_part.py test/two_part.step -o test/multi_out_bra20 --mode full 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/multi_out_bra20/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('layout:', [(L['name'], L['x_mm']) for L in m['layout']])
print('spacing from:', m['spacing']['profile_tools_from'], '| suggested:', m['suggested_material'])
print('plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']][:1])
"
echo "=== 4. container --auto (expect 5 layers, 0 flags, plans A (2,1,5.4) B (2,1,5.7) C (2,1,6.1)) ==="
$P multi_part.py test/container.step -o test/container_auto_out --auto --mode full 2>&1 | tail -1
$P -c "import json; m=json.load(open('test/container_auto_out/manifest.json')); print([(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']])"
echo "=== 5. real container --auto (expect 2 parts, 8 layers, 6 flags, Plan A 2/5.6) ==="
$P multi_part.py test/real_container.step -o test/real_container_out --auto 2>&1 | tail -1
$P -c "
import json
m=json.load(open('test/real_container_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('tool plan A:', [(p['id'], len(p['tools']), p['tool_changes'], round(p['total_seconds']/60,1)) for p in m['tool_plan']['plans']][:1])
print('tools A:', [(t['id'], t['name']) for t in m['tool_plan']['plans'][0]['tools']])
"
echo "=== 6. square (expect 3 layers, 1 hole, 1 pocket, 0 flags; Plan A single 1/4in, 1.4 min) ==="
$P step_to_vcarve.py test/square.step -o test/square_out --mode full 2>&1 | tail -1
echo "=== 7. square gate (expect finish variant chosen, two POCKET_D5.00 lines) ==="
$P step_to_vcarve.py test/square.step -o test/square_gate_out --config test/square_config.json 2>&1 | tail -1
grep -c "POCKET_D5.00" test/square_gate_out/manifest.txt
echo "=== 8. donut (expect 2 layers, 0 holes, 0 pockets, 1 flag) ==="
$P step_to_vcarve.py test/donut.step -o test/donut_out --mode full 2>&1 | tail -1
echo "=== 9. beveled container (expect 3 layers, 8 holes, 1 pocket, PROFILE CIRCLE r=50, 4 flags) ==="
$P step_to_vcarve.py test/beveled_container.step -o test/beveled_container_out --mode full 2>&1 | tail -1
echo "=== 10. beveled plate (expect 3 layers, 1 hole, 1 pocket, no spurious THROUGH_CUT, 5 flags) ==="
$P step_to_vcarve.py test/beveled_plate.step -o test/beveled_plate_out --mode full 2>&1 | tail -1
