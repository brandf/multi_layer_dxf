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

def wire_segments(wire):
    segs = []
    for e in wire.edges():
        segs.extend(edge_segments(e))
    return segs

def wire_sample_points(wire, per_edge=12):
    """Sample points around a wire for containment / area tests."""
    pts = []
    for e in wire.edges():
        try:
            from OCP.BRepAdaptor import BRepAdaptor_Curve
            ad = BRepAdaptor_Curve(e.wrapped)
            p0, p1 = ad.FirstParameter(), ad.LastParameter()
            for i in range(per_edge):
                v = ad.Value(p0 + (p1 - p0) * i / per_edge)
                pts.append((v.X(), v.Y()))
        except Exception:
            for v in (e.start_point(), e.end_point()):
                pts.append((v.X, v.Y))
    return pts

def wire_is_single_circle(wire):
    edges = wire.edges()
    if len(edges) != 1:
        return None
    segs = edge_segments(edges[0])
    if len(segs) == 1 and segs[0][0] == 'circle':
        return segs[0][1], segs[0][2]  # centre, radius
    return None

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
    args = ap.parse_args()

    # Config file overrides CLI defaults (CLI wins if explicitly set is
    # out of scope for v1 — config is for tools / defaults you reuse)
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
    from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder

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
    faces = []
    for s in solids:
        faces.extend(s.faces())

    bb = solid.bounding_box()
    zmin, zmax = bb.min.Z, bb.max.Z
    thickness = zmax - zmin
    print(f"bbox Z {zmin:.3f} .. {zmax:.3f}  thickness {thickness:.3f} mm, {len(faces)} faces")

    flags = []
    planar_z = []   # (z, face)
    cyl_z = []      # dicts
    other_faces = []

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
        else:
            other_faces.append((f, f"surface type {st}, centre Z {f.center().Z:.2f}"))

    for f, why in other_faces:
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
    top_outer_circles = set()
    for z, f in planar_z:
        if abs(z - zmax) < 0.05:
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

    # pocket-in-pocket start depths via containment
    pockets.sort(key=lambda p: p["depth"])
    for p in pockets:
        p["start"] = 0.0
        c = p["face"].center()
        for q in pockets:
            if q is p or q["depth"] >= p["depth"]:
                continue
            if point_in_polygon(c.X, c.Y, q["poly"]):
                if q["depth"] > p["start"]:
                    p["start"] = q["depth"]
        p["cut"] = p["depth"] - p["start"]

    # ---- profile: largest outer wire on top face
    profile_segs = []
    if top_faces:
        best = max(top_faces, key=lambda f: f.area)
        profile_segs = wire_segments(best.outer_wire())
        top_inner = [w for f in top_faces for w in f.inner_wires()]
    else:
        flags.append("NO TOP FACE FOUND — check Z-up / orientation")
        top_inner = []

    # through cuts: top inner wires not explained by a pocket or hole
    through_cuts = []
    for w in top_inner:
        circ = wire_is_single_circle(w)
        if circ:
            (cx, cy), r = circ
            if any(abs(h["cx"] - cx) < 0.05 and abs(h["cy"] - cy) < 0.05 and abs(h["dia"] / 2 - r) < 0.05 for h in holes):
                continue
        poly = wire_sample_points(w)
        # does a pocket floor have (nearly) this outline? A pocket floor's
        # outer wire is the same XY outline as its top opening, even when
        # a hole / pocket-in-pocket changes its area / bbox. So test
        # containment: if most sample points of the top wire lie inside
        # (or on) a pocket floor polygon, it's that pocket's opening.
        explained = False
        far_outside_frac = 0.0
        if poly:
            for p in pockets:
                if not p["poly"]:
                    continue
                inside = sum(1 for (x, y) in poly if point_in_polygon(x, y, p["poly"]))
                # points exactly on the boundary count as inside for
                # ray-casting purposes in most cases; use a 50% threshold
                # to allow for holes notching the outline
                if inside >= len(poly) / 2:
                    explained = True
                    break
                # also: pocket centre inside the top wire?
                c = p["face"].center()
                if point_in_polygon(c.X, c.Y, poly):
                    explained = True
                    break
            if explained:
                # Partially explained = a through feature (e.g. a slot)
                # whose opening merged with a pocket's opening on the top
                # face. Measure it by points FAR outside the pocket floor
                # outline (>2 mm) — boundary-coincident points are
                # unreliable for ray casting, and a tapered pocket's
                # outline is only ~1 mm outside its floor, so the 2 mm
                # margin separates a merged slot from a taper. The merged
                # wire is not emitted as a through cut (that would cut the
                # pocket through) and the slot is not silently dropped
                # either — flag it for a manual through-cut. Found on the
                # machined test (2026-11-08): a through slot overlapping
                # Pocket A vanished.
                # (recompute against the explaining pocket: the loop above
                # broke at the first explaining pocket, so re-find it)
                for p in pockets:
                    if not p["poly"]:
                        continue
                    inside = sum(1 for (x, y) in poly if point_in_polygon(x, y, p["poly"]))
                    if inside >= len(poly) / 2 or point_in_polygon(p["face"].center().X, p["face"].center().Y, poly):
                        # A point far outside the pocket outline is only
                        # evidence of a merged through feature if it is
                        # not on a hole's circle: a hole notching a pocket
                        # corner (test_part Pocket C, D6 at (35,25)) puts
                        # arc points up to its radius outside the outline
                        # and must not trip this flag.
                        def on_hole_circle(x, y):
                            for h in holes:
                                if abs(math.hypot(x - h["cx"], y - h["cy"]) - h["dia"] / 2) < 0.5:
                                    return True
                            return False
                        far = sum(1 for (x, y) in poly
                                  if not point_in_polygon(x, y, p["poly"])
                                  and dist_to_poly_boundary(x, y, p["poly"]) > 2.0
                                  and not on_hole_circle(x, y))
                        far_outside_frac = far / len(poly)
                        break
                if 0.05 < far_outside_frac < 0.95:
                    flags.append(
                        "THROUGH FEATURE MERGED WITH POCKET: top opening is partly a pocket "
                        f"({far_outside_frac:.0%} of its outline is >2 mm outside the pocket) "
                        "and partly a through opening — the through part is NOT in the DXF, "
                        "add it manually in VCarve")
        if not explained:
            through_cuts.append({"segs": wire_segments(w), "poly": poly})

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
            return
        d = {"layer": name, "operation": operation, "start_depth": round(start, 3),
             "cut_depth": round(cut, 3), "segment_count": len(segs)}
        if extra:
            if "centre" in extra:
                d["centres"] = [extra.pop("centre")]
            d.update(extra)
        _layer_index[name] = len(layers)
        layers.append(d)

    # drills first
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
        else:
            flags.append(f"HOLE NOT FROM TOP ({h['kind']}): dia {h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) Z {h['z0']:.2f}..{h['z1']:.2f} — no toolpath emitted")

    # pockets shallow -> deep
    for p in pockets:
        # Non-vertical walls: a pocket whose floor outline is ringed by a
        # non-prismatic face (taper, cone, spline) must not be emitted as
        # a vertical pocket at its floor size — that would cut the wrong
        # shape. Flag it and suppress the layer instead. Found on the
        # machined test (2026-11-08): a 10 deg tapered pocket was emitted
        # as POCKET_D6.00 at its (smaller) floor outline.
        p["suppressed"] = False
        if p["poly"]:
            # A wall face belongs to this pocket if its LOWEST edge lies on
            # the pocket's floor outline — that edge is shared with the
            # floor face. (Face-centre proximity is not enough: on the
            # machined test the tapered pocket sits flush against Pocket A,
            # and its wall's centre is 0.5 mm from Pocket A's outline too,
            # which falsely suppressed Pocket A as well.)
            for f, why in other_faces:
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
                        f"depth {p['depth']:.2f} — {why}")
                    break
        if p["suppressed"]:
            continue
        if abs(p["start"]) < 0.005:
            name = f"POCKET_D{fmt(p['depth'])}"
        else:
            name = f"POCKET_D{fmt(p['depth'])}_START{fmt(p['start'])}"
        add_layer(name, "pocket", p["start"], p["cut"], p["segs"],
                  {"floor_z": round(p["z"], 3), "depth_total": round(p["depth"], 3)})
        for inner_segs, inner_poly in zip(p["inner"], p["inner_polys"]):
            # inner wire is usually the opening of a deeper pocket
            # (pocket-in-pocket) or a hole through the floor — both are
            # already tooled as their own layer. Only flag true islands.
            is_deeper_pocket = False
            if inner_poly:
                # centre of the inner wire is interior to the deeper
                # pocket (boundary points fail ray-casting, so don't test them)
                cx = sum(x for x, _ in inner_poly) / len(inner_poly)
                cy = sum(y for _, y in inner_poly) / len(inner_poly)
                for q in pockets:
                    if q is p or not q["poly"]:
                        continue
                    if point_in_polygon(cx, cy, q["poly"]):
                        is_deeper_pocket = True
                        break
            if not is_deeper_pocket:
                flags.append(f"POCKET INNER WIRE at floor Z {p['z']:.2f} (island / hole through floor) — check report, inner wire not auto-tooled")

    # through cuts (slots etc.)
    for i, tc in enumerate(through_cuts):
        name = "THROUGH_CUT"
        add_layer(name, "profile", 0.0, thickness, tc["segs"])
        flags.append("THROUGH CUT (slot / through opening with no pocket floor) emitted as THROUGH_CUT — verify it is not a pocket opening")

    # profile last
    add_layer("PROFILE_THRU", "profile", 0.0, thickness, profile_segs)

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
    if args.mode == "check":
        print("mode=check: classification only, no DXF / manifest written")
        print(f"layers would be: {len(layers)}, holes: {len(holes)}, pockets: {len(pockets)}, flags: {len(flags)}")
        for f in flags:
            print(" FLAG:", f)
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
        "flags": flags,
    }
    if args.mode in ("full", "manifest"):
        (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        # manifest.txt — simple pipe format for the VCarve Lua gadget,
        # which has no JSON parser. One line per layer, in cut order.
        # layer|operation|start_depth|cut_depth
        lines = [f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|{L['cut_depth']:.3f}"
                 for L in layers]
        (outdir / "manifest.txt").write_text("\n".join(lines) + "\n")

    report = []
    report.append(f"# {stem} — VCarve report\n")
    report.append(f"Stock: {bb.max.X-bb.min.X:.2f} x {bb.max.Y-bb.min.Y:.2f} x {thickness:.2f} mm, Z {zmin:.2f}..{zmax:.2f}\n")
    report.append(f"Layers ({len(layers)}):\n")
    for L in layers:
        report.append(f"- {L['layer']}: {L['operation']}, start {L['start_depth']:.2f}, cut {L['cut_depth']:.2f}, {L['segment_count']} segments")
    report.append(f"\nHoles ({len(holes)}):")
    for h in holes:
        report.append(f"- {h['kind']} D{h['dia']:.2f} at ({h['cx']:.2f},{h['cy']:.2f}) Z {h['z0']:.2f}..{h['z1']:.2f}")
    report.append(f"\nPockets ({len(pockets)}):")
    for p in pockets:
        sup = " — SUPPRESSED, no toolpath (non-vertical walls)" if p.get("suppressed") else ""
        report.append(f"- floor Z {p['z']:.2f}, total depth {p['depth']:.2f}, start {p['start']:.2f}, cut {p['cut']:.2f}{sup}")
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
