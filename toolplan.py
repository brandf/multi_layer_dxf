#!/usr/bin/env python3
"""
Tool planning for onshape-vcarve-2.5d (BRA-12, built 2026-11-08).

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
    candidates are imperial sizes, and the manifest holds MORE THAN
    ONE plan: Plan A (fastest), Plan B/C (fallbacks — e.g. the 1/2"
    endmill is missing, so do it all with the 1/4"). Each plan is
    writable as its own manifest_<id>.txt; the gadget runs whichever
    file you pick.
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
      pocket:  {"area_mm2", "min_width_mm", "depth_mm"}
      profile: {"perimeter_mm", "min_width_mm" (slots only), "depth_mm"}
  - A plan is a TOOL SET: a set of endmills (0-2 sizes) plus, per
    distinct hole diameter, "drill it" or "bore it with an endmill".
    Per layer the tool is then forced (largest fitting endmill in the
    set, exact drill, or largest endmill that fits the hole for a
    bore). Enumerating tool sets (<= 22 sets x <= 4 drill modes) is
    cheap and exact — no per-layer combinatorial search.
  - Cutting time is an MRR estimate (volume / (feed*stepover*stepdown)
    for pockets, length*passes/feed for profiles, plunge+peck for
    drills). Estimates are labelled as such everywhere they appear.
  - Cut order is drill -> pocket -> profile (hard: the profile frees
    the part, so it is last), grouped by tool inside each operation
    so tool changes are minimised. Tool numbers are assigned in
    first-use order — this fixes the v0.2 gadget bug where every
    toolpath was Tool 1 and the posted code called no tool change.

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


def make_endmill(dia_mm, st):
    dia_in = dia_mm / INCH_TO_MM
    feed = st["feed_mm_s"]
    if feed is None:
        feed = min(30.0, max(8.0, 5.0 * dia_mm))
    plunge = st["plunge_mm_s"]
    if plunge is None:
        plunge = feed / 3.0
    stepdown = min(float(st["stepdown_mm"]), 0.5 * dia_mm)
    return {
        "id": f"EM{dia_mm:.2f}",
        "kind": "endmill",
        "dia_mm": round(dia_mm, 4),
        "name": f"End Mill {inch_name(dia_in)} in ({dia_mm:.2f} mm)",
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


def _est_drill(layer, tool, st):
    e = layer.get("est", {})
    n = int(e.get("hole_count", 1))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    pecks = _passes(depth, tool["stepdown_mm"])
    per_hole = depth / max(tool["plunge_mm_s"], 0.1) + 0.75 * (pecks - 1) + 0.5
    return n * per_hole


def _est_bore(layer, tool, st):
    e = layer.get("est", {})
    n = int(e.get("hole_count", 1))
    dia = float(e.get("hole_dia_mm", layer.get("diameter", 0)))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    passes = _passes(depth, tool["stepdown_mm"])
    per_hole = (math.pi * dia * passes) / max(tool["feed_mm_s"], 0.1) \
        + depth / max(tool["plunge_mm_s"], 0.1) + 0.5
    return n * per_hole


def _est_pocket(layer, tool, st):
    e = layer.get("est", {})
    area = float(e.get("area_mm2", 0))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    mrr = tool["feed_mm_s"] * tool["stepover_mm"] * tool["stepdown_mm"]
    passes = _passes(depth, tool["stepdown_mm"])
    return (area * depth) / max(mrr, 0.01) + 1.0 * passes


def _est_profile(layer, tool, st):
    e = layer.get("est", {})
    perim = float(e.get("perimeter_mm", 0))
    depth = float(e.get("depth_mm", layer["cut_depth"]))
    passes = _passes(depth, tool["stepdown_mm"])
    return (perim * passes) / max(tool["feed_mm_s"], 0.1) + 1.0 * passes


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


def _fits(tool_dia, min_width_mm):
    """An endmill needs clearance to move inside a pocket/slot."""
    return tool_dia <= min_width_mm - 0.5


def plan_tools(layers, cfg=None):
    """Rank tool-set plans for these layers. Returns
    {"plans": [best, ...up to max_plans], "error": None} or
    {"plans": [], "error": "..."} when no standard tool can cut a layer."""
    st = settings(cfg)
    layers = [L for L in layers]
    if not layers:
        return {"plans": [], "error": "no layers to plan"}

    em_sizes = [round(i * INCH_TO_MM, 4) for i in st["standard_endmills_in"]]
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

    op_rank = {"drill": 0, "pocket": 1, "profile": 2}
    candidates = []
    for em_set in em_sets:
        for drill_set in drill_modes:
            assigned = []  # (layer, tool, kind, note, seconds)
            ok = True
            for L in layers:
                op = L["operation"]
                e = L.get("est", {})
                if op == "drill":
                    dia = float(e.get("hole_dia_mm", L.get("diameter", 0)))
                    if dia in drill_set:
                        tool = drill_tools[dia]
                        assigned.append((L, tool, "drill", "drill", _est_drill(L, tool, st)))
                    else:
                        # Bore with the largest endmill in the set that
                        # fits inside the hole (needs room to orbit).
                        fitting = [d for d in sorted(em_set, reverse=True)
                                   if d <= 0.8 * dia]
                        if not fitting:
                            ok = False
                            break
                        tool = em_tools[fitting[0]]
                        assigned.append((L, tool, "bore",
                                         f"bore with {tool['name']} (no drill in this plan)",
                                         _est_bore(L, tool, st)))
                elif op == "pocket":
                    mw = float(e.get("min_width_mm", 0))
                    fitting = [d for d in sorted(em_set, reverse=True) if _fits(d, mw)]
                    if not fitting:
                        ok = False
                        break
                    tool = em_tools[fitting[0]]
                    assigned.append((L, tool, "endmill", "largest endmill that fits",
                                     _est_pocket(L, tool, st)))
                elif op == "profile":
                    if _is_outer_profile(L):
                        fitting = sorted(em_set, reverse=True)
                    else:  # through-cut slot: the tool must fit the slot
                        mw = float(e.get("min_width_mm", 0))
                        fitting = [d for d in sorted(em_set, reverse=True) if _fits(d, mw)]
                    if not fitting:
                        ok = False
                        break
                    tool = em_tools[fitting[0]]
                    assigned.append((L, tool, "endmill", "largest endmill that fits",
                                     _est_profile(L, tool, st)))
                else:
                    ok = False
                    break
            if not ok:
                continue
            # Cut order: drill -> pocket -> profile, grouped by tool
            # inside each operation. That is the whole ordering rule.
            ordered = sorted(assigned, key=lambda a: (op_rank[a[0]["operation"]], a[1]["id"]))
            cutting = sum(a[4] for a in ordered)
            changes = 0
            prev = None
            tools_in_order = []
            for _, tool, _, _, _ in ordered:
                if tool["id"] not in [t["id"] for t in tools_in_order]:
                    tools_in_order.append(tool)
                if prev is not None and tool["id"] != prev:
                    changes += 1
                prev = tool["id"]
            total = cutting + changes * float(st["tool_change_seconds"])
            candidates.append({
                "total_seconds": round(total, 1),
                "cutting_seconds": round(cutting, 1),
                "tool_changes": changes,
                "change_seconds": round(changes * float(st["tool_change_seconds"]), 1),
                "tools": [dict(t, tool_number=i + 1)
                          for i, t in enumerate(tools_in_order)],
                "layers": [{"layer": a[0]["layer"], "operation": a[0]["operation"],
                            "tool_id": a[1]["id"], "kind": a[2], "note": a[3],
                            "seconds": round(a[4], 1),
                            "tabs": tabs_for_layer(a[0], st)} for a in ordered],
            })
    if not candidates:
        bad = []
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
    # Dedupe by tool complement, keep the fastest of each; rank by total.
    by_tools = {}
    for c in candidates:
        key = tuple(sorted(t["id"] for t in c["tools"]))
        if key not in by_tools or c["total_seconds"] < by_tools[key]["total_seconds"]:
            by_tools[key] = c
    ranked = sorted(by_tools.values(), key=lambda c: c["total_seconds"])
    plans = []
    for i, c in enumerate(ranked[: int(st["max_plans"])]):
        c = dict(c)
        c["id"] = chr(ord("A") + i)
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


def manifest_txt(plan, layers, dxf_name, st=None):
    """manifest.txt v2: # tool / # tabs / # plan comment lines, then
    layer|operation|start|cut|part|tool_id per layer, in cut order.
    Old gadgets ignore the extra fields (they read fields 1-4).
    Tabs ride on `# tabs: <layer>|<count>|<length_mm>|<thickness_mm>`
    lines, one per outer-profile layer."""
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
    for entry in plan["layers"]:
        L = by_name[entry["layer"]]
        part = L.get("part", "")
        lines.append(f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|"
                     f"{L['cut_depth']:.3f}|{part}|{entry['tool_id']}")
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
    out.append(f"Tool plan {chosen['id']} (chosen, fastest estimate): "
               f"{len(chosen['tools'])} tool(s), {chosen['tool_changes']} manual "
               f"change(s), est {chosen['total_seconds'] / 60:.1f} min total "
               f"(cutting {chosen['cutting_seconds'] / 60:.1f} + changes "
               f"{chosen['change_seconds'] / 60:.1f}). Times are estimates, not promises.")
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
            out.append(f"- Plan {p['id']}: {len(p['tools'])} tool(s), {p['tool_changes']} change(s), "
                       f"est {p['total_seconds'] / 60:.1f} min — {tools}")
    out.append("Review the tools against your VCarve library before cutting — "
               "the gadget asks you to pick each one from the library, or "
               "uses the recommendation above if you cancel.")
    return out
