#!/usr/bin/env python3
"""Auto-orientation test inputs (2026-11-08).

  test/rotated_container.step — test/container.step rotated 90 deg
    about X (its prismatic axis is now Y, not Z), shifted so Zmin=0.
    --auto must recover the parts.container.json result exactly:
    Bottom no flip, Top flip, 5 layers, 0 flags.

  test/beveled_sideways.step — test/beveled_container.step rotated
    90 deg about Y (axis now X). --auto-orient (single-part) must
    rotate it back and give the same 3 layers / 8 holes / 1 pocket /
    post-process plan as the unrotated beveled container.
"""
from build123d import import_step, export_step, Axis, Location


def _rotated(src, dst, axis, deg):
    s = import_step(src)
    s2 = s.rotate(axis, deg)
    bb = s2.bounding_box()
    s2 = s2.moved(Location((0, 0, -bb.min.Z), (0, 0, 0)))
    export_step(s2, dst)
    print(dst, "bbox:", s2.bounding_box().min, "->", s2.bounding_box().max)


_rotated("test/container.step", "test/rotated_container.step", Axis.X, 90)
_rotated("test/beveled_container.step", "test/beveled_sideways.step", Axis.Y, 90)
