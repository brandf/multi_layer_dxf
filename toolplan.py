#!/usr/bin/env python3
"""
Tool planning for multi_layer_dxf (BRA-12, built 2026-11-08).

Design decisions (Brandon, 2026-11-08):
  - NO personal tool library to maintain. Tools wear out and get
    replaced, and keeping a library current is tedious. Instead the
    classifier RECOMMENDS tools from standard sizes, the manifest
    carries the recommendation (plus fallback plans), and the VCarve
    gadget matches each recommendation to a tool in VCarve's own
    standard tool library at run time (ToolDatabase:SelectTool() —
    the SDK has no silent lookup-by-diameter, only the interactive
    dialog, so the gadget asks once per distinct tool and falls back
    to the recommendation if you cancel). You review the plan in
    report.md and tweak in VCarve if your library differs.
  - Brandon's bits are imperial wood bits (Bits & Bits), 1/16" to
    1/2", any given bit may be missing. So the standard endmill
    candidates are imperial sizes, plus metric fine endmills
    (1.0 / 0.8 / 0.5 mm, BRA-18) for pockets narrower than 1/16"
    can cut. The manifest holds MORE THAN ONE plan: Plan A
    (fastest), Plan B/C (fallbacks — e.g. the 1/2" endmill is
    missing, so do it all with the 1/4"). Each plan is writable
    as its own manifest_<id>.txt; the gadget runs whichever file
    you pick.
  - No automatic tool changer: every tool change is manual, so the
    optimiser charges tool_change_seconds per change (default 120 s)
    and can pick a SMALLER tool for everything when that beats the
    optimal-tool-per-operation plan plus a manual change.
  - CAM practice: EVERY profile layer gets TABS by default — the outer
    profile (the part) and every through cut (the slug inside the
    loop: a doughnut hole's centre is a solid disc, not sawdust).
    Count scales down with perimeter; tab length/thickness come from
    config. The tab COUNT is not settable through the documented
    ProfileParameterData fields (the gadget tries TabCount in a
    guarded call and VCarve's default applies if it is ignored).
    Drilled/bored holes need no tabs — the material leaves as chips.

How it works:
  - Each layer carries an "est" dict from the classifier:
      drill:   {"hole_count", "hole_dia_mm", "depth_mm"}
      pocket:  {"area_mm2", "min_width_mm", "depth_mm",
                "perimeter_mm", "corner_radius_mm" (None = no corners)}
      profile: {"perimeter_mm", "min_width_mm" (slots only), "depth_mm",
                "loop_count" (closed contours in the layer; V3.14)}
    Layers may also carry "depends_on" (a layer name that must be cut
    first — a facing pocket for a surface drill, a parent pocket for
    a pocket-in-pocket child). The planner orders by dependency first.
  - A plan is a TOOL SET: a set of endmills (0-2 sizes) plus, per
    distinct hole diameter, "drill it" or "bore it with an endmill".
    Per layer the tool is then forced (largest fitting endmill in the
    set, exact drill, or largest endmill that fits the hole for a
    bore). Enumerating tool sets (<= 46 sets x <= 4 drill modes) is
    cheap and exact — no per-layer combinatorial search.
  - Rough + finish (BRA-14): for a pocket whose corners the roughing
    tool would round beyond their design radius, the plan can add a
    finish pass with the smallest smaller endmill in the set, removing
    only a thin wall allowance. It is a plan VARIANT ("finish"), never
    the fastest (extra tool change) — it is always listed so you can
    pick sharp corners over speed, and max_corner_radius_mm makes it
    mandatory when set. The finish pass is priced like a profile cut
    around the perimeter, not an area clear.
  - Cutting time is an MRR estimate (volume / (feed*stepover*stepdown)
    for pockets, length*passes/feed for profiles, plunge+peck for
    drills). Estimates are labelled as such everywhere they appear.
  - Cut order is dependency-aware (BRA-14): a drill that opens on a
    faced surface runs after the facing pocket; a pocket-in-pocket
    child runs after its parent; a finish pass runs after its rough
    pass. Otherwise drill -> pocket -> profile, grouped by tool inside
    each operation so tool changes are minimised. The profile is
    ALWAYS last (invariant): after it the part hangs on its tabs, so
    nothing may follow it. Tool numbers are assigned in first-use
    order — this fixes the v0.2 gadget bug where every toolpath was
    Tool 1 and the posted code called no tool change.

Public API:
  settings(cfg)            -> merged settings dict
  plan_tools(layers, cfg)  -> {"plans": [plan, ...], "error": str|None}
  choose_plan(plans, wanted_id) -> plan (default: fastest, id "A")
  tabs_for_layer(layer, st) -> tabs dict or None
  manifest_txt(plan, layers, dxf_name) -> manifest.txt (v2) text
  format_tool_plan_report(tool_plan) -> [markdown lines]
"""
import itertools
import math
from fractions import Fraction

INCH_TO_MM = 25.4

DEFAULTS = {
    # Manual tool change, no ATC. The knob that makes "one smaller
    # tool for everything" win when it should. Seconds.
    "tool_change_seconds": 120,
    # Brandon's actual bits: imperial, 1/16" .. 1/2". The optimiser
    # only ever recommends these sizes (drills are exact hole dia).
    "standard_endmills_in": [0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625],
    # Fine-work metric endmills (BRA-18): real tools, common for fine
    # work — the imperial set bottoms out at 1/16" (1.59 mm), so
    # pockets 1.50-1.80 mm wide (e.g. the Kookabus enclosure) got no
    # plan at all. A 1.0 mm tool fits a 1.50 mm pocket under the fit
    # rule (BRA-22: clearance is half the tool diameter, capped at
    # 0.5 mm — so 1.0 mm needs W >= 1.50, 0.8 mm needs W >= 1.20,
    # 0.5 mm needs W >= 0.75); 0.8 / 0.5 mm cover narrower work.
    # Both lists merge into one candidate set; imperial sizes keep
    # their fractional names, metric sizes are named in mm.
    "standard_endmills_mm": [1.0, 0.8, 0.5],
    # Feeds are conservative wood defaults. If "feed_mm_s" /
    # "plunge_mm_s" are set here they are used as-is; otherwise the
    # feed scales with tool diameter (small tools go slower).
    # stepdown is capped at half the tool diameter.
    "feed_mm_s": None,
    "plunge_mm_s": None,
    "spindle_rpm": 20000,
    "stepdown_mm": 3.0,
    "stepover_pct": 40,
    "tabs": {"enabled": True, "count": 4, "length_mm": 5.0, "thickness_mm": 1.0},
    "max_plans": 3,
    # Tool-size cap (Brandon, 2026-11-21, VCarve V12.5 live test): no
    # endmill bigger than this fraction of the part's smallest
    # footprint dimension. The planner used to recommend the largest
    # tool that fits, which put a 1/2 in endmill on a 46 mm part —
    # far too coarse for the part and for the layout around it.
    # 1/6 caps a 46 mm part at 7.67 mm (1/4 in wins) and leaves a
    # 139 mm panel free to use 1/2 in. Per part, not per job: each
    # layer's tool is capped by its own part's size. The cap never
    # goes below max_endmill_floor_mm (1/4 in): the rule is about
    # keeping oversize tools off small parts, not about forcing
    # tiny tools — without the floor, an 80x20 mm part would be
    # capped at 3.33 mm and the eight_parts job went 9.0 -> 13.5
    # min for no benefit (regression run, Nov 21).
    "max_endmill_ratio": 1.0 / 6.0,
    "max_endmill_floor_mm": 6.35,
    # Rough + finish (BRA-14): a pocket roughed with the largest tool
    # that fits leaves round corners (radius = tool radius). A finish
    # pass with a smaller tool, removing only a thin wall allowance,
    # gets the corners closer to sharp. It is never faster than the
    # single pass (extra tool change), so it is offered as an
    # alternative plan — unless max_corner_radius_mm is set, in which
    # case any pocket the roughing tool would round beyond that radius
    # MUST get a finish pass (plans that cannot achieve it are dropped).
    "finish_corners": True,
    "finish_allowance_mm": 0.5,
    "max_corner_radius_mm": None,
}


def settings(cfg):
    """Merge cfg["toolplan"] over DEFAULTS (shallow + tabs sub-dict)."""
    st = dict(DEFAULTS)
    tp = (cfg or {}).get("toolplan", {}) or {}
    for k, v in tp.items():
        if k == "tabs" and isinstance(v, dict):
            t = dict(st["tabs"])
            t.update(v)
            st["tabs"] = t
        else:
            st[k] = v
    return st


def inch_name(dia_in):
    """0.25 -> '1/4', 0.1875 -> '3/16'."""
    return str(Fraction(dia_in).limit_denominator(16))


def standard_endmill_sizes_mm(st):
    """All standard endmill diameters in mm (BRA-18): the imperial
    set plus the fine-work metric set, merged, deduped, sorted."""
    sizes = {round(i * INCH_TO_MM, 4) for i in st["standard_endmills_in"]}
    sizes.update(round(float(d), 4) for d in st.get("standard_endmills_mm", []))
    return sorted(sizes)


def make_endmill(dia_mm, st):
    dia_in = dia_mm / INCH_TO_MM
    feed = st["feed_mm_s"]
    if feed is None:
        feed = min(30.0, max(8.0, 5.0 * dia_mm))
    plunge = st["plunge_mm_s"]
    if plunge is None:
        plunge = feed / 3.0
    stepdown = min(float(st["stepdown_mm"]), 0.5 * dia_mm)
    # Tool labels use the tool's native designation, compact:
    # an imperial endmill is "1/4in" — not "6.35 mm", not
    # "quarter-inch". Metric fine sizes are named in mm — forcing
    # 1.00 mm through the imperial fraction would mislabel it
    # 1/16" (1.59 mm). (Brandon, Nov 22, post-V1 streamlining: the
    # project works in mm; only the tool label uses the native unit.)
    inch_sizes = {round(i * INCH_TO_MM, 4) for i in st["standard_endmills_in"]}
    if round(dia_mm, 4) in inch_sizes:
        name = f"End Mill {inch_name(dia_in)}in"
    else:
        name = f"End Mill {dia_mm:.2f} mm"
    return {
        "id": f"EM{dia_mm:.2f}",
        "kind": "endmill",
        "dia_mm": round(dia_mm, 4),
        "name": name,
        "feed_mm_s": round(feed, 2),
        "plunge_mm_s": round(plunge, 2),
        "spindle_rpm": int(st["spindle_rpm"]),
        "stepdown_mm": round(stepdown, 3),
        "stepover_mm": round(dia_mm * float(st["stepover_pct"]) / 100.0, 3),
    }


def make_drill(dia_mm, st):
    plunge = st["plunge_mm_s"]
    if plunge is None:
        plunge = min(10.0, max(4.0, 1.5 * dia_mm))
    stepdown = min(float(st["stepdown_mm"]), 0.5 * dia_mm)
    return {
        "id": f"D{dia_mm:.2f}",
        "kind": "drill",
        "dia_mm": round(dia_mm, 4),
        "name": f"Drill {dia_mm:.2f} mm",
        "feed_mm_s": round(plunge, 2),
        "plunge_mm_s": round(plunge, 2),
        "spindle_rpm": int(st["spindle_rpm"]),
        "stepdown_mm": round(stepdown, 3),
        "stepover_mm": 0.0,
        "peck": True,
    }


def _passes(cut_mm, stepdown_mm):
    return max(1, math.ceil(cut_mm / max(stepdown_mm, 0.1)))


# --- V3.14 cut-time feedback: the estimators below model the moves
# the toolpath generator actually emits, not just the cutting volume.
# The acceptance run (docs-v3/acceptance.md §6.1) showed the old
# MRR/perimeter estimates understating generated motion by 2-56%
# per job; the gap is not noise, it is structure the old formulas
# never saw: every peck re-plunges from clearance, every bore is a
# stack of helical descents (plus pillar-clearing helices when the
# hole is wide for the tool), and every profile level plunges from
# clearance once per contour. The model mirrors ts/toolpaths.ts
# move for move (same peck depth, same helix pitch, same clearance
# rule); the only estimated quantities are the horizontal approach
# traverses between contours, which the planner cannot see (no
# contour start points at plan time) — a nominal 10 mm each.
# Pockets keep the MRR model: it is right to ~6% on unfilled
# pockets, and the one large pocket miss (a filled pocket whose runs
# are each traversed twice) needs a classifier flag the planner does
# not have — see docs-v3/cuttime_feedback.md.

RAPID_MM_S = 50.0  # the simulator's rapid rate (ts/view3d/model.ts)
_APPROACH_MM = 10.0  # nominal horizontal traverse per approach rapid


def _clearance_gap_mm(layer, st):
    """Vertical air gap between this layer's part top and clearance:
    the generator's clearance is max part z_top + 5 mm, so the gap
    is 5 mm on a single-part job and (max_z_top + 5) - z_top(part)
    on a multi-part job. Part z_tops reach the planner through
    plan_tools(..., part_z_top={part: z_top}); without them the gap
    defaults to 5 mm (exact for single-part jobs)."""
    zt = (st or {}).get("_part_z_top") or {}
    part = layer.get("part")
    if not zt or part is None or part not in zt:
        return 5.0
    return (max(zt.values()) + 5.0) - float(zt[part])


def _loop_count(layer):
    """Closed contours in this layer (the classifier counts merged
    profile loops in est["loop_count"]; 1 when absent)."""
    try:
        return max(1, int(layer.get("est", {}).get("loop_count", 1)))
    except (TypeError, ValueError):
        return 1


def _is_through_cut(layer):
    return "THROUGH_CUT" in str(layer.get("layer", ""))


def _sorted_centres(layer):
    """Hole centres in the generator's order (sorted by x, then y)."""
    return sorted((c for c in (layer.get("centres") or [])),
                  key=lambda c: (c[0], c[1]))


def _est_drill(layer, tool, st):
    """Peck drill, as generated: the tool pecks by its own diameter
    from the stock top (full depth = start_depth + cut_depth, not
    the cut depth alone), and every peck re-plunges from clearance
    — the feed covers the air gap plus the depth reached by that
    peck — then retracts to clearance. Inter-hole traverses at
    clearance, in the generator's centre order."""
    e = layer.get("est", {})
    centres = _sorted_centres(layer)
    n = len(centres) if centres else int(e.get("hole_count", 1))
    full_depth = float(layer.get("start_depth", 0.0)) + float(e.get("depth_mm", layer["cut_depth"]))
    peck = max(float(tool["dia_mm"]), 0.1)
    n_pecks = max(1, math.ceil(full_depth / peck - 1e-9))
    gap = _clearance_gap_mm(layer, st)
    plunge = max(float(tool["plunge_mm_s"]), 0.1)
    feed_s = 0.0
    rapid_s = 0.0
    for k in range(1, n_pecks + 1):
        depth_k = full_depth if k == n_pecks else k * peck
        feed_s += (gap + depth_k) / plunge
        rapid_s += (gap + depth_k) / RAPID_MM_S
    total = n * (feed_s + rapid_s)
    for a, b in zip(centres, centres[1:]):
        total += math.hypot(b[0] - a[0], b[1] - a[1]) / RAPID_MM_S
    return total


def _est_bore(layer, tool, st):
    """Helical bore, as generated: the tool orbits while descending
    the FULL depth (start_depth + cut_depth — a hole opening on a
    pocket floor helices down through the pocket void, at feed
    rate), pitch = stepdown per revolution, then one full circle at
    the bottom; when the orbit radius exceeds the tool radius the
    central pillar is cleared by further full-depth helices at
    tiled radii. Plus one air feed-down per helix and the rapids
    between holes (generator centre order)."""
    e = layer.get("est", {})
    centres = _sorted_centres(layer)
    n = len(centres) if centres else int(e.get("hole_count", 1))
    dia = float(e.get("hole_dia_mm", layer.get("diameter", 0)))
    full_depth = float(layer.get("start_depth", 0.0)) + float(e.get("depth_mm", layer["cut_depth"]))
    stepdown = max(float(tool["stepdown_mm"]), 0.1)
    revs = max(1, math.ceil(full_depth / stepdown - 1e-9))
    rh = (dia - float(tool["dia_mm"])) / 2.0
    if not (rh > 0.05):
        # No room for a helix: the planner never assigns such a tool
        # (the bore fitting gate requires tool dia <= 0.8 * hole
        # dia), but stay total rather than crash if it ever happens.
        passes = _passes(float(e.get("depth_mm", layer["cut_depth"])), stepdown)
        per_hole = ((math.pi * dia * passes) / max(float(tool["feed_mm_s"]), 0.1)
                    + float(e.get("depth_mm", layer["cut_depth"])) / max(float(tool["plunge_mm_s"]), 0.1) + 0.5)
        return n * per_hole
    tool_r = float(tool["dia_mm"]) / 2.0
    radii = [rh]
    if rh > tool_r:
        pillar_r = rh - tool_r
        step = float(tool["dia_mm"]) * 0.8
        k_max = max(0, math.ceil((pillar_r - 2 * tool_r) / step - 1e-9))
        radii += [tool_r + k * step for k in range(k_max + 1)]
    feed = max(float(tool["feed_mm_s"]), 0.1)
    plunge = max(float(tool["plunge_mm_s"]), 0.1)
    gap = _clearance_gap_mm(layer, st)
    # one full circle per revolution plus the bottom circle, per helix
    arc_s = sum((revs + 1) * 2 * math.pi * r / feed for r in radii)
    # each helix is entered from clearance: an air feed-down at plunge
    entry_s = len(radii) * gap / plunge
    # traverses between successive helix radii inside one hole
    traverse_s = sum(abs(radii[i + 1] - radii[i])
                     for i in range(len(radii) - 1)) / RAPID_MM_S
    # final retract, from the hole bottom back to clearance
    retract_s = (gap + full_depth) / RAPID_MM_S
    total = n * (arc_s + entry_s + traverse_s + retract_s)
    for a, b in zip(centres, centres[1:]):
        total += math.hypot(b[0] - a[0], b[1] - a[1]) / RAPID_MM_S
    return total


def _est_pocket(layer, tool, st, area=None):
    e = layer.get("est", {})
    if area is None:
        area = float(e.get("area_mm2", 0))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    mrr = tool["feed_mm_s"] * tool["stepover_mm"] * tool["stepdown_mm"]
    passes = _passes(depth, tool["stepdown_mm"])
    return (area * depth) / max(mrr, 0.01) + 1.0 * passes


def _est_profile(layer, tool, st):
    """Profile, as generated: one contour traversal per level per
    closed loop, plus — the part the old formula never saw — an
    entry plunge from clearance at every level (the tool retracts
    to clearance between contours and levels, then feeds down to
    the previous level) and the rapids that go with it, the level-0
    lead-in ramp on outer profiles (through-cuts ramp along the
    slot itself, so no extra length there), and the tabbed bottom
    traversal when the layer takes tabs."""
    e = layer.get("est", {})
    perim = float(e.get("perimeter_mm", 0))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    feed = max(float(tool["feed_mm_s"]), 0.1)
    plunge = max(float(tool["plunge_mm_s"]), 0.1)
    stepdown = max(float(tool["stepdown_mm"]), 0.1)
    gap = _clearance_gap_mm(layer, st)
    contours = _loop_count(layer)
    tabs = tabs_for_layer(layer, st)
    use_tabs = tabs is not None and float(tabs["thickness_mm"]) < depth
    tab_thick = float(tabs["thickness_mm"]) if use_tabs else 0.0
    levels = _passes(depth - tab_thick, stepdown) if use_tabs else _passes(depth, stepdown)
    # the contour the generator cuts is the loop offset outward by
    # the tool radius (outer profiles only — through-cuts are
    # centred), and an outward offset grows a closed loop's
    # perimeter by 2*pi*toolR (Steiner) whatever its shape
    contour_perim = perim if _is_through_cut(layer) else perim + 2 * math.pi * (float(tool["dia_mm"]) / 2.0)
    # one contour traversal per level per loop (the old term, kept)
    total = (contour_perim * levels) / feed
    # entry plunges: level 0 feeds to zTop + 0.5, later levels to
    # the previous level (gap + li * stepdown of plunge-rate feed)
    plunge_s = (gap - 0.5) / plunge
    for li in range(1, levels):
        plunge_s += (gap + li * stepdown) / plunge
    total += contours * plunge_s
    # rapids: per level, one vertical retract per loop (the
    # inter-loop retracts plus the final one) and one horizontal
    # approach per loop (nominal — the planner cannot see where
    # the loops start)
    for li in range(levels):
        level_depth = min((li + 1) * stepdown, depth - tab_thick)
        total += contours * (gap + level_depth) / RAPID_MM_S
        total += contours * _APPROACH_MM / RAPID_MM_S
    # level-0 lead-in ramp on outer profiles (from outside the part
    # to the contour start; through-cuts ramp along the slot)
    if not _is_through_cut(layer):
        total += contours * max(2 * float(tool["dia_mm"]), 10.0) / feed
    # tabbed bottom traversal: one more full contour, the lifts
    # over the tab spans, and a reposition per loop (none when the
    # layer is a single loop — the tool already ends at its start)
    if use_tabs:
        total += contour_perim / feed
        total += 2 * int(tabs["count"]) * tab_thick / plunge
        if contours > 1:
            total += contours * ((gap + depth) / RAPID_MM_S
                                 + _APPROACH_MM / RAPID_MM_S
                                 + (gap + depth) / plunge)
    return total


def _est_finish(layer, tool, st):
    """A finish pass removes only the thin wall allowance left by the
    rough pass: it is a profile-like cut around the pocket perimeter
    (plus the corner crescents the rough tool could not reach), not
    an area clear — so it is priced like a profile, not a pocket.
    As generated it is one helical descent over the full contour
    plus one planar revolution at the bottom (two contour
    traversals, not one per stepdown as the old formula charged),
    entered from clearance once per loop."""
    e = layer.get("est", {})
    perim = float(e.get("perimeter_mm", 0))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    feed = max(float(tool["feed_mm_s"]), 0.1)
    plunge = max(float(tool["plunge_mm_s"]), 0.1)
    gap = _clearance_gap_mm(layer, st)
    contours = _loop_count(layer)
    # the finish contour is the wall contour: the loop offset by
    # exactly the tool radius — outward for an outer profile
    # (+2*pi*toolR), inward for a pocket wall (-2*pi*toolR),
    # centred for a through-cut
    tool_r = float(tool["dia_mm"]) / 2.0
    if layer.get("operation") == "pocket":
        contour_perim = perim - 2 * math.pi * tool_r
    elif _is_through_cut(layer):
        contour_perim = perim
    else:
        contour_perim = perim + 2 * math.pi * tool_r
    total = 2 * contour_perim / feed
    total += contours * gap / plunge  # air feed-down per loop
    # approach rapids: the first from clearance (horizontal), later
    # ones from the previous loop's bottom (diagonal, mostly vertical)
    total += _APPROACH_MM / RAPID_MM_S
    total += (contours - 1) * (gap + depth + _APPROACH_MM) / RAPID_MM_S
    return total


OP_RANK = {"drill": 0, "pocket": 1, "profile": 2}


def order_entries(entries, tool_key):
    """Dependency-aware cut order (BRA-14).

    entries: dicts with "layer" (name), "operation", optional
    "depends_on" (a layer NAME — the entry depends on that layer being
    fully cut) and optional "depends_on_entry" (an index into entries
    — a finish pass depends on its own rough pass). A layer name
    resolves to its LAST entry: the layer is done when its last pass
    finishes. A dependency on a layer that is not in this plan (e.g.
    --only filtered the facing pocket out) is reported, not fatal.
    Order: dependencies first, then tool-grouped (BRA-15) — continue
    with the current tool when possible, else start with the tool
    that has the most work available — so tool changes are minimised.
    Profiles are ALWAYS last: after the profile cut the part hangs
    on its tabs, so nothing may follow it — this is an invariant,
    not a preference.
    Returns (ordered_entries, warnings)."""
    n = len(entries)
    last_idx = {}
    for i, e in enumerate(entries):
        last_idx[e["layer"]] = i
    deps = [set() for _ in range(n)]
    warnings = []
    for i, e in enumerate(entries):
        d = e.get("depends_on")
        if d:
            if d in last_idx and last_idx[d] != i:
                deps[i].add(last_idx[d])
            elif d not in last_idx:
                warnings.append(
                    f"{e['layer']} depends on {d}, which is not in this plan "
                    f"(facing cut missing — run without --only?)")
        j = e.get("depends_on_entry")
        if j is not None and 0 <= j < n and j != i:
            deps[i].add(j)
    indeg = [len(deps[i]) for i in range(n)]
    dependents = [[] for _ in range(n)]
    for i in range(n):
        for d in deps[i]:
            dependents[d].append(i)

    def _key(i):
        e = entries[i]
        return (1 if e["operation"] == "profile" else 0,
                OP_RANK.get(e["operation"], 99), tool_key(e), i)

    def _pick(pool):
        # Tool-grouped pick (BRA-15): continue with the last tool when
        # possible (free — no change). Otherwise pick a tool that can
        # finish all its non-profile work right now — starting a tool
        # that still has locked work strands it and forces an extra
        # switch later (the real container's surface drill depends on
        # a pocket, so the drill must not go first). Among tools that
        # can finish, take the smallest available group first: the big
        # group usually holds the profile tool and runs last, absorbing
        # the profiles (a drill-first order on the test part is 1
        # change; pockets-first is 2). If no tool can finish now, make
        # progress on the tool with the most work available. Within a
        # tool: (operation rank, tool, index). Profiles are excluded
        # from the pool by the caller until nothing else remains.
        if last_tool is not None:
            same = [i for i in pool if tool_key(entries[i]) == last_tool]
            if same:
                return min(same, key=lambda i: (OP_RANK.get(entries[i]["operation"], 99), tool_key(entries[i]), i))
        if entries[pool[0]]["operation"] == "profile":
            return min(pool, key=lambda i: (OP_RANK.get(entries[i]["operation"], 99), tool_key(entries[i]), i))
        by_tool = {}
        for i in pool:
            by_tool.setdefault(tool_key(entries[i]), []).append(i)
        pool_set = set(pool)

        def _can_finish(tk):
            # Every remaining non-profile node of this tool is
            # available now (profiles excluded — always last).
            for j, e in enumerate(entries):
                if placed[j] or e["operation"] == "profile":
                    continue
                if tool_key(e) == tk and j not in pool_set:
                    return False
            return True

        finishable = [tk for tk in by_tool if _can_finish(tk)]
        if finishable:
            best = min(finishable, key=lambda tk: (len(by_tool[tk]), tk))
        else:
            best = min(by_tool.items(), key=lambda kv: (-len(kv[1]), kv[0]))[0]
        return min(by_tool[best],
                   key=lambda i: (OP_RANK.get(entries[i]["operation"], 99), tool_key(entries[i]), i))

    ordered = []
    placed = [False] * n
    last_tool = None
    while len(ordered) < n:
        avail = [i for i in range(n) if not placed[i] and indeg[i] == 0]
        if not avail:
            break
        nonprof = [i for i in avail if entries[i]["operation"] != "profile"]
        pool = nonprof if nonprof else avail
        i = _pick(pool)
        ordered.append(entries[i])
        placed[i] = True
        last_tool = tool_key(entries[i])
        for j in dependents[i]:
            indeg[j] -= 1
    if len(ordered) < n:
        warnings.append("dependency cycle in cut order — fell back to key order")
        rest = [entries[i] for i in range(n) if not placed[i]]
        ordered.extend(sorted(rest, key=lambda e: _key(entries.index(e))))
    # Profile-last invariant, enforced even if the sort ever slips.
    # (Nothing depends on a profile — dependencies only point at
    # facing/parent pockets and rough passes — so this cannot break
    # a dependency.)
    prof = [e for e in ordered if e["operation"] == "profile"]
    rest = [e for e in ordered if e["operation"] != "profile"]
    return rest + prof, warnings


def _finish_variant(entries, em_set, em_tools, st):
    """Two-pass variant of an assigned entry list (BRA-14): every
    pocket whose corners the roughing tool would round beyond their
    design radius gets a rough pass (with a wall allowance) plus a
    finish pass with the smallest smaller endmill in the set.
    Returns the new entry list, or None if no pocket benefits or no
    finish tool exists in the set."""
    allow = float(st.get("finish_allowance_mm", 0.5))
    out = []
    any_finish = False
    for e in entries:
        if e["operation"] != "pocket":
            out.append(e)
            continue
        L = e["_L"]
        corner = L.get("est", {}).get("corner_radius_mm")
        rough_r = e["tool"]["dia_mm"] / 2.0
        if corner is None or corner >= rough_r:
            out.append(e)  # round pocket, or the rough tool already fits the corner
            continue
        smaller = [d for d in sorted(em_set) if d < e["tool"]["dia_mm"]]
        if not smaller:
            return None  # set has no smaller tool to finish with
        ftool = em_tools[smaller[0]]
        # Rough: same tool, but it leaves `allow` mm on the walls.
        area = float(L.get("est", {}).get("area_mm2", 0))
        perim = float(L.get("est", {}).get("perimeter_mm", 0))
        rough = dict(e)
        rough["kind"] = "rough"
        rough["allowance_mm"] = allow
        rough["note"] = (f"rough, {allow:g} mm wall allowance "
                         f"(corners left R{rough_r:.2f} mm)")
        rough["seconds"] = _est_pocket(L, e["tool"], st,
                                       area=max(0.0, area - perim * allow))
        out.append(rough)
        finish = dict(e)
        finish["tool"] = ftool
        finish["tool_id"] = ftool["id"]
        finish["kind"] = "finish"
        finish["allowance_mm"] = 0.0
        finish["note"] = (f"finish pass — corners to R{ftool['dia_mm'] / 2:.2f} mm")
        finish["seconds"] = _est_finish(L, ftool, st)
        finish["depends_on_entry"] = len(out) - 1  # after its rough pass
        finish["depends_on"] = None
        out.append(finish)
        any_finish = True
    return out if any_finish else None


def _corner_gate_ok(entries, max_corner):
    """Every pocket whose corners the FINAL tool would round beyond
    max_corner_radius_mm fails the gate. The design corner radius is
    not gated (a round pocket's radius is the design, not a tool
    artefact) — only the tool-imposed radius counts."""
    by_layer = {}
    for e in entries:
        if e["operation"] == "pocket":
            by_layer.setdefault(e["layer"], []).append(e)
    for name, es in by_layer.items():
        corner = es[0]["_L"].get("est", {}).get("corner_radius_mm")
        if corner is None:
            continue
        final_r = min(e["tool"]["dia_mm"] / 2.0 for e in es)
        if final_r > corner and final_r > max_corner:
            return False
    return True


def _is_outer_profile(layer):
    return layer["layer"] == "PROFILE_THRU" or layer["layer"].endswith("__PROFILE_THRU")


def tabs_for_layer(layer, st):
    """Tabs for EVERY profile layer, not just the outer one.
    A profile cut is a closed loop, and whatever is inside the loop
    is a separate piece when the cut finishes: the part itself on
    the outer profile, a slug on a through cut (a doughnut hole is
    the clear case — its centre is a solid disc, not sawdust, and it
    goes flying without tabs). Drilled/bored holes need no tabs —
    the material leaves as chips. Through-cut slots are closed loops
    too (an open slot would be part of the outer wire), so they get
    tabs as well.
    Count scales with perimeter: a small slug does not need (or fit)
    4 tabs; config count is the maximum."""
    t = st["tabs"]
    if not t.get("enabled", True):
        return None
    if layer["operation"] != "profile":
        return None
    e = layer.get("est", {})
    perim = float(e.get("perimeter_mm", 0))
    length = float(t.get("length_mm", 5.0))
    if perim > 0:
        # A tab must be a small fraction of the profile, not longer
        # than the part itself. Floor at 2 mm so it still holds.
        length = min(length, max(2.0, perim / 10.0))
    count = int(t.get("count", 4))
    if perim > 0:
        count = min(count, 2 if perim < 80 else 3 if perim < 150 else 4)
    return {"count": count, "length_mm": round(length, 2),
            "thickness_mm": float(t.get("thickness_mm", 1.0))}


def _tool_cap_mm(layer, part_min_dim, st):
    """Largest endmill this layer's part allows (Brandon Nov 21):
    max_endmill_ratio of the part's smallest footprint dimension.
    part_min_dim is a float (one part) or {part_prefix: min_dim};
    layers in a merged job carry "part". None when the part size
    is unknown — then there is no cap. The cap never goes below
    max_endmill_floor_mm (1/4 in)."""
    ratio = st.get("max_endmill_ratio")
    if ratio is None:
        return None
    if isinstance(part_min_dim, dict):
        dim = part_min_dim.get((layer or {}).get("part"))
    else:
        dim = part_min_dim
    if dim is None:
        return None
    floor = st.get("max_endmill_floor_mm")
    cap = float(dim) * float(ratio)
    if floor is not None:
        cap = max(cap, float(floor))
    return cap


def _fits(tool_dia, min_width_mm):
    """An endmill needs clearance to move inside a pocket/slot.
    BRA-22: the clearance is proportional to the tool — half its
    diameter — capped at the old flat 0.5 mm. A tiny tool needs
    less absolute room to move (chip load / deflection scale with
    the tool), and the cap keeps every tool >= 1.0 mm behaving
    exactly as under the flat rule, so no existing plan for
    standard-size tools can change. Only the metric fine endmills
    gain room: 0.50 mm fits W >= 0.75 mm (the 0.913 mm Kookabus
    groove fits, margin 0.163 mm — under the flat rule it needed
    a <= 0.41 mm tool, which does not exist in the set), 0.80 mm
    fits W >= 1.20 mm."""
    return tool_dia <= min_width_mm - min(0.5, 0.5 * tool_dia)


def profile_tool_diameter(layers, cfg=None, part_min_dim=None):
    """The profile-cutting endmill diameter for one part (BRA-16
    spacing rule): the largest standard endmill that cuts the
    part's profile / through-cut layers, by the same fit rule the
    planner uses — an outer profile takes the largest in the set,
    a through-cut slot takes the largest that fits the slot. The
    kerf eats one diameter outside the outline, so this is the
    number the layout spaces by (gap = D_A + D_B + web_min).
    Returns the diameter in mm, or None when the part has no
    profile layers (e.g. --only filtered them out) or no standard
    tool fits a through-cut slot — then the packer falls back to
    gap_mm and the tool plan reports the missing tool (BRA-18).
    The tool-size cap applies here too (same rule as plan_tools)."""
    st = settings(cfg)
    em_sizes = standard_endmill_sizes_mm(st)
    best = None
    for L in layers:
        if L["operation"] != "profile":
            continue
        cap = _tool_cap_mm(L, part_min_dim, st)
        if _is_outer_profile(L):
            fitting = em_sizes
        else:  # through-cut slot: the tool must fit the slot
            mw = float(L.get("est", {}).get("min_width_mm", 0))
            fitting = [d for d in em_sizes if _fits(d, mw)]
        if cap is not None:
            fitting = [d for d in fitting if d <= cap + 1e-9]
        if not fitting:
            return None
        d = max(fitting)
        best = d if best is None else max(best, d)
    return best


def plan_profile_tools(plan):
    """Per-part profile endmill diameters from a CHOSEN merged plan
    (BRA-20): {part_prefix: max profile tool dia in mm}. The plan's
    layers carry prefixed names (P01_...__PROFILE_THRU), so the part
    is the text before the first "__". A part with no profile layers
    in the plan gets no entry (the packer treats it as None — no
    kerf, gap_mm floor only). This is what the layout spaces by
    after BRA-20: the tool that actually cuts, not the fit-rule
    maximum (profile_tool_diameter), which bounds every plan from
    above and reserves wider gaps than the chosen plan needs."""
    tools = {t["id"]: t for t in plan["tools"]}
    per_part = {}
    for e in plan["layers"]:
        if e["operation"] != "profile":
            continue
        part = e["layer"].split("__", 1)[0]
        d = float(tools[e["tool_id"]]["dia_mm"])
        per_part[part] = max(per_part.get(part, 0.0), d)
    return per_part


def plan_tools(layers, cfg=None, part_min_dim=None, part_z_top=None):
    """Rank tool-set plans for these layers. Returns
    {"plans": [best, ...up to max_plans], "error": None} or
    {"plans": [], "error": "..."} when no standard tool can cut a layer.
    part_min_dim is the smallest footprint dimension per part (float
    for one part, {prefix: min_dim} for a merged job) — each layer's
    endmill is capped at max_endmill_ratio of its own part's size.
    part_z_top is {prefix: z_top} for a merged job (V3.14): the
    estimators need each part's top to get the clearance air gap
    right (clearance is max z_top + 5 mm). Single-part callers omit
    it and the gap defaults to 5 mm, which is exact there."""
    st = settings(cfg)
    if part_z_top:
        st["_part_z_top"] = dict(part_z_top)
    layers = [L for L in layers]
    if not layers:
        return {"plans": [], "error": "no layers to plan"}

    em_sizes = standard_endmill_sizes_mm(st)
    em_tools = {d: make_endmill(d, st) for d in em_sizes}
    hole_dias = sorted({round(float(L["est"]["hole_dia_mm"]), 3)
                        for L in layers
                        if L["operation"] == "drill" and L.get("est", {}).get("hole_dia_mm")})
    drill_tools = {d: make_drill(d, st) for d in hole_dias}

    has_cutting = any(L["operation"] in ("pocket", "profile") for L in layers)
    # Endmill subsets of size 0..2 (0 only valid when nothing needs one).
    em_sets = []
    for r in (0, 1, 2):
        for combo in itertools.combinations(sorted(em_sizes, reverse=True), r):
            if r == 0 and has_cutting:
                continue
            em_sets.append(set(combo))
    # Per hole diameter: drill it, or bore it. Cap the combinations.
    if len(hole_dias) > 4:
        drill_modes = [set(hole_dias), set()]
    else:
        drill_modes = []
        for r in range(len(hole_dias) + 1):
            for combo in itertools.combinations(hole_dias, r):
                drill_modes.append(set(combo))

    max_corner = st.get("max_corner_radius_mm")
    want_finish = bool(st.get("finish_corners", True))
    candidates = []
    cap_blocked = []  # layers the tool-size cap alone ruled out
    for em_set in em_sets:
        for drill_set in drill_modes:
            assigned = []  # entry dicts (layer, tool, kind, note, seconds, ...)
            ok = True
            for L in layers:
                op = L["operation"]
                e = L.get("est", {})

                def _entry(tool, kind, note, seconds):
                    return {"layer": L["layer"], "operation": op,
                            "tool": tool, "tool_id": tool["id"],
                            "kind": kind, "note": note, "seconds": seconds,
                            "allowance_mm": 0.0,
                            "depends_on": L.get("depends_on"),
                            "depends_on_entry": None, "_L": L}

                if op == "drill":
                    dia = float(e.get("hole_dia_mm", L.get("diameter", 0)))
                    if dia in drill_set:
                        tool = drill_tools[dia]
                        assigned.append(_entry(tool, "drill", "drill",
                                               _est_drill(L, tool, st)))
                    else:
                        # Bore with the largest endmill in the set that
                        # fits inside the hole (needs room to orbit).
                        fitting = [d for d in sorted(em_set, reverse=True)
                                   if d <= 0.8 * dia]
                        cap = _tool_cap_mm(L, part_min_dim, st)
                        if cap is not None:
                            capped = [d for d in fitting if d <= cap + 1e-9]
                            if not capped and fitting:
                                cap_blocked.append(L["layer"])
                            fitting = capped
                        if not fitting:
                            ok = False
                            break
                        tool = em_tools[fitting[0]]
                        assigned.append(_entry(
                            tool, "bore",
                            f"bore with {tool['name']} (no drill in this plan)",
                            _est_bore(L, tool, st)))
                elif op == "pocket":
                    mw = float(e.get("min_width_mm", 0))
                    fitting = [d for d in sorted(em_set, reverse=True) if _fits(d, mw)]
                    cap = _tool_cap_mm(L, part_min_dim, st)
                    if cap is not None:
                        capped = [d for d in fitting if d <= cap + 1e-9]
                        if not capped and fitting:
                            cap_blocked.append(L["layer"])
                        fitting = capped
                    if not fitting:
                        ok = False
                        break
                    tool = em_tools[fitting[0]]
                    assigned.append(_entry(tool, "endmill", "largest endmill that fits",
                                           _est_pocket(L, tool, st)))
                elif op == "profile":
                    if _is_outer_profile(L):
                        fitting = sorted(em_set, reverse=True)
                    else:  # through-cut slot: the tool must fit the slot
                        mw = float(e.get("min_width_mm", 0))
                        fitting = [d for d in sorted(em_set, reverse=True) if _fits(d, mw)]
                    cap = _tool_cap_mm(L, part_min_dim, st)
                    if cap is not None:
                        capped = [d for d in fitting if d <= cap + 1e-9]
                        if not capped and fitting:
                            cap_blocked.append(L["layer"])
                        fitting = capped
                    if not fitting:
                        ok = False
                        break
                    tool = em_tools[fitting[0]]
                    assigned.append(_entry(tool, "endmill", "largest endmill that fits",
                                           _est_profile(L, tool, st)))
                else:
                    ok = False
                    break
            if not ok:
                continue
            variants = [("single", assigned)]
            if want_finish:
                fin = _finish_variant(assigned, em_set, em_tools, st)
                if fin is not None:
                    variants.append(("finish", fin))
            for variant, entries in variants:
                if max_corner is not None and not _corner_gate_ok(entries, max_corner):
                    continue
                ordered, dep_warnings = order_entries(entries, lambda e: e["tool_id"])
                cutting = sum(e["seconds"] for e in ordered)
                changes = 0
                prev = None
                tools_in_order = []
                for e in ordered:
                    tool = e["tool"]
                    if tool["id"] not in [t["id"] for t in tools_in_order]:
                        tools_in_order.append(tool)
                    if prev is not None and tool["id"] != prev:
                        changes += 1
                    prev = tool["id"]
                total = cutting + changes * float(st["tool_change_seconds"])
                candidates.append({
                    "variant": variant,
                    "finish_pockets": sum(1 for e in ordered if e["kind"] == "finish"),
                    "dependency_warnings": dep_warnings,
                    "total_seconds": round(total, 1),
                    "cutting_seconds": round(cutting, 1),
                    "tool_changes": changes,
                    "change_seconds": round(changes * float(st["tool_change_seconds"]), 1),
                    "tools": [dict(t, tool_number=i + 1)
                              for i, t in enumerate(tools_in_order)],
                    "layers": [{"layer": e["layer"], "operation": e["operation"],
                                "tool_id": e["tool_id"], "kind": e["kind"], "note": e["note"],
                                "seconds": round(e["seconds"], 1),
                                "allowance_mm": e.get("allowance_mm", 0.0),
                                "tabs": tabs_for_layer(e["_L"], st)} for e in ordered],
                })
    if not candidates:
        bad = []
        if cap_blocked:
            ratio = st.get("max_endmill_ratio")
            bad.append(f"tool cap (no endmill over {ratio:.3g} x the part's "
                       f"smallest side) blocks a tool for: "
                       + ", ".join(sorted(set(cap_blocked))))
        for L in layers:
            if L["operation"] == "pocket":
                mw = float(L.get("est", {}).get("min_width_mm", 0))
                if not any(_fits(d, mw) for d in em_sizes):
                    bad.append(f"{L['layer']} (pocket only {mw:.2f} mm wide — "
                               f"smallest standard endmill is {min(em_sizes):.2f} mm)")
            if L["operation"] == "profile" and not _is_outer_profile(L):
                mw = float(L.get("est", {}).get("min_width_mm", 0))
                if not any(_fits(d, mw) for d in em_sizes):
                    bad.append(f"{L['layer']} (slot only {mw:.2f} mm wide)")
        return {"plans": [], "error": "no standard tool fits: " + "; ".join(bad)
                if bad else "no valid tool plan for these layers"}
    # Dedupe by (tool complement, variant), keep the fastest of each;
    # rank by total. A two-pass plan is never the fastest (extra tool
    # change), so without the guarantee below it would be crowded out
    # by single-pass plans — but it is the plan that buys sharp
    # corners, so the fastest finish variant is always visible.
    by_tools = {}
    for c in candidates:
        key = (tuple(sorted(t["id"] for t in c["tools"])), c["variant"])
        if key not in by_tools or c["total_seconds"] < by_tools[key]["total_seconds"]:
            by_tools[key] = c
    ranked = sorted(by_tools.values(), key=lambda c: c["total_seconds"])
    plans = []
    for i, c in enumerate(ranked[: int(st["max_plans"])]):
        c = dict(c)
        c["id"] = chr(ord("A") + i)
        plans.append(c)
    if plans and not any(p["variant"] == "finish" for p in plans):
        fin = [c for c in ranked if c["variant"] == "finish"]
        if fin:
            c = dict(fin[0])
            c["id"] = chr(ord("A") + len(plans))
            plans.append(c)
    return {"plans": plans, "error": None}


def choose_plan(plans, wanted_id=None):
    if not plans:
        return None
    if wanted_id:
        for p in plans:
            if p["id"] == wanted_id.upper():
                return p
    return plans[0]


def post_steps_from_flags(flags):
    """Post-processing steps for manifest.txt, from the POST-PROCESS
    flags: "[PART] POST-PROCESS [method]: <detail> — <step>". Groups
    identical (method, step) pairs across parts, so the same roundover
    on two parts is one line with both parts listed. Returns a list
    of "# post: [method] step (parts)" lines, in first-seen order."""
    grouped = {}
    order = []
    for f in flags or []:
        if "POST-PROCESS [" not in f:
            continue
        part = ""
        if f.startswith("["):
            part = f[1:f.index("]")]
        rest = f.split("POST-PROCESS [", 1)[1]
        method, _, detail = rest.partition("]: ")
        step = detail.split(" — ", 1)[1] if " — " in detail else detail
        step = step.strip()
        if not step:
            continue
        key = (method, step)
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        if part and part not in grouped[key]:
            grouped[key].append(part)
    lines = []
    for method, step in order:
        parts = grouped[(method, step)]
        suffix = f" ({', '.join(parts)})" if parts else ""
        lines.append(f"# post: [{method}] {step}{suffix}")
    return lines


def manifest_txt(plan, layers, dxf_name, st=None, flags=None):
    """manifest.txt v2: # tool / # tabs / # plan comment lines, then
    layer|operation|start|cut|part|tool_id|allowance|kind per layer,
    in cut order. Old gadgets ignore the extra fields (they read
    fields 1-4; v0.3 reads field 6). Field 7 is the wall allowance
    in mm (rough passes), field 8 the pass kind (rough/finish — the
    gadget names the two toolpaths on one layer differently).
    Tabs ride on `# tabs: <layer>|<count>|<length_mm>|<thickness_mm>`
    lines, one per tabbed profile layer. Post-processing steps ride
    on `# post: [method] step (parts)` lines, one per unique step —
    the gadget lists them in its final dialog so the operator knows
    what to do after the CNC cut (e.g. round over the outer edge
    on the router table)."""
    st = st or settings({})
    by_name = {L["layer"]: L for L in layers}
    lines = [f"# dxf: {dxf_name}"]
    mins = plan["total_seconds"] / 60.0
    lines.append(f"# plan: {plan['id']} — {len(plan['tools'])} tool(s), "
                 f"{plan['tool_changes']} change(s), est {mins:.1f} min "
                 f"(cutting {plan['cutting_seconds'] / 60.0:.1f} + "
                 f"changes {plan['change_seconds'] / 60.0:.1f})")
    for t in plan["tools"]:
        lines.append(f"# tool: {t['id']}|{t['kind']}|{t['dia_mm']:.4f}|{t['tool_number']}|"
                     f"{t['feed_mm_s']}|{t['plunge_mm_s']}|{t['spindle_rpm']}|"
                     f"{t['stepdown_mm']}|{t['stepover_mm']}")
    for entry in plan["layers"]:
        L = by_name[entry["layer"]]
        tabs = entry.get("tabs") or tabs_for_layer(L, st)
        if tabs:
            lines.append(f"# tabs: {L['layer']}|{tabs['count']}|"
                         f"{tabs['length_mm']}|{tabs['thickness_mm']}")
    lines.extend(post_steps_from_flags(flags))
    for entry in plan["layers"]:
        L = by_name[entry["layer"]]
        part = L.get("part", "")
        lines.append(f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|"
                     f"{L['cut_depth']:.3f}|{part}|{entry['tool_id']}|"
                     f"{entry.get('allowance_mm', 0.0)}|{entry.get('kind', '')}")
    return "\n".join(lines) + "\n"


def format_tool_plan_report(tool_plan):
    """Markdown lines for report.md: chosen plan, tools, order,
    and the fallback plans with their time cost."""
    out = []
    plans = tool_plan.get("plans", [])
    if not plans:
        out.append(f"Tool plan: none — {tool_plan.get('error', 'no plan')}")
        return out
    chosen = plans[0]
    variant_note = ""
    if chosen.get("variant") == "finish":
        variant_note = (f" — two-pass finish on {chosen.get('finish_pockets', 0)} "
                        f"pocket(s) (rough with wall allowance + finish pass)")
    out.append(f"Tool plan {chosen['id']} (chosen, fastest estimate): "
               f"{len(chosen['tools'])} tool(s), {chosen['tool_changes']} manual "
               f"change(s), est {chosen['total_seconds'] / 60:.1f} min total "
               f"(cutting {chosen['cutting_seconds'] / 60:.1f} + changes "
               f"{chosen['change_seconds'] / 60:.1f}). Times are estimates, not promises."
               f"{variant_note}")
    for w in chosen.get("dependency_warnings", []):
        out.append(f"Cut-order warning: {w}")
    for t in chosen["tools"]:
        out.append(f"- T{t['tool_number']}: {t['name']} — feed {t['feed_mm_s']} mm/s, "
                   f"plunge {t['plunge_mm_s']} mm/s, {t['spindle_rpm']} rpm, "
                   f"stepdown {t['stepdown_mm']} mm"
                   + (f", stepover {t['stepover_mm']} mm" if t["kind"] == "endmill" else ", peck drilling"))
    out.append("Cut order (tool changes marked):")
    prev = None
    for e in chosen["layers"]:
        if prev is not None and e["tool_id"] != prev:
            t = next(t for t in chosen["tools"] if t["id"] == e["tool_id"])
            out.append(f"  — change to T{t['tool_number']} ({t['name']}) —")
        tabs = e.get("tabs")
        tabs_txt = (f" — tabs x{tabs['count']} "
                    f"({tabs['length_mm']} x {tabs['thickness_mm']} mm)"
                    if tabs else "")
        out.append(f"- {e['layer']} ({e['operation']}, {e['kind']}): "
                   f"est {e['seconds']:.0f} s — {e['note']}{tabs_txt}")
        prev = e["tool_id"]
    if len(plans) > 1:
        out.append("Fallback plans (same DXF, run manifest_plan_<id>.txt instead):")
        for p in plans[1:]:
            tools = ", ".join(f"T{t['tool_number']} {t['name']}" for t in p["tools"])
            variant_txt = " (two-pass finish — sharper pocket corners)" \
                if p.get("variant") == "finish" else ""
            out.append(f"- Plan {p['id']}{variant_txt}: {len(p['tools'])} tool(s), {p['tool_changes']} change(s), "
                       f"est {p['total_seconds'] / 60:.1f} min — {tools}")
    out.append("Review the tools against your VCarve library before cutting — "
               "the gadget asks you to pick each one from the library, or "
               "uses the recommendation above if you cancel.")
    return out
