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
    20 mm) is reserved around the material edge; parts are placed
    only inside the usable area (material minus margin). The margin
    and usable area go in the manifest/report.
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
    The same rule sets the gap between rows, the clamp margin
    check (margin must cover D + web_min or the kerf eats the
    sheet edge), and the registration-pin clearance (pin centre to
    a part outline >= D_p + pin radius + ~3 mm). Pockets and
    drills do not affect spacing (they cut interior material).
"""
import math

DEFAULT_CLAMP_MARGIN_MM = 20.0
DEFAULT_PIN_DIAMETER_MM = 6.0
DEFAULT_PIN_KEEP_OUT_MM = 1.0  # extra clearance around a pin hole
DEFAULT_WEB_MIN_MM = 5.0       # minimum remaining web between profile cuts
DEFAULT_PIN_CLEARANCE_MM = 3.0  # pin centre to kerf edge
TOL_MM = 0.05


class PackError(Exception):
    """The layout does not fit the material. The message names the
    part(s) and by how much — it is the user-facing error."""


def clamp_margin_mm(cfg=None, parts_cfg=None):
    """Clamp margin in mm: parts.json wins, then config, then 20."""
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
    """Suggested material size when none was given: packed layout
    bounds + clamp margin on every side, W/D rounded up to the
    next 10 mm; thickness is the tallest part, rounded up to the
    next 1 mm."""
    return {
        "x": _ceil_to(packed_w + 2 * margin, 10),
        "y": _ceil_to(packed_d + 2 * margin, 10),
        "thickness": _ceil_to(max_height, 1),
    }


def check_fits_usable(name, w, d, max_w, max_d):
    """A single part's footprint must fit the usable area in either
    in-plane spin. Raises PackError naming the part and the shortfall."""
    if max_w is None:
        return
    fits = (w <= max_w + TOL_MM and d <= max_d + TOL_MM) or \
           (d <= max_w + TOL_MM and w <= max_d + TOL_MM)
    if not fits:
        over0 = max(0.0, w - max_w) + max(0.0, d - max_d)
        over1 = max(0.0, d - max_w) + max(0.0, w - max_d)
        raise PackError(
            f"part {name} footprint {w:.2f} x {d:.2f} mm does not fit "
            f"usable area {max_w:.2f} x {max_d:.2f} mm in either spin "
            f"(short by {min(over0, over1):.2f} mm in the best spin)")


def pack_shelf(rects, gap, max_w=None, max_d=None,
               web_min_mm=DEFAULT_WEB_MIN_MM):
    """Shelf packing. rects: [{name, w, d, tool_dia?}] in pack order
    (caller sorts largest-first); tool_dia is the part's profile
    endmill diameter (BRA-16 spacing rule) or None when unknown.
    Returns [{name, x, y, w, d, rotate_z}] with x/y the lower-left
    corner of the placed rect.
    The gap between two adjacent parts is pair_gap(D_A, D_B) and the
    gap between two rows is max(gap, max tool in the row above +
    max tool in the row below + web_min). With every tool_dia None
    the gaps are all gap_mm — exactly the old behaviour.
    A rect is tried unrotated first, then rotated 90 deg, in the
    current row; if neither fits the row it starts a new row.
    With max_w/max_d None the layout is unbounded: a single row,
    exactly the old behaviour (regressions must not move).
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
        if max_w is not None:
            check_fits_usable(name, w, d, max_w, max_d)
        # gap to the previous part in this row (0 for the first)
        prev_dia = cur["items"][-1][0].get("tool_dia") if cur["items"] else None
        placed = None
        for rot, (rw, rd) in ((0, (w, d)), (90, (d, w))):
            gx = pair_gap(prev_dia, dia, gap, web_min_mm) if cur["items"] else 0.0
            if max_w is None or x + gx + rw <= max_w + TOL_MM:
                placed = (x + gx, rw, rd, rot)
                break
        if placed is None:
            # new row (unbounded layout never wraps: max_w None
            # always placed above, so this is the bounded case)
            rows.append(cur)
            cur = {"items": [], "height": 0.0, "max_dia": 0.0}
            x = 0.0
            for rot, (rw, rd) in ((0, (w, d)), (90, (d, w))):
                if max_w is None or rw <= max_w + TOL_MM:
                    placed = (0.0, rw, rd, rot)
                    break
            if placed is None:
                raise PackError(
                    f"part {name} footprint {w:.2f} x {d:.2f} mm does not fit "
                    f"usable width {max_w:.2f} mm in either spin")
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
        if i > 0:
            prev = rows[i - 1]
            row_gap = max(gap, prev["max_dia"] + row["max_dia"] + web_min_mm)
            y += prev["height"] + row_gap
        for (r, px, pw, pd, rot) in row["items"]:
            placements.append({"name": r["name"], "x": round(px, 3), "y": round(y, 3),
                               "w": round(pw, 3), "d": round(pd, 3), "rotate_z": rot})
    total_d = y + rows[-1]["height"] if rows else 0.0
    if max_d is not None and total_d > max_d + TOL_MM:
        pw, _ = packed_bounds(placements)
        raise PackError(
            f"packed layout {pw:.2f} x {total_d:.2f} mm exceeds usable area "
            f"{max_w:.2f} x {max_d:.2f} mm (depth overshoot {total_d - max_d:.2f} mm; "
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


def check_edge_clearance(tool_dias, margin, web_min_mm=DEFAULT_WEB_MIN_MM):
    """The clamp margin must leave the sheet edge alive: the profile
    kerf eats D beyond the outline, so the margin has to cover the
    largest profile tool + the edge margin (web_min). Returns a
    violation string, or None when the margin holds."""
    dias = [d for d in tool_dias.values() if d is not None]
    if not dias:
        return None
    biggest = max(dias)
    need = biggest + web_min_mm
    if margin + TOL_MM < need:
        return (f"clamp margin {margin:.1f} mm is less than the {need:.1f} mm "
                f"the {biggest:.2f} mm profile tool needs "
                f"({biggest:.2f} mm kerf + {web_min_mm:g} mm edge margin) — "
                f"increase clamp_margin_mm, or cut the profiles with a "
                f"smaller endmill")
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
