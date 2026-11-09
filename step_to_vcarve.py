#!/usr/bin/env python3
"""
STEP -> layered DXF + manifest.json for VCarve Pro (2.5D, prismatic).

Reads the exact B-rep from a STEP file (no tessellation for
classification — circles stay circles), finds:
  - outer profile (top face outer wire)
  - pocket floors: planar faces with normal +/-Z, Zmin < Z < Zmax
  - through / blind holes: cylindrical faces with axis Z, ~360 deg total
  - through cuts: top-face inner wires with no pocket floor below them
and writes one layered DXF + manifest.json + report.md.

Usage:
  python step_to_vcarve.py part.step -o out/
  python step_to_vcarve.py part.step -o out/ --tol 0.01 --min-tool 3.0

Z-up, Z=0 at bottom of stock, depths measured down from top face.
All units mm in v1.
"""
import argparse, json, math, sys
from pathlib import Path
from collections import defaultdict

# ---------------------------------------------------------------- helpers
def fmt(x):
    return f"{x:.2f}"

def point_in_polygon(px, py, poly):
    """Ray casting. poly = list of (x, y)."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside

def poly_area(poly):
    a = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0

def dist_to_poly_boundary(px, py, poly):
    """Min distance from a point to the polyline through poly's points."""
    best = float("inf")
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
        d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
        best = min(best, d)
    return best

def segs_perimeter(segs):
    """Total cut length of a segment list (toolplan time estimate).
    Arc angles are stored in degrees (see edge_segments); the sweep
    is taken CCW from start to end, which is how ezdxf draws them.
    Good enough for an estimate — a major/minor arc mix-up on a rare
    big arc moves the estimate by seconds, not minutes."""
    total = 0.0
    for s in segs:
        if s[0] == 'line':
            total += math.hypot(s[2][0] - s[1][0], s[2][1] - s[1][1])
        elif s[0] == 'circle':
            total += 2 * math.pi * s[2]
        elif s[0] == 'arc':
            sweep = (s[4] - s[3]) % 360.0
            if sweep == 0:
                sweep = 360.0
            total += s[2] * math.radians(sweep)
        elif s[0] == 'poly':
            pts = s[1]
            for i in range(len(pts)):
                x1, y1 = pts[i]
                x2, y2 = pts[(i + 1) % len(pts)]
                total += math.hypot(x2 - x1, y2 - y1)
    return total

def segs_bbox(segs):
    """(min_x, min_y, max_x, max_y) over segment endpoints / centres.
    Used for the narrowest-width fit test (tool must fit the slot)."""
    xs, ys = [], []
    for s in segs:
        if s[0] == 'line':
            xs += [s[1][0], s[2][0]]
            ys += [s[1][1], s[2][1]]
        elif s[0] in ('circle', 'arc'):
            cx, cy, r = s[1][0], s[1][1], s[2]
            xs += [cx - r, cx + r]
            ys += [cy - r, cy + r]
        elif s[0] == 'poly':
            xs += [p[0] for p in s[1]]
            ys += [p[1] for p in s[1]]
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))

# ---------------------------------------------------------------- OCP edge extraction
def edge_segments(edge):
    """
    Return a list of exact 2D segments for an edge lying in a plane
    parallel to XY: each is ('line', (x1,y1), (x2,y2))
    or ('arc', (cx,cy), r, start_deg, end_deg)
    or ('circle', (cx,cy), r)
    or ('poly', [(x,y), ...]) for splines / other types.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Circle
    ad = BRepAdaptor_Curve(edge.wrapped)
    t = ad.GetType()
    p0, p1 = ad.FirstParameter(), ad.LastParameter()
    if t == GeomAbs_Line:
        a = ad.Value(p0); b = ad.Value(p1)
        return [('line', (a.X(), a.Y()), (b.X(), b.Y()))]
    if t == GeomAbs_Circle:
        circ = ad.Circle()
        loc = circ.Location()
        cx, cy = loc.X(), loc.Y()
        r = circ.Radius()
        span = abs(p1 - p0)
        if span >= 2 * math.pi - 0.01:
            return [('circle', (cx, cy), r)]
        # OCP circle params are angles in radians, in the circle plane
        return [('arc', (cx, cy), r, math.degrees(p0), math.degrees(p1))]
    # spline / ellipse / anything else: discretise, flag upstream
    pts = []
    n = 24
    for i in range(n + 1):
        p = p0 + (p1 - p0) * i / n
        v = ad.Value(p)
        pts.append((v.X(), v.Y()))
    return [('poly', pts)]

def _reverse_segs(segs):
    """Reverse segments of one edge (its parametrisation runs opposite
    the wire direction): lines swap ends, arcs swap start/end angles
    (ezdxf draws arcs CCW, so swapping angles keeps the same arc)."""
    out = []
    for s in segs:
        if s[0] == 'line':
            out.append(('line', s[2], s[1]))
        elif s[0] == 'arc':
            out.append(('arc', s[1], s[2], s[4], s[3]))
        elif s[0] == 'poly':
            out.append(('poly', s[1][::-1]))
        else:  # circle — direction-independent
            out.append(s)
    return out


def wire_segments(wire):
    segs = []
    edges = wire.edges()
    prev_end = None
    first_edge_segs = None
    for k, e in enumerate(edges):
        es = edge_segments(e)
        try:
            sp = (e.start_point().X, e.start_point().Y)
            ep = (e.end_point().X, e.end_point().Y)
        except Exception:
            sp = ep = None
        if k == 0:
            first_edge_segs = es
        if prev_end is not None and sp is not None:
            d_sp = math.hypot(sp[0] - prev_end[0], sp[1] - prev_end[1])
            d_ep = math.hypot(ep[0] - prev_end[0], ep[1] - prev_end[1])
            if d_ep < d_sp - 1e-9:
                es = _reverse_segs(es)
                sp, ep = ep, sp
        segs.extend(es)
        if ep is not None:
            prev_end = ep
    # first edge: orient by the closing check (it must meet prev_end)
    if first_edge_segs is not None and prev_end is not None and len(edges) > 1:
        try:
            e0 = edges[0]
            sp0 = (e0.start_point().X, e0.start_point().Y)
            ep0 = (e0.end_point().X, e0.end_point().Y)
            d_sp = math.hypot(sp0[0] - prev_end[0], sp0[1] - prev_end[1])
            d_ep = math.hypot(ep0[0] - prev_end[0], ep0[1] - prev_end[1])
            if d_ep < d_sp - 1e-9:
                # the first edge's segments are at the head of segs
                n0 = len(first_edge_segs)
                segs[:n0] = _reverse_segs(segs[:n0])
        except Exception:
            pass
    return segs

def wire_sample_points(wire, per_edge=12):
    """Sample points around a wire for containment / area tests.
    Each edge's samples are oriented to the wire direction (see
    wire_segments): without this, phantom chords between
    non-adjacent edge samples corrupt point-in-polygon and
    distance tests."""
    raw = []
    for e in wire.edges():
        try:
            from OCP.BRepAdaptor import BRepAdaptor_Curve
            ad = BRepAdaptor_Curve(e.wrapped)
            p0, p1 = ad.FirstParameter(), ad.LastParameter()
            ep = []
            for i in range(per_edge):
                v = ad.Value(p0 + (p1 - p0) * i / per_edge)
                ep.append((v.X(), v.Y()))
        except Exception:
            ep = [(v.X, v.Y) for v in (e.start_point(), e.end_point())]
        raw.append(ep)
    if not raw:
        return []
    pts = list(raw[0])
    for ep in raw[1:]:
        if not ep:
            continue
        d_first = math.hypot(ep[0][0] - pts[-1][0], ep[0][1] - pts[-1][1])
        d_last = math.hypot(ep[-1][0] - pts[-1][0], ep[-1][1] - pts[-1][1])
        if d_last < d_first - 1e-9:
            ep = ep[::-1]
        pts.extend(ep)
    # orient the first edge by the closing check
    n0 = len(raw[0])
    if n0 > 1 and len(pts) > n0:
        first = pts[:n0]
        d_first = math.hypot(first[0][0] - pts[-1][0], first[0][1] - pts[-1][1])
        d_last = math.hypot(first[-1][0] - pts[-1][0], first[-1][1] - pts[-1][1])
        if d_last < d_first - 1e-9:
            pts = first[::-1] + pts[n0:]
    return pts

def _wire_is_island(solid, poly, floor_z):
    """True if material rises above the floor inside this inner wire
    (a rib / boss island the pocket must preserve) — tested by asking
    the solid whether points just above the floor, inside the wire,
    are inside the solid. A hole or deeper-pocket opening has void
    above the floor, so it tests False. Found on the real container
    (BRA-8, 2026-11-08): the Bottom's mating rib (r15..18) rises
    1.5 mm above the Z 8.00 step face, and a plain pocket of the
    outer wire would have machined it away."""
    if not poly or len(poly) < 3:
        return False
    cx = sum(x for x, _ in poly) / len(poly)
    cy = sum(y for _, y in poly) / len(poly)
    try:
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.gp import gp_Pnt
        from OCP.TopAbs import TopAbs_IN, TopAbs_ON
        cls = BRepClass3d_SolidClassifier(solid.wrapped)
        pts = poly[::max(1, len(poly) // 6)][:6]
        for (px, py) in pts:
            dx, dy = px - cx, py - cy
            dist = math.hypot(dx, dy)
            if dist < 1e-9:
                continue
            for off in (0.3, 0.8, 2.0):
                if off >= dist:
                    continue
                tx = px - dx / dist * off
                ty = py - dy / dist * off
                for dz in (0.1, 0.5):
                    cls.Perform(gp_Pnt(tx, ty, floor_z + dz), 1e-6)
                    if cls.State() in (TopAbs_IN, TopAbs_ON):
                        return True
    except Exception:
        return False
    return False


def wire_is_single_circle(wire):
    # A circle is often ONE edge — but OCC splits some circles into
    # two semicircular edges (a seam). The real container's 8 hole-floor
    # discs were 2-edge wires, so this returned None for 7 of 8 and the
    # discs were misread as pockets (BRA-8, 2026-11-08). Accept any set
    # of circle/arc edges that share one centre and radius and sweep
    # the full 360 degrees.
    centre = None
    radius = None
    sweep = 0.0
    for e in wire.edges():
        for s in edge_segments(e):
            if s[0] == 'circle':
                (_, (cx, cy), r) = s
                sweep += 360.0
            elif s[0] == 'arc':
                (_, (cx, cy), r, a0, a1) = s
                sweep += (a1 - a0) % 360.0
            else:
                return None
            if centre is None:
                centre, radius = (cx, cy), r
            elif (abs(cx - centre[0]) > 0.05 or abs(cy - centre[1]) > 0.05
                    or abs(r - radius) > 0.05):
                return None
    if centre is None or abs(sweep - 360.0) > 1.0:
        return None
    return centre, radius

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", type=Path)
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--tol", type=float, default=0.01, help="Z grouping tolerance, mm")
    ap.add_argument("--min-tool", type=float, default=0.0, help="flag features smaller than this, mm")
    ap.add_argument("--max-drill", type=float, default=20.0, help="cylinders larger than this are pockets/profile, not drills, mm")
    # Flexible / not-all-or-nothing modes:
    #   full (default): DXF + manifest + report
    #   check: classify + report only, write nothing to VCarve
    #   dxf: DXF + report, no manifest (use VCarve manually / template)
    #   manifest: manifest + report, no DXF (re-run DXF later)
    ap.add_argument("--mode", choices=["full", "check", "dxf", "manifest"], default="full")
    ap.add_argument("--only", default="", help="comma list: drill,pocket,profile — only emit those operations")
    ap.add_argument("--config", type=Path, default=None, help="JSON config file (see config.example.json)")
    ap.add_argument("--auto-orient", action="store_true",
                    help="auto-detect the prismatic axis and best side up, rotate/flip the solid before classifying (see auto_orient.py)")
    ap.add_argument("--no-toolplan", action="store_true",
                    help="skip tool recommendations (multi_part.py plans the merged job itself)")
    ap.add_argument("--plan", default="",
                    help="which tool plan to write as manifest.txt (A/B/C — default fastest, A)")
    args = ap.parse_args()

    # Config file overrides CLI defaults (CLI wins if explicitly set is
    # out of scope for v1 — config is for tools / defaults you reuse)
    cfg = {}
    if args.config and args.config.exists():
        cfg = json.loads(args.config.read_text())
        args.tol = cfg.get("tol_mm", args.tol)
        args.min_tool = cfg.get("min_tool_mm", args.min_tool)
        args.max_drill = cfg.get("max_drill_mm", args.max_drill)
        if cfg.get("only") and not args.only:
            args.only = ",".join(cfg["only"])
        print(f"config: {args.config} tol={args.tol} min_tool={args.min_tool} only={args.only or 'all'}")

    from build123d import import_step, GeomType
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Torus,
                             GeomAbs_Cone, GeomAbs_BSplineSurface)

    outdir = args.out
    outdir.mkdir(parents=True, exist_ok=True)
    stem = args.step.stem

    solid = import_step(str(args.step))
    # import_step may return a Compound; take its solids
    try:
        solids = solid.solids()
    except Exception:
        solids = [solid]
    if len(solids) != 1:
        print(f"WARNING: {len(solids)} solids in STEP, using first / all faces merged", file=sys.stderr)
    # Auto-orientation (2026-11-08): a STEP exported from Onshape in
    # any orientation, or a part modelled on its side, is rotated so
    # its prismatic axis is Z and its most-open side faces up, before
    # any classification runs. Ambiguous parts are classified as-is
    # and flagged — never silently re-oriented.
    auto_decision = None
    if args.auto_orient:
        import auto_orient as _ao
        auto_decision = _ao.analyze_orientation(solids[0])
        print(f"auto-orient: axis {auto_decision['axis']} "
              f"(share {auto_decision['axis_share']:.0%}), "
              f"openings +{auto_decision['up_area_mm2']:.0f} vs -{auto_decision['down_area_mm2']:.0f} mm2, "
              f"flip={auto_decision['flip']}, ambiguous={auto_decision['ambiguous']}")
        for n in auto_decision["notes"]:
            print(f" auto-orient note: {n}")
        if auto_decision["dominant"] and not auto_decision["ambiguous"]:
            solid, applied = _ao.orient_solid(solids[0], auto_decision)
            print(f"auto-orient applied: {applied}")
            solids = [solid]
        elif auto_decision["ambiguous"]:
            flags_note = "AUTO-ORIENT AMBIGUOUS — classified as-is, check orientation: " + "; ".join(auto_decision["notes"])
            print(f" {flags_note}")
            # flags list is created below; stash for now
            auto_decision["flags_note"] = flags_note
    faces = []
    for s in solids:
        faces.extend(s.faces())

    bb = solid.bounding_box()
    zmin, zmax = bb.min.Z, bb.max.Z
    thickness = zmax - zmin
    print(f"bbox Z {zmin:.3f} .. {zmax:.3f}  thickness {thickness:.3f} mm, {len(faces)} faces")

    flags = []
    if auto_decision and auto_decision.get("flags_note"):
        flags.append(auto_decision["flags_note"])
    planar_z = []   # (z, face)
    cyl_z = []      # dicts
    other_faces = []
    # Structured measurements for non-prismatic faces, used by the
    # post-processing planner (below): each entry is a dict with
    # kind + measured parameters + face, so the planner can say
    # "round over the top outer edge with an R3 bit" instead of
    # just "non-prismatic face". Added 2026-11-08 (de-bevel work).
    nonprism_info = []

    for f in faces:
        try:
            ad = BRepAdaptor_Surface(f.wrapped)
            st = ad.GetType()
        except Exception as e:
            other_faces.append((f, str(e)))
            continue
        if st == GeomAbs_Plane:
            n = f.normal_at()
            if abs(abs(n.Z) - 1.0) < 1e-3:
                planar_z.append((f.center().Z, f))
            elif abs(abs(n.X) - 1.0) < 1e-3 or abs(abs(n.Y) - 1.0) < 1e-3:
                pass  # vertical wall — expected in a prismatic part
            else:
                other_faces.append((f, f"slanted planar face, normal {n}"))
                fb = f.bounding_box()
                nonprism_info.append({
                    "kind": "chamfer", "face": f,
                    "angle_deg": round(math.degrees(math.acos(min(1.0, abs(n.Z)))), 1),
                    "z_span": round(fb.max.Z - fb.min.Z, 3),
                    "xy_span": round(max(fb.max.X - fb.min.X, fb.max.Y - fb.min.Y), 3),
                })
        elif st == GeomAbs_Cylinder:
            cyl = ad.Cylinder()
            ax = cyl.Axis().Direction()
            loc = cyl.Location()
            if abs(abs(ax.Z()) - 1.0) < 1e-3:
                span = abs(ad.LastUParameter() - ad.FirstUParameter())
                cyl_z.append({
                    "cx": loc.X(), "cy": loc.Y(), "r": cyl.Radius(),
                    "z0": f.bounding_box().min.Z, "z1": f.bounding_box().max.Z,
                    "span": span, "face": f,
                })
            else:
                other_faces.append((f, f"non-Z cylinder, axis {ax.X():.2f},{ax.Y():.2f},{ax.Z():.2f}"))
                # A horizontal cylinder is usually an edge fillet
                # (roundover) — its radius is the fillet radius.
                nonprism_info.append({
                    "kind": "fillet", "face": f,
                    "radius": round(cyl.Radius(), 3),
                    "axis": (round(ax.X(), 2), round(ax.Y(), 2), round(ax.Z(), 2)),
                })
        elif st == GeomAbs_Torus:
            tor = ad.Torus()
            other_faces.append((f, f"torus face (fillet), minor radius {tor.MinorRadius():.2f}"))
            nonprism_info.append({
                "kind": "fillet", "face": f,
                "radius": round(tor.MinorRadius(), 3),
                "major_radius": round(tor.MajorRadius(), 3),
            })
        elif st == GeomAbs_Cone:
            cone = ad.Cone()
            cax = cone.Axis().Direction()
            cloc = cone.Axis().Location()
            fb = f.bounding_box()
            other_faces.append((f, f"cone, semi-angle {math.degrees(cone.SemiAngle()):.1f} deg, axis {cax.X():.2f},{cax.Y():.2f},{cax.Z():.2f}"))
            nonprism_info.append({
                "kind": "taper", "face": f,
                "semi_angle_deg": round(math.degrees(cone.SemiAngle()), 1),
                "axis": (round(cax.X(), 2), round(cax.Y(), 2), round(cax.Z(), 2)),
                "cx": round(cloc.X(), 3), "cy": round(cloc.Y(), 3),
                "z0": round(fb.min.Z, 3), "z1": round(fb.max.Z, 3),
            })
        else:
            other_faces.append((f, f"surface type {st}, centre Z {f.center().Z:.2f}"))
            nonprism_info.append({
                "kind": "freeform", "face": f, "surface_type": str(st),
            })

    for f, why in other_faces:
        # Faces measured into the post-processing plan (nonprism_info)
        # get a POST-PROCESS entry instead of this generic flag — the
        # plan says what to do about them, this flag only said they
        # exist. Faces the planner could not measure keep the flag.
        if any(info["face"] is f for info in nonprism_info):
            continue
        flags.append(f"NON-PRISMATIC / REVIEW: {why} (area {f.area:.1f} mm2, centre {f.center()})")

    # ---- holes: group cylinders by centre + radius, sum angular span
    # Circular parts need two exclusions, both found on the container
    # test (2026-11-08):
    #  1. The outer wall of a round part is itself a full cylinder
    #     (D100 here) — it is the profile, not a thru hole. Skip any
    #     cylinder matching a top-face outer-wire circle.
    #  2. A circular pocket's wall is also a full cylinder (D60 here).
    #     A D60 "hole" would never be drilled on a router; it is
    #     pocketed with an endmill. Cylinders over --max-drill
    #     (default 20 mm) are left to the pocket / profile code, whose
    #     floor face is the disc at the pocket bottom.
    # Outer-wall circles from the TOP and BOTTOM faces only — not from
    # every planar Z face. On a beveled part the top face is shrunk by
    # the fillet, so the outer wall cylinder (true radius) only matches
    # the bottom face's circle; without it, the outer wall would be
    # misclassified as a thru hole. But intermediate faces must NOT be
    # included: a blind hole's bottom disc and a counterbore floor are
    # circles too, and including them made the classifier skip those
    # holes entirely (machined.step lost 3 holes, 2026-11-08).
    top_outer_circles = set()
    for z, f in planar_z:
        if abs(z - zmax) < 0.05 or abs(z - zmin) < 0.05:
            circ = wire_is_single_circle(f.outer_wire())
            if circ:
                (ccx, ccy), cr = circ
                top_outer_circles.add((round(ccx, 2), round(ccy, 2), round(cr, 3)))

    groups = defaultdict(list)
    for c in cyl_z:
        key = (round(c["cx"], 2), round(c["cy"], 2), round(c["r"], 3))
        groups[key].append(c)

    holes = []  # {cx, cy, dia, z0, z1, kind}
    for (cx, cy, r), cs in sorted(groups.items()):
        if (round(cx, 2), round(cy, 2), round(r, 3)) in top_outer_circles:
            continue  # outer profile wall, not a hole
        if 2 * r > args.max_drill:
            continue  # large circular pocket / profile, handled elsewhere
        total_span = sum(c["span"] for c in cs)
        z0 = min(c["z0"] for c in cs); z1 = max(c["z1"] for c in cs)
        if total_span >= 5.5:  # ~315 deg, full hole (may be split in 2 halves)
            if abs(z0 - zmin) < 0.05 and abs(z1 - zmax) < 0.05:
                kind = "thru"
            elif abs(z1 - zmax) < 0.05:
                kind = "blind_top"
            elif abs(z0 - zmin) < 0.05:
                kind = "blind_bottom"
            else:
                kind = "internal"
            holes.append({"cx": cx, "cy": cy, "dia": 2 * r, "z0": z0, "z1": z1, "kind": kind})
        else:
            flags.append(
                f"PARTIAL CYLINDER (fillet / rounded wall, not a hole): "
                f"centre ({cx:.2f},{cy:.2f}) r={r:.2f} span={math.degrees(total_span):.0f}deg Z {z0:.2f}..{z1:.2f}"
            )

    # Counterbore over a through hole: the wider hole above removes the
    # top section of the narrower cylinder, so it ends at the counterbore
    # floor instead of at zmax — but it still goes through the part.
    # Found on the machined test (2026-11-08): D6 under a D12 counterbore
    # was misclassified blind_bottom and its drill layer was dropped.
    for h in holes:
        if h["kind"] in ("blind_bottom", "internal") and abs(h["z0"] - zmin) < 0.05:
            for w in holes:
                if w is h or w["dia"] <= h["dia"]:
                    continue
                if (abs(w["cx"] - h["cx"]) < 0.05 and abs(w["cy"] - h["cy"]) < 0.05
                        and abs(w["z0"] - h["z1"]) < 0.05 and abs(w["z1"] - zmax) < 0.05):
                    h["kind"] = "thru"
                    h["z1"] = zmax
                    flags.append(
                        f"COUNTERBORE THRU HOLE: dia {h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) "
                        f"under D{w['dia']:.2f} counterbore — treated as thru")
                    break
            if h["kind"] != "thru":
                # Countersunk thru hole: the cylinder ends where a
                # coaxial Z cone (the countersink) starts, and the cone
                # reaches the top — the hole still goes through.
                # Found on the beveled plate test (2026-11-08).
                for info in nonprism_info:
                    if info["kind"] != "taper":
                        continue
                    ax = info.get("axis")
                    if not ax or abs(abs(ax[2]) - 1.0) > 1e-3:
                        continue
                    if (abs(info.get("cx", 1e9) - h["cx"]) < 0.05
                            and abs(info.get("cy", 1e9) - h["cy"]) < 0.05
                            and abs(info.get("z0", 0) - h["z1"]) < 0.5
                            and abs(info.get("z1", 0) - zmax) < 0.05):
                        h["kind"] = "thru"
                        h["z1"] = zmax
                        flags.append(
                            f"COUNTERSUNK THRU HOLE: dia {h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) "
                            f"under a {info['semi_angle_deg']:.0f} deg countersink — treated as thru")
                        break

    # ---- planar Z faces: group by Z
    by_z = defaultdict(list)
    for z, f in planar_z:
        by_z[round(z / max(args.tol, 0.001))].append((z, f))
    # rebuild with representative Z
    z_levels = []
    for _, lst in sorted(by_z.items()):
        zrep = sum(z for z, _ in lst) / len(lst)
        z_levels.append((zrep, [f for _, f in lst]))

    top_faces = [f for z, fs in z_levels if abs(z - zmax) < 0.05 for f in fs]
    bottom_faces = [f for z, fs in z_levels if abs(z - zmin) < 0.05 for f in fs]

    # hole-bottom discs: planar face, single circle, matches a hole
    def is_hole_bottom(face):
        circ = wire_is_single_circle(face.outer_wire())
        if not circ:
            return False
        (cx, cy), r = circ
        for h in holes:
            if abs(h["cx"] - cx) < 0.05 and abs(h["cy"] - cy) < 0.05 and abs(h["dia"] / 2 - r) < 0.05:
                return True
        return False

    pockets = []  # {z, depth, face, outer_segs, poly}
    for z, fs in z_levels:
        if abs(z - zmax) < 0.05 or abs(z - zmin) < 0.05:
            continue
        for f in fs:
            if is_hole_bottom(f):
                continue
            poly = wire_sample_points(f.outer_wire())
            pockets.append({"z": z, "depth": zmax - z, "face": f,
                            "segs": wire_segments(f.outer_wire()), "poly": poly,
                            "inner": [wire_segments(w) for w in f.inner_wires()],
                            "inner_polys": [wire_sample_points(w) for w in f.inner_wires()]})

    # pocket-in-pocket start depths via containment. The parent pocket
    # is recorded: a child pocket can only be cut after its parent
    # (the parent's floor is the surface the child starts from), so
    # the child DEPENDS on the parent in cut order (BRA-14).
    pockets.sort(key=lambda p: p["depth"])
    for p in pockets:
        p["start"] = 0.0
        p["parent"] = None
        c = p["face"].center()
        for q in pockets:
            if q is p or q["depth"] >= p["depth"]:
                continue
            if point_in_polygon(c.X, c.Y, q["poly"]):
                if q["depth"] > p["start"]:
                    p["start"] = q["depth"]
                    p["parent"] = q
        p["cut"] = p["depth"] - p["start"]

    def _pocket_layer_name(p):
        if abs(p["start"]) < 0.005:
            return f"POCKET_D{fmt(p['depth'])}"
        return f"POCKET_D{fmt(p['depth'])}_START{fmt(p['start'])}"

    def _pocket_corner_radius(segs):
        """Tightest corner of a pocket outline (mm): the smallest arc
        radius, or 0.0 if two straight edges meet at a sharp corner,
        or None if the outline has no corners (round / spline outline).
        A finish pass can only sharpen a corner down to the finish
        tool's own radius — this is the number the tool planner
        reasons about (BRA-14)."""
        if not segs:
            return None
        radii = []
        sharp = False
        for s in segs:
            if s[0] == 'arc':
                radii.append(s[2])
            elif s[0] == 'circle':
                radii.append(s[2])
        # Sharp corners: consecutive line segments that change
        # direction. segs are wire-ordered, so consecutive lines share
        # an endpoint; collinear splits (turn ~0) are not corners.
        n = len(segs)
        for i in range(n):
            a, b = segs[i], segs[(i + 1) % n]
            if a[0] != 'line' or b[0] != 'line':
                continue
            d1 = (a[2][0] - a[1][0], a[2][1] - a[1][1])
            d2 = (b[2][0] - b[1][0], b[2][1] - b[1][1])
            n1 = math.hypot(*d1)
            n2 = math.hypot(*d2)
            if n1 < 1e-9 or n2 < 1e-9:
                continue
            cosang = (d1[0] * d2[0] + d1[1] * d2[1]) / (n1 * n2)
            if cosang < math.cos(math.radians(10)):
                sharp = True
                break
        if sharp:
            return 0.0
        if radii:
            return round(min(radii), 3)
        return None

    # ---- pocket suppression, decided BEFORE layer building: a pocket
    # whose floor outline is ringed by a non-prismatic wall (taper,
    # cone, spline) must not be emitted as a vertical pocket at its
    # floor size — that would cut the wrong shape. Decided here (not
    # in the layer loop) because the drill pass below needs to know
    # which pockets are actually emitted: a hole opening on a
    # suppressed pocket's floor has no machined surface to drill from.
    # Found on the machined test (2026-11-08): a 10 deg tapered pocket
    # was emitted as POCKET_D6.00 at its (smaller) floor outline.
    for p in pockets:
        p["suppressed"] = False
        if p["poly"]:
            # A wall face belongs to this pocket if its LOWEST edge lies on
            # the pocket's floor outline — that edge is shared with the
            # floor face. (Face-centre proximity is not enough: on the
            # machined test the tapered pocket sits flush against Pocket A,
            # and its wall's centre is 0.5 mm from Pocket A's outline too,
            # which falsely suppressed Pocket A as well.)
            for info in nonprism_info:
                f = info["face"]
                # A small floor fillet (Z span << pocket depth) does not
                # make the pocket un-cuttable — the endmill leaves a
                # sharp corner and the fillet becomes a post-process
                # item (ball-nose) instead. A taper / freeform wall
                # spanning most of the depth does suppress the pocket.
                fb = f.bounding_box()
                zspan = fb.max.Z - fb.min.Z
                if info["kind"] in ("taper", "freeform"):
                    substantial = True
                else:
                    # 0.6, not 0.5: a floor fillet's Z span is exactly
                    # its radius, and R2 on a 4 mm pocket is 0.5 — that
                    # must NOT suppress the pocket (floating point
                    # would flip it). A wall that is mostly round
                    # (span > 60% of depth) does suppress.
                    substantial = zspan > 0.6 * p["depth"]
                if not substantial:
                    continue
                try:
                    low_edge = min(f.edges(), key=lambda e: e.center().Z)
                except Exception:
                    continue
                c = low_edge.center()
                if abs(c.Z - p["z"]) > 0.05:
                    continue
                if dist_to_poly_boundary(c.X, c.Y, p["poly"]) < 0.1:
                    p["suppressed"] = True
                    flags.append(
                        f"POCKET SUPPRESSED (non-vertical walls, no toolpath): floor Z {p['z']:.2f}, "
                        f"depth {p['depth']:.2f} — {info['kind']} wall, Z span {zspan:.2f} mm")
                    break
    # A child pocket whose parent is suppressed has no surface to
    # start from either.
    for p in pockets:
        if p.get("parent") is not None and p["parent"].get("suppressed"):
            if not p["suppressed"]:
                p["suppressed"] = True
                flags.append(
                    f"POCKET SUPPRESSED (parent pocket suppressed): floor Z {p['z']:.2f}, "
                    f"depth {p['depth']:.2f} — its parent has non-vertical walls")

    # floor Z -> layer name, for pockets that WILL be cut. A hole
    # opening on one of these floors is drilled from that surface
    # (the facing pocket runs first) — see the drill loop (BRA-14).
    pocket_floor_layer = {}
    for p in pockets:
        if not p["suppressed"]:
            pocket_floor_layer[round(p["z"], 3)] = _pocket_layer_name(p)

    # ---- profile: largest outer wire among ALL planar Z faces
    # A beveled / filleted top edge shrinks the top face, so the top
    # face no longer carries the true profile — the bottom face does
    # (or vice versa for a bottom-edge fillet). Taking the largest
    # outer-wire area over every planar Z face recovers the true
    # prismatic profile from a beveled STEP with no rollback.
    # (2026-11-08 de-bevel work.)
    def _outer_wire_area(f):
        try:
            return abs(poly_area(wire_sample_points(f.outer_wire())))
        except Exception:
            return 0.0

    profile_segs = []
    profile_poly = []
    profile_source = None
    if planar_z:
        prof_face = max((f for _, f in planar_z), key=_outer_wire_area)
        profile_segs = wire_segments(prof_face.outer_wire())
        profile_poly = wire_sample_points(prof_face.outer_wire())
        profile_source = f"Z {prof_face.center().Z:.2f} face"
        # Top vs bottom outline mismatch = an edge fillet/chamfer ate
        # one side. Report it; the post-process plan (below) says how
        # to put the edge back.
        top_area = max((_outer_wire_area(f) for f in top_faces), default=0.0)
        bot_area = max((_outer_wire_area(f) for f in bottom_faces), default=0.0)
        if top_area > 0 and bot_area > 0:
            diff = abs(top_area - bot_area) / max(top_area, bot_area)
            if diff > 0.01:
                flags.append(
                    f"PROFILE OUTLINE DIFFERS top vs bottom by {diff:.0%} "
                    f"(top {top_area:.0f} mm2, bottom {bot_area:.0f} mm2) — "
                    f"profile taken from {profile_source}; an edge fillet/chamfer "
                    "is in the post-processing plan, not in the DXF")
        # Vertical-wall check: if any vertical face sticks out beyond
        # the profile (both top and bottom edges filleted), the profile
        # is undersized and must not be trusted silently.
        if profile_poly:
            px = [x for x, _ in profile_poly]; py = [y for _, y in profile_poly]
            wall = [1e18, 1e18, -1e18, -1e18]  # xmin, ymin, xmax, ymax
            for f in faces:
                try:
                    ad2 = BRepAdaptor_Surface(f.wrapped)
                    st2 = ad2.GetType()
                except Exception:
                    continue
                is_vert = False
                if st2 == GeomAbs_Plane:
                    n2 = f.normal_at()
                    is_vert = abs(abs(n2.X) - 1.0) < 1e-3 or abs(abs(n2.Y) - 1.0) < 1e-3
                elif st2 == GeomAbs_Cylinder:
                    ax2 = ad2.Cylinder().Axis().Direction()
                    is_vert = abs(abs(ax2.Z()) - 1.0) < 1e-3
                if is_vert:
                    fb = f.bounding_box()
                    wall[0] = min(wall[0], fb.min.X); wall[1] = min(wall[1], fb.min.Y)
                    wall[2] = max(wall[2], fb.max.X); wall[3] = max(wall[3], fb.max.Y)
            if wall[2] > -1e17:
                over = max(min(px) - wall[0], min(py) - wall[1],
                           wall[2] - max(px), wall[3] - max(py))
                if over > 0.05:
                    flags.append(
                        f"VERTICAL WALLS EXTEND {over:.2f} mm BEYOND PROFILE — "
                        "edge fillet/chamfer on both top and bottom, profile "
                        "may be undersized; check the wall footprint before cutting")
        top_inner = [w for f in top_faces for w in f.inner_wires()]
    else:
        flags.append("NO PLANAR Z FACE FOUND — check Z-up / orientation")
        top_inner = []

    # ---- through-cut helpers (shared by top and bottom scans) ----
    def _on_hole_circle(x, y):
        # A point far outside a pocket outline is only evidence of a
        # merged through feature if it is not on a hole's circle: a hole
        # notching a pocket corner (test_part Pocket C, D6 at (35,25))
        # puts arc points up to its radius outside the outline.
        for h in holes:
            if abs(math.hypot(x - h["cx"], y - h["cy"]) - h["dia"] / 2) < 0.5:
                return True
        return False

    def _far_outside_frac(poly, pocket_poly):
        # Fraction of a wire's sample points >2 mm outside a pocket floor
        # outline (and not on a hole circle). Boundary-coincident points
        # are unreliable for ray casting, and a tapered pocket's outline
        # is only ~1 mm outside its floor, so the 2 mm margin separates
        # a merged slot from a taper or a hole notch.
        if not poly or not pocket_poly:
            return 0.0
        far = sum(1 for (x, y) in poly
                  if not point_in_polygon(x, y, pocket_poly)
                  and dist_to_poly_boundary(x, y, pocket_poly) > 2.0
                  and not _on_hole_circle(x, y))
        return far / len(poly)

    def _max_far_dist(poly, pocket_poly):
        # Deepest excursion of a wire outside a pocket outline (mm).
        # A merged slot sticks out 6+ mm; a pocket whose FLOOR corners
        # are rounded by a fillet sticks out <3 mm at the corners only
        # (beveled plate test) — fraction alone cannot tell them apart.
        if not poly or not pocket_poly:
            return 0.0
        return max((dist_to_poly_boundary(x, y, pocket_poly)
                    for (x, y) in poly
                    if not point_in_polygon(x, y, pocket_poly)
                    and not _on_hole_circle(x, y)), default=0.0)

    def _explained_by_pocket(poly):
        # (explained, pocket, far_frac): does a pocket floor have
        # (nearly) this outline? A pocket floor's outer wire is the same
        # XY outline as its top opening, even when a hole or
        # pocket-in-pocket changes its area / bbox.
        for p in pockets:
            if not p["poly"]:
                continue
            inside = sum(1 for (x, y) in poly if point_in_polygon(x, y, p["poly"]))
            if inside >= len(poly) / 2:
                return True, p, _far_outside_frac(poly, p["poly"])
            c = p["face"].center()
            if point_in_polygon(c.X, c.Y, poly):
                return True, p, _far_outside_frac(poly, p["poly"])
        return False, None, 0.0

    def _same_bbox(poly_a, poly_b, tol=0.05):
        if not poly_a or not poly_b:
            return False
        ax = [x for x, _ in poly_a]; ay = [y for _, y in poly_a]
        bx = [x for x, _ in poly_b]; by = [y for _, y in poly_b]
        return (abs(min(ax) - min(bx)) < tol and abs(max(ax) - max(bx)) < tol
                and abs(min(ay) - min(by)) < tol and abs(max(ay) - max(by)) < tol)

    # through cuts: top inner wires not explained by a pocket or hole
    through_cuts = []
    merged_candidates = []  # (poly, pocket, far_frac) — resolved below
    for w in top_inner:
        circ = wire_is_single_circle(w)
        if circ:
            (cx, cy), r = circ
            # Any circle coaxial with a hole is that hole's opening —
            # a countersink / counterbore opening is WIDER than the
            # drill, so radius must not be part of the match. Without
            # this, a countersunk hole's top circle was emitted as a
            # spurious THROUGH_CUT. (2026-11-08 beveled plate test.)
            if any(abs(h["cx"] - cx) < 0.05 and abs(h["cy"] - cy) < 0.05 for h in holes):
                continue
        poly = wire_sample_points(w)
        if not poly:
            continue
        explained, pocket, far_frac = _explained_by_pocket(poly)
        if explained:
            # Partially explained = a through feature (e.g. a slot)
            # whose opening merged with a pocket's opening on the top
            # face. It is not emitted as a through cut here (that would
            # cut the pocket through) — it is a candidate for bottom-face
            # recovery below. Found on the machined test (2026-11-08):
            # a through slot overlapping Pocket A vanished.
            # The >3 mm excursion test separates a real merged slot
            # (sticks out 6+ mm) from a pocket whose floor corners are
            # merely rounded by a fillet (<3 mm at the corners only).
            if 0.05 < far_frac < 0.95 and _max_far_dist(poly, pocket["poly"]) > 3.0:
                merged_candidates.append((poly, pocket, far_frac))
        else:
            through_cuts.append({"segs": wire_segments(w), "poly": poly, "source": "top"})

    # Bottom-face recovery (BRA-9): a through feature whose top opening
    # merged with a pocket's opening still has a clean, unmerged outline
    # on the bottom face — the pocket is blind, so it cannot appear
    # there. Verified on test/machined.step: the slot is a merged
    # 12-edge wire on top, but a clean 26x8 rectangle on the bottom.
    # Bottom wires are ONLY used to resolve a merged candidate, never
    # emitted on their own — a blind pocket opening from the bottom
    # would otherwise be mis-emitted as a through cut.
    bottom_inner = [w for f in bottom_faces for w in f.inner_wires()]
    for w in bottom_inner:
        circ = wire_is_single_circle(w)
        if circ:
            (cx, cy), r = circ
            if any(abs(h["cx"] - cx) < 0.05 and abs(h["cy"] - cy) < 0.05 for h in holes):
                continue  # hole opening (incl. countersink / counterbore)
        poly = wire_sample_points(w)
        if not poly:
            continue
        if any(_same_bbox(poly, tc["poly"]) for tc in through_cuts):
            continue  # already emitted from the top face
        for i, (tpoly, pocket, far_frac) in enumerate(merged_candidates):
            if pocket is None:
                continue
            if _far_outside_frac(poly, pocket["poly"]) > 0.05:
                through_cuts.append({"segs": wire_segments(w), "poly": poly, "source": "bottom"})
                merged_candidates[i] = (tpoly, pocket, far_frac, True)
                break

    for cand in merged_candidates:
        poly, pocket, far_frac = cand[0], cand[1], cand[2]
        recovered = len(cand) > 3 and cand[3]
        if recovered:
            flags.append(
                "THROUGH FEATURE MERGED WITH POCKET on top face — recovered from "
                "bottom face as THROUGH_CUT (verify the outline in VCarve)")
        else:
            flags.append(
                "THROUGH FEATURE MERGED WITH POCKET: top opening is partly a pocket "
                f"({far_frac:.0%} of its outline is >2 mm outside the pocket) "
                "and partly a through opening — the through part is NOT in the DXF, "
                "add it manually in VCarve")

    # ---- post-processing plan: from the prismatic blank to the final shape
    # The DXF above is the prismatic blank — what the CNC cuts in 2.5D.
    # Every non-prismatic face is a feature the blank does NOT have.
    # This plan says how to put each one back, and whether the CNC or a
    # post-process step is the better place. The default call per
    # feature is a starting point, not a rule:
    #   - outer-edge fillet/chamfer -> router table (one setup, the
    #     bit is already there, no CNC tool change or 3D toolpath)
    #   - pocket top-edge fillet/chamfer -> handheld router (a table
    #     cannot reach inside a pocket)
    #   - pocket-floor fillet, tapered wall, sculpted surface ->
    #     CNC 3D (a router table cannot reach them at all)
    #   - countersink -> drill press (one bit, after drilling)
    #   - non-Z hole -> drill press from the side (or a 2nd CNC setup)
    # Brandon's call (2026-11-08): use the CNC for non-prismatic
    # features when it makes sense, post-process when it is simpler.
    # config.json "post_method_overrides" maps "kind/location" to a
    # method to change the default call.
    _POST = {
        ("fillet", "outer_top"): ("router_table",
            "Round over the top outer edge on the router table after the CNC cut.",
            "CNC: roundover bit in the spindle, or a ball-nose 3D finish pass."),
        ("chamfer", "outer_top"): ("router_table",
            "Chamfer the top outer edge on the router table after the CNC cut.",
            "CNC: chamfer tool / V-bit."),
        ("fillet", "outer_bottom"): ("router_table",
            "Round over the bottom outer edge on the router table (flip the part over) after the CNC cut.",
            "CNC: roundover bit in the spindle."),
        ("chamfer", "outer_bottom"): ("router_table",
            "Chamfer the bottom outer edge on the router table (flip the part over) after the CNC cut.",
            "CNC: chamfer tool / V-bit."),
        ("fillet", "pocket_top"): ("hand_router",
            "Round over the pocket's top edge with a handheld router (bearing-guided bit) — a router table cannot reach inside a pocket.",
            "CNC: roundover bit."),
        ("chamfer", "pocket_top"): ("hand_router",
            "Chamfer the pocket's top edge with a handheld router (bearing-guided bit).",
            "CNC: chamfer tool."),
        ("fillet", "pocket_floor"): ("cnc_3d",
            "Cut the pocket-floor fillet on the CNC with a ball-nose 3D finish pass — a router table cannot reach a floor fillet. Or leave the corner sharp.",
            None),
        ("chamfer", "pocket_floor"): ("cnc_3d",
            "Cut the pocket-floor chamfer on the CNC (chamfer tool / ball-nose) — a router table cannot reach it.",
            None),
        ("taper", "pocket_top"): ("cnc_3d",
            "Tapered pocket wall: cut with a 3D finishing pass on the CNC (ball-nose), or redesign the pocket as vertical + a post chamfer.",
            None),
        ("taper", "pocket_floor"): ("cnc_3d",
            "Tapered pocket wall: cut with a 3D finishing pass on the CNC (ball-nose), or redesign the pocket as vertical + a post chamfer.",
            None),
        ("taper", "hole"): ("drill_press",
            "Countersink the hole on the drill press after drilling.",
            "CNC: chamfer tool."),
        ("taper", "outer_top"): ("cnc_3d",
            "Tapered outer wall: 3D finishing pass on the CNC (ball-nose), or redesign as vertical + post chamfer.",
            None),
        ("taper", "outer_bottom"): ("cnc_3d",
            "Tapered outer wall: 3D finishing pass on the CNC (ball-nose), or redesign as vertical + post chamfer.",
            None),
        ("fillet", "outer_edge"): ("router_table",
            "Round over the outer edge on the router table after the CNC cut.",
            "CNC: roundover bit in the spindle."),
        ("chamfer", "outer_edge"): ("router_table",
            "Chamfer the outer edge on the router table after the CNC cut.",
            "CNC: chamfer tool / V-bit."),
        ("chamfer", "hole"): ("drill_press",
            "Break / countersink the hole edge on the drill press after drilling.",
            "CNC: chamfer tool."),
        ("freeform", "other"): ("cnc_3d",
            "Sculpted surface: 3D rough + finish from an STL in VCarve, or hand shaping.",
            None),
        ("fillet", "hole"): ("hand",
            "Break the hole edge by hand (deburring tool / sanding) — small edge fillet.",
            None),
    }

    def _locate_feature(cx, cy, cz, z_low=None):
        # (location key, location text) for a non-prismatic face centre.
        # z_low is the face's lowest Z (its bbox min): when a wall face
        # sits flush against two pockets, the pocket whose floor Z
        # matches the face's low edge owns it — the machined test's
        # tapered pocket wall is flush with Pocket A (floor Z 9) but its
        # low edge is at Z 8, its own pocket's floor.
        if profile_poly and dist_to_poly_boundary(cx, cy, profile_poly) < 2.0:
            if cz > zmax - 3.0:
                return "outer_top", "outer top edge"
            if cz < zmin + 3.0:
                return "outer_bottom", "outer bottom edge"
            return "outer_edge", "outer edge"
        best_pocket = None
        best_score = None
        for p in pockets:
            if not p["poly"]:
                continue
            if point_in_polygon(cx, cy, p["poly"]) or dist_to_poly_boundary(cx, cy, p["poly"]) < 2.0:
                score = abs(z_low - p["z"]) if z_low is not None else 0.0
                if best_score is None or score < best_score:
                    best_score = score
                    best_pocket = p
        if best_pocket is not None:
            p = best_pocket
            if abs(cz - p["z"]) < 2.0:
                return "pocket_floor", f"pocket floor (Z {p['z']:.2f})"
            return "pocket_top", f"pocket top edge (floor Z {p['z']:.2f})"
        for h in holes:
            if math.hypot(cx - h["cx"], cy - h["cy"]) < h["dia"] / 2 + 1.0:
                return "hole", f"hole D{h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f})"
        return "other", f"face at ({cx:.1f},{cy:.1f}), Z {cz:.2f}"

    post_process = []
    _seen_pp = {}
    _overrides = cfg.get("post_method_overrides", {}) if isinstance(cfg, dict) else {}
    for info in nonprism_info:
        f = info["face"]
        kind = info["kind"]
        # Location: for a cone, the FACE centre is unreliable — it is
        # the centre of mass of the conical surface, which sits off the
        # axis (the beveled plate's countersink face centred at
        # (14.5,15) instead of on its (20,15) axis). Use the cone's
        # axis location instead. Other faces use their centre.
        if kind == "taper":
            c = (info.get("cx", f.center().X), info.get("cy", f.center().Y),
                 (info.get("z0", 0) + info.get("z1", 0)) / 2)
            loc_key, loc_text = _locate_feature(c[0], c[1], c[2], z_low=info.get("z0"))
            # A chamfer on a CIRCULAR edge is a cone, not a plane: a
            # short cone (Z span <= 3 mm) that is not a countersink is
            # a chamfer, not a tapered wall. (Beveled container test:
            # the pocket-top 2 mm chamfer was misread as a taper.)
            if loc_key != "hole" and (info.get("z1", 0) - info.get("z0", 0)) <= 3.0:
                kind = "chamfer"
                info = dict(info)
                info["angle_deg"] = round(90.0 - info["semi_angle_deg"], 1)
                info["z_span"] = round(info["z1"] - info["z0"], 3)
        else:
            c = f.center()
            loc_key, loc_text = _locate_feature(c.X, c.Y, c.Z,
                                                z_low=f.bounding_box().min.Z)
        if kind == "taper" and loc_key == "hole":
            feature = "countersink"
        elif kind == "taper":
            feature = "tapered wall"
        elif kind == "freeform" and loc_key in ("pocket_top", "pocket_floor"):
            # A non-vertical pocket wall built as a loft/spline (the
            # machined test's 10 deg tapered pocket) — it is a taper,
            # not a sculpted surface.
            feature = "tapered wall"
        elif kind == "freeform":
            feature = "sculpted surface"
        else:
            feature = kind
        if kind == "fillet":
            params = f"R{info['radius']:.2f} mm"
            tool = f"roundover bit R{info['radius']:.2f} mm"
        elif kind == "chamfer":
            params = f"{info['angle_deg']:.0f} deg, {info['z_span']:.2f} mm tall"
            tool = f"chamfer bit {info['angle_deg']:.0f} deg"
        elif kind == "taper" and loc_key == "hole":
            params = f"semi-angle {info['semi_angle_deg']:.1f} deg"
            tool = f"countersink bit {info['semi_angle_deg']:.1f} deg"
        elif kind == "taper":
            params = f"semi-angle {info['semi_angle_deg']:.1f} deg"
            tool = "ball-nose endmill, 3D finish pass"
        elif kind == "freeform":
            params = info.get("surface_type", "freeform")
            tool = "ball-nose endmill, 3D rough + finish from STL"
        else:
            params = ""
            tool = ""
        if feature == "tapered wall" and kind == "freeform":
            params = "non-vertical wall"
            tool = "ball-nose endmill, 3D finish pass"
        if feature == "tapered wall":
            method, step, alt = _POST.get(("taper", loc_key), _POST[("taper", "pocket_top")])
        elif kind == "freeform":
            method, step, alt = _POST[("freeform", "other")]
        else:
            method, step, alt = _POST.get(
                (kind, loc_key),
                _POST.get((kind, "other"),
                          ("decision_needed",
                           "No automatic call — decide CNC vs post-process by hand for this feature.",
                           None)))
        override_key = f"{kind}/{loc_key}"
        if override_key in _overrides:
            method = _overrides[override_key]
            step = step + " (method overridden from config)"
        # Dedup by location TEXT, not just key: two faces can share
        # the key "pocket_top" while belonging to different pockets
        # (different floor Z) — collapsing them would print the wrong
        # floor Z for one of them.
        dedup_key = (feature, loc_text, params)
        if dedup_key in _seen_pp:
            _seen_pp[dedup_key]["count"] = _seen_pp[dedup_key].get("count", 1) + 1
            continue
        entry = {"feature": feature, "location": loc_text, "params": params,
                 "method": method, "tool": tool, "step": step,
                 "cnc_alternative": alt}
        _seen_pp[dedup_key] = entry
        post_process.append(entry)
    for e in post_process:
        cnt = e.get("count", 1)
        suffix = f" (x{cnt} faces)" if cnt > 1 else ""
        flags.append(f"POST-PROCESS [{e['method']}]: {e['feature']} {e['params']} at {e['location']}{suffix} — {e['step']}")

    # ---- build layers / manifest
    layers = []  # dicts for manifest, in cutting order
    dxf_layers = {}  # layer name -> list of segments

    _layer_index = {}

    def add_layer(name, operation, start, cut, segs, extra=None):
        if not segs:
            return
        dxf_layers.setdefault(name, []).extend(segs)
        if name in _layer_index:
            # same layer, more geometry (e.g. 4x D6 holes) — merge, don't
            # create a second toolpath entry
            d = layers[_layer_index[name]]
            d["segment_count"] += len(segs)
            if extra and "centre" in extra:
                d.setdefault("centres", []).append(extra["centre"])
                d.pop("centre", None)
            if extra and "est" in extra:
                # Two pockets/slots sharing one layer (same depth):
                # time estimates add, the fit test takes the narrowest.
                e0 = d.setdefault("est", {})
                for k, v in extra["est"].items():
                    if k in ("perimeter_mm", "area_mm2"):
                        e0[k] = round(e0.get(k, 0.0) + v, 3)
                    elif k == "min_width_mm":
                        e0[k] = round(min(e0.get(k, v), v), 3)
                    elif k == "corner_radius_mm":
                        # tightest corner wins; None = no corners here
                        cur = e0.get(k)
                        if v is None:
                            e0.setdefault(k, None)
                        elif cur is None:
                            e0[k] = v
                        else:
                            e0[k] = round(min(cur, v), 3)
            return
        d = {"layer": name, "operation": operation, "start_depth": round(start, 3),
             "cut_depth": round(cut, 3), "segment_count": len(segs)}
        if extra:
            if "centre" in extra:
                d["centres"] = [extra.pop("centre")]
            d.update(extra)
        _layer_index[name] = len(layers)
        layers.append(d)

    # drills first. A hole that opens on an intermediate face is NOT
    # undrillable: face the stock down to that face first, then drill
    # from there (BRA-14 — Brandon's point, and the real container's
    # Bottom needs exactly this: its 8 blind holes open on the Z 8.00
    # step face, 1.50 mm below the top). The facing pocket is an
    # emitted layer, so the drill DEPENDS on it in cut order.
    _surface_flags = set()
    for h in sorted(holes, key=lambda h: (h["kind"], h["dia"])):
        if h["kind"] == "thru":
            name = f"DRILL_D{fmt(h['dia'])}_THRU"
            add_layer(name, "drill", 0.0, thickness,
                      [('circle', (h["cx"], h["cy"]), h["dia"] / 2)],
                      {"diameter": round(h["dia"], 3), "centre": [round(h["cx"], 3), round(h["cy"], 3)]})
        elif h["kind"] == "blind_top":
            depth = zmax - h["z0"]
            name = f"DRILL_D{fmt(h['dia'])}_D{fmt(depth)}"
            add_layer(name, "drill", 0.0, depth,
                      [('circle', (h["cx"], h["cy"]), h["dia"] / 2)],
                      {"diameter": round(h["dia"], 3), "centre": [round(h["cx"], 3), round(h["cy"], 3)]})
        elif h["kind"] == "internal" and round(h["z1"], 3) in pocket_floor_layer:
            surf = pocket_floor_layer[round(h["z1"], 3)]
            depth = h["z1"] - h["z0"]
            start = zmax - h["z1"]
            name = f"DRILL_D{fmt(h['dia'])}_D{fmt(depth)}_START{fmt(start)}"
            add_layer(name, "drill", start, depth,
                      [('circle', (h["cx"], h["cy"]), h["dia"] / 2)],
                      {"diameter": round(h["dia"], 3), "centre": [round(h["cx"], 3), round(h["cy"], 3)],
                       "depends_on": surf})
            key = (round(h["dia"], 3), round(h["z1"], 3), surf)
            if key not in _surface_flags:
                _surface_flags.add(key)
                flags.append(
                    f"DRILL FROM SURFACE: dia {h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) "
                    f"opens on the Z {h['z1']:.2f} face — {surf} faces it down first "
                    f"(start depth {start:.2f} mm), then drill {depth:.2f} mm from there")
        else:
            flags.append(f"HOLE NOT FROM TOP ({h['kind']}): dia {h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) Z {h['z0']:.2f}..{h['z1']:.2f} — no toolpath emitted")

    # pockets shallow -> deep (suppression was decided in the pre-pass
    # above, so the drill loop already knows which floors exist)
    for p in pockets:
        if p["suppressed"]:
            continue
        name = _pocket_layer_name(p)
        pbb = p["face"].bounding_box()
        extra = {"floor_z": round(p["z"], 3), "depth_total": round(p["depth"], 3),
                 "est": {"area_mm2": round(abs(poly_area(p["poly"])), 3) if p.get("poly") else 0.0,
                         "min_width_mm": round(min(pbb.max.X - pbb.min.X, pbb.max.Y - pbb.min.Y), 3),
                         "depth_mm": round(p["cut"], 3),
                         "perimeter_mm": round(segs_perimeter(p["segs"]), 3),
                         "corner_radius_mm": _pocket_corner_radius(p["segs"])}}
        if p.get("parent") is not None:
            # pocket-in-pocket: the child starts on the parent's floor,
            # so the parent is cut first (BRA-14).
            extra["depends_on"] = _pocket_layer_name(p["parent"])
        add_layer(name, "pocket", p["start"], p["cut"], p["segs"], extra)
        # Inner wires of the pocket floor: a hole opening or a deeper
        # pocket's opening is a void below the floor (already tooled);
        # an ISLAND is material rising above the floor (a rib / boss)
        # and must be preserved — its outline goes into the DXF layer
        # so VCarve pockets around it, and a child pocket nested
        # inside an island gets its outline added too, re-opening the
        # cut region inside the island (even-odd nesting). Without
        # this, the real container's mating rib would be machined away
        # (BRA-8, 2026-11-08).
        island_polys = []
        for inner_segs, inner_poly in zip(p["inner"], p["inner_polys"]):
            if not inner_poly:
                continue
            # centre of the inner wire is interior to the deeper
            # pocket (boundary points fail ray-casting, so don't test them)
            cx = sum(x for x, _ in inner_poly) / len(inner_poly)
            cy = sum(y for _, y in inner_poly) / len(inner_poly)
            explained = None
            # A deeper pocket's opening: the wire IS the pocket's
            # outline (same bbox), not merely centred inside it. Centre
            # containment alone misfires on a stepped face: the real
            # container's Ø36 rib wire is centred on the Ø30 central
            # pocket but is the rib's outer boundary, not the pocket's
            # opening — it must reach the island test below, not be
            # dismissed here. (BRA-8, 2026-11-08.)
            for q in pockets:
                if q is p or not q["poly"]:
                    continue
                if _same_bbox(inner_poly, q["poly"]):
                    explained = "pocket"
                    break
            if explained is None:
                xs = [x for x, _ in inner_poly]
                ys = [y for _, y in inner_poly]
                for h in holes:
                    if (abs(cx - h["cx"]) < 0.1 and abs(cy - h["cy"]) < 0.1
                            and abs((max(xs) - min(xs)) - h["dia"]) < 0.1
                            and abs((max(ys) - min(ys)) - h["dia"]) < 0.1):
                        explained = "hole"
                        break
            if explained is None and _wire_is_island(solids[0], inner_poly, p["z"]):
                explained = "island"
                island_polys.append(inner_poly)
                add_layer(name, "pocket", p["start"], p["cut"], inner_segs)
                flags.append(
                    f"POCKET ISLAND at floor Z {p['z']:.2f} — a rib/boss rises above the floor "
                    f"inside the pocket outline; its outline is in the DXF as an island and the "
                    f"pocket clears around it (verify the island in VCarve)")
            if explained is None:
                flags.append(f"POCKET INNER WIRE at floor Z {p['z']:.2f} (island / hole through floor) — check report, inner wire not auto-tooled")
        # A child pocket nested inside an island needs its outline in
        # the parent's layer, or the slab above the child's start would
        # never be cleared (the island blocks the parent's pocket and
        # the child only cuts from its start depth down).
        for q in pockets:
            if q.get("parent") is not p or not q.get("segs"):
                continue
            qc = q["face"].center()
            if any(point_in_polygon(qc.X, qc.Y, ipoly) for ipoly in island_polys):
                add_layer(name, "pocket", p["start"], p["cut"], q["segs"])

    # through cuts (slots etc.)
    for i, tc in enumerate(through_cuts):
        name = "THROUGH_CUT"
        tbb = segs_bbox(tc["segs"])
        add_layer(name, "profile", 0.0, thickness, tc["segs"],
                  {"est": {"perimeter_mm": round(segs_perimeter(tc["segs"]), 3),
                           "min_width_mm": round(min(tbb[2] - tbb[0], tbb[3] - tbb[1]), 3),
                           "depth_mm": round(thickness, 3)}})
        flags.append("THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening")

    # profile last
    add_layer("PROFILE_THRU", "profile", 0.0, thickness, profile_segs,
              {"est": {"perimeter_mm": round(segs_perimeter(profile_segs), 3),
                       "depth_mm": round(thickness, 3)}})

    # small-feature flags
    if args.min_tool > 0:
        for h in holes:
            if h["dia"] < args.min_tool:
                flags.append(f"HOLE SMALLER THAN MIN TOOL {args.min_tool}mm: dia {h['dia']:.2f}")
        for p in pockets:
            # crude: pocket width from bbox (don't reuse `bb` — that's the stock bbox)
            pbb = p["face"].bounding_box()
            if min(pbb.max.X - pbb.min.X, pbb.max.Y - pbb.min.Y) < args.min_tool:
                flags.append(f"POCKET NARROWER THAN MIN TOOL: floor Z {p['z']:.2f}")

    # ---- flexible modes: --only, --mode check/dxf/manifest
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        layers = [L for L in layers if L["operation"] in wanted]
        dxf_layers = {k: v for k, v in dxf_layers.items()
                      if any(L["layer"] == k for L in layers)}
        print(f"--only {sorted(wanted)}: {len(layers)} layers kept")

    # Time-estimate inputs for tool planning (attached even with
    # --no-toolplan: multi_part.py plans the merged job from these).
    for L in layers:
        if L["operation"] == "drill":
            n = len(L.get("centres", [])) or 1
            L["est"] = {"hole_count": n, "hole_dia_mm": L.get("diameter", 0),
                        "depth_mm": L["cut_depth"]}

    # ---- tool planning (BRA-12): recommend tools from standard
    # sizes, rank plans by estimated time including manual tool
    # changes, order layers to minimise changes. Additive — the
    # classification above is unchanged by this block.
    import toolplan as _tp
    tool_plan = None
    if not args.no_toolplan:
        tool_plan = _tp.plan_tools(layers, cfg)
        if tool_plan["plans"]:
            chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
            tool_plan["chosen"] = chosen["id"]
            # reorder layers into the chosen plan's cut order
            order = {e["layer"]: i for i, e in enumerate(chosen["layers"])}
            layers = sorted(layers, key=lambda L: order.get(L["layer"], 99))
        else:
            flags.append(f"TOOL PLAN: {tool_plan['error']} — no tool recommendations; "
                         "gadget falls back to its TOOLS table")
    else:
        # No plan (multi_part plans the merged job, or --no-toolplan):
        # still order the layers so dependencies are respected and the
        # profile is last — the manifest is cut in list order.
        layers, _dep_warn = _tp.order_entries(
            layers, lambda e: e.get("tool_id") or e["layer"])
        for w in _dep_warn:
            flags.append(f"CUT ORDER: {w}")
    if args.mode == "check":
        print("mode=check: classification only, no DXF / manifest written")
        print(f"layers would be: {len(layers)}, holes: {len(holes)}, pockets: {len(pockets)}, flags: {len(flags)}")
        for f in flags:
            print(" FLAG:", f)
        if tool_plan and tool_plan.get("plans"):
            print("TOOL PLAN:")
            for line in _tp.format_tool_plan_report(tool_plan):
                print("  " + line)
        return

    # ---- write DXF with ezdxf (skipped in mode=manifest)
    dxf_path = None
    if args.mode in ("full", "dxf"):
        import ezdxf
        doc = ezdxf.new("R2010", setup=True)
        doc.units = 4  # mm
        msp = doc.modelspace()
        for name, segs in dxf_layers.items():
            doc.layers.add(name)
            for s in segs:
                if s[0] == 'line':
                    _, (x1, y1), (x2, y2) = s
                    msp.add_line((x1, y1), (x2, y2), dxfattribs={"layer": name})
                elif s[0] == 'circle':
                    _, (cx, cy), r = s
                    msp.add_circle((cx, cy), r, dxfattribs={"layer": name})
                elif s[0] == 'arc':
                    _, (cx, cy), r, a0, a1 = s
                    msp.add_arc((cx, cy), r, a0, a1, dxfattribs={"layer": name})
                elif s[0] == 'poly':
                    pts = s[1]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": name})
                    flags.append(f"SPLINE / NON-ARC EDGE discretised to polyline on layer {name}")
        dxf_path = outdir / f"{stem}.dxf"
        doc.saveas(str(dxf_path))

    manifest = {
        "source_step": str(args.step),
        "units": "mm",
        "stock": {"x_min": round(bb.min.X, 3), "y_min": round(bb.min.Y, 3),
                  "x_max": round(bb.max.X, 3), "y_max": round(bb.max.Y, 3),
                  "z_min": round(zmin, 3), "z_max": round(zmax, 3),
                  "thickness": round(thickness, 3)},
        "z_top": round(zmax, 3),
        "cut_order": ["drill", "pocket", "profile"],
        "layers": layers,
        "holes": holes,
        "pocket_count": len(pockets),
        "post_process": post_process,
        "flags": flags,
    }
    if tool_plan is not None:
        manifest["tool_plan"] = tool_plan
    if args.mode in ("full", "manifest"):
        (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        # manifest.txt — v2 with tool lines when a plan exists, else the
        # old pipe format (gadget falls back to its TOOLS table).
        # layer|operation|start_depth|cut_depth|part|tool_id
        if tool_plan and tool_plan.get("plans"):
            chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
            st = _tp.settings(cfg)
            (outdir / "manifest.txt").write_text(
                _tp.manifest_txt(chosen, layers, f"{stem}.dxf", st))
            for p in tool_plan["plans"]:
                if p["id"] != chosen["id"]:
                    (outdir / f"manifest_plan_{p['id']}.txt").write_text(
                        _tp.manifest_txt(p, layers, f"{stem}.dxf", st))
        else:
            lines = [f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|{L['cut_depth']:.3f}"
                     for L in layers]
            # First line tells the VCarve gadget which DXF belongs to this
            # manifest (same folder). The gadget skips '#' lines.
            (outdir / "manifest.txt").write_text(
                f"# dxf: {stem}.dxf\n" + "\n".join(lines) + "\n")

    report = []
    report.append(f"# {stem} — VCarve report\n")
    report.append(f"Stock: {bb.max.X-bb.min.X:.2f} x {bb.max.Y-bb.min.Y:.2f} x {thickness:.2f} mm, Z {zmin:.2f}..{zmax:.2f}\n")
    report.append(f"Layers ({len(layers)}):\n")
    for L in layers:
        report.append(f"- {L['layer']}: {L['operation']}, start {L['start_depth']:.2f}, cut {L['cut_depth']:.2f}, {L['segment_count']} segments")
    if tool_plan is not None:
        report.append("\nTool plan (recommendations from standard sizes — review against your VCarve library):")
        report.extend(_tp.format_tool_plan_report(tool_plan))
    report.append(f"\nHoles ({len(holes)}):")
    for h in holes:
        report.append(f"- {h['kind']} D{h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) Z {h['z0']:.2f}..{h['z1']:.2f}")
    report.append(f"\nPockets ({len(pockets)}):")
    for p in pockets:
        sup = " — SUPPRESSED, no toolpath (non-vertical walls)" if p.get("suppressed") else ""
        report.append(f"- floor Z {p['z']:.2f}, total depth {p['depth']:.2f}, start {p['start']:.2f}, cut {p['cut']:.2f}{sup}")
    report.append(f"\nPost-processing plan ({len(post_process)} steps — features the prismatic blank does not have):")
    for e in post_process:
        cnt = e.get("count", 1)
        suffix = f" (x{cnt} faces)" if cnt > 1 else ""
        report.append(f"- [{e['method']}] {e['feature']} {e['params']} at {e['location']}{suffix}: {e['step']}"
                      + (f" Alternative: {e['cnc_alternative']}" if e.get("cnc_alternative") else ""))
    if not post_process:
        report.append("- none — part is fully prismatic")
    report.append("\nFlags — read before cutting:")
    report.append("\n".join(f"- {f}" for f in flags) if flags else "- none")
    (outdir / "report.md").write_text("\n".join(report) + "\n")

    if dxf_path:
        print(f"wrote {dxf_path}")
    if args.mode in ("full", "manifest"):
        print(f"wrote {outdir/'manifest.json'}")
    print(f"wrote {outdir/'report.md'}")
    print(f"layers: {len(layers)}, holes: {len(holes)}, pockets: {len(pockets)}, flags: {len(flags)}")
    for f in flags:
        print(" FLAG:", f)

if __name__ == "__main__":
    main()
