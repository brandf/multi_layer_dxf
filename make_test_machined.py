#!/usr/bin/env python3
"""Build a harder, realistic machined-plate test part with build123d, export STEP.

Independent of test_part.step: different size, shape and feature mix, so it
is a second validation, not a re-run of the same geometry.

Known ground truth (mm, Z-up, stock 120 x 80 x 14, Z=0 bottom, Z=14 top,
outer corners filleted R8):
- Pocket A: 60 x 40, depth 5.00 (floor Z=9), centred at (-15, 0)
- Pocket-in-pocket B: 30 x 20, 4.00 more (floor Z=5, total 9),
  centred at (-15, 0), inside Pocket A
- Pocket C: 20 x 20, depth 3.00 (floor Z=11), centred at (35, 15)
- Counterbore: at (35, -20) — D12.00 counterbore 3.00 deep (Z=14 -> Z=11)
  over a D6.00 through hole. Expected classifier behaviour: two hole
  entries at the same centre (D12 blind depth 3 + D6 thru), not one.
- Through holes: 4x D5.00 at (+/-50, +/-30) corners
- Blind hole: D8.00, depth 5.00 (floor Z=9), at (0, -28)
- Bottom-only blind hole (trap): D5.00, 4.00 up from the bottom
  (Z=0 -> Z=4), at (-45, -28). Must be FLAGGED blind_bottom, no toolpath.
- Tapered pocket (trap): 24 x 16 opening at the top, walls tapered 10 deg
  inward going down, 6.00 deep, centred at (10, 28). Non-prismatic walls
  must be FLAGGED, not silently treated as a vertical pocket.
- Through slot: 26 x 8, through, centred at (-35, 22)
"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent / "test" / "machined.step"
OUT.parent.mkdir(parents=True, exist_ok=True)

with BuildPart() as part:
    Box(120, 80, 14, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Fillet only the four vertical outer corners R8 (edges at x=±60, y=±40)
    corner_edges = [
        e for e in part.edges().filter_by(Axis.Z)
        if abs(abs(e.center().X) - 60) < 0.01 and abs(abs(e.center().Y) - 40) < 0.01
    ]
    assert len(corner_edges) == 4, f"expected 4 corner edges, got {len(corner_edges)}"
    fillet(corner_edges, radius=8)

    # Pocket A, 5 deep from top (Z=14 -> Z=9)
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((-15, 0))):
            Rectangle(60, 40)
    extrude(amount=-5, mode=Mode.SUBTRACT)

    # Pocket B inside A, 4 more (Z=9 -> Z=5)
    with BuildSketch(Plane.XY.offset(9)):
        with Locations(Location((-15, 0))):
            Rectangle(30, 20)
    extrude(amount=-4, mode=Mode.SUBTRACT)

    # Pocket C, 3 deep (Z=14 -> Z=11)
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((35, 15))):
            Rectangle(20, 20)
    extrude(amount=-3, mode=Mode.SUBTRACT)

    # Counterbore D12 x 3 deep, then D6 through, both at (35, -20)
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((35, -20))):
            Circle(6)
    extrude(amount=-3, mode=Mode.SUBTRACT)
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((35, -20))):
            Circle(3)
    extrude(amount=-14, mode=Mode.SUBTRACT)

    # Through holes D5 at corners
    with BuildSketch(Plane.XY.offset(14)):
        with GridLocations(100, 60, 2, 2):
            Circle(2.5)
    extrude(amount=-14, mode=Mode.SUBTRACT)

    # Blind hole D8, 5 deep (Z=14 -> Z=9)
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((0, -28))):
            Circle(4)
    extrude(amount=-5, mode=Mode.SUBTRACT)

    # Bottom-only blind hole D5, 4 up from bottom (Z=0 -> Z=4) — trap
    with BuildSketch(Plane.XY.offset(0)):
        with Locations(Location((-45, -28))):
            Circle(2.5)
    extrude(amount=4, mode=Mode.SUBTRACT)

    # Tapered pocket, 10 deg inward taper, 6 deep — trap
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((10, 28))):
            Rectangle(24, 16)
    extrude(amount=-6, mode=Mode.SUBTRACT, taper=10)

    # Through slot 26 x 8
    with BuildSketch(Plane.XY.offset(14)):
        with Locations(Location((-35, 22))):
            Rectangle(26, 8)
    extrude(amount=-14, mode=Mode.SUBTRACT)

solid = part.part
print(f"volume: {solid.volume:.1f} mm^3")
print(f"bbox: {solid.bounding_box().min} -> {solid.bounding_box().max}")
export_step(solid, str(OUT))
print(f"wrote {OUT}")
