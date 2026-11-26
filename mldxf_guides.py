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
   clearance), extended from parts to clamp footprints. The job
   origin is kept out the same way: no clamp centre within ``half
   the footprint diagonal + D_profile + keep_out_mm`` of (0, 0),
   because the posted G-code parks the tool at the origin at the end
   of every job (Masso/GRBL footer: M5, ``G0 X0 Y0``, M30 — at
   clearance Z, 5 mm above the stock top), the operator sets the G54
   zero at the sheet corner, and the first M6 moves to the change
   position — so the tool occupies and travels through the origin
   corner at job start and end. The clearance reuses the profile-cut
   distance so a clamp stays as far from the origin as from any cut
   the tool makes. The collet nut / spindle are wider than the cutter
   and the clamp body height is not in the inventory, so this rule
   keeps the clamp body out of the tool's neighbourhood at the origin
   — it does not prove vertical clearance.
2. **Hold the sheet with contacts, not edges (V3.16).** A clamp
   restrains the sheet only through what it actually contacts
   (Brandon, Nov 25, 2026): a normal top-down clamp pushes down
   from the top at a point and holds laterally by friction only
   (mu x hold-down) — it pushes on NO side, and one clamp never
   serves two edges; a clamp with a lip constrains only the part
   of the one edge its lip touches, and only as a push — the
   sheet can move away from a lip freely. Clamps come in three
   contact types, each with explicit capacities recorded in the
   inventory (``mldxf_config.clamp_contact_type``): ``top_down``
   (hold-down force at a point + friction), ``edge_push``
   (lateral force against exactly one edge, no hold-down),
   ``pin`` (lateral constraint in two dimensions at a point, no
   hold-down). The verdict is computed from these contacts,
   never from counting edges touched: for the worst cut
   (position + tangential force, from the plan's own numbers),
   the placed contacts must balance the lateral force AND its
   moment about every contact taken as a pivot (the moment arm
   runs from the cut to the contact — a contact far from the cut
   resists less) AND the lift moment from the force acting at
   stock-top height, each with an explicit safety factor. A
   contact is local and one-sided where the physics says so: a
   lip pushes, never pulls. There is no "edge covered" anywhere
   in the verdict — an edge is never covered as a whole, only
   contacted at points. The placement rule follows Brandon's
   practice: a few strong clamps with good moment arms, spread
   across the sides — the moment balance decides sufficiency,
   not a count, and it never demands more clamps just for the
   sake of more clamps.
3. **Support near the cuts.** Candidate positions are ranked by
   proximity to the longest/most-loaded cuts, profiles first, so
   clamps sit near the work, not at the far corners. A clamp counts
   as supporting a part when its centre is within
   ``SUPPORT_RADIUS_MM`` of that part's profile outline.
4. **Loading forces, first order only.** The cutting force is
   estimated from the plan's own numbers — material removal rate
   per operation and a specific cutting energy for wood — giving a
   tangential force per cut. The moment check reuses those
   per-layer forces with their cut positions: the worst cut is
   the sampled profile/pocket point (both tangent senses) whose
   force demands the most hold-down at the farthest contact.
   Each placed clamp's required hold-down is reported — what the
   worst cut demands at that clamp, with the safety factor —
   against the clamp's rated ``hold_down_force_n`` when the
   inventory carries one. A bolted T-track clamp's hold-down is
   LARGE — the check never assumes a small default; when the
   rating is unknown the check is UNPROVEN because the force is
   unmeasured, not because it is small. **This is a first-order
   estimate, not a validated physics model** — the constant, the
   formula and its limits are documented wherever the number
   appears (here, in the report, and in the UI text the CLI
   returns), and the number must never be presented as
   validated.
5. **T-track only.** The clamp centre goes on a slot, at the slot
   coordinate nearest the ideal position. ``assert_real_t_track``
   is called first, so placeholder slots refuse with a named
   error, never a guess. Non-T-track methods in the inventory
   (tape, glue, screws) are listed as alternatives for areas the
   slots cannot reach, with the same keep-out rules — positions
   are not computed for them.
6. **Operator convenience as the tie-break.** Among near-equal
   positions, prefer sheet edges over between-parts positions and
   reuse the same clamp type across the job; a sheet wider than
   ``MIN_CLAMPS_WIDE_SHEET_MM`` gets at least two clamps when
   positions exist, so it is never held at a single point.

7. **What the moment balance is and is not.** The balance is a
   static, rigid-plate check on the worst sampled cut: lateral
   force balanced by friction / lateral contacts, yaw moment
   balanced by the couple between contacts (each contact taken
   in turn as the pivot, the others resisting), lift moment
   (force x stock height) balanced by hold-down. It assumes the
   sheet is rigid, the bed is flat, the cut force is the
   estimated tangential force at the sampled point, friction is
   mu x hold-down with mu = 0.2 unless the clamp records its
   own, and the safety factor is 2.0. It ignores the sheet's
   weight, radial and axial (plunge) force components, tool
   wear, deflection, vibration, grain, and the fact that a cut
   severs material (a freed part is held by tabs, not by this
   balance). A placement with a single contact can never balance
   a moment — a moment needs a couple, i.e. at least two
   contacts — so it is insufficient by construction, whatever
   the rating. The balance can say "unproven" or "insufficient"
   honestly; it cannot say a hold is safe. Verify holding force
   by hand before cutting.

Sheet placement assumption (recorded in the output, not hidden):
the sheet's lower-left corner sits at the bed origin (0, 0), so
slot coordinates and sheet coordinates share an origin. If the
operator places the sheet elsewhere on the bed, the slot
coordinates in the recommendation shift by the same offset.

Output (V2_SCOPE.md §6.3): a ``GUIDE_CLAMP`` layer in the job's
DXF (clamp footprints as rectangles at their sheet positions), a
``workholding`` section in ``job.json`` (one entry per recommended
clamp: ``clamp_id``, ``method``, ``slot``, ``x_mm``, ``y_mm``,
``reason`` — plus its ``roles`` (what the clamp provides:
hold-down / friction / edge-push / pin, and support) and its
``force_check`` (the hold-down / lateral capacity the worst cut
demands at that clamp, against its rating) — and a ``balance``
verdict for the placement as a whole: ``proven``,
``unproven`` or ``insufficient``, with the worst cut, the
required hold-down per clamp, and the fixture limits), and a
recommendation section in ``report.md``.

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
# Safety factor on every balance demand (lateral force, yaw
# moment, lift moment): the contacts must provide twice the worst
# estimated demand. Explicit, stated everywhere the numbers appear.
SAFETY_FACTOR = 2.0
# Friction coefficient for a top-down clamp's lateral resistance
# (friction capacity = mu x hold-down). 0.2 is a conservative dry
# wood-on-metal value; a clamp entry may record its own
# ``friction_mu``. It is an assumption, not a measurement — the
# balance says so wherever it reports a friction number.
FRICTION_MU_DEFAULT = 0.2
# Two placed clamps must be at least this far apart (centre to
# centre) — clamps stacked on the same spot do not add support.
MIN_CLAMP_SEPARATION_MM = 30.0
# Candidate positions are sampled along each slot at this step, plus
# the exact projections of each part centroid onto each slot.
CANDIDATE_STEP_MM = 5.0
# Origin keep-out (Nov 25, 2026 — Brandon: a clamp next to the
# zero-zero mark is in the tool's way at homing / job start). The
# distance itself is computed per job in compute_guides (footprint
# half-diagonal + largest profile tool diameter + keep-out — see
# there); this constant is only the documented floor the rule never
# goes below, so a job with no profile tool and no keep-out still
# keeps clamps out of the origin corner by more than a clamp
# half-diagonal.
ORIGIN_KEEP_OUT_FLOOR_MM = 15.0
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

MOMENT_MODEL_NOTE = (
    "Contact-balance check (first-order, not a validated physics "
    "model): for the worst sampled cut — each profile/pocket chord "
    "midpoint, both tangent senses, with that layer's estimated "
    "tangential force — the placed contacts must balance the "
    "lateral force, its yaw moment about every contact taken as a "
    "pivot, and the lift moment (force x stock height), each with "
    "safety factor 2.0. A top-down clamp resists laterally by "
    "friction (mu x hold-down, mu = 0.2 unless the clamp records "
    "its own — an assumption, not a measurement); an edge-push "
    "clamp pushes one edge only and cannot pull; a pin constrains "
    "laterally in two dimensions and holds nothing down. A single "
    "contact can never balance a moment. The check ignores the "
    "sheet's weight, radial and axial force components, tool wear, "
    "deflection, vibration and grain, and the fact that a cut "
    "severs material. When a rating the balance needs is unknown, "
    "the verdict is unproven — the force is unmeasured, not small. "
    "Verify holding force by hand before cutting."
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


# ---------------------------------------------------------------- contacts
# (the balance model — Brandon, Nov 25, 2026)

def _contacts_for_clamp(clamp, x, y, footprint, sheet_w, sheet_d):
    """Local contacts for one placed clamp: what it actually
    touches, as points with capacities (see the module docstring,
    point 2). ``footprint`` is the oriented (w, d) at the placed
    position. Returns a list of contact dicts, each with ``kind``,
    ``x``, ``y`` and ``capacity_n`` (None when the rating the
    contact needs is unrecorded — unmeasured, not zero).
    - top_down: a hold-down contact at the centre (capacity =
      hold_down_force_n) and a friction contact at the same point
      (capacity = mu x hold-down, mu from the clamp or
      FRICTION_MU_DEFAULT; None when the hold-down is unrated).
      It serves no edge laterally.
    - edge_push: one push-only lateral contact on the sheet edge
      the footprint reaches (the lip touches that edge, at the
      clamp's along-edge coordinate); capacity =
      lateral_capacity_n; direction = the edge's inward normal.
      When the footprint reaches no edge the lip touches nothing
      and the clamp contributes no contact. No hold-down.
    - pin: one two-way lateral contact at the centre (a dowel in
      a hole blocks both directions); capacity =
      lateral_capacity_n. No hold-down."""
    import mldxf_config as cfg
    ctype = cfg.clamp_contact_type(clamp)
    w, d = float(footprint[0]), float(footprint[1])
    if ctype == "edge_push":
        # The lip touches the edge the footprint reaches: the
        # footprint's face must be at the edge (within 1 mm —
        # one candidate-sampling step of slack). The contact is
        # the centre projected onto that edge line; the reaction
        # pushes inward along the edge normal, never pulls.
        reaches = []
        if y - d / 2 <= 1.0:
            reaches.append(("bottom", y - d / 2, (0.0, 1.0), (x, 0.0)))
        if sheet_d - (y + d / 2) <= 1.0:
            reaches.append(("top", sheet_d - (y + d / 2), (0.0, -1.0),
                            (x, sheet_d)))
        if x - w / 2 <= 1.0:
            reaches.append(("left", x - w / 2, (1.0, 0.0), (0.0, y)))
        if sheet_w - (x + w / 2) <= 1.0:
            reaches.append(("right", sheet_w - (x + w / 2), (-1.0, 0.0),
                            (sheet_w, y)))
        if not reaches:
            return []
        edge, _gap, normal, point = min(reaches, key=lambda e: e[1])
        return [{"kind": "edge_push", "edge": edge,
                 "x": round(point[0], 3), "y": round(point[1], 3),
                 "normal": normal,
                 "capacity_n": clamp.get("lateral_capacity_n")}]
    if ctype == "pin":
        return [{"kind": "pin", "x": round(x, 3), "y": round(y, 3),
                 "capacity_n": clamp.get("lateral_capacity_n")}]
    # top_down (default)
    hold = clamp.get("hold_force_n")
    mu = clamp.get("friction_mu")
    if mu is None:
        mu = FRICTION_MU_DEFAULT
    fric = None if hold is None else round(float(mu) * float(hold), 3)
    return [{"kind": "hold_down", "x": round(x, 3), "y": round(y, 3),
             "capacity_n": hold},
            {"kind": "friction", "x": round(x, 3), "y": round(y, 3),
             "capacity_n": fric, "mu": mu}]


def _sample_cuts(profile_segs, pocket_segs, per_layer_forces):
    """Sampled cut points with their tangential force: for every
    endmill layer that carries a force estimate, the midpoint of
    each DXF chord segment, with the segment's tangent direction
    (unit) and the layer's force. Both tangent senses are
    evaluated by the balance (climb vs conventional — the worse
    one is what matters). Returns a list of (x, y, tx, ty,
    force_n, layer)."""
    force_by_layer = {e["layer"]: e["force_n"]
                      for e in per_layer_forces}
    samples = []
    for segs in (profile_segs, pocket_segs):
        for ((ax, ay), (bx, by)), layer in segs:
            force = force_by_layer.get(layer)
            if force is None:
                continue
            mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
            dx, dy = bx - ax, by - ay
            n = math.hypot(dx, dy)
            if n < 1e-9:
                continue
            samples.append((mx, my, dx / n, dy / n, force, layer))
    return samples


def _slots_along_edges(slots, sheet_w, sheet_d):
    """Which sheet sides have a slot running along them: an x-slot
    in the lower half runs along the bottom, in the upper half
    along the top; a y-slot in the left half along the left, in
    the right half along the right. A coarse inventory fact (a
    slot's half is not a contact) — it only says where a contact
    can be placed at all, so the balance can name the sides no
    slot reaches."""
    along = {"bottom": False, "top": False, "left": False,
             "right": False}
    for s in slots or []:
        if not isinstance(s, dict) or s.get("placeholder") is True:
            continue
        if s.get("axis") == "x":
            along["bottom" if float(s["at_y_mm"]) <= sheet_d / 2.0
                  else "top"] = True
        elif s.get("axis") == "y":
            along["left" if float(s["at_x_mm"]) <= sheet_w / 2.0
                  else "right"] = True
    return along


def _moment_balance(samples, clamp_contacts, z_top_mm):
    """Contact balance for the worst sampled cut (see the module
    docstring, points 2 and 7). ``clamp_contacts`` is a list of
    (clamp_index, contact) pairs from every placed clamp.
    ``z_top_mm`` is the stock height the lateral force acts at.
    For each sample and each tangent sense, the lateral force,
    its yaw moment about every distinct contact position taken
    as a pivot, and its lift moment (force x stock height) must
    be balanced by the other contacts, each with SAFETY_FACTOR.
    A contact's capacity is None when its rating is unrecorded:
    it can cover a shortfall only as an unknown, so a component
    whose known capacity falls short is unproven when an unknown
    contact could help, insufficient when no unknown could.
    Returns the balance dict: verdict (proven / unproven /
    insufficient), the worst cut, the per-pivot demands at the
    worst cut, the required hold-down / lateral capacity per
    clamp, and the note. With no samples (no force estimated)
    the verdict is unproven; with no contacts at all it is
    insufficient — nothing resists the cut."""
    if not samples:
        return {"verdict": "unproven",
                "worst_cut": None,
                "reasons": ["cutting force not estimated — the "
                            "moment balance has no force to check"],
                "per_clamp": [],
                "per_pivot": [],
                "required_hold_down_max_n": None}
    if not clamp_contacts:
        return {"verdict": "insufficient",
                "worst_cut": None,
                "reasons": ["no contacts placed — nothing resists "
                            "the cut force"],
                "per_clamp": [],
                "per_pivot": [],
                "required_hold_down_max_n": None}
    # Distinct pivot positions (a top-down clamp's hold-down and
    # friction share one point — one pivot per position).
    pivots = []
    seen = set()
    for _ci, c in clamp_contacts:
        key = (round(c["x"], 3), round(c["y"], 3))
        if key not in seen:
            seen.add(key)
            pivots.append((c["x"], c["y"]))
    # Contacts grouped by clamp, for the per-clamp requirements.
    by_clamp = {}
    for ci, c in clamp_contacts:
        by_clamp.setdefault(ci, []).append(c)

    def _lateral(Fx, Fy):
        """(known capacity, unknown-can-help) against the force
        (Fx, Fy): friction and pin contacts can direct their
        reaction any way up to their capacity; an edge-push
        contact contributes only along its inward normal, and
        only when that normal has a component opposing the
        force."""
        fn = math.hypot(Fx, Fy)
        if fn < 1e-12:
            return 0.0, False
        ux, uy = -Fx / fn, -Fy / fn  # direction the reaction needs
        known, unknown = 0.0, False
        for _ci, c in clamp_contacts:
            if c["kind"] in ("friction", "pin"):
                if c["capacity_n"] is None:
                    unknown = True
                else:
                    known += float(c["capacity_n"])
            elif c["kind"] == "edge_push":
                nx, ny = c["normal"]
                along = nx * ux + ny * uy
                if along > 0:
                    if c["capacity_n"] is None:
                        unknown = True
                    else:
                        known += float(c["capacity_n"]) * along
        return known, unknown

    def _yaw_about(px, py, qx, qy, Fx, Fy):
        """(demand, known capacity, unknown-can-help) for the yaw
        moment about pivot (px, py) from the force at (qx, qy).
        A contact at another position resists with its lateral
        capacity times its distance from the pivot (friction/pin
        can direct the reaction; an edge-push contact only when
        its fixed direction gives a moment of the needed sign)."""
        m_signed = (qx - px) * Fy - (qy - py) * Fx
        demand = abs(m_signed)
        need_sign = -1.0 if m_signed > 0 else 1.0
        known, unknown = 0.0, False
        for _ci, c in clamp_contacts:
            if (round(c["x"], 3), round(c["y"], 3)) == (round(px, 3),
                                                        round(py, 3)):
                continue  # the pivot itself carries no couple
            dx, dy = c["x"] - px, c["y"] - py
            lever = math.hypot(dx, dy)
            if lever < 1e-9:
                continue
            if c["kind"] in ("friction", "pin"):
                if c["capacity_n"] is None:
                    unknown = True
                else:
                    known += float(c["capacity_n"]) * lever
            elif c["kind"] == "edge_push":
                nx, ny = c["normal"]
                # Moment of R * normal about the pivot, per unit R.
                s = dx * ny - dy * nx
                if s * need_sign > 0:
                    if c["capacity_n"] is None:
                        unknown = True
                    else:
                        known += float(c["capacity_n"]) * abs(s)
        return demand, known, unknown

    def _tip_about(px, py, Fx, Fy):
        """(demand, known capacity, unknown-can-help) for the lift
        moment about the axis through (px, py) perpendicular to
        the force: demand is force x stock height; only hold-down
        contacts resist, at their perpendicular distance from
        the axis."""
        fn = math.hypot(Fx, Fy)
        if fn < 1e-12 or z_top_mm is None:
            return 0.0, 0.0, False
        demand = fn * float(z_top_mm)
        # Axis direction: the tip-moment direction, perpendicular
        # to the force in the bed plane.
        mx, my = -Fy / fn, Fx / fn
        known, unknown = 0.0, False
        for _ci, c in clamp_contacts:
            if c["kind"] != "hold_down":
                continue
            if (round(c["x"], 3), round(c["y"], 3)) == (round(px, 3),
                                                        round(py, 3)):
                continue
            d = abs((c["x"] - px) * my - (c["y"] - py) * mx)
            if d < 1e-9:
                continue
            if c["capacity_n"] is None:
                unknown = True
            else:
                known += float(c["capacity_n"]) * d
        return demand, known, unknown

    def _verdict_component(demand, known, unknown):
        if known + 1e-9 >= SAFETY_FACTOR * demand:
            return "proven"
        if unknown:
            return "unproven"
        return "insufficient"

    worst = None  # (max required hold-down, sample, sense)
    overall = "proven"
    worst_per_pivot = []
    for (qx, qy, tx, ty, force, layer) in samples:
        for sense in (1.0, -1.0):
            Fx, Fy = sense * force * tx, sense * force * ty
            lat_known, lat_unknown = _lateral(Fx, Fy)
            lat = _verdict_component(force, lat_known, lat_unknown)
            # Required hold-down / lateral capacity per clamp at
            # this cut: what clamp i would need if it alone
            # resisted the worst moment about each other pivot.
            per_clamp_req = {}
            for ci, contacts in by_clamp.items():
                mu = None
                hold = None
                for c in contacts:
                    if c["kind"] == "friction":
                        mu = c.get("mu", FRICTION_MU_DEFAULT)
                    if c["kind"] == "hold_down":
                        hold = c["capacity_n"]
                req_hold, req_lat = 0.0, 0.0
                has_other_pivot = False
                for (px, py) in pivots:
                    # Skip pivots at this clamp's own position.
                    if any((round(c["x"], 3), round(c["y"], 3))
                           == (round(px, 3), round(py, 3))
                           for c in contacts):
                        continue
                    has_other_pivot = True
                    m_signed = (qx - px) * Fy - (qy - py) * Fx
                    m = abs(m_signed)
                    need_sign = -1.0 if m_signed > 0 else 1.0
                    for c in contacts:
                        dx, dy = c["x"] - px, c["y"] - py
                        lever = math.hypot(dx, dy)
                        if c["kind"] in ("friction", "pin"):
                            if lever > 1e-9:
                                req_lat = max(
                                    req_lat,
                                    m * SAFETY_FACTOR / lever)
                                if mu:
                                    req_hold = max(
                                        req_hold,
                                        m * SAFETY_FACTOR
                                        / (mu * lever))
                        elif c["kind"] == "edge_push":
                            nx, ny = c["normal"]
                            s = dx * ny - dy * nx
                            if s * need_sign > 0 and abs(s) > 1e-9:
                                req_lat = max(
                                    req_lat,
                                    m * SAFETY_FACTOR / abs(s))
                    # Lift: this clamp's hold-down resisting the
                    # tip about the axis through the pivot.
                    if z_top_mm is not None:
                        fn = math.hypot(Fx, Fy)
                        if fn > 1e-12:
                            mx, my = -Fy / fn, Fx / fn
                            for c in contacts:
                                if c["kind"] != "hold_down":
                                    continue
                                d = abs((c["x"] - px) * my
                                        - (c["y"] - py) * mx)
                                if d > 1e-9:
                                    req_hold = max(
                                        req_hold,
                                        force * float(z_top_mm)
                                        * SAFETY_FACTOR / d)
                # With no other pivot there is no couple to
                # resist about — the requirement is undefined,
                # not zero (a single contact can never balance a
                # moment); None says so instead of printing a
                # false 0.00 N.
                per_clamp_req[ci] = {
                    "required_hold_down_n": (
                        (round(req_hold, 2) if req_hold > 0 else 0.0)
                        if has_other_pivot else None),
                    "required_lateral_n": (
                        (round(req_lat, 2) if req_lat > 0 else 0.0)
                        if has_other_pivot else None),
                    "hold_down_rated_n": hold,
                }
            # Verdict at this cut: the worst component over the
            # lateral check and every pivot's yaw + tip.
            cut_verdict = lat
            pivot_rows = []
            for (px, py) in pivots:
                yd, yk, yu = _yaw_about(px, py, qx, qy, Fx, Fy)
                yv = _verdict_component(yd, yk, yu)
                td, tk, tu = _tip_about(px, py, Fx, Fy)
                tv = _verdict_component(td, tk, tu)
                if yv == "insufficient" or tv == "insufficient":
                    cut_verdict = "insufficient"
                elif cut_verdict != "insufficient" and (
                        yv == "unproven" or tv == "unproven"):
                    cut_verdict = "unproven"
                pivot_rows.append({
                    "pivot_x_mm": round(px, 3),
                    "pivot_y_mm": round(py, 3),
                    "yaw_moment_n_mm": round(yd, 2),
                    "yaw_known_capacity_n_mm": round(yk, 2),
                    "yaw_unknown": bool(yu),
                    "tip_moment_n_mm": round(td, 2),
                    "tip_known_capacity_n_mm": round(tk, 2),
                    "tip_unknown": bool(tu),
                })
            if cut_verdict == "insufficient":
                overall = "insufficient"
            elif overall != "insufficient" and cut_verdict == "unproven":
                overall = "unproven"
            max_req = max(
                (v["required_hold_down_n"]
                 for v in per_clamp_req.values()
                 if v["required_hold_down_n"] is not None),
                default=None)
            if worst is None or (max_req is not None
                                 and (worst[0] is None
                                      or max_req > worst[0])):
                worst = (max_req, (qx, qy, tx, ty, force, layer),
                         sense, per_clamp_req, pivot_rows,
                         cut_verdict)
    _max_req, (qx, qy, tx, ty, force, layer), sense, per_clamp_req, \
        pivot_rows, _cv = worst
    return {"verdict": overall,
            "worst_cut": {"x_mm": round(qx, 2), "y_mm": round(qy, 2),
                          "layer": layer,
                          "force_n": round(force, 2),
                          "tangent": [round(tx, 3), round(ty, 3)],
                          "sense": int(sense)},
            "per_clamp": per_clamp_req,
            "per_pivot": pivot_rows,
            "required_hold_down_max_n":
                round(_max_req, 2) if _max_req is not None else None}


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

    # Clamp-margin floor (Brandon, Nov 25, 2026): the margin band
    # must fit the clamp body — the margin is at least the largest
    # across-slot clamp footprint in the inventory. The layout does
    # not enforce this (the headless pipeline never reads the home);
    # the guides do, where the inventory is known. A job whose
    # margin is too small is cuttable but unclampable, so this
    # refuses with a named error before any clamp is placed.
    import layout as _layout
    _margin = job.get("clamp_margin_mm")
    if _margin is not None:
        _floor_v = _layout.check_margin_for_clamps(
            float(_margin), clamps["clamps"])
        if _floor_v:
            raise GuidesError("guides_margin_too_small", _floor_v)

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
    # Origin keep-out: no clamp centre within r_origin of the job
    # origin (0, 0). r_origin is the footprint's half-diagonal plus
    # the profile-cut clearance (largest profile tool diameter +
    # keep-out), floored so a job with no profile tool still keeps
    # clamps out of the corner — so the footprint itself stays at
    # least D_profile + keep_out from the origin point, the same
    # distance it must keep from any profile outline. See the
    # module docstring (point 1) for why the tool is at the origin:
    # the posted footer parks there (G0 X0 Y0) at the end of every
    # job, and the operator zeroes G54 there at setup.
    _fw, _fd = float(footprint[0]), float(footprint[1])
    r_origin = max(ORIGIN_KEEP_OUT_FLOOR_MM,
                   math.hypot(_fw, _fd) / 2.0 + d_profile + keep_out)
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

    def clears_origin(x, y):
        """Origin keep-out for a candidate centre: the centre stays
        at least r_origin from (0, 0) — applied alongside clears()
        wherever candidates are filtered, so a position that clears
        every cut but sits on the origin corner is never placed."""
        return math.hypot(x, y) + 1e-9 >= r_origin

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
    # Sampled cut points for the moment balance (profile/pocket
    # chord midpoints with their layer's estimated tangential
    # force), and the stock height the lateral force acts at
    # (material thickness, else the tallest part). A job on which
    # NO candidate clears at all places no clamp and keeps the
    # "place by hand" recommendation — it presents no placement
    # as a plan, so there is nothing to prove.
    cut_samples = _sample_cuts(profile_segs, pocket_segs, per_layer)
    z_top = None
    if isinstance(material, dict) and material.get("thickness"):
        z_top = float(material["thickness"])
    else:
        _heights = [float(p["height_mm"]) for p in parts
                    if isinstance(p, dict) and p.get("height_mm")]
        z_top = max(_heights) if _heights else None
    slots_along = _slots_along_edges(slots, sheet_w, sheet_d)

    def _placed_contacts(placed_list):
        """Flat (clamp_index, contact) list for the placed set."""
        out = []
        for _i, (_x, _y, _slot, _fp) in enumerate(placed_list):
            for _c in _contacts_for_clamp(clamp, _x, _y, _fp,
                                          sheet_w, sheet_d):
                out.append((_i, _c))
        return out

    def _balance_of(placed_list):
        return _moment_balance(cut_samples,
                               _placed_contacts(placed_list), z_top)

    placed = []
    placed_slots = set()
    uncovered = {name for name in part_names if name is not None}
    # Greedy: each round, rank the surviving candidates — ones
    # whose nearest cut belongs to an uncovered part (support)
    # first, then ones on a slot no clamp uses yet (spread across
    # the sides — Brandon's practice is a few strong clamps with
    # good moment arms, spread across the sides, not more
    # clamps), then ones farthest from the clamps already placed
    # (long moment arms), then by distance to the nearest cut,
    # then by sheet edge (edges over between-parts), then by
    # position (so the result is deterministic). The loop stops
    # once every part is covered and the bare minimum count is
    # met — unless the moment balance is insufficient with known
    # ratings, in which case another clamp may fix it and the
    # loop keeps placing while clamps remain. A placement the
    # balance cannot prove is reported as unproven with the
    # numbers, never presented as proven.
    remaining = list(candidates)
    while remaining and len(placed) < available:
        if not uncovered and len(placed) >= min_clamps:
            if _balance_of(placed)["verdict"] != "insufficient":
                break
        scored = []
        for cand in remaining:
            x, y, slot, (w, d) = cand
            rect = (x - w / 2, y - d / 2, x + w / 2, y + d / 2)
            if not clears(rect) or not clears_origin(x, y):
                continue
            if any(math.hypot(x - px, y - py) < MIN_CLAMP_SEPARATION_MM
                   for (px, py, _s, _f) in placed):
                continue
            dist, layer = _nearest_profile(cand, rank_segs)
            if dist is None:
                dist = float("inf")
            nearest_part = layer_part.get(layer) if layer else None
            covers_new = 1 if nearest_part in uncovered else 0
            slot_key = (slot["axis"],
                        slot["at_y_mm"] if slot["axis"] == "x"
                        else slot["at_x_mm"])
            new_slot = 1 if slot_key not in placed_slots else 0
            if placed:
                spread = min(math.hypot(x - px, y - py)
                             for (px, py, _s, _f) in placed)
            else:
                spread = float("inf")
            key = (0 if covers_new else 1, 0 if new_slot else 1,
                   -spread, dist, edge_dist(x, y),
                   round(x, 3), round(y, 3))
            scored.append((key, cand, layer, dist))
        if not scored:
            break
        scored.sort(key=lambda s: s[0])
        _key, cand, layer, dist = scored[0]
        placed.append(cand)
        remaining.remove(cand)
        x, y, slot, (w, d) = cand
        placed_slots.add((slot["axis"],
                          slot["at_y_mm"] if slot["axis"] == "x"
                          else slot["at_x_mm"]))
        nearest_part = layer_part.get(layer) if layer else None
        if nearest_part in uncovered:
            uncovered.discard(nearest_part)
    # Contact balance for the placed set (see the module
    # docstring, points 2 and 7). The verdict is proven only
    # when the worst sampled cut is balanced with the safety
    # factor on every component and every rating the balance
    # needs is recorded; unproven when a needed rating is
    # unknown (the force is unmeasured, not small); insufficient
    # when a known rating falls short. A placement is never
    # called proven on force grounds it does not have. (There is
    # no edge-based refusal any more: the old
    # ``guides_unrestrained`` refusal was an artifact of the
    # edge premise — a one-sided layout is now warned about with
    # the balance numbers, not refused.)
    balance = _balance_of(placed)
    balance["safety_factor"] = SAFETY_FACTOR
    balance["friction_mu_default"] = FRICTION_MU_DEFAULT
    balance["z_top_mm"] = z_top
    balance["slots_along_edges"] = slots_along
    balance["moment_note"] = MOMENT_MODEL_NOTE
    missing_sides = sorted(e for e, ok in slots_along.items()
                           if not ok)
    balance["sides_without_slot"] = missing_sides
    reasons = list(balance.get("reasons") or [])
    if missing_sides:
        reasons.append(
            "no slot runs along the " + " / ".join(missing_sides)
            + " edge(s) of this fixture, so no contact can be "
            "placed there — four-side placement is impossible on "
            "these slots; the balance below is for the placed "
            "contacts only")
    balance["reasons"] = reasons
    wc = balance.get("worst_cut")
    req_max = balance.get("required_hold_down_max_n")
    if balance["verdict"] == "proven":
        balance_note = (
            "Contact balance: PROVEN — the worst cut "
            f"({wc['force_n']:.2f} N at ({wc['x_mm']:g}, "
            f"{wc['y_mm']:g}), {wc['layer']}) is balanced by the "
            "placed contacts with safety factor "
            f"{SAFETY_FACTOR:g}; worst required hold-down "
            f"{req_max:.2f} N.")
    elif balance["verdict"] == "unproven":
        if wc is not None and req_max is not None:
            balance_note = (
                "Contact balance: UNPROVEN — the worst cut "
                f"({wc['force_n']:.2f} N at ({wc['x_mm']:g}, "
                f"{wc['y_mm']:g}), {wc['layer']}) demands "
                f"{req_max:.2f} N of hold-down at the farthest "
                "clamp, but the clamp's hold-down force is "
                "unrated (unmeasured, not small) — verify by "
                "hand before cutting.")
        else:
            balance_note = ("Contact balance: UNPROVEN — "
                            + "; ".join(reasons))
    else:  # insufficient
        if wc is not None and req_max is None:
            # A single contact can never balance a moment — the
            # required hold-down is undefined, not 0.00 N.
            balance_note = (
                "Contact balance: INSUFFICIENT — only one clamp "
                "is placed, and a single contact can never "
                "balance a moment: the worst cut "
                f"({wc['force_n']:.2f} N at ({wc['x_mm']:g}, "
                f"{wc['y_mm']:g}), {wc['layer']}) has nothing to "
                "lever against — add a second clamp on another "
                "slot, with a long moment arm between them.")
        elif wc is not None and req_max is not None:
            rated = clamp.get("hold_force_n")
            rated_txt = (f"rated {rated:g} N" if rated is not None
                         else "unrated")
            balance_note = (
                "Contact balance: INSUFFICIENT — the worst cut "
                f"({wc['force_n']:.2f} N at ({wc['x_mm']:g}, "
                f"{wc['y_mm']:g}), {wc['layer']}) demands "
                f"{req_max:.2f} N of hold-down ({rated_txt}) — add "
                "a clamp with a longer moment arm, or a stronger "
                "clamp.")
        else:
            balance_note = ("Contact balance: INSUFFICIENT — "
                            + "; ".join(reasons))
    if missing_sides:
        balance_note += (" No slot runs along the "
                         + " / ".join(missing_sides)
                         + " edge(s) of this fixture — four-side "
                         "placement is impossible on these slots.")
    balance["note"] = balance_note

    # Per-clamp force checks come from the balance (required
    # hold-down / lateral capacity at the worst cut, against the
    # clamp's ratings); the entries loop below reads them from
    # balance["per_clamp"] by clamp index.
    balance_per_clamp = balance.get("per_clamp") or {}

    clamp_entries = []
    for _ci, (x, y, slot, (w, d)) in enumerate(placed):
        _d, layer = _nearest_profile((x, y, slot, (w, d)), rank_segs)
        part = layer_part.get(layer) if layer else None
        supports = (part is not None and _d is not None
                    and not math.isinf(_d)
                    and _d <= SUPPORT_RADIUS_MM)
        ctype = cfg.clamp_contact_type(clamp)
        contacts_here = _contacts_for_clamp(clamp, x, y, (w, d),
                                            sheet_w, sheet_d)
        roles = []
        if ctype == "top_down":
            roles += ["hold-down", "friction"]
        elif ctype == "edge_push":
            roles.append("edge-push")
        elif ctype == "pin":
            roles.append("pin")
        if supports:
            roles.append("support")
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
        if ctype == "edge_push":
            _edge = next((c["edge"] for c in contacts_here
                          if c["kind"] == "edge_push"), None)
            if _edge:
                contact_txt = (f"Edge-push on the {_edge} edge — "
                               "pushes that edge only, where the lip "
                               "touches; it cannot pull the sheet "
                               "back and provides no hold-down")
            else:
                contact_txt = ("Edge-push clamp clear of every edge "
                               "— its lip touches nothing, so it "
                               "holds nothing")
        elif ctype == "pin":
            contact_txt = ("Pin — constrains lateral movement in two "
                           "dimensions at that point; provides no "
                           "hold-down")
        else:
            contact_txt = ("Top-down hold-down — pins the sheet down "
                           "at that point; lateral hold is friction "
                           "only (mu x hold-down)")
        if _d is None or math.isinf(_d):
            reason = (f"{contact_txt} — no profile/pocket outline in "
                      "this job, placed clear of every drill point, "
                      f"on the {slot_str}.")
        elif supports:
            reason = (f"{contact_txt} + supports the {supported} "
                      f"(nearest cut {_d:.1f} mm away) — clamp centre "
                      f"on the {slot_str}.")
        else:
            reason = (f"{contact_txt} — clamp centre on the "
                      f"{slot_str}.")
        # This clamp's force check, from the balance: what the
        # worst cut demands at this clamp, against its rating.
        _req = (balance_per_clamp.get(_ci)
                or balance_per_clamp.get(str(_ci)) or {})
        req_hold = _req.get("required_hold_down_n")
        req_lat = _req.get("required_lateral_n")
        rated_hold = clamp.get("hold_force_n")
        rated_lat = clamp.get("lateral_capacity_n")
        if req_hold is None and req_lat is None:
            if balance["verdict"] == "insufficient" and wc is not None:
                fc_status = "insufficient"
                fc_note = ("Too weak — a single contact can never "
                           "balance a moment: this clamp has nothing "
                           "to lever against — add a second clamp on "
                           "another slot.")
            else:
                fc_status = "unproven"
                fc_note = ("cutting force not estimated — "
                           + "; ".join(force_skipped)
                           + " — verify holding force by hand")
        elif ctype == "top_down":
            if rated_hold is None:
                fc_status = "unproven"
                fc_note = (f"Unproven — the worst cut demands "
                           f"{req_hold:.2f} N of hold-down at this "
                           "clamp, but its hold-down force is "
                           "unrated (unmeasured, not small) — verify "
                           "by hand.")
            elif req_hold <= rated_hold:
                fc_status = "proven"
                fc_note = (f"Proven — the worst cut demands "
                           f"{req_hold:.2f} N of hold-down at this "
                           f"clamp, rated {rated_hold:g} N.")
            else:
                fc_status = "insufficient"
                fc_note = (f"Too weak — the worst cut demands "
                           f"{req_hold:.2f} N of hold-down at this "
                           f"clamp, rated {rated_hold:g} N.")
        elif ctype == "pin":
            if rated_lat is None:
                fc_status = "unproven"
                fc_note = (f"Unproven — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           "this pin, but its lateral capacity is "
                           "unrated — verify by hand.")
            elif req_lat <= rated_lat:
                fc_status = "proven"
                fc_note = (f"Proven — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           f"this pin, rated {rated_lat:g} N.")
            else:
                fc_status = "insufficient"
                fc_note = (f"Too weak — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           f"this pin, rated {rated_lat:g} N.")
        else:  # edge_push
            if not any(c["kind"] == "edge_push"
                       for c in contacts_here):
                fc_status = "insufficient"
                fc_note = ("Too weak — this edge-push clamp's lip "
                           "touches no edge, so it holds nothing.")
            elif rated_lat is None:
                fc_status = "unproven"
                fc_note = (f"Unproven — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           "this clamp, but its lateral capacity is "
                           "unrated — verify by hand.")
            elif req_lat <= rated_lat:
                fc_status = "proven"
                fc_note = (f"Proven — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           f"this clamp, rated {rated_lat:g} N.")
            else:
                fc_status = "insufficient"
                fc_note = (f"Too weak — the worst cut demands "
                           f"{req_lat:.2f} N of lateral capacity at "
                           f"this clamp, rated {rated_lat:g} N.")
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
            "roles": roles,
            "contact_type": ctype,
            "reason": reason,
            "force_check": {
                "worst_force_n": worst_force,
                "hold_force_n": rated_hold,
                "lateral_capacity_n": rated_lat,
                "required_hold_down_n": req_hold,
                "required_lateral_n": req_lat,
                "status": fc_status,
                "note": fc_note,
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
            f"on the {slots_used}. {balance['note']}")
        if any("support" in c.get("roles", [])
               for c in clamp_entries):
            recommendation += (
                f" Each support clamp sits within "
                f"{SUPPORT_RADIUS_MM:g} mm of the {rank_kind} cut it "
                f"supports.")
        if worst_force is not None:
            recommendation += (f" Worst estimated cut force "
                               f"{worst_force:.2f} N.")
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
            "slots is too close to a cut or to the job origin. Place "
            "clamps by hand, keeping them clear of every cut by at "
            f"least {c_profile:.2f} mm from a profile outline "
            f"({d_profile:g} mm profile tool + {keep_out:g} mm "
            f"keep-out) and clear of the job origin (0, 0) by at "
            f"least {r_origin:.2f} mm from the clamp centre.")
        recommendation += f" {balance['note']}"
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
        "balance": balance,
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
        "origin_keep_out_mm": round(r_origin, 3),
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
    b = workholding.get("balance") or {}
    if b:
        lines += [f"{b.get('note', '')}", ""]
        wc = b.get("worst_cut") or {}
        if wc:
            lines += [f"Worst cut: {wc.get('force_n')} N at "
                      f"({wc.get('x_mm')}, {wc.get('y_mm')}) on "
                      f"{wc.get('layer')}.", ""]
        for c in workholding["clamps"]:
            fc = c.get("force_check") or {}
            if fc.get("required_hold_down_n") is not None:
                _rated = fc.get("hold_force_n")
                lines += [f"Required hold-down at "
                          f"({c['x_mm']:g}, {c['y_mm']:g}): "
                          f"{fc['required_hold_down_n']:.2f} N "
                          f"({'rated ' + str(_rated) + ' N' if _rated is not None else 'hold-down unrated'}).",
                          ""]
            elif fc.get("required_lateral_n") is not None:
                _rated = fc.get("lateral_capacity_n")
                lines += [f"Required lateral capacity at "
                          f"({c['x_mm']:g}, {c['y_mm']:g}): "
                          f"{fc['required_lateral_n']:.2f} N "
                          f"({'rated ' + str(_rated) + ' N' if _rated is not None else 'lateral capacity unrated'}).",
                          ""]
        if b.get("sides_without_slot"):
            lines += ["Sides with no slot on this fixture: "
                      + ", ".join(b["sides_without_slot"])
                      + " — no contact can be placed there.", ""]
        if b.get("moment_note"):
            lines += ["Moment model (first-order estimate only — not "
                      "a validated physics model):", "",
                      f"- {b['moment_note']}", ""]
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
              f"Origin keep-out: no clamp centre within "
              f"{workholding.get('origin_keep_out_mm')} mm of the job "
              f"origin (0, 0) — the posted G-code parks the tool "
              f"there (G0 X0 Y0) at the end of every job.",
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
