#!/usr/bin/env python3
"""Square-pocket test model for rough + finish (BRA-14).

80x60x10 plate with a 40x40x5 SHARP-corner square pocket (floor Z 5)
and one D10 thru hole at (65,30).

Expected:
  3 layers, 1 hole, 1 pocket, 0 flags.
  Pocket corner_radius_mm = 0.0 (sharp corners).
  Tool plan: a two-pass "finish" variant exists (rough 1/2 in leaving
  R6.35 corners + finish 1/16 in to R0.79 mm). With
  config max_corner_radius_mm = 1.0 the finish variant becomes the
  chosen plan, and the manifest carries two lines for POCKET_D5.00
  (rough with 0.5 mm allowance, then finish).
"""
from build123d import Solid, Plane, export_step
from pathlib import Path

outdir = Path(__file__).parent / "test"
plate = Solid.make_box(80, 60, 10)
pocket = Solid.make_box(40, 40, 5, Plane(origin=(10, 10, 5)))
hole = Solid.make_cylinder(5, 10, Plane(origin=(65, 30, 0)))
part = plate - pocket - hole
export_step(part, str(outdir / "square.step"))
print("wrote", outdir / "square.step")
