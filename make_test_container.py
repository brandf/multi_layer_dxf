#!/usr/bin/env python3
"""Container test, approximating Brandon's container model (2026-11-08).

Scene (closed, concentric — the hard case for layout):
  Bottom: outer D100, H12, Z 0..12. Central pocket D60, depth 6 from
    top (floor Z6). 8x D5 thru holes on D84 PCD.
  Top: outer D100, H10, Z 12..22 in the scene, sitting on Bottom.
    Its inside faces DOWN: central pocket D60, depth 5 from its
    bottom face (floor Z17 in scene, opening at Z12). No holes.
    After flip_x, that pocket is depth 5 from the new top, floor Z5.

Expected after multi_part.py with parts.container.json
(flip Top, bottom-align, side-by-side, gap 10):
  Bottom: 1 profile D100, 1 pocket D6.00, 8x D5 thru holes, Z 0..12
  Top:    1 profile D100, 1 pocket D5.00, 0 holes, Z 0..10
  Layout: Bottom X 0..100, Top X 110..210, both Y 0..100, no overlap
  No fillet — Fillet 1 in the CAD model is post-process, snapshot is before it.
"""
import math
from build123d import *

# Bottom
bottom = Pos(0, 0, 6) * Cylinder(radius=50, height=12)
bottom -= Pos(0, 0, 9) * Cylinder(radius=30, height=6)  # pocket D60, Z 6..12
for k in range(8):
    a = math.radians(k * 45)
    bottom -= Pos(42 * math.cos(a), 42 * math.sin(a), 6) * Cylinder(radius=2.5, height=14)

# Top, in scene above Bottom, inside down
top = Pos(0, 0, 17) * Cylinder(radius=50, height=10)
top -= Pos(0, 0, 14.5) * Cylinder(radius=30, height=5)  # pocket D60, Z 12..17

scene = Compound(children=[bottom, top])
export_step(scene, "test/container.step")
for name, part in (("Bottom", bottom), ("Top", top)):
    bb = part.bounding_box()
    print(name, "vol", round(part.volume, 1), "bbox", bb.min, "->", bb.max)
print("wrote test/container.step")
