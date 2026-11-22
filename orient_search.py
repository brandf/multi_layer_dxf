#!/usr/bin/env python3
"""Orientation search (BRA-17, 2026-11-09).

Replaces the auto-orient heuristic (auto_orient.py: dominant axis
>50% + most-open-side-up) with a measurement: try all 6
axis-aligned orientations (+/-X, +/-Y, +/-Z as the up axis), run
the full classifier + tool plan on each, and pick the winner by
actual outcome — cut time, un-cut holes, post-processing,
single- vs double-sided. No thresholds, no tuned dominance
constants. The margin rule first proposed for BRA-17 (dominant if
>=40% AND >=1.5x second-best) is superseded by this and was never
built.

The classifier stays a black box: each orientation is written to
a temp STEP and classified by step_to_vcarve.py in a subprocess,
exactly as multi_part.py already does per part. No refactor of
the 1500-line classifier. The search scores the real outputs
(manifest.json), which is the point: "best" means the best
toolpaths, not the best proxy.

Material prune (Brandon 2026-11-09): if the material size is
known, prune before classifying — an orientation survives only
if its height <= material thickness AND its footprint fits the
material W x D in either in-plane spin. The real container on
10 mm stock keeps only Z up / Z down (9.5 / 8.0 mm tall; the
X/Y orientations are 46 mm tall). If all 6 are pruned the search
fails with a named error (BRA-16 fit-or-error) — the part cannot
be cut from that material at any orientation.

Scorer (config "orientation_penalties", equivalent minutes):
cut time from the chosen plan (incl. tool-change penalties)
+ a FIXED flip penalty (default 25: flip + re-clamp + re-zero +
second setup) charged once when the orientation leaves ANY
feature un-cuttable from the top — holes or pockets not from
the top — plus small per-feature back-side cutting costs
(hole 0.5, pocket 5.0) + post-processing penalties per method
(cnc_3d 30, decision_needed 5, hand_router 3, drill_press 3,
router_table 2) + 60 if no standard tool plan exists. The flip
is fixed, not per-hole (BRA-21): the old +15/hole priced a
1-hole flip at 15 and a 16-hole flip at 240, when the flip
itself costs the same either way. No special-casing for
magnets or for insides-up: the difference falls out of the
penalties. Evidence (measured 2026-11-09, real container both
parts flipped = magnets on bottom): the flipped job is FASTER
on the clock (Plan A 1 change / 3.5 min vs upright 2 / 5.6)
because it skips the Bottom's 8 magnet holes — and worse, its
pockets are cut on the WRONG side (BRA-21: a downward-opening
pocket was emitted as a top pocket, which would bore into the
Bottom's outside face). With the fix the flipped job scores
46.1 against the upright's 9.6 at the merged-job level — about
4.8x, the difficulty Brandon expects — for the right reasons:
a real flip cost (25) plus real back-side work (8 holes x 0.5
+ 2 pockets x 5.0). Note the accounting: the search charges the
flip per part (exact when orientations are mixed — a single
flipped part needs its own second setup — but an all-flipped
sheet shares one flip, so the sum of per-part scores overstates
that case; the 4.8x above is the sheet-level number). The
flipped orientation is priced, not disqualified: if a part
only works double-sided, the search still picks the least-bad
and the report says why.

Ties: if the original orientation (+Z, identity) scores within
"orientation_tie_minutes" (default 0.5) of the best, prefer it —
do not rotate a part pointlessly for a fraction of a minute.
The in-plane spin (rotating a part 90 deg on the sheet) is a
layout variable, not part of the 6: it does not change the
cutting, only the footprint.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# (label, (rotation axis, degrees)) — rotation about the bbox centre.
# Each brings the named source axis to +Z. All six are proper
# rotations (no mirroring): a physical part can be turned to any.
ORIENTATIONS = [
    ("+Z", None),            # identity: Z already up
    ("-Z", ("X", 180)),      # flip: -Z up
    ("+X", ("Y", -90)),      # +X -> +Z
    ("-X", ("Y", 90)),       # -X -> +Z
    ("+Y", ("X", 90)),       # +Y -> +Z
    ("-Y", ("X", -90)),      # -Y -> +Z
]

DEFAULT_PENALTIES = {
    # The flip is a FIXED setup cost, not a per-hole one (BRA-21,
    # 2026-11-09 — Brandon: the flipped orientation should cost
    # 4-5x, not just skip work). The old model charged +15 per
    # un-cut hole, which priced a 1-hole flip at 15 and a 16-hole
    # flip at 240, when the flip itself costs the same either way:
    # unclamp, flip the stock, re-clamp, re-zero, second setup.
    # So: one fixed flip penalty when ANY feature is un-cuttable
    # from the top, plus small per-feature back-side costs for the
    # actual cutting (a Ø2.25 hole is seconds; a pocket takes
    # minutes). All in equivalent minutes, all configurable.
    "flip": 25.0,
    "hole_not_from_top": 0.5,
    "pocket_not_from_top": 5.0,
    # A 3D surfacing pass is slow (small stepover, ball nose) — the
    # flat weight is coarse. A proper area-based 3D time estimate
    # is a follow-up; it needs the non-prismatic face area in the
    # post_process entries, which the classifier does not record yet.
    "post_cnc_3d": 30.0,
    "post_decision_needed": 5.0,
    "post_hand_router": 3.0,
    "post_drill_press": 3.0,
    "post_router_table": 2.0,
    "no_plan": 60.0,
}
DEFAULT_TIE_MINUTES = 0.5
_ORIENT_IDX = {label: i for i, (label, _) in enumerate(ORIENTATIONS)}


def parse_material(spec):
    """Material size in. Accepts "WxDxT" ("150x100x10"), a dict
    {"x","y","thickness"}, or a list [W, D, T] (mm). Returns
    {"x","y","thickness"} or None. Raises ValueError on bad input."""
    if spec is None:
        return None
    if isinstance(spec, dict):
        try:
            return {"x": float(spec["x"]), "y": float(spec["y"]),
                    "thickness": float(spec["thickness"])}
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"bad material dict (need x/y/thickness): {spec!r}")
    if isinstance(spec, (list, tuple)):
        if len(spec) != 3:
            raise ValueError(f"bad material list (need [W, D, T]): {spec!r}")
        return {"x": float(spec[0]), "y": float(spec[1]), "thickness": float(spec[2])}
    if isinstance(spec, str):
        parts = spec.lower().replace("mm", "").split("x")
        if len(parts) != 3:
            raise ValueError(f"bad material spec (want WxDxT, e.g. 150x100x10): {spec!r}")
        try:
            w, d, t = (float(p.strip()) for p in parts)
        except ValueError:
            raise ValueError(f"bad material spec (want WxDxT, e.g. 150x100x10): {spec!r}")
        return {"x": w, "y": d, "thickness": t}
    raise ValueError(f"bad material spec: {spec!r}")


def material_from_cfg(cfg):
    """Material from a config dict: cfg["material"] (any form
    parse_material takes) or cfg["stock_size_mm"] ([W, D, T]).
    Returns a material dict or None."""
    if not cfg:
        return None
    if cfg.get("material") is not None:
        return parse_material(cfg["material"])
    if cfg.get("stock_size_mm") is not None:
        return parse_material(cfg["stock_size_mm"])
    return None


def rotate_solid(solid, orientation):
    """Rotate the solid so the orientation's source axis is +Z.
    Rotation is about the bounding-box centre (not the volume
    centre — a pocket/hole shifts the volume centre). Returns
    (rotated_solid, applied_description)."""
    from build123d import Axis, Location

    label, rot = orientation
    if rot is None:
        return solid, "as modelled (+Z up)"
    axis_name, deg = rot
    axis = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}[axis_name]
    bb = solid.bounding_box()
    ctr = (bb.min + bb.max) / 2
    s = solid.moved(Location((-ctr.X, -ctr.Y, -ctr.Z), (0, 0, 0)))
    s = s.rotate(axis, deg)
    s = s.moved(Location((ctr.X, ctr.Y, ctr.Z), (0, 0, 0)))
    return s, f"rotate {deg:+.0f} about {axis_name} ({label} up)"


def prune_reason(bbox, material):
    """None if this oriented bbox fits the material, else the
    reason string. Height must fit the thickness; the footprint
    must fit W x D in either in-plane spin. (Clamp margin is a
    layout concern, BRA-16 — the prune uses the raw sheet size:
    a part bigger than the whole sheet cannot fit, period.)"""
    if material is None:
        return None
    height = bbox.max.Z - bbox.min.Z
    fx = bbox.max.X - bbox.min.X
    fy = bbox.max.Y - bbox.min.Y
    tol = 0.05
    if height > material["thickness"] + tol:
        return (f"height {height:.2f} mm > material thickness "
                f"{material['thickness']:.2f} mm")
    w, d = material["x"], material["y"]
    if not ((fx <= w + tol and fy <= d + tol) or (fx <= d + tol and fy <= w + tol)):
        return (f"footprint {fx:.2f} x {fy:.2f} mm does not fit "
                f"material {w:.2f} x {d:.2f} mm")
    return None


def score_manifest(man, cfg=None):
    """Score one orientation's classifier output (manifest.json
    dict). Returns (score_minutes, breakdown dict). The cut time
    comes from a real tool plan run in-process on these layers;
    the penalties price what the cut time leaves out — above all
    holes with no toolpath, which is what makes an orientation
    double-sided."""
    import toolplan as _tp

    cfg = cfg or {}
    penalties = dict(DEFAULT_PENALTIES)
    penalties.update(cfg.get("orientation_penalties", {}))
    breakdown = {"cut_minutes": 0.0, "holes_not_from_top": 0,
                 "pockets_not_from_top": 0, "flip": False,
                 "post": {}, "no_plan": False}
    layers = man.get("layers", [])
    stock = man.get("stock") or {}
    min_dim = None
    if stock.get("x_max") is not None:
        min_dim = min(stock["x_max"] - stock["x_min"],
                      stock["y_max"] - stock["y_min"])
    tp = _tp.plan_tools(layers, cfg, min_dim)
    if tp["plans"]:
        chosen = _tp.choose_plan(tp["plans"])
        breakdown["cut_minutes"] = round(chosen["total_seconds"] / 60.0, 2)
    else:
        breakdown["no_plan"] = True
    score = breakdown["cut_minutes"]
    if breakdown["no_plan"]:
        score += penalties["no_plan"]
    n_hole = sum(1 for f in man.get("flags", [])
                 if f.startswith("HOLE NOT FROM TOP"))
    n_pocket = sum(1 for f in man.get("flags", [])
                   if f.startswith("POCKET NOT FROM TOP"))
    breakdown["holes_not_from_top"] = n_hole
    breakdown["pockets_not_from_top"] = n_pocket
    if n_hole > 0 or n_pocket > 0:
        # One flip + re-register + second setup, however many
        # features live on the other side — plus the actual
        # back-side cutting time per feature.
        breakdown["flip"] = True
        score += penalties["flip"]
    score += n_hole * penalties["hole_not_from_top"]
    score += n_pocket * penalties["pocket_not_from_top"]
    post_counts = {}
    for e in man.get("post_process", []):
        m = e.get("method", "decision_needed")
        post_counts[m] = post_counts.get(m, 0) + 1
    breakdown["post"] = post_counts
    for method, n in post_counts.items():
        score += n * penalties.get(f"post_{method}", penalties["post_decision_needed"])
    return round(score, 2), breakdown


def search(solid, cfg=None, material=None, config_path=None,
           tol=0.01, min_tool=0.0, max_drill=20.0, only=""):
    """Try all 6 orientations of one solid, prune by material,
    classify + score the survivors. Returns a dict:
      {"ranked": [entries best-first], "pruned": [...],
       "best": entry or None, "error": str or None}
    Each ranked entry carries the orientation, the ROTATED SOLID
    (in-memory — the caller classifies it once more through its
    normal flow for canonical outputs), its bbox, layer/hole/
    pocket/flag counts, and score + breakdown. The temp dirs the
    classifier wrote are deleted when search returns; only the
    summaries survive.
    If material prunes every orientation, best is None and error
    names the part's smallest height / footprint. Raises
    RuntimeError if a classifier subprocess fails."""
    cfg = cfg or {}
    material = parse_material(material) if material is not None else material_from_cfg(cfg)
    penalties_tie = float(cfg.get("orientation_tie_minutes", DEFAULT_TIE_MINUTES))
    classifier = str(Path(__file__).parent / "step_to_vcarve.py")
    ranked = []
    pruned = []
    with tempfile.TemporaryDirectory(prefix="orient_search_") as tmp:
        tmp = Path(tmp)
        for idx, orientation in enumerate(ORIENTATIONS):
            label = orientation[0]
            rotated, applied = rotate_solid(solid, orientation)
            bb = rotated.bounding_box()
            height = bb.max.Z - bb.min.Z
            footprint = (bb.max.X - bb.min.X, bb.max.Y - bb.min.Y)
            reason = prune_reason(bb, material)
            if reason is not None:
                pruned.append({"orientation": label, "reason": reason,
                               "height_mm": round(height, 3),
                               "footprint_mm": [round(footprint[0], 3), round(footprint[1], 3)]})
                continue
            step_path = tmp / f"orient_{idx}.step"
            from build123d import export_step
            export_step(rotated, str(step_path))
            outdir = tmp / f"orient_{idx}_out"
            cmd = [sys.executable, classifier, str(step_path), "-o", str(outdir),
                   "--mode", "manifest", "--min-tool", str(min_tool),
                   "--max-drill", str(max_drill), "--no-toolplan"]
            if config_path:
                cmd += ["--config", str(config_path)]
            if only:
                cmd += ["--only", only]
            if tol != 0.01:
                cmd += ["--tol", str(tol)]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(
                    f"classifier failed for orientation {label} ({applied}):\n{r.stdout}\n{r.stderr}")
            man = json.loads((outdir / "manifest.json").read_text())
            score, breakdown = score_manifest(man, cfg)
            ranked.append({
                "orientation": label,
                "applied": applied,
                "height_mm": round(height, 3),
                "footprint_mm": [round(footprint[0], 3), round(footprint[1], 3)],
                "layers": len(man.get("layers", [])),
                "holes": len(man.get("holes", [])),
                "pockets": man.get("pocket_count", 0),
                "flags": len(man.get("flags", [])),
                "score": score,
                "breakdown": breakdown,
                "solid": rotated,
            })
    if not ranked:
        bb = solid.bounding_box()
        dims = sorted([bb.max.X - bb.min.X, bb.max.Y - bb.min.Y, bb.max.Z - bb.min.Z])
        mat = (f"{material['x']:.1f} x {material['y']:.1f} x {material['thickness']:.1f} mm"
               if material else "no material given")
        return {"ranked": [], "pruned": pruned, "best": None,
                "error": (f"no orientation fits material {mat}: smallest part dimension "
                          f"{dims[0]:.2f} mm; pruned: " +
                          "; ".join(f"{p['orientation']} ({p['reason']})" for p in pruned))}
    ranked.sort(key=lambda e: (e["score"], e["flags"],
                               _ORIENT_IDX[e["orientation"]]))
    best = ranked[0]
    identity = next((e for e in ranked if e["orientation"] == "+Z"), None)
    if identity is not None and identity is not best \
            and identity["score"] <= best["score"] + penalties_tie:
        best = identity
    return {"ranked": ranked, "pruned": pruned, "best": best, "error": None}


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Orientation search for one solid in a STEP (BRA-17).")
    ap.add_argument("step")
    ap.add_argument("--material", default=None, help="WxDxT mm, e.g. 150x100x10")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tol", type=float, default=0.01)
    ap.add_argument("--min-tool", type=float, default=0.0)
    ap.add_argument("--max-drill", type=float, default=20.0)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    cfg = {}
    if args.config:
        cfg = json.loads(Path(args.config).read_text())
    material = parse_material(args.material) if args.material else material_from_cfg(cfg)
    from build123d import import_step
    imported = import_step(args.step)
    try:
        solids = imported.solids()
    except Exception:
        solids = [imported]
    for i, solid in enumerate(solids):
        print(f"--- solid {i} ---")
        res = search(solid, cfg, material, args.config, args.tol, args.min_tool, args.max_drill, args.only)
        if res["error"]:
            print(f"ERROR: {res['error']}")
            continue
        for e in res["ranked"]:
            b = e["breakdown"]
            print(f"  {e['orientation']:>3} score {e['score']:6.2f}  cut {b['cut_minutes']:5.2f} min  "
                  f"holes-not-from-top {b['holes_not_from_top']}  pockets-not-from-top {b['pockets_not_from_top']}  "
                  f"flip {b['flip']}  post {b['post']}  "
                  f"layers {e['layers']} flags {e['flags']}  "
                  f"{'BEST' if e is res['best'] else ''}")
        for p in res["pruned"]:
            print(f"  {p['orientation']:>3} PRUNED: {p['reason']}")


if __name__ == "__main__":
    main()
