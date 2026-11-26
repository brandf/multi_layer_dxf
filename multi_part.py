#!/usr/bin/env python3
"""
Multi-part wrapper for step_to_vcarve.py.

CAD scene reality: a Part Studio often holds several parts laid out
logically — e.g. a container with a top and a bottom that fit together.
Those parts do NOT all want the same CAM direction:
  - the bottom is cut face-up (its top face is the CAM top)
  - the lid / top may be modelled upside-down in the scene, or its
    mating face is its bottom — you cut it flipped over, so its CAM
    top is its bottom face in the CAD scene
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
  - layout="side_by_side": parts are shelf-packed in XY (BRA-16,
    layout.py: fill rows left-to-right, wrap when full, a part may
    rotate 90 deg in Z to fit — recorded as pack_rotate_z_deg).
    The gap between two parts is tool-dependent, not fixed: the
    merged tool plan is computed first (from the per-part
    classification pre-pass — layers are translation-invariant)
    and each part's profile endmill is taken from the CHOSEN plan
    (BRA-20; --plan picks which), then gaps are
    max(gap_mm, D_A + D_B + web_min) so the tabs keep a web to
    hold onto; the same rule sets row gaps and the edge inset
    (each part outline sits its own D — the kerf only — inside
    the usable boundary, so the kerf runs up to the usable
    boundary and the margin band is the web on the outside),
    and registration-pin clearance. When no merged
    plan exists (a layer no standard tool fits), the per-part
    fit-rule maxima are used instead (the old behaviour). With a
    material size given, parts sit only inside the usable area
    (material minus clamp_margin_mm, default 15 mm, on every
    side), each outline inset by its own profile tool + web;
    without one, the layout is a single row and the report
    suggests a material size. The run fails with a named error if
    the layout cannot fit. Side by side is essential when the
    scene is a closed assembly: Top and Bottom share the same XY
    footprint in the CAD scene (concentric), so preserving scene XY
    would put two profiles on top of each other in the DXF.
  - layout="scene" preserves scene XY instead (use it when the
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
                    help="auto-orient each part by orientation search (BRA-17: try all 6 axis-aligned orientations, score by outcome, prune by material) and lay out largest first; explicit parts.json entries override per part")
    ap.add_argument("--material", default=None,
                    help="material WxDxT mm, e.g. 150x100x10 — prunes orientations that cannot fit (BRA-17); config 'material' / 'stock_size_mm' also accepted, CLI wins")
    args = ap.parse_args()

    cfg = {}
    if args.config:
        if not args.config.exists():
            print(f"ERROR: config file not found: {args.config}", file=sys.stderr)
            sys.exit(1)
        cfg = json.loads(args.config.read_text())

    # Material size (BRA-17 prune, BRA-16 fit-or-error): CLI wins,
    # else config "material" / "stock_size_mm". Validated up front
    # so a bad spec fails before any classification runs.
    import orient_search as _os
    try:
        material = _os.parse_material(args.material) if args.material \
            else _os.material_from_cfg(cfg)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    if material:
        print(f"material: {material['x']:.1f} x {material['y']:.1f} x "
              f"{material['thickness']:.1f} mm (orientations that cannot fit are pruned)")

    parts_cfg = {"parts": []}
    if args.parts and args.parts.exists():
        parts_cfg = json.loads(args.parts.read_text())
    part_entries = parts_cfg.get("parts", [])
    align_z = parts_cfg.get("align_z", "bottom")
    layout = parts_cfg.get("layout", "side_by_side")
    gap = float(parts_cfg.get("gap_mm", 10))
    auto_mode = bool(args.auto or parts_cfg.get("auto", False))
    # Layout (BRA-16): clamp margin + two-sided pin reservation.
    # parts.json wins, then config, then defaults (layout.py).
    import layout as _layout
    import toolplan as _tp
    margin = _layout.clamp_margin_mm(cfg, parts_cfg)
    usable = _layout.usable_area(material, margin)
    web_min = _layout.web_min_mm(cfg, parts_cfg)
    # Clamp margin vs web (Brandon Nov 25, 2026): the margin band
    # IS the web on the outside, so the margin must be bigger than
    # web_min. Fails before any output exists.
    _web_v = _layout.check_margin_web(margin, web_min)
    if _web_v:
        print(f"ERROR: {_web_v}", file=sys.stderr)
        return 1
    pin_clearance = _layout.pin_clearance_mm(cfg, parts_cfg)
    two_sided = bool(parts_cfg.get("two_sided", cfg.get("two_sided", False)))
    pin_dia = float(cfg.get("pin_diameter_mm",
                            parts_cfg.get("pin_diameter_mm",
                                          _layout.DEFAULT_PIN_DIAMETER_MM)))
    if material:
        print(f"clamp margin: {margin:.1f} mm, usable area: "
              f"{usable[0]:.1f} x {usable[1]:.1f} mm"
              + (" (two-sided: pin positions reserved)" if two_sided else ""))

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
    # Orientation search up front (BRA-17), before any layout:
    # every part that needs auto-orienting is searched now, so a
    # material prune failure (no orientation fits) fails the whole
    # run before any part is classified, and the footprint sort
    # below uses the CHOSEN orientation's footprint. Explicit
    # parts.json entries skip the search for that part.
    # items: (solid, search_result or None)
    items = [(s, None) for s in solids]
    if auto_mode:
        for idx, (s, _) in enumerate(items):
            entry = part_entries[idx] if idx < len(part_entries) else {}
            explicit = any(k in entry for k in ("flip_x", "flip_y", "rotate_z_deg")) or entry.get("auto") is False
            if explicit:
                continue
            res = _os.search(s, cfg, material, args.config,
                             min_tool=args.min_tool, only=args.only)
            if res["error"]:
                print(f"ERROR: [part {idx+1}] orientation search: {res['error']}", file=sys.stderr)
                return 1
            items[idx] = (s, res)
    if auto_mode and not part_entries:
        # Sort by footprint area AFTER the search (largest first) so
        # the side-by-side row packs tidily. Only when there are no
        # explicit part entries — re-sorting would mismatch entries
        # to parts.
        def _footprint(item):
            s, res = item
            if res is not None:
                s = res["best"]["solid"]
            bb = s.bounding_box()
            return (bb.max.X - bb.min.X) * (bb.max.Y - bb.min.Y)
        items = sorted(items, key=_footprint, reverse=True)
    print(f"{len(solids)} part(s) in STEP, auto={auto_mode}")

    from build123d import Location
    def rot_about_centre(obj, axis, deg):
        # Rotate about the BOUNDING-BOX centre, not obj.center()
        # (the volume centre). A pocket / hole shifts the volume
        # centre, so rotating about it would shift the part by
        # 2x that offset after the flip — the lid in the first
        # test came out Z 0.34..8.34 instead of 0..8 for exactly
        # this reason. Bbox centre is the geometric centre.
        # build123d rotate is about the origin, so translate to
        # origin, rotate, translate back.
        bb = obj.bounding_box()
        ctr = (bb.min + bb.max) / 2
        obj = obj.moved(Location((-ctr.X, -ctr.Y, -ctr.Z), (0, 0, 0)))
        obj = obj.rotate(axis, deg)
        obj = obj.moved(Location((ctr.X, ctr.Y, ctr.Z), (0, 0, 0)))
        return obj

    # ---- prepare phase (BRA-16): apply the orientation search
    # result + the part's own transform, then measure the footprint
    # and height. NOTHING is classified or written yet, so a
    # fit-or-error failure here fails the run before any output
    # exists (no DXF / manifest written).
    prepared = []
    for i, (solid, search_res) in enumerate(items):
        entry = part_entries[i] if i < len(part_entries) else {}
        label = entry.get("label", f"P{i+1:02d}")
        prefix = f"P{i+1:02d}_{label}"
        flip_x = bool(entry.get("flip_x", False))
        flip_y = bool(entry.get("flip_y", False))
        rot_z = float(entry.get("rotate_z_deg", 0))

        auto_search = None
        if search_res is not None:
            auto_search = {
                "best": search_res["best"]["orientation"],
                "best_score": search_res["best"]["score"],
                "ranked": [{k: e[k] for k in ("orientation", "score", "layers", "flags")
                            if k in e} | {"cut_minutes": e["breakdown"]["cut_minutes"],
                                          "holes_not_from_top": e["breakdown"]["holes_not_from_top"],
                                          "pockets_not_from_top": e["breakdown"]["pockets_not_from_top"],
                                          "flip": e["breakdown"]["flip"],
                                          "post": e["breakdown"]["post"]}
                           for e in search_res["ranked"]],
                "pruned": search_res["pruned"],
            }
            solid = search_res["best"]["solid"]
            _best = search_res["best"]
            _others = "; ".join(f"{e['orientation']} {e['score']:.1f}"
                                for e in search_res["ranked"] if e is not _best)
            _pruned = "; ".join(f"{p['orientation']} ({p['reason']})" for p in search_res["pruned"])
            print(f"orient search [{prefix}]: best {_best['orientation']} "
                  f"(score {_best['score']:.1f}, cut {_best['breakdown']['cut_minutes']:.1f} min, "
                  f"{_best['breakdown']['holes_not_from_top']} un-cut holes, "
                  f"{_best['breakdown']['pockets_not_from_top']} un-cut pockets)"
                  + (f" over {_others}" if _others else "")
                  + (f"; pruned {_pruned}" if _pruned else ""))

        s = solid
        if flip_x:
            s = rot_about_centre(s, Axis.X, 180)
        if flip_y:
            s = rot_about_centre(s, Axis.Y, 180)
        if rot_z:
            s = rot_about_centre(s, Axis.Z, rot_z)
        bb = s.bounding_box()
        fw = bb.max.X - bb.min.X
        fd = bb.max.Y - bb.min.Y
        height = bb.max.Z - bb.min.Z
        if material and height > material["thickness"] + _layout.TOL_MM:
            print(f"ERROR: part {prefix} height {height:.2f} mm > material thickness "
                  f"{material['thickness']:.2f} mm "
                  f"(overshoot {height - material['thickness']:.2f} mm) — "
                  f"no orientation / fit for this material", file=sys.stderr)
            return 1
        if usable is not None:
            try:
                _layout.check_fits_usable(prefix, fw, fd, usable[0], usable[1])
            except _layout.PackError as e:
                print(f"ERROR: {e}", file=sys.stderr)
                return 1
        prepared.append({"entry": entry, "label": label, "prefix": prefix,
                         "flip_x": flip_x, "flip_y": flip_y, "rot_z": rot_z,
                         "solid": s, "auto_search": auto_search,
                         "footprint": (fw, fd), "height": height})

    # ---- profile tools first (BRA-16 spacing, BRA-20 plan-aware):
    # classify each part once at the origin (manifest only) so the
    # packer knows the profile endmill diameter before placing
    # anything. The tool does not change under a Z rotation or a
    # translation, so the pre-pass diameter holds for the placed
    # part. Only needed for side-by-side packing; scene layout
    # keeps scene XY and needs no gaps.
    # BRA-20: pack from the CHOSEN merged plan's actual profile
    # tools, not the per-part fit-rule maxima. The maxima bound
    # every plan's tools from above, so the layout was valid for
    # the chosen plan and all fallbacks — but wider than the cut
    # needs (two_part reserved 30.4 mm gaps while plan A cuts both
    # profiles with a 3/16 in endmill and only needs 14.5 mm).
    # The merged plan is computed from the pre-pass layers, which
    # are translation-invariant, so the plan is the same one the
    # final classification produces. When no merged plan exists
    # (e.g. Kookabus — a layer no standard tool fits), fall back
    # to the fit-rule maxima, exactly the old behaviour.
    profile_dias = {}
    profile_tool_source = None
    if layout == "side_by_side":
        import tempfile
        from build123d import export_step as _export_step
        pre_layers = []  # combined layers, prefixed as the merge does
        pre_z_tops = {}  # V3.14: per-part z_top for the clearance gap
        with tempfile.TemporaryDirectory(prefix="profile_tools_") as tmp:
            tmp = Path(tmp)
            for p in prepared:
                step_path = tmp / f"{p['prefix']}.step"
                _export_step(p["solid"], str(step_path))
                pre_out = tmp / f"{p['prefix']}_out"
                cmd = [sys.executable, str(Path(__file__).parent / "step_to_vcarve.py"),
                       str(step_path), "-o", str(pre_out),
                       "--mode", "manifest", "--min-tool", str(args.min_tool),
                       "--no-toolplan"]
                if args.config:
                    cmd += ["--config", str(args.config)]
                if args.only:
                    cmd += ["--only", args.only]
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"ERROR: profile-tool pre-pass failed for {p['prefix']}:\n"
                          f"{r.stdout}\n{r.stderr}", file=sys.stderr)
                    return r.returncode
                man = json.loads((pre_out / "manifest.json").read_text())
                pre_z_tops[p["prefix"]] = man["z_top"]
                for L in man["layers"]:
                    L2 = dict(L)
                    L2["layer"] = f"{p['prefix']}__{L['layer']}"
                    L2["part"] = p["prefix"]
                    if L2.get("depends_on"):
                        L2["depends_on"] = f"{p['prefix']}__{L2['depends_on']}"
                    pre_layers.append(L2)
                p["pre_layers"] = man["layers"]  # fit-rule fallback only
        part_min_dims = {p["prefix"]: min(p["footprint"]) for p in prepared}
        pre_plan = _tp.plan_tools(pre_layers, cfg, part_min_dims, pre_z_tops) if pre_layers else {"plans": [], "error": "no layers"}
        if pre_plan["plans"]:
            chosen_pre = _tp.choose_plan(pre_plan["plans"], args.plan)
            profile_dias = _tp.plan_profile_tools(chosen_pre)
            for p in prepared:
                profile_dias.setdefault(p["prefix"], None)
            profile_tool_source = f"plan {chosen_pre['id']}"
            print(f"profile tools from chosen plan {chosen_pre['id']} "
                  f"(BRA-20 — the tools that actually cut): " +
                  ", ".join(f"{k} {v:.2f} mm" if v is not None else f"{k} none"
                            for k, v in sorted(profile_dias.items())))
        else:
            for p in prepared:
                d = _tp.profile_tool_diameter(p["pre_layers"], cfg,
                                              min(p["footprint"]))
                profile_dias[p["prefix"]] = d
            profile_tool_source = "fit-rule maxima (no merged plan)"
            print(f"profile tools from fit-rule maxima "
                  f"(no merged plan: {pre_plan['error']}): " +
                  ", ".join(f"{k} {v:.2f} mm" if v is not None else f"{k} none"
                            for k, v in sorted(profile_dias.items())))
        for p in prepared:
            p.pop("pre_layers", None)
        for p in prepared:
            p["profile_tool_dia_mm"] = profile_dias[p["prefix"]]
        # Part-to-edge (BRA-16 spacing rule, Brandon Nov 25, 2026):
        # the edge inset — each part outline (its own D, the kerf
        # only) inside the usable boundary — is enforced by
        # pack_shelf below (PackError before any output exists) and
        # re-checked against the chosen plan's actual tools after
        # the merge. The clamp margin no longer carries the tool
        # diameter; the margin band is the web on the outside.

    # ---- pack phase (BRA-16): shelf packing inside the usable
    # area (material minus clamp margin). Unbounded when no material
    # is given: a single row, exactly the old behaviour, so the
    # regressions do not move.
    placements = None
    if layout == "side_by_side":
        rects = [{"name": p["prefix"], "w": p["footprint"][0], "d": p["footprint"][1],
                  "tool_dia": profile_dias.get(p["prefix"])}
                 for p in prepared]
        try:
            placements = _layout.pack_shelf(
                rects, gap,
                max_w=usable[0] if usable else None,
                max_d=usable[1] if usable else None,
                web_min_mm=web_min)
        except _layout.PackError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1
        for p, pl in zip(prepared, placements):
            p["placement"] = pl
            p["pack_rot_z"] = pl["rotate_z"]
        pw, pd = _layout.packed_bounds(placements)
        print(f"layout: shelf-packed {len(placements)} part(s) into "
              f"{pw:.1f} x {pd:.1f} mm"
              + (f" of usable {usable[0]:.1f} x {usable[1]:.1f} mm" if usable else ""))
    else:  # layout == "scene": keep scene XY; check the union fits
        for p in prepared:
            p["placement"] = None
            p["pack_rot_z"] = 0
        if usable is not None:
            xs = [p["solid"].bounding_box().min.X for p in prepared]
            xe = [p["solid"].bounding_box().max.X for p in prepared]
            ys = [p["solid"].bounding_box().min.Y for p in prepared]
            ye = [p["solid"].bounding_box().max.Y for p in prepared]
            uw, ud = max(xe) - min(xs), max(ye) - min(ys)
            if uw > usable[0] + _layout.TOL_MM or ud > usable[1] + _layout.TOL_MM:
                print(f"ERROR: scene layout {uw:.2f} x {ud:.2f} mm does not fit "
                      f"usable area {usable[0]:.2f} x {usable[1]:.2f} mm "
                      f"(overshoot {max(0.0, uw - usable[0]):.2f} x "
                      f"{max(0.0, ud - usable[1]):.2f} mm)", file=sys.stderr)
                return 1

    # Suggested size when none was given (BRA-16): required usable
    # extents (parts + kerf) + clamp margin, rounded up to
    # the next 10 mm.
    suggested_material = None
    if material is None and placements is not None:
        req_w, req_d = _layout.required_usable_extents(
            placements, profile_dias, web_min)
        max_h = max((p["height"] for p in prepared), default=0.0)
        suggested_material = _layout.suggest_material(req_w, req_d, max_h, margin)
        print(f"suggested material: {suggested_material['x']:.0f} x "
              f"{suggested_material['y']:.0f} x {suggested_material['thickness']:.0f} mm "
              f"(required usable {req_w:.1f} x {req_d:.1f} mm — parts + kerf — "
              f"+ {margin:.0f} mm clamp margin)")

    # Registration pins (BRA-16 interface for BRA-13): two-sided
    # jobs only; positions are a reservation recorded in the
    # manifest, not a cut feature yet.
    reg_pins = []
    pin_note = None
    if two_sided:
        if placements is not None:
            reg_pins, pin_note = _layout.pin_positions(
                material, margin, placements, pin_dia=pin_dia,
                tool_dias=profile_dias, pin_clearance_mm=pin_clearance)
        else:
            pin_note = "scene layout: pin positions not computed (BRA-13)"
        if reg_pins:
            print(f"registration pins: " +
                  ", ".join(f"({p['x']:.1f}, {p['y']:.1f}) D{p['diameter_mm']:.0f}"
                            for p in reg_pins))
        elif pin_note:
            print(f"registration pins: none — {pin_note}")

    outdir = args.out
    outdir.mkdir(parents=True, exist_ok=True)
    parts_dir = outdir / "parts"
    parts_dir.mkdir(exist_ok=True)

    combined_layers = []
    combined_flags = []
    parts_out = []
    all_dxf_layers = {}  # prefixed layer -> segments (via ezdxf merge below)

    import ezdxf
    combined_doc = ezdxf.new("R2010", setup=True)
    combined_doc.units = 4
    msp = combined_doc.modelspace()

    for i, p in enumerate(prepared):
        entry = p["entry"]
        label = p["label"]
        prefix = p["prefix"]
        flip_x = p["flip_x"]
        flip_y = p["flip_y"]
        rot_z = p["rot_z"]
        auto_search = p["auto_search"]
        s = p["solid"]
        pack_rot_z = p["pack_rot_z"]
        placement = p["placement"]

        # Packing rotation (90 deg in Z to fit the row) is applied
        # to the solid before classification; it changes only the
        # footprint orientation, not the cutting. The total Z
        # rotation is recorded in the manifest.
        if pack_rot_z:
            s = rot_about_centre(s, Axis.Z, pack_rot_z)
        total_rot_z = rot_z + pack_rot_z

        # bottom-align + layout placement (see module docstring)
        bb = s.bounding_box()
        dx = dy = dz = 0.0
        if align_z == "bottom":
            dz = -bb.min.Z  # outside bottom face -> Z=0
        if layout == "side_by_side":
            # placement origin is the usable area's lower-left
            # corner (clamp margin in from the sheet edge) — always,
            # even when no material was given: the DXF is written in
            # sheet coordinates for the suggested material, so the
            # margin offset must be there or the parts sit at (0,0)
            # against the sheet edge (VCarve V12.5 live test, Nov 21).
            ox = margin
            oy = margin
            dx = ox + placement["x"] - bb.min.X
            dy = oy + placement["y"] - bb.min.Y
        elif layout == "scene":
            pass  # scene XY preserved, only bottom-align
        if dx or dy or dz:
            s = s.moved(Location((dx, dy, dz), (0, 0, 0)))

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
        print(f"--- {prefix} (flip_x={flip_x} flip_y={flip_y} rot_z={total_rot_z}"
              + (f" incl. pack {pack_rot_z}" if pack_rot_z else "") + ") ---")
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
            # Cut-order dependencies name a layer in the same part —
            # prefix them too, or the merged plan cannot resolve them.
            if L2.get("depends_on"):
                L2["depends_on"] = f"{prefix}__{L2['depends_on']}"
            combined_layers.append(L2)
        combined_flags.extend(f"[{prefix}] {f}" for f in man["flags"])
        # Sheet coordinates: placement is inside the usable area,
        # which starts one clamp margin in from the sheet edge —
        # always (see the offset above); the manifest records sheet
        # coordinates for the suggested material.
        _ox = margin
        _oy = margin
        _fp = p["footprint"]
        if pack_rot_z:
            _fp = (_fp[1], _fp[0])  # 90 deg in Z swaps the footprint
        p_out = {
            "name": prefix, "label": label,
            "flip_x": flip_x, "flip_y": flip_y, "rotate_z_deg": total_rot_z,
            "pack_rotate_z_deg": pack_rot_z,
            "profile_tool_dia_mm": p.get("profile_tool_dia_mm"),
            "x_mm": round(_ox + placement["x"], 3) if placement else None,
            "y_mm": round(_oy + placement["y"], 3) if placement else None,
            "footprint_mm": [round(_fp[0], 3), round(_fp[1], 3)],
            "height_mm": round(p["height"], 3),
            "stock": man["stock"], "z_top": man["z_top"],
            "layers": [L["layer"] for L in man["layers"]],
            "holes": man["holes"], "pocket_count": man["pocket_count"],
        }
        if auto_search is not None:
            p_out["orientation_search"] = auto_search
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
    tool_plan = _tp.plan_tools(combined_layers, cfg, part_min_dims,
                               {p["name"]: p["z_top"] for p in parts_out}) if combined_layers else {"plans": [], "error": "no layers"}
    if tool_plan["plans"]:
        chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
        tool_plan["chosen"] = chosen["id"]
        order = {e["layer"]: i for i, e in enumerate(chosen["layers"])}
        combined_layers = sorted(combined_layers, key=lambda L: order.get(L["layer"], 99))
    else:
        combined_flags.append(f"TOOL PLAN: {tool_plan['error']} — no tool recommendations; "
                              "gadget falls back to its TOOLS table")

    # ---- spacing re-check (BRA-16 item 6): the layout was packed
    # from the per-part fit-rule maxima, which bound every plan's
    # profile tools from above — but the chosen plan is what
    # actually cuts, so verify its real profile tools against the
    # packed gaps before writing anything. Switching plans changes
    # the spacing, so this re-check runs against the chosen plan.
    spacing_check = None
    if placements is not None and tool_plan["plans"]:
        chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
        tool_by_id = {t["id"]: t for t in chosen["tools"]}
        actual_dias = {}
        for e in chosen["layers"]:
            if e["operation"] != "profile":
                continue
            part = e["layer"].split("__", 1)[0]
            d = tool_by_id[e["tool_id"]]["dia_mm"]
            actual_dias[part] = max(actual_dias.get(part, 0.0), d)
        violations = _layout.verify_spacing(placements, actual_dias, gap, web_min)
        if material:
            violations += _layout.verify_edge_insets(
                placements, actual_dias, usable[0], usable[1], web_min)
        if violations:
            print(f"ERROR: spacing re-check failed against plan {chosen['id']} — "
                  f"the packed layout does not fit the chosen plan's profile tools:",
                  file=sys.stderr)
            for v in violations:
                print(f"ERROR: {v}", file=sys.stderr)
            return 1
        spacing_check = (f"verified against plan {chosen['id']} (profile tools " +
                         ", ".join(f"{k} {v:.2f} mm"
                                   for k, v in sorted(actual_dias.items())) + ")")

    stem = args.step.stem
    manifest = {
        "source_step": str(args.step),
        "units": "mm",
        "material": material,
        "clamp_margin_mm": margin,
        "usable_area_mm": ({"x": round(usable[0], 3), "y": round(usable[1], 3)}
                           if usable else None),
        "layout": [{"name": p["prefix"],
                    "x_mm": round(margin + pl["x"], 3),
                    "y_mm": round(margin + pl["y"], 3),
                    "w_mm": pl["w"], "d_mm": pl["d"],
                    "rotate_z_deg": pl["rotate_z"],
                    "profile_tool_dia_mm": profile_dias.get(p["prefix"])}
                   for p, pl in zip(prepared, placements)] if placements else None,
        "spacing": {"rule": "max(gap_mm, D_A + D_B + web_min_mm)",
                    "edge_inset": "each part outline sits its own profile tool dia (the kerf) inside the usable-area boundary (the kerf runs up to the usable boundary; the margin band is the web on the outside; clamp margin carries no tool diameter)",
                    "gap_mm": gap, "web_min_mm": web_min,
                    "pin_clearance_mm": pin_clearance,
                    "profile_tools_from": profile_tool_source,
                    "check": spacing_check},
        "suggested_material": suggested_material,
        "registration_pins": reg_pins if two_sided else None,
        "parts": parts_out,
        "layers": combined_layers,
        "flags": combined_flags,
        "cut_order": ["drill", "pocket", "profile"],
        "tool_plan": tool_plan,
    }
    if pin_note:
        combined_flags.append(f"REGISTRATION PINS: {pin_note}")
    if args.mode in ("full", "manifest"):
        (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        if tool_plan["plans"]:
            chosen = _tp.choose_plan(tool_plan["plans"], args.plan)
            st = _tp.settings(cfg)
            (outdir / "manifest.txt").write_text(
                _tp.manifest_txt(chosen, combined_layers, f"{stem}.dxf", st, combined_flags))
            for p in tool_plan["plans"]:
                if p["id"] != chosen["id"]:
                    (outdir / f"manifest_plan_{p['id']}.txt").write_text(
                        _tp.manifest_txt(p, combined_layers, f"{stem}.dxf", st, combined_flags))
        else:
            (outdir / "manifest.txt").write_text(
                f"# dxf: {stem}.dxf\n" +
                "\n".join(f"{L['layer']}|{L['operation']}|{L['start_depth']:.3f}|{L['cut_depth']:.3f}|{L.get('part','')}"
                          for L in combined_layers) + "\n")
    if args.mode in ("full", "dxf"):
        combined_doc.saveas(str(outdir / f"{stem}.dxf"))
    report = [f"# {stem} — multi-part VCarve report\n"]
    if material:
        report.append(f"Material: {material['x']:.1f} x {material['y']:.1f} x "
                      f"{material['thickness']:.1f} mm; clamp margin {margin:.1f} mm, "
                      f"usable area {usable[0]:.1f} x {usable[1]:.1f} mm "
                      f"(parts sit inside the usable area, each outline its own "
                      f"profile tool (the kerf) inside the usable boundary — the kerf "
                      f"runs up to the usable boundary and the margin band is the web "
                      f"on the outside).")
    elif suggested_material:
        report.append(f"Material: none given — suggested "
                      f"{suggested_material['x']:.0f} x {suggested_material['y']:.0f} x "
                      f"{suggested_material['thickness']:.0f} mm "
                      f"(required usable — parts + kerf — + {margin:.0f} mm clamp margin, rounded up to 10 mm).")
    if placements is not None:
        tools_txt = ", ".join(
            f"{p['prefix']} {profile_dias.get(p['prefix']):.2f} mm"
            if profile_dias.get(p['prefix']) is not None else
            f"{p['prefix']} no profile tool"
            for p in prepared)
        report.append(f"Spacing (BRA-16 tool rule, BRA-20 plan-aware): gaps are "
                      f"max({gap:.1f} mm, D_A + D_B + {web_min:.1f} mm web); "
                      f"each part outline sits its own profile tool (the kerf) inside "
                      f"the usable boundary (the margin band is the web on the outside); "
                      f"profile tools from {profile_tool_source}: {tools_txt}."
                      + (f" {spacing_check}." if spacing_check else ""))
    if two_sided:
        if reg_pins:
            report.append("Registration pins (two-sided flip, mirror about the flip axis): " +
                          ", ".join(f"({p['x']:.1f}, {p['y']:.1f}) D{p['diameter_mm']:.0f}"
                                    for p in reg_pins))
        elif pin_note:
            report.append(f"Registration pins: none — {pin_note}")
    for p in parts_out:
        line = (f"- {p['name']}: stock {p['stock']['x_max']-p['stock']['x_min']:.1f} x "
                f"{p['stock']['y_max']-p['stock']['y_min']:.1f} x {p['stock']['thickness']:.1f} mm, "
                f"flip_x={p['flip_x']} rot_z={p['rotate_z_deg']}, layers {len(p['layers'])}")
        if p.get("x_mm") is not None:
            line += f", at ({p['x_mm']:.1f}, {p['y_mm']:.1f})"
        if p.get("orientation_search"):
            a = p["orientation_search"]
            ranked = "; ".join(f"{e['orientation']} {e['score']:.1f}" for e in a["ranked"])
            line += f" [search: best {a['best']} ({ranked})"
            if a["pruned"]:
                line += "; pruned " + "; ".join(f"{x['orientation']} ({x['reason']})" for x in a["pruned"])
            line += "]"
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
