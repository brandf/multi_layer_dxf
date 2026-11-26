#!/usr/bin/env python3
"""2D layout for multi-part jobs (BRA-16, 2026-11-09).

Replaces the single-row largest-first layout in multi_part.py with
shelf packing, a clamp margin, fit-or-error against a given material
size, a suggested size when none is given, and the registration-pin
interface for two-sided jobs (BRA-13 consumes it; this module only
defines the positions).

Rules (BRA-16 issue + Brandon 2026-11-08):
  - Material size in: W x D x thickness, CLI --material or config
    "material" / "stock_size_mm" (parsed by orient_search).
    If omitted, the tool suggests a size in the report.
  - Fit-or-error: if a size is given, the packed layout MUST fit
    inside it or the run fails with a named error (non-zero exit,
    no DXF/manifest written). Never silently overflow the material
    or shrink a part.
  - Packing: shelf/row packing — fill rows left-to-right, wrap when
    full. A part may be rotated 90 deg in Z to fit (recorded as
    rotate_z in the manifest). Gap between parts is gap_mm.
  - Clamping: a clamp margin (config "clamp_margin_mm", default
    15 mm) is reserved around the material edge; parts are placed
    only inside the usable area (material minus margin). The margin
    is clamp space only, sized for the clamp body — it carries no
    tool diameter — and it is the web on the outside (Brandon,
    Nov 25, 2026). The margin and usable area go in the
    manifest/report.
  - Registration pins (two-sided): when the job is two-sided, the
    layout reserves two pin positions (dowel-pin holes) outside the
    parts but inside the material, in the clamp-safe zone (inside
    the usable area, clear of every part by the keep-out radius),
    and records them in the manifest so side B mirrors them about
    the flip axis. Pins are a layout reservation only — BRA-13
    builds the two-sided flow that consumes them.
  - Tool-dependent spacing (BRA-16 spacing rule, Brandon
    2026-11-08): a profile (or through) cut eats one tool diameter
    outside the part outline, so the gap between two parts is
    max(gap_mm, D_A + D_B + web_min), where D_A/D_B are the parts'
    profile endmill diameters (toolplan.profile_tool_diameter, the
    planner fit rule, computed BEFORE packing — see multi_part.py)
    and web_min is the remaining web for the tabs (default 5 mm).
    The same rule sets the gap between rows and the edge inset:
    every part outline sits D_p inside the usable-area boundary
    (its own profile tool — the kerf only), so the kerf runs up
    to the usable boundary and the margin band itself is the web
    on the outside; the clamp margin must be bigger than web_min
    (see check_margin_web) and it carries no tool diameter
    (Brandon, Nov 25, 2026). The registration-pin clearance is
    pin centre to a part outline >= D_p + pin radius + ~3 mm.
    Pockets and drills do not affect spacing (they cut interior
    material).
"""
import math

DEFAULT_CLAMP_MARGIN_MM = 15.0
# Floor for the clamp margin (Brandon, Nov 25, 2026): the margin
# band must fit the clamp body, so the margin is at least the
# largest across-slot clamp footprint in the recorded inventory —
# the clamp's long side runs along its slot, so the across-slot
# width is min(footprint). Recorded inventory: test-tt-clamp
# 20 x 12 mm -> 12 mm across. The default 15 mm leaves 3 mm
# slack. Enforced at guide time (mldxf_guides.compute_guides),
# where the inventory is known — the headless pipeline never
# reads the home, so it cannot enforce this itself. See
# check_margin_for_clamps below.
MIN_CLAMP_MARGIN_MM = 12.0
DEFAULT_PIN_DIAMETER_MM = 6.0
DEFAULT_PIN_KEEP_OUT_MM = 1.0  # extra clearance around a pin hole
DEFAULT_WEB_MIN_MM = 5.0       # minimum remaining web between profile cuts
DEFAULT_PIN_CLEARANCE_MM = 3.0  # pin centre to kerf edge
TOL_MM = 0.05


class PackError(Exception):
    """The layout does not fit the material. The message names the
    part(s) and by how much — it is the user-facing error."""


def clamp_margin_mm(cfg=None, parts_cfg=None):
    """Clamp margin in mm: parts.json wins, then config, then 15
    (the default). The margin is clamp space only — see
    MIN_CLAMP_MARGIN_MM for the floor from the clamp inventory."""
    for src in (parts_cfg, cfg):
        if src and src.get("clamp_margin_mm") is not None:
            return float(src["clamp_margin_mm"])
    return DEFAULT_CLAMP_MARGIN_MM


def web_min_mm(cfg=None, parts_cfg=None):
    """Minimum remaining web between profile cuts (BRA-16 spacing
    rule): parts.json wins, then config, then 5 mm."""
    for src in (parts_cfg, cfg):
        if src and src.get("web_min_mm") is not None:
            return float(src["web_min_mm"])
    return DEFAULT_WEB_MIN_MM


def pin_clearance_mm(cfg=None, parts_cfg=None):
    """Clearance from a registration-pin centre to the kerf edge
    (BRA-16 spacing rule): parts.json wins, then config, then 3 mm."""
    for src in (parts_cfg, cfg):
        if src and src.get("pin_clearance_mm") is not None:
            return float(src["pin_clearance_mm"])
    return DEFAULT_PIN_CLEARANCE_MM


def pair_gap(d_a, d_b, gap_mm, web_min_mm=DEFAULT_WEB_MIN_MM):
    """Minimum gap between two part outlines (BRA-16 spacing rule):
    max(gap_mm, D_A + D_B + web_min). Each profile cut eats one tool
    diameter outside the outline, so the remaining web is
    gap - D_A - D_B and the tabs have nothing to hold onto if it
    vanishes. A part with no profile tool (None — e.g. --only
    filtered the profiles out) contributes no kerf. The gap_mm
    floor still applies."""
    return max(float(gap_mm),
               (d_a or 0.0) + (d_b or 0.0) + float(web_min_mm))


def usable_area(material, margin):
    """(usable W, usable D) inside the clamp margin, or None when
    no material is given (unbounded layout)."""
    if material is None:
        return None
    return (material["x"] - 2 * margin, material["y"] - 2 * margin)


def _ceil_to(value, step):
    return math.ceil(value / step - 1e-9) * step


def suggest_material(packed_w, packed_d, max_height, margin):
    """Suggested material size when none was given: the REQUIRED
    usable extents (packed layout bounds plus the far-side kerf
    insets — see required_usable_extents) + clamp margin on every
    side, W/D rounded up to the next 10 mm; thickness is the
    tallest part, rounded up to the next 1 mm. The caller passes
    the required extents, not the raw packed bounds, so the sheet
    covers parts + kerf + margin (the margin band is the web on
    the outside)."""
    return {
        "x": _ceil_to(packed_w + 2 * margin, 10),
        "y": _ceil_to(packed_d + 2 * margin, 10),
        "thickness": _ceil_to(max_height, 1),
    }


def check_fits_usable(name, w, d, max_w, max_d, dia=None,
                     web_min_mm=DEFAULT_WEB_MIN_MM):
    """A single part's footprint must fit the usable area in either
    in-plane spin. Raises PackError naming the part and the shortfall.
    With dia given, the fit also reserves the part's own edge inset
    (dia — the kerf only) on every side: the kerf runs up to the
    usable boundary and the margin band is the web on the outside.
    With dia None (the prepare-phase call, before the profile tools
    are known) it checks the bare footprint only; pack_shelf
    enforces the insets once the tools are known."""
    if max_w is None:
        return
    inset = dia if dia is not None else 0.0
    fits = (w + 2 * inset <= max_w + TOL_MM and d + 2 * inset <= max_d + TOL_MM) or \
           (d + 2 * inset <= max_w + TOL_MM and w + 2 * inset <= max_d + TOL_MM)
    if not fits:
        over0 = max(0.0, w + 2 * inset - max_w) + max(0.0, d + 2 * inset - max_d)
        over1 = max(0.0, d + 2 * inset - max_w) + max(0.0, w + 2 * inset - max_d)
        raise PackError(
            f"part {name} footprint {w:.2f} x {d:.2f} mm does not fit "
            f"usable area {max_w:.2f} x {max_d:.2f} mm in either spin "
            f"(short by {min(over0, over1):.2f} mm in the best spin)"
            + (f" (includes {inset:.2f} mm kerf inset per side)"
               if inset else ""))


def pack_shelf(rects, gap, max_w=None, max_d=None,
               web_min_mm=DEFAULT_WEB_MIN_MM):
    """Shelf packing. rects: [{name, w, d, tool_dia?}] in pack order
    (caller sorts largest-first); tool_dia is the part's profile
    endmill diameter (BRA-16 spacing rule) or None when unknown.
    Returns [{name, x, y, w, d, rotate_z}] with x/y the lower-left
    corner of the placed rect, in usable-area coordinates.
    Edge inset (Brandon, Nov 25, 2026): every part outline sits
    (its own tool_dia — the kerf only) inside the usable-area
    boundary, so the kerf runs up to the usable boundary and the
    margin band itself is the web on the outside; the clamp
    margin must be bigger than web_min (see check_margin_web).
    The first part in a row starts at its own inset, the first
    row starts at the largest inset in the row, and a part only
    fits a row when its outline plus its own inset fits the
    usable width — the inset is per part, not a single max. With
    every tool_dia None the insets are all zero — exactly the old
    behaviour.
    The gap between two adjacent parts is pair_gap(D_A, D_B) and the
    gap between two rows is max(gap, max tool in the row above +
    max tool in the row below + web_min). With every tool_dia None
    the gaps are all gap_mm — exactly the old behaviour.
    A rect is tried unrotated first, then rotated 90 deg, in the
    current row; if neither fits the row it starts a new row.
    With max_w/max_d None the layout is unbounded: a single row,
    but placements still start at the edge inset (the unbounded
    regressions move with the Nov 25, 2026 semantics change).
    Raises PackError naming the part and the overshoot when a rect
    cannot fit the usable width in either spin, or the rows exceed
    the usable depth."""
    rows = []  # each row: {"items": [(rect, x, w, d, rot)], "height", "max_dia"}
    cur = {"items": [], "height": 0.0, "max_dia": 0.0}
    x = 0.0
    for r in rects:
        w, d = float(r["w"]), float(r["d"])
        name = r["name"]
        dia = r.get("tool_dia")
        inset = dia if dia is not None else 0.0
        if max_w is not None:
            check_fits_usable(name, w, d, max_w, max_d, dia, web_min_mm)
        # gap to the previous part in this row (the first part in a
        # row starts at its own edge inset, not at the usable edge)
        prev_dia = cur["items"][-1][0].get("tool_dia") if cur["items"] else None
        placed = None
        for rot, (rw, rd) in ((0, (w, d)), (90, (d, w))):
            gx = pair_gap(prev_dia, dia, gap, web_min_mm) if cur["items"] else inset
            if max_w is None or x + gx + rw + inset <= max_w + TOL_MM:
                placed = (x + gx, rw, rd, rot)
                break
        if placed is None:
            # new row (unbounded layout never wraps: max_w None
            # always placed above, so this is the bounded case)
            rows.append(cur)
            cur = {"items": [], "height": 0.0, "max_dia": 0.0}
            x = 0.0
            for rot, (rw, rd) in ((0, (w, d)), (90, (d, w))):
                if max_w is None or rw + 2 * inset <= max_w + TOL_MM:
                    placed = (inset, rw, rd, rot)
                    break
            if placed is None:
                raise PackError(
                    f"part {name} footprint {w:.2f} x {d:.2f} mm does not fit "
                    f"usable width {max_w:.2f} mm in either spin"
                    + (f" (needs {inset:.2f} mm kerf inset per side)"
                       if inset else ""))
        px, pw, pd, rot = placed
        cur["items"].append((r, px, pw, pd, rot))
        cur["height"] = max(cur["height"], pd)
        if dia is not None:
            cur["max_dia"] = max(cur["max_dia"], dia)
        x = px + pw
    rows.append(cur)
    # Row y offsets: the gap between two rows is the same rule, with
    # each row's largest profile tool.
    placements = []
    y = 0.0
    for i, row in enumerate(rows):
        # First row starts at its largest edge inset; later rows
        # stack on the previous row's height + the row gap.
        row_inset = max(
            ((it[0].get("tool_dia"))
             if it[0].get("tool_dia") is not None else 0.0)
            for it in row["items"]) if row["items"] else 0.0
        if i == 0:
            y = row_inset
        else:
            prev = rows[i - 1]
            row_gap = max(gap, prev["max_dia"] + row["max_dia"] + web_min_mm)
            y += prev["height"] + row_gap
        for (r, px, pw, pd, rot) in row["items"]:
            placements.append({"name": r["name"], "x": round(px, 3), "y": round(y, 3),
                               "w": round(pw, 3), "d": round(pd, 3), "rotate_z": rot})
    total_d = y + rows[-1]["height"] if rows else 0.0
    if max_d is not None:
        # Top edge: every part in the last row needs its own
        # kerf inset above its top edge.
        top_need = max(
            (it[3] + it[0].get("tool_dia")
             if it[0].get("tool_dia") is not None else it[3])
            for it in rows[-1]["items"]) if rows and rows[-1]["items"] else 0.0
        if y + top_need > max_d + TOL_MM:
            pw, _ = packed_bounds(placements)
            raise PackError(
                f"packed layout {pw:.2f} x {y + top_need:.2f} mm exceeds usable area "
                f"{max_w:.2f} x {max_d:.2f} mm (depth overshoot {y + top_need - max_d:.2f} mm "
                f"including each part's kerf inset above its top edge; "
                f"{len(rects)} parts, gaps per the tool-spacing rule "
                f"(D_A + D_B + {web_min_mm:g} mm web) — a larger sheet, a smaller "
                f"clamp margin, or smaller profile tools would fit; clamp margin "
                f"already removed)")
    return placements


def verify_spacing(placements, tool_dias, gap_mm,
                   web_min_mm=DEFAULT_WEB_MIN_MM):
    """Check the packed gaps against the tool-spacing rule, using
    the ACTUAL profile tools (e.g. from the chosen merged plan —
    BRA-16 item 6: switching plans changes the spacing, so the fit
    is re-checked). placements: [{name, x, y, w, d}] in usable-area
    coordinates; tool_dias: {name: dia_mm or None}. Returns a list
    of violation strings (empty = every gap holds the required web).
    Rows are grouped by their shared y; horizontal gaps are checked
    between consecutive parts in a row, vertical gaps between parts
    in adjacent rows whose x-ranges overlap."""
    violations = []
    rows = {}
    for p in placements:
        rows.setdefault(round(p["y"], 3), []).append(p)
    row_ys = sorted(rows)
    for yi, y in enumerate(row_ys):
        row = sorted(rows[y], key=lambda p: p["x"])
        for a, b in zip(row, row[1:]):
            gap = b["x"] - (a["x"] + a["w"])
            req = pair_gap(tool_dias.get(a["name"]), tool_dias.get(b["name"]),
                           gap_mm, web_min_mm)
            if gap + TOL_MM < req:
                violations.append(
                    f"{a['name']}–{b['name']} horizontal gap {gap:.2f} mm < "
                    f"{req:.2f} mm required "
                    f"({tool_dias.get(a['name'])} + {tool_dias.get(b['name'])} + "
                    f"{web_min_mm:g} mm web)")
        if yi + 1 < len(row_ys):
            below = rows[row_ys[yi + 1]]
            for a in row:
                for b in below:
                    if a["x"] + a["w"] <= b["x"] + TOL_MM or \
                            b["x"] + b["w"] <= a["x"] + TOL_MM:
                        continue  # x-ranges do not overlap: not adjacent
                    gap = b["y"] - (a["y"] + a["d"])
                    req = pair_gap(tool_dias.get(a["name"]), tool_dias.get(b["name"]),
                                   gap_mm, web_min_mm)
                    if gap + TOL_MM < req:
                        violations.append(
                            f"{a['name']}–{b['name']} vertical gap {gap:.2f} mm < "
                            f"{req:.2f} mm required "
                            f"({tool_dias.get(a['name'])} + {tool_dias.get(b['name'])} + "
                            f"{web_min_mm:g} mm web)")
    return violations


def verify_edge_insets(placements, tool_dias, max_w, max_d,
                       web_min_mm=DEFAULT_WEB_MIN_MM):
    """Check the packed edge insets against the tool-spacing rule,
    using the ACTUAL profile tools. placements: [{name, x, y, w, d}]
    in usable-area coordinates; tool_dias: {name: dia_mm or None}.
    Returns a list of violation strings (empty = every part outline
    sits its own dia (the kerf) inside the usable-area boundary,
    so its kerf runs up to the usable boundary and the margin
    band is the web on the outside). A part with no profile tool
    (None) has no kerf and needs no inset."""
    violations = []
    if max_w is None or max_d is None:
        return violations
    for p in placements:
        dia = tool_dias.get(p["name"])
        if dia is None:
            continue
        inset = dia
        if p["x"] + TOL_MM < inset:
            violations.append(
                f"{p['name']} left edge {p['x']:.2f} mm < "
                f"{inset:.2f} mm inset "
                f"({dia:.2f} mm profile tool — the kerf)")
        if p["y"] + TOL_MM < inset:
            violations.append(
                f"{p['name']} bottom edge {p['y']:.2f} mm < "
                f"{inset:.2f} mm inset "
                f"({dia:.2f} mm profile tool — the kerf)")
        if p["x"] + p["w"] + inset > max_w + TOL_MM:
            violations.append(
                f"{p['name']} right edge {p['x'] + p['w']:.2f} mm + "
                f"{inset:.2f} mm inset > usable width {max_w:.2f} mm")
        if p["y"] + p["d"] + inset > max_d + TOL_MM:
            violations.append(
                f"{p['name']} top edge {p['y'] + p['d']:.2f} mm + "
                f"{inset:.2f} mm inset > usable depth {max_d:.2f} mm")
    return violations


def required_usable_extents(placements, tool_dias,
                            web_min_mm=DEFAULT_WEB_MIN_MM):
    """(required usable W, required usable D) for a packing: the
    packed bounds plus each edge part's own kerf inset on the
    far sides. The near-side insets are already in the placements
    (the first part in a row starts at its own inset, the first
    row starts at its largest inset); the far sides need the
    trailing inset added: max over parts of (x + w + dia)
    and (y + d + dia). A part with no profile tool (None)
    contributes no inset. Feed the result to suggest_material so
    the suggested sheet covers parts + kerf + margin (the margin
    band is the web on the outside)."""
    if not placements:
        return (0.0, 0.0)
    req_w = 0.0
    req_d = 0.0
    for p in placements:
        dia = tool_dias.get(p["name"])
        inset = dia if dia is not None else 0.0
        req_w = max(req_w, p["x"] + p["w"] + inset)
        req_d = max(req_d, p["y"] + p["d"] + inset)
    return (req_w, req_d)


def check_margin_web(margin, web_min_mm=DEFAULT_WEB_MIN_MM):
    """The clamp margin IS the web on the outside (Brandon, Nov 25,
    2026): the kerf runs up to the usable-area boundary, so the
    material holding the sheet edge is the margin band itself —
    and it must be bigger than web_min. Returns a violation
    string, or None when the margin holds. A configured margin at
    or below web_min refuses here rather than silently leaving
    too little web on the outside."""
    if margin <= web_min_mm:
        return (f"clamp margin {margin:.1f} mm must be bigger than the "
                f"web_min {web_min_mm:.1f} mm — the margin band is the web "
                f"on the outside; increase clamp_margin_mm (or lower "
                f"web_min_mm)")
    return None


def check_margin_for_clamps(margin, clamps):
    """The clamp margin must fit the clamp body: the margin band is
    clamp space only, so the margin is at least the largest
    across-slot clamp footprint in the inventory — the clamp's long
    side runs along its slot, so the across-slot width is
    min(footprint). Only clamps that actually sit in the band count:
    slot-mounted ones (``t_track: true``) the operator owns
    (``count > 0``). Off-slot methods (tape, glue, screw, pin) never
    sit in the band — tape is stuck on top of the sheet wherever it
    is needed, not slotted into the margin — and a count-0 template
    entry is a method the operator does not own, so neither sets
    the floor. Returns a violation string, or None when the
    margin holds. ``clamps`` is a list of dicts with ``id`` and
    ``footprint_mm``. The floor for the recorded inventory is
    MIN_CLAMP_MARGIN_MM (test-tt-clamp 20 x 12 mm -> 12 mm).
    Enforced at guide time (mldxf_guides.compute_guides), where the
    inventory is known."""
    worst = None
    for c in clamps or []:
        if not isinstance(c, dict):
            continue
        if not c.get("t_track"):
            continue
        try:
            owned = int(c.get("count", 0))
        except (TypeError, ValueError):
            owned = 0
        if owned <= 0:
            continue
        fp = c.get("footprint_mm")
        if not fp or len(fp) < 2:
            continue
        across = min(float(fp[0]), float(fp[1]))
        if worst is None or across > worst[0]:
            worst = (across, c.get("id", "?"))
    if worst is None:
        return None
    if margin + TOL_MM < worst[0]:
        return (f"clamp margin {margin:.1f} mm cannot fit the "
                f"{worst[1]} clamp ({worst[0]:.1f} mm across its slot) — "
                f"increase clamp_margin_mm to at least {worst[0]:.1f} mm")
    return None


def packed_bounds(placements):
    """(width, depth) of the packed layout from its placements."""
    if not placements:
        return (0.0, 0.0)
    return (max(p["x"] + p["w"] for p in placements),
            max(p["y"] + p["d"] for p in placements))


def pin_positions(material, margin, placements, pin_dia=DEFAULT_PIN_DIAMETER_MM,
                  keep_out=DEFAULT_PIN_KEEP_OUT_MM, tool_dias=None,
                  pin_clearance_mm=DEFAULT_PIN_CLEARANCE_MM):
    """Two registration-pin positions for a two-sided job, or a
    (pins, error) pair. Candidate spots sit just inside the usable
    area (inset by pin radius + keep-out from its edges): the four
    corners plus the four edge midpoints. A spot is usable when it
    is clear of every placed part rect expanded by the pin
    keep-out: with tool diameters given, the clearance from a pin
    centre to a part outline is D_p + pin radius + pin_clearance
    (the profile kerf must not reach the pin hole); without them it
    is the old pin radius + keep-out. The returned pair is the clear
    pair with the greatest separation (a wide diagonal registers
    the flip best), which must span at least 35% of the usable
    diagonal — two pins next to each other do not locate a flip.
    The pins carry keep_out_radius_mm = max D_p + pin radius +
    pin_clearance (or radius + keep-out when no tools are given).
    Returns ([pins], None) or ([], reason) when no such pair exists
    — the caller records the reason as a flag instead of failing
    the run (pins are a reservation for BRA-13, not a cut feature
    yet)."""
    if material is None:
        return [], "no material size given — pin positions need a material sheet to sit on"
    uw, ud = material["x"] - 2 * margin, material["y"] - 2 * margin
    r = pin_dia / 2.0
    inset = margin + r + keep_out
    x0, x1 = inset, material["x"] - inset
    y0, y1 = inset, material["y"] - inset
    xm, ym = (x0 + x1) / 2, (y0 + y1) / 2
    candidates = [(x0, y0), (x1, y1), (x1, y0), (x0, y1),
                  (xm, y0), (xm, y1), (x0, ym), (x1, ym)]

    def clear(px, py):
        # Candidates are sheet coordinates; placements are usable-area
        # coordinates (usable origin = one clamp margin in from the
        # sheet edge), so shift the part rects by the margin.
        # A pin centre must stay D_p + pin radius + clearance from a
        # part outline (the kerf eats D_p beyond the outline); with
        # no tool diameters the old radius + keep-out applies.
        for p in placements:
            dia = (tool_dias or {}).get(p["name"])
            exp = (dia + r + pin_clearance_mm) if dia is not None else (r + keep_out)
            if (margin + p["x"] - exp <= px <= margin + p["x"] + p["w"] + exp and
                    margin + p["y"] - exp <= py <= margin + p["y"] + p["d"] + exp):
                return False
        return True

    clear_spots = [c for c in candidates if clear(*c)]
    best = None
    best_d = 0.0
    for i in range(len(clear_spots)):
        for j in range(i + 1, len(clear_spots)):
            a, b = clear_spots[i], clear_spots[j]
            d = math.dist(a, b)
            if d > best_d:
                best_d, best = d, (a, b)
    min_span = 0.35 * math.hypot(uw, ud)
    if best is not None and best_d >= min_span:
        dias = [d for d in (tool_dias or {}).values() if d is not None]
        ko = (max(dias) + r + pin_clearance_mm) if dias else (r + keep_out)
        pins = [{"x": round(px, 3), "y": round(py, 3),
                 "diameter_mm": pin_dia,
                 "keep_out_radius_mm": round(ko, 3)}
                for px, py in best]
        return pins, None
    return [], ("no well-separated pin positions inside the usable area "
                f"({uw:.1f} x {ud:.1f} mm) — parts cover the corners/edges; "
                "place pins manually for the two-sided flip (BRA-13)")
