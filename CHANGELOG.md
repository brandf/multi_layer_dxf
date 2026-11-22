# multi_layer_dxf — Changelog

## v1.0.1 — 2026-11-22

Post-V1 streamlining, first item (Brandon): tool labels use the tool's
native designation, compact. An imperial endmill is now labelled
"1/4in" (not "6.35 mm", not "quarter-inch") in the gadget's tool
prompts and final dialog and in report.md's tool lists. Metric tools
(a 1.00 mm endmill, a 2.25 mm drill) still display in mm. The project
still works in mm throughout — geometry, planner math, manifest data
(the `# tool:` lines still carry the diameter in mm) — only the label
changed. Tool ids (EM6.35, D2.25) and the ToolDBId remembering keyed
on them are unchanged, so remembered tools still match.

## v1.0.0 — 2026-11-22

First release. STEP → layered DXF + manifest → VCarve Pro gadget → toolpaths.
Live-tested end to end in VCarve Pro V12.5 on the real two-part container
(Bottom + Top, Ø46 mm): 8 toolpaths, Plan A 3 tools / 2 changes / 7.0 min,
rib standing, profiles cutting through 10 mm stock, tabs holding both parts
in the sheet, tools remembered on the second run (unconfirmed — see below).

### What it does

- Any CAD (STEP, mm, Z-up) of a prismatic 2.5D part → one layered DXF +
  `manifest.json` + `manifest.txt` + `report.md`. Pockets, holes and
  profiles each land on their own layer with depths in the layer name;
  circles stay true circles.
- Multi-part scenes become one VCarve job: per-part CAM orientation search
  (all 6 axis-aligned orientations, scored by actual outcome), shelf
  packing with clamp margins and tool-dependent spacing, ranked tool plans
  from standard sizes (no personal tool library — Brandon reviews in
  report.md).
- The VCarve gadget (`vcarve/multi_layer_dxf.lua`, installed via the
  `.vgadget`) reads `manifest.txt`, imports the DXF, names each tool
  before its library dialog, remembers picks in the registry for the
  next run, creates drill / pocket / profile toolpaths in cut order,
  places real tabs on the profile vectors, and lists the
  post-processing steps in its final dialog.
- Beveled STEP recovery: accept a finished STEP with fillets, recover
  the prismatic shape, file non-prismatic faces into a post-processing
  plan (router table / hand router / CNC 3D / drill press).
- Slanted walls, floor fillets, countersinks, non-vertical holes,
  undercuts and true 3D surfaces are detected and flagged, never
  silently guessed.

### Proven in the live test (Nov 21–22, VCarve Pro V12.5)

- Gadget loads (`-- VECTRIC LUA SCRIPT` first line is required), picks
  the manifest with the real `FileDialog()` API, imports the DXF.
- Clamp-margin offset always applies; parts sit inside the margin
  whether or not `--material` was given.
- Tool cap: no endmill bigger than 1/6 of a part's smallest footprint
  side, floored at 1/4 in (a 1/2 in tool on a 46 mm part was "very large").
- Pocket fit width accounts for islands: the step pocket's 5.03 mm
  annulus takes the 1/8 in tool, so the rib stands.
- Fit-rule clearance is proportional for tiny tools (0.5 × tool dia,
  capped at 0.5 mm) — the Kookabus merged job has a plan.
- Through cuts use VCarve's `z` (material thickness) formula.
- Tabs are real ToolpathTab objects on the vectors (the SDK spells the
  method two ways; the gadget tries both).
- A `--config` naming a missing file fails loudly instead of silently
  running with defaults.

### Still open (not in v1)

- BRA-6: live-test the Onshape FeatureScript (`featurescript/CAM_Snapshot.fs`)
  in a real Onshape document.
- BRA-13: two-sided parts (flip setup with registration pins) — needs a
  real two-sided test part.
- BRA-19: direct STEP → toolpaths, eliminating VCarve for a subset of
  parts. Not built until the VCarve path is proven on real jobs.
- Tool remembering on a second run is implemented (ToolDBId registry
  defaults) but not yet confirmed live.
