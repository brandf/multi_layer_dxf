#!/usr/bin/env python3
"""Eight unrelated parts in one STEP — generalisation test for
multi_part.py (not a container, no Top/Bottom pairing).

1. bracket:        L-footprint plate 50x40x8, 2x D6 thru
2. disc:           D40 disc, 6 thick, D12 thru centre hole
3. plate:          70x50x10, 30x20x4 pocket, 4x D5 thru
4. slotbar:        80x20x8 bar, 40x8 thru slot, 2x D4 thru
5. counterbore:    40x40x12 block, D12 counterbore (4 deep) + D6 thru
6. ring:           D60/D30 donut, 10 thick
7. sideways:       30x20x12 block modelled lying on its side
                   (prismatic axis along X) — auto-orient must recover it
8. stepped_plate:  60x60x15, 40x40x5 pocket, D8 blind hole 6 deep
                   in the pocket floor, 2x D6 thru
Each part is a separate solid, placed apart in the scene.
"""
from build123d import *

# 1. L-bracket: 50x40x8 with the +X/+Y corner notched out
p1 = Pos(0, 0, 4) * Box(50, 40, 8)
p1 -= Pos(12.5, 10, 4) * Box(25, 20, 8)          # notch -> L footprint
p1 -= Pos(-15, -10, 4) * Cylinder(radius=3, height=10)
p1 -= Pos(15, -10, 4) * Cylinder(radius=3, height=10)

# 2. disc: D40 x 6, D12 centre hole
p2 = Pos(100, 0, 3) * Cylinder(radius=20, height=6)
p2 -= Pos(100, 0, 3) * Cylinder(radius=6, height=8)

# 3. plate: 70x50x10, pocket 30x20x4 from top, 4x D5 thru
p3 = Pos(200, 0, 5) * Box(70, 50, 10)
p3 -= Pos(200, 0, 8) * Box(30, 20, 4)             # pocket floor Z 6
for hx, hy in ((-25, -15), (25, -15), (-25, 15), (25, 15)):
    p3 -= Pos(200 + hx, hy, 5) * Cylinder(radius=2.5, height=12)

# 4. slot bar: 80x20x8, 40x8 thru slot, 2x D4 thru
p4 = Pos(300, 0, 4) * Box(80, 20, 8)
p4 -= Pos(300, 0, 4) * Box(40, 8, 10)             # thru slot
p4 -= Pos(270, 0, 4) * Cylinder(radius=2, height=10)
p4 -= Pos(330, 0, 4) * Cylinder(radius=2, height=10)

# 5. counterbore block: 40x40x12, D12 x 4 deep counterbore + D6 thru
p5 = Pos(400, 0, 6) * Box(40, 40, 12)
p5 -= Pos(400, 0, 10) * Cylinder(radius=6, height=4)   # counterbore Z 8..12
p5 -= Pos(400, 0, 6) * Cylinder(radius=3, height=14)   # D6 thru

# 6. ring: D60 outer / D30 inner, 10 thick
p6 = Pos(500, 0, 5) * Cylinder(radius=30, height=10)
p6 -= Pos(500, 0, 5) * Cylinder(radius=15, height=12)

# 7. sideways block: built upright, then rotated 90 deg about Y
#    (prismatic axis ends up along X) — auto-orient must recover it.
p7 = Pos(0, 0, 6) * Box(30, 20, 12)
p7 -= Pos(0, 0, 10) * Box(15, 10, 4)             # pocket, floor Z 8
p7 -= Pos(10, 0, 6) * Cylinder(radius=2.5, height=14)
p7 = Rot(0, 90, 0) * p7                          # now lying on its side
p7 = Pos(600, 0, 6) * p7

# 8. stepped plate: 60x60x15, pocket 40x40x5, D8 blind 6 deep in the
#    pocket floor, 2x D6 thru
p8 = Pos(700, 0, 7.5) * Box(60, 60, 15)
p8 -= Pos(700, 0, 12.5) * Box(40, 40, 5)         # pocket floor Z 10
p8 -= Pos(700, 0, 7) * Cylinder(radius=4, height=6)  # blind hole Z 4..10
p8 -= Pos(680, -20, 7.5) * Cylinder(radius=3, height=17)
p8 -= Pos(720, 20, 7.5) * Cylinder(radius=3, height=17)

scene = Compound(children=[p1, p2, p3, p4, p5, p6, p7, p8])
export_step(scene, "test/eight_parts.step")
for i, part in enumerate([p1, p2, p3, p4, p5, p6, p7, p8], 1):
    bb = part.bounding_box()
    print(f"part {i}: vol {part.volume:.0f} bbox "
          f"({bb.min.X:.1f},{bb.min.Y:.1f},{bb.min.Z:.1f}) -> "
          f"({bb.max.X:.1f},{bb.max.Y:.1f},{bb.max.Z:.1f})")
print("wrote test/eight_parts.step")
