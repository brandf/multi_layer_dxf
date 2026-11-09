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
    args = ap.parse_args()

    parts_cfg = {"parts": []}
    if args.parts and args.parts.exists():
        parts_cfg = json.loads(args.parts.read_text())
    part_entries = parts_cfg.get("parts", [])
    align_z = parts_cfg.get("align_z", "bottom")
    layout = parts_cfg.get("layout", "side_by_side")
    gap = float(parts_cfg.get("gap_mm", 10))
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
    print(f"{len(solids)} part(s) in STEP")

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
               "--mode", args.mode, "--min-tool", str(args.min_tool)]
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
        parts_out.append({
            "name": prefix, "label": label,
            "flip_x": flip_x, "flip_y": flip_y, "rotate_z_deg": rot_z,
            "stock": man["stock"], "z_top": man["z_top"],
            "layers": [L["layer"] for L in man["layers"]],
            "holes": man["holes"], "pocket_count": man["pocket_count"],
        })
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

    stem = args.step.stem
    manifest = {
        "source_step": str(args.step),
        "units": "mm",
        "parts": parts_out,
        "layers": combined_layers,
        "flags": combined_flags,
        "cut_order": ["drill", "pocket", "profile"],
    }
    if args.mode in ("full", "manifest"):
        (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        (outdir / "manifest.txt").write_text(
            f"# dxf: {stem}.dxf\n" +
            "\n".join(f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|{L['cut_depth']:.3f}|{L.get('part','')}"
                      for L in combined_layers) + "\n")
    if args.mode in ("full", "dxf"):
        combined_doc.saveas(str(outdir / f"{stem}.dxf"))
    report = [f"# {stem} — multi-part VCarve report\n"]
    for p in parts_out:
        report.append(f"- {p['name']}: stock {p['stock']['x_max']-p['stock']['x_min']:.1f} x "
                      f"{p['stock']['y_max']-p['stock']['y_min']:.1f} x {p['stock']['thickness']:.1f} mm, "
                      f"flip_x={p['flip_x']} rot_z={p['rotate_z_deg']}, layers {len(p['layers'])}")
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
