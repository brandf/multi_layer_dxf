#!/usr/bin/env python3
"""Workholding guides — slot-based clamp placement (V2.9).

For a finished job (layout + tool plan already computed), recommend
clamp positions (V2_SCOPE.md §6.2):

1. **Keep-out first.** A clamp footprint plus ``keep_out_mm`` must
   clear every profile and pocket outline and every drill point,
   with the V1 part-to-clamp spacing rule applied to the footprint:
   a profile cut eats one profile-tool diameter beyond the outline,
   so the footprint must stay ``D_profile + keep_out_mm`` from any
   profile outline; a pocket cutter stays inside its outline, so
   the footprint must stay ``keep_out_mm`` from a pocket outline;
   a drill's edge reaches half its diameter past its centre, so the
   footprint must stay ``keep_out_mm + drill_dia / 2`` from a drill
   centre. The checks reuse the geometry the job's own DXF carries
   (the cut truth) and the spacing idea of ``layout.py`` (kerf +
   clearance), extended from parts to clamp footprints.
2. **Support near the cuts.** Candidate positions are ranked by
   proximity to the longest/most-loaded cuts, profiles first, so
   clamps sit near the work, not at the far corners. A clamp counts
   as supporting a part when its centre is within
   ``SUPPORT_RADIUS_MM`` of that part's profile outline.
3. **Loading forces, first order only.** The cutting force is
   estimated from the plan's own numbers — material removal rate
   per operation and a specific cutting energy for wood — giving a
   tangential force per cut. Each recommended clamp must resist the
   worst-case force, using the clamp's ``hold_force_n`` when the
   inventory carries one; when it does not, the guide says so
   ("holding force unknown — verify by hand") rather than
   inventing a number. **This is a first-order estimate, not a
   validated physics model** — the constant, the formula and its
   limits are documented wherever the number appears (here, in the
   report, and in the UI text the CLI returns), and the number must
   never be presented as validated.
4. **T-track only.** The clamp centre goes on a slot, at the slot
   coordinate nearest the ideal position. ``assert_real_t_track``
   is called first, so placeholder slots refuse with a named
   error, never a guess. Non-T-track methods in the inventory
   (tape, glue, screws) are listed as alternatives for areas the
   slots cannot reach, with the same keep-out rules — positions
   are not computed for them.
5. **Operator convenience as the tie-break.** Among near-equal
   positions, prefer sheet edges over between-parts positions and
   reuse the same clamp type across the job; a sheet wider than
   ``MIN_CLAMPS_WIDE_SHEET_MM`` gets at least two clamps when
   positions exist, so it is never held at a single point.

Sheet placement assumption (recorded in the output, not hidden):
the sheet's lower-left corner sits at the bed origin (0, 0), so
slot coordinates and sheet coordinates share an origin. If the
operator places the sheet elsewhere on the bed, the slot
coordinates in the recommendation shift by the same offset.

Output (V2_SCOPE.md §6.3): a ``GUIDE_CLAMP`` layer in the job's
DXF (clamp footprints as rectangles at their sheet positions), a
``workholding`` section in ``job.json`` (one entry per recommended
clamp: ``clamp_id``, ``method``, ``slot``, ``x_mm``, ``y_mm``,
``reason``), and a recommendation section in ``report.md``.

This module runs under the repo venv python (it needs ezdxf) as a
subprocess of ``mldxf guides`` / ``mldxf rerun`` — see
``mldxf.py`` ``cmd_guides``. It never touches the library home
itself: the caller hands it the machine profile and clamp
inventory it already loaded (live home for ``guides``, the
recorded provenance for a rerun replay), as an inputs JSON file::

    {"machine": {...}, "clamps": {"version": n, "clamps": [...]},
     "cli_version": "2.0.0"}

Usage: ``mldxf_guides.py <job-dir> --inputs <inputs.json>``.
Stdout is exactly one JSON object: ``{"ok": true, "workholding":
{...}}`` on success, ``{"ok": false, "error": "<named error>",
"message": "..."}`` on a user error. Human-readable progress goes
to stderr. Exit codes follow the CLI contract: 0 success, 1 user
error, 2 internal error (traceback — a bug).

Idempotent: re-running on a job that already has guides removes
the old ``GUIDE_CLAMP`` layer and the old report section first,
then recomputes from the current inputs.

No fabricated content: no invented T-track measurements, tool
inventory, or clamp inventory — every number comes from the job
or the inputs file. A job with no material size recorded (neither
``material`` nor ``suggested_material``) fails with a named
error: guides need a sheet to place clamps on.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GUIDE_LAYER = "GUIDE_CLAMP"
GUIDE_LAYER_COLOR = 3  # green in the usual AutoCAD palette

# --- documented constants (see the module docstring) -------------------
# Specific cutting energy for wood, N/mm^2 (= J/mm^3). Published
# values for wood are typically of order 10-30 N/mm^2 depending on
# species, grain direction, moisture and tool sharpness; 30 is taken
# at the top of that range so the first-order estimate errs toward
# OVERestimating the force. It is a conservative planning value, not
# a measurement of this machine, this wood, or these tools, and the
# force it produces must never be presented as validated.
SPECIFIC_CUTTING_ENERGY_N_PER_MM2 = 30.0
# A clamp counts as supporting a part when its centre is within this
# distance of that part's profile outline. A heuristic, not physics:
# it only decides which clamp is recorded as supporting which cut.
SUPPORT_RADIUS_MM = 45.0
# A sheet wider than this gets at least two clamps when positions
# exist, so a wide sheet is never held at a single point (it could
# pivot). A heuristic, not physics.
MIN_CLAMPS_WIDE_SHEET_MM = 100.0
# Two placed clamps must be at least this far apart (centre to
# centre) — clamps stacked on the same spot do not add support.
MIN_CLAMP_SEPARATION_MM = 30.0
# Candidate positions are sampled along each slot at this step, plus
# the exact projections of each part centroid onto each slot.
CANDIDATE_STEP_MM = 5.0
# Arcs are discretised to this many chord segments per full circle
# for the keep-out checks (a circle becomes a 32-gon; the chord
# error at the container's 23 mm radius is ~0.03 mm, far below the
# keep-out tolerances).
ARC_SEGMENTS_PER_CIRCLE = 32

FORCE_MODEL_NOTE = (
    "First-order estimate only — not a validated physics model. "
    "Cutting force is estimated as F = Kc x MRR / v_c with "
    "Kc = 30 N/mm^2 (specific cutting energy for wood, taken at "
    "the top of the typically published 10-30 N/mm^2 range so the "
    "estimate errs toward overestimating), MRR from the plan's own "
    "feed / stepdown / stepover per operation, and v_c = pi x tool "
    "diameter x spindle rpm / 60. Drill thrust is axial (into the "
    "bed) and is not part of this lateral-force estimate. The "
    "estimate ignores grain direction, moisture, tool wear, "
    "deflection and vibration; treat it as an order-of-magnitude "
    "check, and verify holding force by hand before cutting."
)

# Sheet placement assumption (see the module docstring).
SHEET_ORIGIN_ON_BED_MM = [0.0, 0.0]


class GuidesError(Exception):
    """A named, user-facing failure (exit 1)."""

    def __init__(self, name, message):
        super().__init__(message)
        self.name = name
        self.message = message


def progress(message):
    print(message, file=sys.stderr)


def emit(obj):
    print(json.dumps(obj))
    sys.stdout.flush()


# ---------------------------------------------------------------- geometry

def _point_seg_dist(px, py, x1, y1, x2, y2):
    """Distance from a point to a line segment."""
    dx, dy = x2 - x1, y2 - y1
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / length2
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _point_in_rect(px, py, rect):
    x0, y0, x1, y1 = rect
    return x0 <= px <= x1 and y0 <= py <= y1


def _seg_seg_dist(p1, p2, p3, p4):
    """Distance between two segments (0 when they touch/cross)."""
    def _orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def _on_seg(a, b, c):
        return (min(a[0], c[0]) - 1e-9 <= b[0] <= max(a[0], c[0]) + 1e-9
                and min(a[1], c[1]) - 1e-9 <= b[1] <= max(a[1], c[1]) + 1e-9)

    d1, d2 = _orient(p3, p4, p1), _orient(p3, p4, p2)
    d3, d4 = _orient(p1, p2, p3), _orient(p1, p2, p4)
    if (((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))
            and d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0):
        return 0.0
    if d1 == 0 and _on_seg(p3, p1, p4):
        return 0.0
    if d2 == 0 and _on_seg(p3, p2, p4):
        return 0.0
    if d3 == 0 and _on_seg(p1, p3, p2):
        return 0.0
    if d4 == 0 and _on_seg(p1, p4, p2):
        return 0.0
    return min(
        _point_seg_dist(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1]),
        _point_seg_dist(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1]),
        _point_seg_dist(p3[0], p3[1], p1[0], p1[1], p2[0], p2[1]),
        _point_seg_dist(p4[0], p4[1], p1[0], p1[1], p2[0], p2[1]))


def _seg_rect_dist(seg, rect):
    """Distance from a segment to an axis-aligned rectangle
    (x0, y0, x1, y1); 0 when they touch or overlap."""
    (x1, y1), (x2, y2) = seg
    if _point_in_rect(x1, y1, rect) or _point_in_rect(x2, y2, rect):
        return 0.0
    corners = [(rect[0], rect[1]), (rect[2], rect[1]),
               (rect[2], rect[3]), (rect[0], rect[3])]
    edges = [(corners[i], corners[(i + 1) % 4]) for i in range(4)]
    return min(_seg_seg_dist((x1, y1), (x2, y2), a, b) for a, b in edges)


def _point_rect_dist(px, py, rect):
    """Distance from a point to an axis-aligned rectangle."""
    if _point_in_rect(px, py, rect):
        return 0.0
    dx = max(rect[0] - px, 0.0, px - rect[2])
    dy = max(rect[1] - py, 0.0, py - rect[3])
    return math.hypot(dx, dy)


def _circle_points(cx, cy, r, a0_deg, a1_deg, segments):
    """Points along an arc (degrees, CCW) — a full circle when the
    sweep is 360 deg. The chord error is far below keep-out
    tolerances at ARC_SEGMENTS_PER_CIRCLE."""
    sweep = (a1_deg - a0_deg) % 360.0
    if sweep == 0.0:
        sweep = 360.0
    n = max(2, int(math.ceil(segments * sweep / 360.0)))
    return [(cx + r * math.cos(math.radians(a0_deg + sweep * i / n)),
             cy + r * math.sin(math.radians(a0_deg + sweep * i / n)))
            for i in range(n + 1)]


# ---------------------------------------------------------------- DXF input

def _read_cut_geometry(dxf_path, layer_operation):
    """Cut geometry from the job DXF, per layer: ({operation: {layer:
    [segments]}}, drill points [(x, y, dia)], ignored count).
    Only layers listed in the job's ``layers`` are cut geometry;
    '0' / 'Defpoints' and anything else are not cuts. Entities the
    reader does not know (the V1 writer only emits LINE, CIRCLE,
    ARC, LWPOLYLINE) are counted, never silently ignored — the
    caller reports the count. A drill drawn as anything but a
    circle has no centre to measure from; its outline still counts
    as a pocket outline for keep-out (conservative: it is a hole)."""
    import ezdxf
    doc = ezdxf.readfile(str(dxf_path))
    per_layer = {"profile": {}, "pocket": {}}
    drills = []
    ignored = 0
    for ent in doc.modelspace():
        layer = ent.dxf.layer
        op = layer_operation.get(layer)
        if op is None:
            continue
        t = ent.dxftype()
        if t == "LINE":
            s, e = ent.dxf.start, ent.dxf.end
            pts = [(s.x, s.y), (e.x, e.y)]
        elif t == "LWPOLYLINE":
            pts = [(x, y) for x, y in ent.get_points("xy")]
            if ent.closed and len(pts) > 1:
                pts = pts + [pts[0]]
        elif t == "ARC":
            c = ent.dxf.center
            pts = _circle_points(c.x, c.y, ent.dxf.radius,
                                 ent.dxf.start_angle, ent.dxf.end_angle,
                                 ARC_SEGMENTS_PER_CIRCLE)
        elif t == "CIRCLE":
            c = ent.dxf.center
            if op == "drill":
                drills.append((c.x, c.y, 2.0 * ent.dxf.radius))
                continue
            pts = _circle_points(c.x, c.y, ent.dxf.radius, 0.0, 360.0,
                                 ARC_SEGMENTS_PER_CIRCLE)
        else:
            ignored += 1
            continue
        target_op = op if op in ("profile", "pocket") else "pocket"
        per_layer[target_op].setdefault(layer, []).extend(
            zip(pts, pts[1:]))
    return per_layer, drills, ignored


# ---------------------------------------------------------------- force model

def _estimate_forces(job):
    """First-order tangential cutting force per endmill layer of
    Plan A (plans[0]), from the plan's own numbers (see the module
    docstring and FORCE_MODEL_NOTE). Returns
    (worst_force_n, worst_layer_name, per-layer list, skipped list).
    Drills are skipped (axial thrust, not lateral force). A job
    with no tool plan yields (None, None, [], [...]) — the guides
    still run; the force is reported as not estimated."""
    tool_plan = job.get("tool_plan") or {}
    plans = tool_plan.get("plans") or []
    if not plans:
        return None, None, [], ["no tool plan in job.json"]
    plan = plans[0]
    tools = {t.get("id"): t for t in plan.get("tools") or []
             if isinstance(t, dict)}
    per_layer = []
    skipped = []
    for layer in plan.get("layers") or []:
        tool = tools.get(layer.get("tool_id"))
        if layer.get("operation") == "drill" or tool is None:
            if layer.get("operation") == "drill":
                skipped.append(f"{layer.get('layer')}: drill — axial "
                               "thrust, not a lateral cutting force")
            continue
        if tool.get("kind") != "endmill":
            continue
        feed = tool.get("feed_mm_s")
        stepdown = tool.get("stepdown_mm")
        stepover = tool.get("stepover_mm")
        rpm = tool.get("spindle_rpm")
        dia = tool.get("dia_mm")
        if None in (feed, stepdown, rpm, dia) or not dia or not rpm:
            skipped.append(f"{layer.get('layer')}: tool "
                           f"{tool.get('id')} is missing feed / "
                           "stepdown / rpm / diameter — force not "
                           "estimated for this layer")
            continue
        # MRR: a profile cut slots at full tool width; a pocket
        # cut steps over by stepover_mm per pass. A pocket with no
        # stepover recorded falls back to half the tool diameter
        # (conservative for a pocket, and noted in the skipped list
        # only when the value was actually missing).
        if layer.get("operation") == "profile":
            radial = dia
        else:
            radial = stepover if stepover else dia / 2.0
        mrr = feed * stepdown * radial  # mm^3/s
        vc = math.pi * dia * rpm / 60.0  # mm/s
        force = SPECIFIC_CUTTING_ENERGY_N_PER_MM2 * mrr / vc  # N
        per_layer.append({"layer": layer.get("layer"),
                          "operation": layer.get("operation"),
                          "tool_id": tool.get("id"),
                          "force_n": round(force, 2)})
    if not per_layer:
        return None, None, [], skipped or [
            "no endmill layers in Plan A — force not estimated"]
    worst = max(per_layer, key=lambda e: e["force_n"])
    return worst["force_n"], worst["layer"], per_layer, skipped


# ---------------------------------------------------------------- candidates

def _slot_candidates(slots, sheet_w, sheet_d, footprint, centroids):
    """Candidate clamp centres: for each real slot, the exact
    projections of each part centroid onto the slot, plus a grid
    along the slot at CANDIDATE_STEP_MM. Returns a list of
    (x, y, slot) with the centre on the slot and the oriented
    footprint fully inside the sheet. ``footprint`` is the
    unoriented [w, d] from the inventory; a y-axis slot swaps it
    (the clamp's long side runs along the slot)."""
    fw, fd = float(footprint[0]), float(footprint[1])
    seen = set()
    out = []
    for slot in slots:
        axis = slot["axis"]
        if axis == "x":
            fixed = float(slot["at_y_mm"])
            lo, hi = float(slot["from_x_mm"]), float(slot["to_x_mm"])
            w, d = fw, fd
            span = (lo, hi)
        else:
            fixed = float(slot["at_x_mm"])
            lo, hi = float(slot["from_y_mm"]), float(slot["to_y_mm"])
            w, d = fd, fw
            span = (lo, hi)
        along = set()
        for cx, cy in centroids:
            proj = cx if axis == "x" else cy
            along.add(round(max(span[0], min(span[1], proj)), 3))
        steps = int(math.floor((span[1] - span[0]) / CANDIDATE_STEP_MM))
        for i in range(steps + 1):
            along.add(round(span[0] + i * CANDIDATE_STEP_MM, 3))
        for a in sorted(along):
            x, y = (a, fixed) if axis == "x" else (fixed, a)
            if x - w / 2 < -1e-9 or x + w / 2 > sheet_w + 1e-9:
                continue
            if y - d / 2 < -1e-9 or y + d / 2 > sheet_d + 1e-9:
                continue
            key = (round(x, 3), round(y, 3))
            if key in seen:
                continue
            seen.add(key)
            out.append((x, y, slot, (w, d)))
    return out


def _nearest_profile(candidate, profile_segments):
    """(distance, layer_index) from a candidate centre to the
    nearest profile segment. ``profile_segments`` is a list of
    (segment, layer_name)."""
    cx, cy = candidate[0], candidate[1]
    best, best_layer = None, None
    for seg, layer in profile_segments:
        d = _point_seg_dist(cx, cy, seg[0][0], seg[0][1],
                            seg[1][0], seg[1][1])
        if best is None or d < best:
            best, best_layer = d, layer
    return best, best_layer


# ---------------------------------------------------------------- main compute

def compute_guides(job, dxf_path, machine, clamps):
    """Compute the workholding recommendation for a finished job.
    ``machine`` / ``clamps`` are the loaded dicts (live home, or
    the recorded provenance on a rerun replay). Returns the
    ``workholding`` dict for job.json. Raises GuidesError on a
    named failure (placeholder slots, no clamps, no material)."""
    import mldxf_config as cfg

    cfg.assert_real_t_track(machine)
    cfg.check_clamp_mountable({"clamps": clamps["clamps"]}, machine)

    material = job.get("material") or job.get("suggested_material")
    if not isinstance(material, dict) or "x" not in material \
            or "y" not in material:
        raise GuidesError(
            "guides_no_material",
            "no material size is recorded in job.json (neither "
            "'material' nor 'suggested_material') — guides need a "
            "sheet to place clamps on; re-plan with --material")
    sheet_w, sheet_d = float(material["x"]), float(material["y"])

    layers = job.get("layers") or []
    layer_operation = {}
    layer_part = {}
    for entry in layers:
        name = entry.get("layer")
        op = (entry.get("operation") or "").lower()
        if name and op in ("profile", "pocket", "drill"):
            layer_operation[name] = op
            layer_part[name] = entry.get("part")
    if not layer_operation:
        # Fall back to the layer name itself (single-part jobs name
        # layers PROFILE_THRU / POCKET_... / DRILL_...).
        for entry in layers:
            name = entry.get("layer") or ""
            for op, key in (("profile", "PROFILE"), ("pocket", "POCKET"),
                            ("drill", "DRILL")):
                if key in name.upper():
                    layer_operation[name] = op
                    layer_part[name] = entry.get("part")
    per_layer, drills, ignored = _read_cut_geometry(dxf_path,
                                                    layer_operation)
    profile_segs = [(seg, layer) for layer, segs in
                    per_layer["profile"].items() for seg in segs]
    pocket_segs = [(seg, layer) for layer, segs in
                   per_layer["pocket"].items() for seg in segs]

    # Profile tool diameter: the largest endmill cutting a profile
    # layer in Plan A (0 when there is no plan / no profile layer).
    tool_plan = job.get("tool_plan") or {}
    plans = tool_plan.get("plans") or []
    plan_tools = {}
    d_profile = 0.0
    if plans:
        plan_tools = {t.get("id"): t for t in plans[0].get("tools") or []
                      if isinstance(t, dict)}
        for layer in plans[0].get("layers") or []:
            if layer.get("operation") == "profile":
                tool = plan_tools.get(layer.get("tool_id")) or {}
                if tool.get("dia_mm"):
                    d_profile = max(d_profile, float(tool["dia_mm"]))
    worst_force, worst_layer, per_layer, force_skipped = \
        _estimate_forces(job)

    # Ranking is by distance to the nearest profile cut; a job
    # with no profile cut at all (e.g. --only pocket) ranks by
    # the nearest pocket cut instead.

    # The clamp type: the first T-track method in inventory order
    # with count > 0. One type across the job (operator
    # convenience); a second type is never mixed in.
    t_clamps = [c for c in clamps["clamps"]
                if c.get("t_track") and c.get("count", 0) > 0]
    if not t_clamps:
        raise GuidesError(
            "guides_no_clamps",
            "no T-track clamp with count > 0 is in the clamp "
            "inventory (clamps.json) — guides have nothing to place. "
            "Record the T-track clamps you own (or run 'mldxf "
            "clamps list' to see what is recorded)")
    clamp = t_clamps[0]
    keep_out = float(clamp.get("keep_out_mm", 0.0))
    footprint = clamp.get("footprint_mm")
    c_profile = keep_out + d_profile
    c_pocket = keep_out
    rank_segs = profile_segs if profile_segs else pocket_segs
    rank_kind = "profile" if profile_segs else "pocket"

    parts = job.get("parts") or []
    layout = job.get("layout") or []
    centroids = []
    part_names = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        fp = part.get("footprint_mm")
        if part.get("x_mm") is not None and fp:
            centroids.append((float(part["x_mm"]) + float(fp[0]) / 2.0,
                              float(part["y_mm"]) + float(fp[1]) / 2.0))
            part_names.append(part.get("name"))
    if not centroids and layout:
        for entry in layout:
            centroids.append((float(entry["x_mm"]) + float(entry["w_mm"]) / 2.0,
                              float(entry["y_mm"]) + float(entry["d_mm"]) / 2.0))
            part_names.append(entry.get("name"))
    if not centroids:
        # A job with no per-part positions (single-part, no layout):
        # centre the sheet — candidates still rank by distance to
        # the cuts, which is what matters.
        centroids = [(sheet_w / 2.0, sheet_d / 2.0)]
        part_names = [None]

    slots = [s for s in machine["t_track"]["slots"]
             if isinstance(s, dict) and s.get("placeholder") is not True]
    candidates = _slot_candidates(slots, sheet_w, sheet_d, footprint,
                                  centroids)

    def clears(rect):
        """Keep-out check for one footprint rect (x0, y0, x1, y1)."""
        for seg, _layer in profile_segs:
            if _seg_rect_dist(seg, rect) + 1e-9 < c_profile:
                return False
        for seg, _layer in pocket_segs:
            if _seg_rect_dist(seg, rect) + 1e-9 < c_pocket:
                return False
        for dx, dy, dia in drills:
            if _point_rect_dist(dx, dy, rect) + 1e-9 < \
                    keep_out + dia / 2.0:
                return False
        return True

    def part_covered(part_name, placed):
        """True when a placed clamp is within SUPPORT_RADIUS_MM of
        the part's ranking cut outline (profile, else pocket)."""
        for (cx, cy, _slot, _fp) in placed:
            for seg, layer in rank_segs:
                if layer_part.get(layer) != part_name:
                    continue
                if _point_seg_dist(cx, cy, seg[0][0], seg[0][1],
                                   seg[1][0], seg[1][1]) \
                        <= SUPPORT_RADIUS_MM:
                    return True
        return False

    def edge_dist(cx, cy):
        return min(cx, sheet_w - cx, cy, sheet_d - cy)

    available = int(clamp.get("count", 0))
    min_clamps = 2 if max(sheet_w, sheet_d) > MIN_CLAMPS_WIDE_SHEET_MM \
        else 1
    min_clamps = min(min_clamps, available)
    placed = []
    uncovered = {name for name in part_names if name is not None}
    # Greedy: each round, rank the surviving candidates — ones
    # whose nearest profile belongs to an uncovered part first,
    # then by distance to the nearest profile cut, then by sheet
    # edge (edges over between-parts), then by position (so the
    # result is deterministic).
    remaining = list(candidates)
    while remaining and len(placed) < available:
        scored = []
        for cand in remaining:
            x, y, slot, (w, d) = cand
            rect = (x - w / 2, y - d / 2, x + w / 2, y + d / 2)
            if not clears(rect):
                continue
            if any(math.hypot(x - px, y - py) < MIN_CLAMP_SEPARATION_MM
                   for (px, py, _s, _f) in placed):
                continue
            dist, layer = _nearest_profile(cand, rank_segs)
            if dist is None:
                dist = float("inf")
            nearest_part = layer_part.get(layer) if layer else None
            covers_new = 1 if nearest_part in uncovered else 0
            scored.append(((0 if covers_new else 1), dist,
                           edge_dist(x, y), round(x, 3), round(y, 3),
                           cand, layer, dist))
        if not scored:
            break
        scored.sort(key=lambda s: s[:5])
        _rank, _dist, _edge, _x, _y, cand, layer, dist = scored[0]
        placed.append(cand)
        remaining.remove(cand)
        nearest_part = layer_part.get(layer) if layer else None
        if nearest_part in uncovered:
            uncovered.discard(nearest_part)
        if not uncovered and len(placed) >= min_clamps:
            break

    hold_force = clamp.get("hold_force_n")
    if worst_force is None:
        force_status = "unknown"
        force_note = ("cutting force not estimated — "
                      + "; ".join(force_skipped)
                      + " — verify holding force by hand")
    elif hold_force is None:
        force_status = "unknown"
        force_note = "holding force unknown — verify by hand"
    elif hold_force >= worst_force:
        force_status = "holds"
        force_note = (f"hold force {hold_force:g} N covers the "
                      f"estimated worst cut force {worst_force:.2f} N")
    else:
        force_status = "insufficient"
        force_note = (f"hold force {hold_force:g} N is below the "
                      f"estimated worst cut force {worst_force:.2f} N "
                      "— add another clamp near the same cut, or "
                      "verify by hand")

    clamp_entries = []
    for (x, y, slot, (w, d)) in placed:
        _d, layer = _nearest_profile((x, y, slot, (w, d)), rank_segs)
        part = layer_part.get(layer) if layer else None
        if slot["axis"] == "x":
            slot_str = (f"x-axis slot at y={slot['at_y_mm']:g} mm")
            slot_axis, slot_at = "x", float(slot["at_y_mm"])
            s_from, s_to = float(slot["from_x_mm"]), float(slot["to_x_mm"])
        else:
            slot_str = (f"y-axis slot at x={slot['at_x_mm']:g} mm")
            slot_axis, slot_at = "y", float(slot["at_x_mm"])
            s_from, s_to = float(slot["from_y_mm"]), float(slot["to_y_mm"])
        supported = (f"{part} {rank_kind} cut" if part
                     else f"the {rank_kind} cut")
        if _d is None or math.isinf(_d):
            reason = ("No profile/pocket outline in this job — "
                      "placed clear of every drill point, on the "
                      f"{slot_str}.")
        else:
            reason = (f"Supports the {supported} "
                      f"(nearest cut {_d:.1f} mm away) — clamp centre "
                      f"on the {slot_str}.")
        clamp_entries.append({
            "clamp_id": clamp["id"],
            "method": clamp["method"],
            "slot": slot_str,
            "slot_axis": slot_axis,
            "slot_at_mm": round(slot_at, 3),
            "slot_from_mm": round(s_from, 3),
            "slot_to_mm": round(s_to, 3),
            "x_mm": round(x, 3),
            "y_mm": round(y, 3),
            "footprint_mm": [round(w, 3), round(d, 3)],
            "reason": reason,
            "force_check": {
                "worst_force_n": worst_force,
                "hold_force_n": hold_force,
                "status": force_status,
                "note": force_note,
            },
        })

    alternatives = []
    for other in clamps["clamps"]:
        if other.get("t_track") or other.get("count", 0) <= 0:
            continue
        alternatives.append({
            "clamp_id": other["id"],
            "method": other["method"],
            "note": ("Alternative for areas the slots cannot reach — "
                     "the same keep-out rules apply (footprint + "
                     f"{other.get('keep_out_mm', 0):g} mm keep-out "
                     "clears every cut); positions are not computed "
                     "for off-slot methods, place by hand."),
        })

    # Recommendation sentence (also the report / UI text).
    if clamp_entries:
        positions = "; ".join(
            f"({c['x_mm']:g}, {c['y_mm']:g})" for c in clamp_entries)
        slots_used = "; ".join(sorted({c["slot"] for c in clamp_entries}))
        recommendation = (
            f"{len(clamp_entries)} clamp"
            f"{'s' if len(clamp_entries) != 1 else ''}: "
            f"{len(clamp_entries)}x {clamp['id']} at {positions} — "
            f"on the {slots_used}. Each sits within "
            f"{SUPPORT_RADIUS_MM:g} mm of the {rank_kind} cut it "
            f"supports.")
        if worst_force is not None:
            recommendation += (f" Worst estimated cut force "
                               f"{worst_force:.2f} N.")
        recommendation += f" ({force_note})."
        if force_status == "insufficient":
            recommendation += (" WARNING: the clamp's hold force is "
                               "below the estimated worst cut force.")
        if uncovered:
            recommendation += (
                " Note: no clamp within "
                f"{SUPPORT_RADIUS_MM:g} mm of the profile of "
                + ", ".join(sorted(uncovered))
                + " — the slots cannot reach it under the keep-out "
                "rules; hold that area by hand (see alternatives).")
        if len(placed) < min_clamps:
            recommendation += (
                f" Note: only {len(placed)} clamp(s) could be placed "
                f"although the sheet calls for at least {min_clamps} "
                "— the inventory or the slots do not allow more.")
    else:
        recommendation = (
            "No clamp position could be placed on any real T-track "
            "slot without breaking the keep-out rules (footprint + "
            f"keep-out clears every cut) — every candidate on the "
            "slots is too close to a cut. Place clamps by hand, "
            "keeping them clear of every cut by at least "
            f"{c_profile:.2f} mm from a profile outline "
            f"({d_profile:g} mm profile tool + {keep_out:g} mm "
            "keep-out).")
    if alternatives:
        recommendation += (" Alternatives for areas the slots cannot "
                           "reach: " + ", ".join(
                               a["method"] for a in alternatives) + ".")
    elif not clamp_entries:
        recommendation += (" No alternative workholding is recorded "
                           "in the inventory either.")

    notes = []
    if ignored:
        notes.append(f"{ignored} entit(ies) on cut layers had a DXF "
                     "type this reader does not model and were not "
                     "used in the keep-out checks — verify the "
                     "recommendation by hand.")
    if force_skipped:
        notes.append("Force model skipped: " + "; ".join(force_skipped))

    workholding = {
        "clamps": clamp_entries,
        "alternatives": alternatives,
        "recommendation": recommendation,
        "force_model": {
            "specific_cutting_energy_n_per_mm2":
                SPECIFIC_CUTTING_ENERGY_N_PER_MM2,
            "worst_force_n": worst_force,
            "worst_layer": worst_layer,
            "formula": "F = Kc x MRR / v_c; MRR = feed x stepdown x "
                       "radial engagement (tool diameter for a "
                       "profile slot, stepover for a pocket); "
                       "v_c = pi x tool diameter x spindle rpm / 60",
            "per_layer": per_layer,
            "note": FORCE_MODEL_NOTE,
        },
        "sheet_mm": [round(sheet_w, 3), round(sheet_d, 3)],
        "sheet_origin_on_bed_mm": list(SHEET_ORIGIN_ON_BED_MM),
        "notes": notes,
        "provenance": {
            "machine": machine,
            "clamps": clamps["clamps"],
            "machine_id": machine.get("id"),
            "machine_version": machine.get("version"),
            "clamps_version": clamps.get("version"),
            "guides_cli_version": None,  # filled in by main()
        },
    }
    return workholding


# ---------------------------------------------------------------- outputs

def _canonical_json_bytes(obj):
    return (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _report_section(workholding):
    """The report.md section (replaces any earlier one)."""
    fm = workholding["force_model"]
    lines = ["", "## Workholding guides (V2.9)", "",
             workholding["recommendation"], ""]
    for c in workholding["clamps"]:
        lines.append(
            f"- {c['clamp_id']} ({c['method']}) at "
            f"({c['x_mm']:g}, {c['y_mm']:g}) mm on {c['slot']}, "
            f"footprint {c['footprint_mm'][0]:g} x "
            f"{c['footprint_mm'][1]:g} mm — {c['reason']} "
            f"Force check: {c['force_check']['note']}.")
    if workholding["alternatives"]:
        lines.append("")
        lines.append("Alternatives for areas the slots cannot reach "
                     "(same keep-out rules, place by hand):")
        for a in workholding["alternatives"]:
            lines.append(f"- {a['clamp_id']} ({a['method']}): {a['note']}")
    lines += ["",
              "Force model (first-order estimate only — not a "
              "validated physics model):",
              "",
              f"- {fm['note']}",
              f"- Formula: {fm['formula']}.",
              ]
    if fm["worst_force_n"] is not None:
        lines.append(
            f"- Worst estimated cut force: {fm['worst_force_n']:.2f} N "
            f"({fm['worst_layer']}).")
    lines += ["",
              "Sheet origin on the bed: lower-left corner at (0, 0) — "
              "if the sheet is placed elsewhere on the bed, the slot "
              "coordinates above shift by the same offset.",
              "",
              f"Machine: {workholding['provenance']['machine_id']} "
              f"(version "
              f"{workholding['provenance']['machine_version']}), "
              f"clamp inventory version "
              f"{workholding['provenance']['clamps_version']}. "
              "Guide layer: GUIDE_CLAMP in the DXF.",
              ""]
    return "\n".join(lines)


def _write_outputs(job_dir, workholding):
    """Write the GUIDE_CLAMP layer into the DXF, the workholding
    section into job.json (+ manifest.json copy), and the
    recommendation into report.md. Idempotent: an earlier guide
    layer / report section is removed first. Updates job.json's
    ``outputs`` hashes for the files this step changed."""
    from pathlib import Path
    import ezdxf

    job_dir = Path(job_dir)
    job_path = job_dir / "job.json"
    job = json.loads(job_path.read_text())
    dxf_name = None
    for entry in job.get("outputs") or []:
        name = entry.get("file", "")
        if name.endswith(".dxf") and "/" not in name:
            dxf_name = name
            break
    if dxf_name is None:
        for cand in sorted(job_dir.glob("*.dxf")):
            dxf_name = cand.name
            break
    if dxf_name is None:
        raise GuidesError("guides_no_dxf",
                          f"no DXF file found in {job_dir} — guides "
                          "need the job's DXF to add the GUIDE_CLAMP "
                          "layer")
    dxf_path = job_dir / dxf_name

    doc = ezdxf.readfile(str(dxf_path))
    msp = doc.modelspace()
    # Remove any earlier guide geometry + layer (idempotency).
    for ent in list(msp.query(f'*[layer=="{GUIDE_LAYER}"]')):
        msp.delete_entity(ent)
    if GUIDE_LAYER in doc.layers:
        try:
            doc.layers.remove(GUIDE_LAYER)
        except Exception:
            pass  # an empty layer left behind is harmless
    doc.layers.add(GUIDE_LAYER, color=GUIDE_LAYER_COLOR)
    for c in workholding["clamps"]:
        w, d = c["footprint_mm"]
        x0, y0 = c["x_mm"] - w / 2.0, c["y_mm"] - d / 2.0
        x1, y1 = c["x_mm"] + w / 2.0, c["y_mm"] + d / 2.0
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                           close=True,
                           dxfattribs={"layer": GUIDE_LAYER})
    doc.saveas(str(dxf_path))

    # Report: replace any earlier guides section, then append.
    report_path = job_dir / "report.md"
    section = _report_section(workholding)
    if report_path.is_file():
        text = report_path.read_text()
        heading = "## Workholding guides (V2.9)"
        start = text.find(heading)
        if start != -1:
            rest = text[start + len(heading):]
            nxt = rest.find("\n## ")
            text = (text[:start]
                    + (rest[nxt + 1:] if nxt != -1 else ""))
        if text and not text.endswith("\n"):
            text += "\n"
        report_path.write_text(text + section)
    else:
        report_path.write_text("# Workholding guides (V2.9)\n" + section)

    # job.json + manifest.json (byte-identical copy), with fresh
    # outputs hashes for the files this step changed.
    job["workholding"] = workholding
    entries = []
    for path in sorted(p for p in job_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(job_dir).as_posix()
        if rel in ("job.json", "manifest.json"):
            continue
        entries.append({"file": rel, "sha256": _sha256_file(path)})
    job["outputs"] = entries
    blob = _canonical_json_bytes(job)
    job_path.write_bytes(blob)
    (job_dir / "manifest.json").write_bytes(blob)
    return job


# ---------------------------------------------------------------- CLI

def main(argv=None):
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(
        prog="mldxf_guides",
        description="Workholding guides (V2.9): slot-based clamp "
                    "placement for a finished job.")
    parser.add_argument("job_dir", help="finished job directory")
    parser.add_argument("--inputs", required=True,
                        help="JSON file: {machine, clamps, cli_version}")
    parser.add_argument("--json", action="store_true",
                        help="emit exactly one JSON object on stdout")
    args = parser.parse_args(argv)

    try:
        job_dir = Path(args.job_dir)
        if not job_dir.is_dir():
            raise GuidesError("job_not_found",
                              f"job dir not found: {job_dir}")
        job_path = job_dir / "job.json"
        if not job_path.is_file():
            raise GuidesError(
                "guides_unavailable",
                f"{job_dir} has no job.json (v1 job) — guides need "
                "the V2.2 job model (job.json with layout + tool "
                "plan + material). v1 jobs are read-only; re-run "
                "`mldxf plan` on the source STEP instead")
        try:
            job = json.loads(job_path.read_text())
        except ValueError as e:
            raise GuidesError("job_invalid",
                              f"{job_path} is not valid JSON: {e}")
        try:
            inputs = json.loads(Path(args.inputs).read_text())
        except OSError as e:
            raise GuidesError("guides_inputs_missing",
                              f"cannot read inputs file {args.inputs}: {e}")
        except ValueError as e:
            raise GuidesError("guides_inputs_missing",
                              f"inputs file {args.inputs} is not valid "
                              f"JSON: {e}")
        machine = inputs.get("machine")
        clamps = inputs.get("clamps")
        if not isinstance(machine, dict) \
                or not isinstance(clamps, dict) \
                or not isinstance(clamps.get("clamps"), list):
            raise GuidesError(
                "guides_inputs_missing",
                "inputs file must carry {'machine': {...}, 'clamps': "
                "{'version': n, 'clamps': [...]}}")
        # The caller loads + validates the libraries; the asserts
        # run again here so a hand-edited replay input cannot slip
        # placeholder slots or unmountable clamps through.
        import mldxf_config as cfg
        try:
            cfg.assert_real_t_track(machine)
            cfg.check_clamp_mountable(clamps, machine)
        except cfg.ConfigError as e:
            text = str(e)
            if "placeholders" in text:
                raise GuidesError("t_track_placeholder", text)
            raise GuidesError("clamp_no_slot", text)

        dxf_name = None
        for entry in job.get("outputs") or []:
            name = entry.get("file", "")
            if name.endswith(".dxf") and "/" not in name:
                dxf_name = name
                break
        if dxf_name is None:
            for cand in sorted(job_dir.glob("*.dxf")):
                dxf_name = cand.name
                break
        if dxf_name is None:
            raise GuidesError("guides_no_dxf",
                              f"no DXF file found in {job_dir}")
        workholding = compute_guides(job, job_dir / dxf_name,
                                     machine, clamps)
        workholding["provenance"]["guides_cli_version"] = \
            inputs.get("cli_version")
        job = _write_outputs(job_dir, workholding)
        emit({"ok": True, "workholding": workholding,
              "job": {"job_id": job.get("job_id"),
                      "job_dir": str(job_dir.resolve())}})
        return 0
    except GuidesError as e:
        emit({"ok": False, "error": e.name, "message": e.message})
        return 1
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit({"ok": False, "error": "internal_error",
              "message": f"{type(e).__name__}: {e}"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
