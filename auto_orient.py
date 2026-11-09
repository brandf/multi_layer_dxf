"""Auto-orientation for CAM (2026-11-08).

Given one solid from a STEP, decide how it should sit on the CNC bed
without the user writing a parts.json entry:

  1. Prismatic axis: the axis (X, Y or Z) that most planar-face area
     is normal to, plus most cylinder area runs along. A prismatic
     2.5D part has one dominant axis; a plain box does not (all three
     axes tie) and is reported ambiguous, never guessed.
  2. Best side up: among the planar faces normal to that axis,
     excluding the two outer faces, a face whose normal points
     +axis is the floor of a cavity opening toward +axis (pocket /
     blind hole / counterbore floor). Sum the opening area per side;
     the side with more opening area faces up. Through holes count
     for both sides, so they are ignored. A tie is ambiguous.
  3. The transform is returned, not applied: rotate the axis to Z,
     then flip 180 deg about X if the down side won. All rotations
     are about the part's bounding-box centre.

Nothing here guesses for a non-prismatic part: if the axis does not
dominate, or the two sides tie, the decision is flagged ambiguous
and the caller classifies the part as-is.
"""
import math


def analyze_orientation(solid, tol=0.01):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder

    faces = solid.faces()
    scores = {"X": 0.0, "Y": 0.0, "Z": 0.0}
    total = 0.0
    # planar faces: (axis, sign, area, centre-vector)
    planes = []
    for f in faces:
        try:
            ad = BRepAdaptor_Surface(f.wrapped)
            st = ad.GetType()
        except Exception:
            continue
        if st == GeomAbs_Plane:
            n = f.normal_at()
            a = f.area
            total += a
            for axis, comp in (("X", n.X), ("Y", n.Y), ("Z", n.Z)):
                if abs(abs(comp) - 1.0) < 1e-3:
                    scores[axis] += a
                    planes.append((axis, 1 if comp > 0 else -1, a, f.center()))
                    break
        elif st == GeomAbs_Cylinder:
            cyl = ad.Cylinder()
            ax = cyl.Axis().Direction()
            a = f.area
            total += a
            for axis, comp in (("X", ax.X()), ("Y", ax.Y()), ("Z", ax.Z())):
                if abs(abs(comp) - 1.0) < 1e-3:
                    scores[axis] += a
                    break

    axis = max(scores, key=scores.get)
    axis_share = (scores[axis] / total) if total > 0 else 0.0
    dominant = axis_share > 0.5
    notes = []
    if not dominant:
        notes.append(
            f"no dominant prismatic axis (best {axis} {axis_share:.0%} of face area) — "
            "part is not clearly 2.5D along one axis")

    # Best side up, along the chosen axis. Outer faces (centre within
    # tol of the bbox extremes along the axis) are the part's outside,
    # not openings — exclude them.
    up = down = 0.0
    if dominant:
        bb = solid.bounding_box()
        lo = {"X": bb.min.X, "Y": bb.min.Y, "Z": bb.min.Z}[axis]
        hi = {"X": bb.max.X, "Y": bb.max.Y, "Z": bb.max.Z}[axis]
        for ax, sign, a, c in planes:
            if ax != axis:
                continue
            pos = {"X": c.X, "Y": c.Y, "Z": c.Z}[axis]
            if abs(pos - lo) < max(tol, 0.05) or abs(pos - hi) < max(tol, 0.05):
                continue  # outer face
            if sign > 0:
                up += a
            else:
                down += a
    flip = False
    ambiguous_flip = False
    if dominant and up > 0 and down > 0:
        if abs(up - down) < 0.10 * max(up, down):
            ambiguous_flip = True
            notes.append(
                f"openings tie: +{axis} side {up:.0f} mm2 vs -{axis} side {down:.0f} mm2 "
                "(within 10%) — no flip, check which side should face up")
        elif down > up:
            flip = True
    elif dominant and down > 0 and up == 0:
        flip = True
    if flip:
        notes.append(f"flipped: -{axis} side has the openings ({down:.0f} mm2 vs {up:.0f} mm2)")

    return {
        "axis": axis,
        "axis_share": round(axis_share, 3),
        "axis_scores": {k: round(v, 1) for k, v in scores.items()},
        "dominant": dominant,
        "up_area_mm2": round(up, 1),
        "down_area_mm2": round(down, 1),
        "flip": flip,
        "ambiguous": (not dominant) or ambiguous_flip,
        "notes": notes,
    }


def orient_solid(solid, decision):
    """Apply the decision: rotate the prismatic axis to Z, then flip
    180 deg about X if the down side won. Rotations are about the
    bounding-box centre. Returns (solid, applied_list)."""
    from build123d import Axis, Location

    def rot_about_centre(obj, axis, deg):
        bb = obj.bounding_box()
        ctr = (bb.min + bb.max) / 2
        obj = obj.moved(Location((-ctr.X, -ctr.Y, -ctr.Z), (0, 0, 0)))
        obj = obj.rotate(axis, deg)
        obj = obj.moved(Location((ctr.X, ctr.Y, ctr.Z), (0, 0, 0)))
        return obj

    applied = []
    s = solid
    if decision["axis"] == "X":
        s = rot_about_centre(s, Axis.Y, -90)  # +X -> +Z
        applied.append("rotate -90 about Y (axis X -> Z)")
    elif decision["axis"] == "Y":
        s = rot_about_centre(s, Axis.X, 90)   # +Y -> +Z
        applied.append("rotate +90 about X (axis Y -> Z)")
    if decision["flip"]:
        s = rot_about_centre(s, Axis.X, 180)
        applied.append("flip 180 about X (down side up)")
    return s, applied
