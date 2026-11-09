#!/usr/bin/env python3
"""Synthetic BEVELED test models (2026-11-08) — the no-rollback test.

The user asked: what if the STEP already has the bevels/fillets in it
and there was never a rollback? The classifier must recover the
prismatic blank from the beveled solid AND propose the post-processing
steps that put the bevels back.

Model 1 — beveled container (test/beveled_container.step):
  Same ground truth as test/container.step Bottom (Ø100 H12, central
  pocket Ø60 D6, 8x Ø5 thru on Ø84 PCD) PLUS:
    - R3 fillet on the top outer edge (torus/cylinder face)
    - 2 mm x 45 deg chamfer on the pocket's top edge
    - R2 fillet where the pocket wall meets the pocket floor
  Expected: profile is still Ø100 (from the bottom face, not the
  filleted top face), pocket Ø60 D6, 8 holes, and a post-process plan
  of [outer top fillet R3 -> router table roundover; pocket top
  chamfer 45 deg -> handheld router; pocket floor fillet R2 -> CNC
  ball-nose]. The pocket must NOT be suppressed by its floor fillet.

Model 2 — beveled plate (test/beveled_plate.step):
  80x60x10 plate, 2 mm x 45 deg chamfer on all four top edges,
  one Ø8 thru hole with a 90 deg countersink (cone) at (20, 15),
  one 20x20 pocket D4 with an R2 floor fillet at (-20, 0).
  Expected: profile 80x60, pocket D4 (not suppressed), drill D8 thru
  (countersunk, still thru), post-process [top edge chamfer ->
  router table; countersink -> drill press; floor fillet R2 -> CNC
  ball-nose].
"""
import math
from build123d import *


def _edges_at(solid, z, radius=None, geom=None):
    out = []
    for e in solid.edges():
        if abs(e.center().Z - z) > 0.01:
            continue
        if radius is not None:
            try:
                r = e.radius
            except Exception:
                continue
            if abs(r - radius) > 0.01:
                continue
        if geom is not None and e.geom_type != geom:
            continue
        out.append(e)
    return out


# ---------- Model 1: beveled container bottom ----------
bottom = Pos(0, 0, 6) * Cylinder(radius=50, height=12)
bottom -= Pos(0, 0, 9) * Cylinder(radius=30, height=6)  # pocket D60, Z 6..12
for k in range(8):
    a = math.radians(k * 45)
    bottom -= Pos(42 * math.cos(a), 42 * math.sin(a), 6) * Cylinder(radius=2.5, height=14)

top_outer = _edges_at(bottom, 12, radius=50)
assert len(top_outer) == 1, f"top outer edge: {len(top_outer)}"
bottom = fillet(top_outer, radius=3)
pocket_top = _edges_at(bottom, 12, radius=30)
assert len(pocket_top) == 1, f"pocket top edge: {len(pocket_top)}"
bottom = chamfer(pocket_top, length=2)
floor_edge = _edges_at(bottom, 6, radius=30)
assert len(floor_edge) == 1, f"floor edge: {len(floor_edge)}"
bottom = fillet(floor_edge, radius=2)

export_step(bottom, "test/beveled_container.step")
print("beveled_container: volume %.1f, bbox %s" % (
    bottom.volume, bottom.bounding_box()))

# ---------- Model 2: beveled plate ----------
plate = Box(80, 60, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate -= Pos(20, 15, 5) * Cylinder(radius=4, height=12)  # Ø8 thru
plate -= Solid.make_cone(4, 7, 3, Plane(origin=(20, 15, 7)))  # 90 deg countersink
plate -= Pos(-20, 0, 8) * Box(20, 20, 4)  # pocket 20x20 D4, Z 6..10
# chamfer the four OUTER top edges only (not the pocket's top edges):
# outer edges sit at |x|=40 or |y|=30
top_edges = [e for e in plate.edges()
             if abs(e.center().Z - 10) < 0.01 and e.geom_type == GeomType.LINE
             and (abs(abs(e.center().X) - 40) < 0.01 or abs(abs(e.center().Y) - 30) < 0.01)]
assert len(top_edges) == 4, f"top outer edges: {len(top_edges)}"
plate = chamfer(top_edges, length=2)
fl = [e for e in plate.edges()
      if abs(e.center().Z - 6) < 0.01 and e.geom_type == GeomType.LINE]
assert len(fl) == 4, f"floor edges: {len(fl)}"
plate = fillet(fl, radius=2)

export_step(plate, "test/beveled_plate.step")
print("beveled_plate: volume %.1f, bbox %s" % (
    plate.volume, plate.bounding_box()))
