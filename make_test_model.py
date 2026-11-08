#!/usr/bin/env python3
"""Build a known prismatic test part with build123d, export STEP.

Known ground truth (mm, Z-up, stock 100 x 80 x 12, Z=0 bottom, Z=12 top):
- Outer profile: 100 x 80 rectangle, sharp corners
- Pocket A: 40 x 30, depth 6.00 (floor Z=6), centred at (-20, 0)
- Pocket-in-pocket B: 20 x 15, depth 3.00 more (floor Z=3, total 9),
  centred at (-20, 0), inside Pocket A
- Pocket C: 25 x 20, depth 4.00 (floor Z=8), centred at (25, 15)
- Through holes: 4x D6.00 at (+/-35, +/-25) corners, 1x D10.00 at (25, -20)
- Blind hole: D8.00, depth 5.00 (floor Z=7), at (0, -25)
- Through slot: 30 x 8, through, centred at (25, -5) — vertical walls,
  should appear as a pocket/profile opening, flagged in report
"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent / "test" / "test_part.step"
OUT.parent.mkdir(parents=True, exist_ok=True)

with BuildPart() as part:
    Box(100, 80, 12, align=(Align.CENTER, Align.CENTER, Align.MIN))

    # Pocket A, 6 deep from top (Z=12 -> Z=6)
    with BuildSketch(Plane.XY.offset(12)):
        with Locations(Location((-20, 0))):
            Rectangle(40, 30)
    extrude(amount=-6, mode=Mode.SUBTRACT)

    # Pocket B inside A, 3 more (Z=6 -> Z=3)
    with BuildSketch(Plane.XY.offset(6)):
        with Locations(Location((-20, 0))):
            Rectangle(20, 15)
    extrude(amount=-3, mode=Mode.SUBTRACT)

    # Pocket C, 4 deep (Z=12 -> Z=8)
    with BuildSketch(Plane.XY.offset(12)):
        with Locations(Location((25, 15))):
            Rectangle(25, 20)
    extrude(amount=-4, mode=Mode.SUBTRACT)

    # Through holes D6 at corners
    with BuildSketch(Plane.XY.offset(12)):
        with GridLocations(70, 50, 2, 2):
            Circle(3)
    extrude(amount=-12, mode=Mode.SUBTRACT)

    # Through hole D10
    with BuildSketch(Plane.XY.offset(12)):
        with Locations(Location((25, -20))):
            Circle(5)
    extrude(amount=-12, mode=Mode.SUBTRACT)

    # Blind hole D8, 5 deep (Z=12 -> Z=7)
    with BuildSketch(Plane.XY.offset(12)):
        with Locations(Location((0, -25))):
            Circle(4)
    extrude(amount=-5, mode=Mode.SUBTRACT)

    # Through slot 30 x 8
    with BuildSketch(Plane.XY.offset(12)):
        with Locations(Location((25, -5))):
            Rectangle(30, 8)
    extrude(amount=-12, mode=Mode.SUBTRACT)

solid = part.part
print(f"volume: {solid.volume:.1f} mm^3")
print(f"bbox: {solid.bounding_box().min} -> {solid.bounding_box().max}")
export_step(solid, str(OUT))
print(f"wrote {OUT}")
