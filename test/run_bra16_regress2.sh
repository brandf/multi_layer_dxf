#!/bin/bash
# BRA-16 remaining checks (suite part 2 — the first run was killed
# by a service restart during test 14).
cd ~/workspace/cnc-onshape-vcarve || exit 1
P=.venv/bin/python
echo "=== 4b. kookabus check, full capture (expect no crash; layers 12/10/7, holes 18/5/7, flags 30/67/9) ==="
$P multi_part.py test/external/kookabus-03-enclosure.step -o test/external/kookabus_out --mode check 2>&1 | grep -E "^---|layers:|mode=check"
echo "=== 14. BRA-16: eight parts --auto --material 500x300x19 (expect fit, shelf rows, no suggested) ==="
$P multi_part.py test/eight_parts.step -o test/eight_parts_bra16_out --auto --material 500x300x19 2>&1 | tail -2
$P -c "
import json
m = json.load(open('test/eight_parts_bra16_out/manifest.json'))
print('parts', len(m['parts']), 'layers', len(m['layers']), 'flags', len(m['flags']))
print('material:', m['material'], 'usable:', m['usable_area_mm'], 'suggested:', m['suggested_material'])
for L in m['layout']: print(' ', L)
"
echo "=== 15. BRA-16: real container --material 150x100x10 (expect prune, 2 orientations each) ==="
$P multi_part.py test/real_container.step -o test/real_container_mat_out --auto --material 150x100x10 2>&1 | grep -E "orient search|parts:" | head -5
echo "=== 16. BRA-16: real container --material 150x100x5 (expect named error, exit 1, no outputs) ==="
$P multi_part.py test/real_container.step -o test/real_container_small_out --auto --material 150x100x5 >/tmp/small16.log 2>&1
echo "exit=$?"
grep -E "ERROR" /tmp/small16.log | head -3
ls test/real_container_small_out 2>&1 | head -2
echo "=== 17. BRA-16: two-sided pins on real container (expect 2 pins in manifest) ==="
$P multi_part.py test/real_container.step -o test/real_container_pins_out --auto --parts test/bra16_twosided.json --material 300x200x10 2>&1 | grep -E "registration pins|parts:" | head -3
$P -c "
import json
m = json.load(open('test/real_container_pins_out/manifest.json'))
print('pins:', m['registration_pins'])
print('flags:', m['flags'])
"
echo "=== DONE ==="
