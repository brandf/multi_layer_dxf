#!/usr/bin/env python3
"""
Multi-part wrapper for step_to_vcarve.py.

Onshape scene reality: a Part Studio often holds several parts laid out
logically — e.g. a container with a top and a bottom that fit together.
Those parts do NOT all want the same CAM direction:
  - the bottom is cut face-up (its top face is the CAM top)
  - the lid / top may be modelled upside-down in the scene, or its
    mating face is its bottom — you cut it flipped over, so its CAM
    top is its Onshape bottom face
  - a part may be rotated in the scene for packing, but cut unrotated

This wrapper:
  1. loads a STEP with N solids (one per part)
  2. matches each solid to a part entry in --parts config (by index,
     sorted by centre X then Y — deterministic — or by bbox size)
  3. applies that part's transform *about its own centre* before
     classification:
        flip_x / flip_y : rotate 180 deg about X / Y through the centre
                          (turn the part over; its bottom becomes its top)
        rotate_z_deg    : rotate about Z through the centre
     No XY recentring: parts keep their scene XY layout in the DXF,
     so one VCarve job cuts all of them in the same layout.
     Flipping about X mirrors Y — that is physical, not a bug: when
     you turn a part over, its Y reverses. The DXF shows the flipped
     orientation, which is what the cutter sees.
  4. runs step_to_vcarve.py per part (the verified single-part
     classifier — no refactor of that code)
  5. merges the per-part DXFs into one DXF with layers prefixed
     P01_<label>__..., P02_<label>__..., plus a combined manifest
     with a `parts` array (each part's stock, transform, layers)
     and a combined manifest.txt for the VCarve gadget.

Usage:
  python multi_part.py scene.step -o out/ --parts parts.json
  python multi_part.py scene.step -o out/ --parts parts.json --mode check

parts.json example (see parts.example.json):
  {
    "align_z": "bottom",        // "bottom" (default) or "scene"
    "layout": "side_by_side",   // "side_by_side" (default) or "scene"
    "gap_mm": 10,
    "parts": [
      {"label": "bottom", "flip_x": false},
      {"label": "lid",    "flip_x": true, "rotate_z_deg": 0}
    ]
  }
Layout / alignment (added for the container Top/Bottom, 2026-11-08):
  - align_z="bottom": after the flip, each part is translated so its
    outside bottom face sits at Z=0 — bottom-aligned on the material,
    outside down, inside up, one-sided cut. Stock thickness is then
    that part's own height; in VCarve set the job material to the
    thicker part (or cut each part from its own thickness of stock
    side by side on the same bed — see README).
  - layout="side_by_side": parts are laid out in a row in XY with
    gap_mm between them, Ymin aligned to 0. This is essential when
    the scene is a closed assembly: Top and Bottom share the same
    XY footprint in Onshape (concentric), so preserving scene XY
    would put two profiles on top of each other in the DXF.
    layout="scene" preserves scene XY instead (use it when the
    scene is already laid out flat for cutting).
If --parts is omitted, every part is classified as-is, labelled
P01, P02, ... — no flip, no rotation. That is the safe default:
it never silently flips a part you did not ask to flip.
"""
import argparse, json, subprocess, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", type=Path)
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--parts", type=Path, default=None, help="JSON parts config")
    ap.add_argument("--mode", choices=["full", "check", "dxf", "manifest"], default="full")
    ap.add_argument("--only", default="")
    ap.add_argument("--min-tool", type=float, default=0.0)
    ap.add_argument("--config", type=Path, default=None, help="JSON config file (see config.example.json)")
    ap.add_argument("--plan", default="",
                    help="which tool plan to write as manifest.txt (A/B/C — default fastest, A)")
    ap.add_argument("--auto", action="store_true",
                    help="auto-orient each part (prismatic axis to Z, best side up) and lay out largest first; explicit parts.json entries override per part")
    args = ap.parse_args()

    cfg = {}
    if args.config and args.config.exists():
        cfg = json.loads(args.config.read_text())

    parts_cfg = {"parts": []}
    if args.parts and args.parts.exists():
        parts_cfg = json.loads(args.parts.read_text())
    part_entries = parts_cfg.get("parts", [])
    align_z = parts_cfg.get("align_z", "bottom")
    layout = parts_cfg.get("layout", "side_by_side")
    gap = float(parts_cfg.get("gap_mm", 10))
    auto_mode = bool(args.auto or parts_cfg.get("auto", False))
    main._layout_x = 0.0

    outdir = args.out
    outdir.mkdir(parents=True, exist_ok=True)
    parts_dir = outdir / "parts"
    parts_dir.mkdir(exist_ok=True)

    from build123d import import_step, Axis
    imported = import_step(str(args.step))
    try:
        solids = imported.solids()
    except Exception:
        solids = [imported]
    # deterministic order: bbox min X, Y, Z, rounded to 0.1 mm.
    # Do NOT sort by centre(): centre X/Y are ~0 with floating-point
    # noise (~1e-12), and that noise dominated the tuple and swapped
    # the container Top/Bottom in testing. Bbox mins are exact.
    def _key(s):
        bb = s.bounding_box()
        return (round(bb.min.X, 1), round(bb.min.Y, 1), round(bb.min.Z, 1))
    solids = sorted(solids, key=_key)
    if auto_mode and not part_entries:
        # Sort by footprint area AFTER orientation (largest first) so
        # the side-by-side row packs tidily. Only when there are no
        # explicit part entries — re-sorting would mismatch entries
        # to parts. (auto_orient.py)
        import auto_orient as _ao
        def _footprint(s):
            d = _ao.analyze_orientation(s)
            if d["dominant"] and not d["ambiguous"]:
                s, _ = _ao.orient_solid(s, d)
            bb = s.bounding_box()
            return (bb.max.X - bb.min.X) * (bb.max.Y - bb.min.Y)
        solids = sorted(solids, key=_footprint, reverse=True)
    print(f"{len(solids)} part(s) in STEP, auto={auto_mode}")

    combined_layers = []
    combined_flags = []
    parts_out = []
    all_dxf_layers = {}  # prefixed layer -> segments (via ezdxf merge below)

    import ezdxf
    combined_doc = ezdxf.new("R2010", setup=True)
    combined_doc.units = 4
    msp = combined_doc.modelspace()

    for i, solid in enumerate(solids):
        entry = part_entries[i] if i < len(part_entries) else {}
        label = entry.get("label", f"P{i+1:02d}")
        prefix = f"P{i+1:02d}_{label}"
        flip_x = bool(entry.get("flip_x", False))
        flip_y = bool(entry.get("flip_y", False))
        rot_z = float(entry.get("rotate_z_deg", 0))

        # Auto-orientation (2026-11-08): unless this part has an
        # explicit entry (flip/rotate keys, or "auto": false), decide
        # its CAM orientation from the geometry — prismatic axis to Z,
        # most-open side up. Ambiguous parts are classified as-is and
        # flagged, never silently re-oriented.
        auto_decision = None
        explicit = any(k in entry for k in ("flip_x", "flip_y", "rotate_z_deg")) or entry.get("auto") is False
        if auto_mode and not explicit:
            import auto_orient as _ao
            auto_decision = _ao.analyze_orientation(solid)
            if auto_decision["dominant"] and not auto_decision["ambiguous"]:
                solid, applied = _ao.orient_solid(solid, auto_decision)
                print(f"auto-orient {prefix}: axis {auto_decision['axis']} "
                      f"(share {auto_decision['axis_share']:.0%}), flip={auto_decision['flip']} — {applied}")
            else:
                print(f"auto-orient {prefix}: AMBIGUOUS — classified as-is: {'; '.join(auto_decision['notes'])}")
                combined_flags.append(f"[{prefix}] AUTO-ORIENT AMBIGUOUS — classified as-is: {'; '.join(auto_decision['notes'])}")

        # transform about the part's own centre, in a copy
        s = solid
        c = s.center()
        # build123d rotate is about the origin, so translate to origin,
        # rotate, translate back — per axis, in order X, Y, then Z
        from build123d import Location
        def rot_about_centre(obj, axis, deg):
            # Rotate about the BOUNDING-BOX centre, not obj.center()
            # (the volume centre). A pocket / hole shifts the volume
            # centre, so rotating about it would shift the part by
            # 2x that offset after the flip — the lid in the first
            # test came out Z 0.34..8.34 instead of 0..8 for exactly
            # this reason. Bbox centre is the geometric centre.
            bb = obj.bounding_box()
            ctr = (bb.min + bb.max) / 2
            obj = obj.moved(Location((-ctr.X, -ctr.Y, -ctr.Z), (0, 0, 0)))
            obj = obj.rotate(axis, deg)
            obj = obj.moved(Location((ctr.X, ctr.Y, ctr.Z), (0, 0, 0)))
            return obj
        if flip_x:
            s = rot_about_centre(s, Axis.X, 180)
        if flip_y:
            s = rot_about_centre(s, Axis.Y, 180)
        if rot_z:
            s = rot_about_centre(s, Axis.Z, rot_z)

        # bottom-align + side-by-side layout (see module docstring)
        bb = s.bounding_box()
        dx = dy = dz = 0.0
        if align_z == "bottom":
            dz = -bb.min.Z  # outside bottom face -> Z=0
        if layout == "side_by_side":
            # X is placed in the loop below via _layout_x; Ymin -> 0
            dy = -bb.min.Y
            # stash the running X cursor on the function object
            if not hasattr(main, "_layout_x"):
                main._layout_x = 0.0
            dx = main._layout_x - bb.min.X
            main._layout_x = main._layout_x + (bb.max.X - bb.min.X) + gap
        if dx or dy or dz:
            from build123d import Location as _Loc
            s = s.moved(_Loc((dx, dy, dz), (0, 0, 0)))

        part_step = parts_dir / f"{prefix}.step"
        from build123d import export_step
        export_step(s, str(part_step))

        part_out = parts_dir / f"{prefix}"
        cmd = [sys.executable, str(Path(__file__).parent / "step_to_vcarve.py"),
               str(part_step), "-o", str(part_out),
               "--mode", args.mode, "--min-tool", str(args.min_tool),
               "--no-toolplan"]  # the merged job is planned once, below
        if args.config:
            cmd += ["--config", str(args.config)]
        if args.only:
            cmd += ["--only", args.only]
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(f"--- {prefix} (flip_x={flip_x} flip_y={flip_y} rot_z={rot_z}) ---")
        print(r.stdout.strip())
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr)
            return r.returncode
        if args.mode == "check":
            continue

        man = json.loads((part_out / "manifest.json").read_text())
        for L in man["layers"]:
            L2 = dict(L)
            L2["layer"] = f"{prefix}__{L['layer']}"
            L2["part"] = prefix
            combined_layers.append(L2)
        combined_flags.extend(f"[{prefix}] {f}" for f in man["flags"])
        p_out = {
            "name": prefix, "label": label,
            "flip_x": flip_x, "flip_y": flip_y, "rotate_z_deg": rot_z,
            "stock": man["stock"], "z_top": man["z_top"],
            "layers": [L["layer"] for L in man["layers"]],
            "holes": man["holes"], "pocket_count": man["pocket_count"],
        }
        if auto_decision is not None:
            p_out["auto_orientation"] = auto_decision
        parts_out.append(p_out)
        # merge DXF entities, renaming layers
        if args.mode in ("full", "dxf"):
            doc = ezdxf.readfile(str(part_out / f"{prefix}.dxf"))
            for ent in doc.modelspace():
                new_layer = f"{prefix}__{ent.dxf.layer}"
                if new_layer not in combined_doc.layers:
                    combined_doc.layers.add(new_layer)
                ent.dxf.layer = new_layer
                msp.add_entity(ent.copy() if hasattr(ent, "copy") else ent)

    if args.mode == "check":
        print("mode=check: multi-part classification only")
        return 0

    # ---- tool planning (BRA-12) on the MERGED job, so tool changes
    # are minimised across both parts, not per part. Per-part runs
    # used --no-toolplan; their layers carry the "est" inputs.
    import toolplan as _tp
    tool_plan = _tp.plan_tools(combined_layers, cfg) if combined_layers else {"plans": [], "error": "no layers"}
    if tool_plan["plans"]:
        chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
        tool_plan["chosen"] = chosen["id"]
        order = {e["layer"]: i for i, e in enumerate(chosen["layers"])}
        combined_layers = sorted(combined_layers, key=lambda L: order.get(L["layer"], 99))
    else:
        combined_flags.append(f"TOOL PLAN: {tool_plan['error']} — no tool recommendations; "
                              "gadget falls back to its TOOLS table")

    stem = args.step.stem
    manifest = {
        "source_step": str(args.step),
        "units": "mm",
        "parts": parts_out,
        "layers": combined_layers,
        "flags": combined_flags,
        "cut_order": ["drill", "pocket", "profile"],
        "tool_plan": tool_plan,
    }
    if args.mode in ("full", "manifest"):
        (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        if tool_plan["plans"]:
            chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
            st = _tp.settings(cfg)
            (outdir / "manifest.txt").write_text(
                _tp.manifest_txt(chosen, combined_layers, f"{stem}.dxf", st))
            for p in tool_plan["plans"]:
                if p["id"] != chosen["id"]:
                    (outdir / f"manifest_plan_{p['id']}.txt").write_text(
                        _tp.manifest_txt(p, combined_layers, f"{stem}.dxf", st))
        else:
            (outdir / "manifest.txt").write_text(
                f"# dxf: {stem}.dxf\n" +
                "\n".join(f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|{L['cut_depth']:.3f}|{L.get('part','')}"
                          for L in combined_layers) + "\n")
    if args.mode in ("full", "dxf"):
        combined_doc.saveas(str(outdir / f"{stem}.dxf"))
    report = [f"# {stem} — multi-part VCarve report\n"]
    for p in parts_out:
        line = (f"- {p['name']}: stock {p['stock']['x_max']-p['stock']['x_min']:.1f} x "
                f"{p['stock']['y_max']-p['stock']['y_min']:.1f} x {p['stock']['thickness']:.1f} mm, "
                f"flip_x={p['flip_x']} rot_z={p['rotate_z_deg']}, layers {len(p['layers'])}")
        if p.get("auto_orientation"):
            a = p["auto_orientation"]
            line += (f" [auto: axis {a['axis']} {a['axis_share']:.0%}, "
                     f"openings +{a['up_area_mm2']:.0f} vs -{a['down_area_mm2']:.0f} mm2, "
                     f"flip={a['flip']}, ambiguous={a['ambiguous']}]")
        report.append(line)
    report.append("\nTool plan (recommendations from standard sizes — review against your VCarve library):")
    report.extend(_tp.format_tool_plan_report(tool_plan))
    report.append("\nFlags — read before cutting:")
    report.append("\n".join(f"- {f}" for f in combined_flags) if combined_flags else "- none")
    (outdir / "report.md").write_text("\n".join(report) + "\n")
    print(f"wrote {outdir / 'manifest.json'}")
    print(f"wrote {outdir / f'{stem}.dxf'}")
    print(f"wrote {outdir / 'report.md'}")
    print(f"parts: {len(parts_out)}, layers: {len(combined_layers)}, flags: {len(combined_flags)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
