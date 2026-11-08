#!/usr/bin/env python3
"""Two-part scene test: container bottom + lid, lid cut flipped.

Part A (bottom): 60x40x10, centre (0,0,5) => Z 0..10
  pocket 20x20, depth 4 from top (floor Z6), 1x D6 thru hole.
Part B (lid): 60x40x8, centre (80,0,4) => Z 0..8, laid out to the right.
  In the scene its pocket opens DOWNWARD: 20x20, depth 3 from its
  bottom face (floor Z3). Without flip the classifier would read
  that as depth 5 from the top — wrong. With flip_x=true the pocket
  becomes depth 3 from the (new) top, floor Z5. 1x D8 thru hole.
"""
from build123d import *

# bottom: box, pocket from top, hole thru
a = Pos(0, 0, 5) * Box(60, 40, 10)
a -= Pos(0, 0, 8) * Box(20, 20, 4)   # pocket: Z 6..10
a -= Pos(-20, 0, 5) * Cylinder(radius=3, height=12)

# lid: box, pocket from BOTTOM (opening at Z0, floor Z3), hole thru
b = Pos(80, 0, 4) * Box(60, 40, 8)
b -= Pos(80, 0, 1.5) * Box(20, 20, 3)  # pocket: Z 0..3, floor Z3
b -= Pos(100, 0, 4) * Cylinder(radius=4, height=10)

scene = Compound(children=[a, b])
export_step(scene, "test/two_part.step")
for name, part in (("bottom", a), ("lid", b)):
    bb = part.bounding_box()
    print(name, "vol", round(part.volume, 1), "bbox", bb.min, "->", bb.max)
print("wrote test/two_part.step")
