#!/usr/bin/env python3
"""Doughnut test model for the tabs-on-through-cuts rule (BRA-12).

A doughnut-shaped prism: Ø100 outer, Ø60 through hole, 10 mm thick.
The centre is NOT sawdust — it is a solid disc freed by the inner
profile cut, so the inner cut needs tabs exactly like the outer one.

Expected classifier output:
  2 layers, 0 holes, 0 pockets, 1 flag (the standard through-cut
  "verify it is not a pocket opening" flag):
    THROUGH_CUT  (profile ON the Ø60 circle, tabs x4 — perimeter 188 mm)
    PROFILE_THRU (profile OUTSIDE the Ø100 circle, tabs x4)
  Tool plan: 1 tool (End Mill 1/2 in), 0 changes.
"""
from build123d import Solid, export_step
from pathlib import Path

outdir = Path(__file__).parent / "test"
outer = Solid.make_cylinder(50, 10)
inner = Solid.make_cylinder(30, 10)
donut = outer - inner
export_step(donut, str(outdir / "donut.step"))
print("wrote", outdir / "donut.step")
