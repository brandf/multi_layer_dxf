# multi_layer_dxf — STEP to layered DXF for VCarve Pro (2.5D, prismatic)

Turn a STEP file of a prismatic 2.5D part into a layered DXF plus a
manifest VCarve Pro can turn into toolpaths. Pockets, holes, and
profiles each land on their own layer with their depths in the layer
name, and circles stay true circles — no recreating the model in
VCarve, no setting up one toolpath at a time for every Z depth. A
scene with several parts becomes one VCarve job: the tool figures out
each part's CAM orientation, lays them out side by side, and
recommends tools from standard sizes with a ranked plan.

## Quick start (Windows — Python + VCarve on one machine)

1. Install Python 3.12 from python.org, checking **"Add python to
   PATH"** (the classic gotcha — without it, `python` is not found).
2. Clone the repo somewhere short, e.g. `C:\cnc\multi_layer_dxf`.
3. Double-click `setup_windows.bat`. It creates `.venv`, installs
   build123d + ezdxf, and smoke-tests the classifier on the synthetic
   test part (expect: 8 layers, 6 holes, 3 pockets, 1 flag).
4. Run it on your model: `run_vcarve.bat container.step container_out`
   — that writes the DXF, `manifest.json`, `manifest.txt`, and
   `report.md` into `container_out`. Read `report.md` first.
5. Install the gadget once: in VCarve, Gadgets > Install New Gadget,
   pick `vcarve\multi_layer_dxf.vgadget` (build it with
   `make_vgadget.py`), restart VCarve.
6. In VCarve, start a job, Gadgets > multi_layer_dxf, pick the
   `manifest.txt`. It imports the DXF, asks you to match each tool to
   your library, and builds the toolpaths in cut order. Preview, then
   File > Save As the `.crv` — the gadget never saves the job or posts
   G-code for you.

## What it does

```
Any CAD (prismatic solid, bevels NOT yet added)
  -> STEP export (mm)
  -> step_to_vcarve.py
  -> one layered DXF + manifest.json + report
  -> VCarve Pro: run the Lua gadget, or import DXF + load template
  -> pocket / drill / profile toolpaths, depths from the manifest
```

Bevels / chamfers / fillets are router-table post-processing.
Capture the 2.5D geometry *before* those features exist in the
tree — see `featurescript/CAM_Snapshot.fs` — or export STEP from
a rollback / version at the prismatic stage.

## Scope (v1, honest)

Works for: flat-bottom pockets, pocket-in-pocket, vertical walls,
vertical through holes, vertical blind holes, through profile,
slots with vertical walls. Lines, arcs, and full circles stay exact.

Flagged for review, not silently guessed:
- counterbores / countersinks (detected, emitted as two levels)
- islands / bosses inside pockets
- splines (emitted as polylines, flagged)
- any slanted / non-Z face, draft, fillet on a pocket floor
- holes whose axis is not Z
- features smaller than your smallest tool (configurable)

Does NOT do: true 3D roughing/finishing, slanted walls, undercuts.

## Files

- `step_to_vcarve.py` — STEP -> layered DXF + manifest.json
- `make_test_model.py` — builds a known test part in build123d,
  exports STEP, so you can verify the recognizer without a CAD install
- `featurescript/CAM_Snapshot.fs` — Onshape custom feature, insert
  before your first bevel/chamfer/fillet. Groups Z levels in-tree
  and creates one CAM_* sketch per Z level (v0.2 — grouping and
  sketch creation are now written, not a stub; still needs a live
  Onshape test before trusting it on a real part, and the
  UNVERIFIED-marked API calls in the file are the things to check).
- `vcarve/multi_layer_dxf.lua` — VCarve Pro gadget (Lua). Reads
  manifest.txt, imports the DXF named on its `# dxf:` line, creates
  drill / pocket / profile toolpaths per layer with start_depth /
  cut_depth from the manifest. v0.6 — live-tested in VCarve Pro
  V12.5 (Nov 21-22): 8 toolpaths for the real container. It does
  not save the job or post G-code; preview, then File > Save As
  the `.crv` yourself.
- `VALIDATION.md` — the ready-to-run checklist for the real container
  STEP (BRA-8), including the regression commands and the Windows
  gadget test steps (plus the optional Onshape FeatureScript test).
- `test/` — outputs from the synthetic test model

## Can I open something directly in VCarve, with toolpaths?

Short answer: not as a `.crv` file written from Python. VCarve's
`.crv` format is proprietary and undocumented — there is no supported
way to write one outside VCarve itself.

The supported way to get a `.crv` *with toolpaths* is the Lua gadget
in `vcarve/multi_layer_dxf.lua`: run it inside VCarve, it imports the DXF,
creates the toolpaths from `manifest.txt`, and recalculates. One click
in VCarve, instead of dozens of manual toolpaths — then you preview
and save the `.crv` yourself (the gadget deliberately does not save
the job or post G-code).

That gadget is v0.6 — live-tested in VCarve Pro V12.5 (Nov 21-22,
8 toolpaths for the real container). The file picker is
`FileDialog()`, confirmed from the official V12 Gadget SDK —
`GetFileName()` does not exist in the Vectric API (found out the
hard way, Nov 21: no dialog ever appeared). Same story for the
vector selection: `SelectVectorsOnLayer()` is not a global either —
it is a helper each gadget defines for itself, now included from
Vectric's own sample. `JoinVectors()` does not exist at all and is
gone. Tabs are placed as real `ToolpathTab` objects on the vectors
before the profile is created (`UseTabs` alone creates none — Nov 22:
profiles calculated with "No tabs defined" and no tabs). The
remaining least-certain calls are the registry tool remembering
(`ToolDBId` defaults) and the tab placement, both guarded so the
gadget falls back to asking / warns instead of silently doing the
wrong thing.
Until it is tested on Windows, the verified path is:

1. `step_to_vcarve.py` → layered DXF + manifest.json
2. VCarve: File > Import > Import Vectors, pick the DXF
3. One toolpath per layer, using manifest.json for start/cut depth
4. Preview, save `.crv`, post G-code

That is 8 toolpaths for the test part, not 40 — the complexity is
already in the vectors.

## Multiple parts in one scene — and CAM direction may not match the CAD scene

A Part Studio often holds several parts laid out logically, e.g. a
container with a top and a bottom that fit together. Two things follow:

1. **CAM direction is per-part, not per-scene.** The bottom is cut
   face-up. The lid may be modelled upside-down in the scene, or its
   mating face is its bottom — you cut it flipped over, so its CAM
   top is its bottom face in the CAD scene. The tool must not assume the
   scene's Z is the CAM Z for every part.
2. **One VCarve job can cut all of them.** Parts keep their scene XY
   layout in the DXF, so the job is one setup, one material sheet.

`multi_part.py` does this. It splits a STEP into its solids, applies
a per-part transform about that part's *bounding-box* centre, runs
the verified single-part classifier per part, and merges the results
into one DXF + manifest, layers prefixed `P01_bottom__...`,
`P02_lid__...`.

```bash
cp parts.example.json parts.json   # edit: label, flip_x, flip_y, rotate_z_deg
python multi_part.py scene.step -o out/ --parts parts.json
```

Verified on the test scene (`test/two_part.step`):
bottom 60×40×10, pocket D4.00; lid 60×40×8, pocket **D3.00 after
flip** (it opens from the bottom in the scene — without the flip it
would have been misread as D5.00), 6 layers total, 0 flags.
Note: flip about X mirrors Y — that's physical, when you turn a part
over its Y reverses, and the DXF shows the flipped orientation.

### Container example — Top/Bottom, inside up, bottom-aligned

Your container (round, ~D100 in the test approximation): Bottom
and Top are concentric in the CAD scene, so scene XY would put
two profiles on top of each other. The fix is in `multi_part.py`:
`align_z: "bottom"` + `layout: "side_by_side"` (see
`parts.container.json`).

- Bottom: no flip (inside already up), Top: `flip_x: true`
  (inside down in the closed scene, flipped over so inside is up)
- Both parts translated so their outside bottom face is at Z=0 —
  bottom-aligned on the material, outside down, one-sided cut.
  In VCarve, set the job material to the thicker part's thickness,
  or cut each part from its own thickness of stock side by side on
  the same bed.
- Laid out in a row with 10 mm gap: Bottom X 0..100, Top X 110..210.

Verified on `test/container.step`: Bottom — 8× D5 thru holes,
pocket D6.00, profile D100, Z 0..12; Top (flipped) — pocket D5.00,
profile D100, no holes, Z 0..10; 5 layers total, 0 flags.

Two classifier fixes this model forced:
1. A round part's outer wall is a full cylinder — it is the profile,
   not a D100 thru hole. Cylinders matching a top-face outer circle
   are skipped as holes.
2. A circular pocket's wall is also a full cylinder — a D60 pocket
   is pocketed with an endmill, not drilled. Cylinders over
   `--max-drill` (default 20 mm) are left to pocket/profile code.

Your feature tree also confirms the snapshot point: **Fillet 1 is
inside the `post process` folder, after Extrude 7 / Move face 1** —
so the CAM Snapshot goes just before that folder, not after it.
The rounded outside in the render is the fillet; cutting the
profile from the filleted model would undersize it. `Move face 1`
is prismatic in this model (Brandon, 2026-11-08): a vertical move
adding clearance after subtracting Bottom from Top / vice versa —
it just shifts a Z level, which the classifier handles as a
different pocket depth, no flag expected.

If `--parts` is omitted, every part is classified as-is, labelled
P01, P02, … — no silent flips.

### Harder validation — machined plate (`test/machined.step`)

A second, independent test model (`make_test_machined.py`, 120×80×14,
filleted R8 corners) with a different feature mix, built 2026-11-08
while waiting for the real container STEP. Ground truth: Pocket A
60×40 D5 + pocket-in-pocket B D9 (start 5), Pocket C 20×20 D3,
counterbore D12×3 over a D6 thru hole, 4× D5 thru, D8 blind D5,
a bottom-only D5 blind hole (trap), a 10° tapered pocket (trap),
and a through slot overlapping Pocket A (trap).

Verified after the fixes below: 9 layers, 8 holes, 4 pockets,
13 flags — all explainable. D6 thru is now emitted, the tapered
pocket is suppressed, the bottom-only hole is flagged with no
toolpath, and the merged slot is now recovered from the bottom
face as a full THROUGH_CUT (see bug 3).

Three classifier bugs this model found and fixed (2026-11-08):
1. **Counterbore thru hole dropped.** A D6 thru hole under a D12
   counterbore ends at the counterbore floor (Z=11), not at the top,
   so it was classified `blind_bottom` and no drill layer was emitted.
   Now: a bottom-starting cylinder under a wider coaxial hole that
   reaches the top is reclassified `thru`.
2. **Tapered pocket emitted at floor size.** A 10° tapered pocket
   was emitted as `POCKET_D6.00` at its (smaller) floor outline
   despite its walls being flagged non-prismatic. Now: a pocket whose
   lowest wall edge lies on its floor outline and belongs to a
   non-prismatic face is suppressed — flagged, no toolpath.
   (Face-centre proximity was tried first and falsely suppressed
   Pocket A too, because the tapered pocket sits flush against it;
   the lowest-edge test is what discriminates.)
3. **Through slot merged with a pocket vanished.** A slot overlapping
   Pocket A merges with the pocket's top opening, so the merged wire
   was explained as the pocket and the slot disappeared from the DXF.
   First flagged as "THROUGH FEATURE MERGED WITH POCKET" (points >2 mm
   outside the pocket outline, excluding points on a hole's circle,
   so a hole notching a pocket corner does not trip it). Then
   **recovered (BRA-9, 2026-11-08):** a through feature appears on
   both faces, and the pocket is blind, so the slot's outline is
   clean and unmerged on the bottom face — the classifier now scans
   bottom-face inner wires too, and only uses a bottom wire to
   resolve a merged candidate (a blind pocket opening from the
   bottom would otherwise be mis-emitted as a through cut). The
   machined plate now yields the full 26×8 slot (-48..-22, 18..26)
   as THROUGH_CUT, and the flag reads "recovered from bottom face
   — verify the outline in VCarve". Regressions clean: test_part
   8 layers / 6 holes / 3 pockets / 1 flag, container 5 layers /
   0 flags, two_part 6 layers / 0 flags, Kookabus unchanged
   (11 / 7 / 6 layers, 70 / 631 / 22 flags).

### External sample — Kookabus enclosure (`test/external/`)

A real, non-synthetic STEP was also tried: the Kookabus-03
enclosure assembly from kookabus.com
(`kookabus-03-enclosure.step`, FreeCAD AP214, 139×105.5 mm base +
lid + DIN clip, 3 solids, 2.0 MB). It is a 3D-print design, not a
machined part, so it is **not** a clean 2.5D validation — the
classifier correctly flags it heavily (torus fillets, cone
countersinks, horizontal cylinders, slanted hex-nut pockets:
P01 70 flags, P02 631, P03 22 in check mode) and does not crash
on a real AP214 file with 978 faces. The machined plate above is
the clean validation; the Kookabus file is kept as a robustness
sample only.

The FeatureScript side matches: insert one CAM Snapshot per part,
pick that part's CAM plane (not necessarily Top), and set
“Cut from: Top | Bottom”. The Python flip and the FeatureScript
“Cut from” must agree; the Python side is the source of truth for
the DXF.

## Flexible, not all-or-nothing

```bash
# just check what the recognizer sees, write nothing for VCarve
python step_to_vcarve.py part.step -o out/ --mode check

# DXF only, toolpath manually / via template in VCarve
python step_to_vcarve.py part.step -o out/ --mode dxf

# manifest only (re-run DXF later)
python step_to_vcarve.py part.step -o out/ --mode manifest

# drills only, or pockets only
python step_to_vcarve.py part.step -o out/ --only drill
python step_to_vcarve.py part.step -o out/ --only pocket,profile

# reusable defaults (tools, min tool, tolerance)
cp config.example.json config.json   # edit it
python step_to_vcarve.py part.step -o out/ --config config.json
```

The VCarve gadget is flexible the same way: `MODE`, `ONLY`,
`SKIP_LAYERS`, and the `TOOLS` table at the top of
`vcarve/multi_layer_dxf.lua` — edit once, reuse for every model.
You can run it for drills only, skip the profile, preview without
saving, etc. Nothing is all-or-nothing.

## Tool plan — recommendations, not a library (built 2026-11-08, BRA-12)

Brandon has no automatic tool changer and does not want to maintain
a tool library (bits wear out and get replaced). So the pipeline
does not ask for one. Instead `toolplan.py` recommends tools from
standard sizes — his bits are imperial Bits & Bits wood bits,
1/16"–1/2", any given bit may be missing — plus metric fine endmills
(1.0 / 0.8 / 0.5 mm, BRA-18) for pockets narrower than 1/16" can
cut, and the manifest carries
the recommendation plus fallback plans:

- **Per layer:** drills get an exact-diameter drill as primary and
  an endmill bore (largest standard endmill that fits inside the
  hole) as fallback. Pockets get the largest standard endmill that
  fits the narrowest spot; profiles get the largest that fits (outer
  profiles take any size, slots must fit the slot). An endmill fits
  a pocket/slot when dia <= min_width - clearance, where clearance
  = min(0.5 mm, half the tool diameter) (BRA-22, 2026-11-09): a
  0.50 mm endmill fits a pocket 0.75 mm wide, while every tool
  >= 1.0 mm behaves exactly as under the old flat 0.5 mm rule —
  the change only affects pockets in [0.75, 1.0) and [1.2, 1.3) mm.
- **Tool size is capped by the part (2026-11-21, BRA-5 live test):**
  the planner used to pick purely on cutting time, which put a
  1/2" endmill on a 46 mm part. No endmill is now bigger than 1/6
  of its own part's smallest footprint side — a 46 mm part caps at
  1/4", a 139 mm panel can still use 1/2" — and the cap never goes
  below 1/4", so a long skinny part is not forced onto a tiny tool
  for no benefit. Config: `toolplan.max_endmill_ratio` (default
  1/6) and `toolplan.max_endmill_floor_mm` (default 6.35). Effect:
  the real container's Plan A is now 1/4" + 1/8" (7.0 min, was 5.9
  with the 1/4" on the step pocket — the step pocket's 5.03 mm
  annulus around the rib cannot take the 1/4" tool, island fix
  2026-11-22); the Kookabus merged Plan A is 3/8" (215.1 min, was
  212.1); eight_parts is unchanged at 9.0 min.
- **Plans, not one answer:** a plan is a tool set (endmills + per
  hole-diameter drill-or-bore). Total time = estimated cutting time
  (MRR model — volume/(feed·stepover·stepdown) for pockets,
  length·passes/feed for profiles, plunge+peck for drills) +
  `tool_change_seconds` per manual change (default 120 s, set it in
  `config.json` → `toolplan.tool_change_seconds` to match your real
  change time). The fastest plan is chosen; the next two distinct
  plans are kept as fallbacks. Each plan is writable as its own
  `manifest_plan_<id>.txt` — the gadget runs whichever file you pick.
  `--plan B` writes plan B as `manifest.txt` instead.
- **The change penalty is the point:** with no ATC, one smaller
  endmill for everything can beat the optimal tool per operation
  plus a manual change. Verified on the test models: the container
  picks Drill Ø5 + 1/2" endmill (5.4 min, 1 change) over all-bore
  (6.1 min); the synthetic test part picks Drill Ø6 + 1/4" (4.3 min)
  over a single 3/16" endmill for everything (4.4 min, 0 changes) —
  nearly tied, and the estimate says so. Times are estimates, not
  promises; the report shows the comparison so you can judge.
- **Tabs:** every profile layer gets tabs by default (4 tabs, 5 mm
  long, 1 mm thick — `config.json` → `toolplan.tabs`), because a
  profile cut is a closed loop and whatever is inside the loop is a
  separate piece when the cut finishes: the part on the outer
  profile, the slug on a through cut. A doughnut hole is the clear
  case — its centre is a solid disc, not sawdust, and it goes flying
  without tabs. Tab count scales down with perimeter (a 26×8 slot
  gets 2 tabs, a Ø60 hole 4); tab length is clamped to a tenth of
  the profile perimeter. Drilled/bored holes need no tabs — the
  material leaves as chips. The gadget places the tabs as real
  `ToolpathTab` objects on the vectors before creating the profile
  (`InsertToolpathAtTabAtPoint`, evenly spaced around each closed
  contour); `UseTabs` alone only *uses* tabs that already exist and
  creates none — setting it without placing tabs is how the Nov 22
  live test got profiles with no tabs at all.
- **Matching to your VCarve library:** the SDK has no silent
  lookup-by-diameter — `ToolDatabase` only offers `SelectTool()`
  (interactive dialog) and `GetTool(id)`. So gadget v0.6 names each
  tool first, then opens that tool's library dialog, one tool at a
  time; Cancel uses the recommendation as-is (a tool created with
  the recommended diameter/feeds). A picked tool is remembered in
  the registry (`ToolDBId` defaults, keyed by the manifest tool id)
  and reused without asking on the next run — set
  `REMEMBER_TOOLS = false` to always ask. It warns in the final
  message if the tool you picked differs in diameter from the
  recommendation (diameters are compared in mm — a 1/4 in library
  tool reports 0.25, `InMM` false; the Nov 22 run warned about a
  correctly picked 1/4 in tool before this was fixed).
  Set `MATCH_TO_LIBRARY = false` at the top of the gadget to skip
  the dialogs. Either way, review the plan in `report.md` first.
- **Tool numbers** are assigned in first-use order — this fixes the
  v0.2 bug where every toolpath was Tool 1 and the posted code
  called no tool change.
- Feeds are conservative wood defaults, scaling with tool diameter
  (small tools go slower); stepdown is capped at half the tool
  diameter. Override any of it in `config.json` → `toolplan`.

## Rough + finish, surface drills, profile last (built 2026-11-08, BRA-14)

Three CAM-practice rules Brandon asked about, all in the plan now:

- **Rough + finish (pockets only).** A square pocket roughed with
  a 1/4" endmill leaves R3.18 corners. The planner offers a finish
  variant: rough with the big tool leaving `finish_allowance_mm`
  (default 0.5 mm) on the walls, then a finish pass with the
  smallest smaller endmill in the plan's tool set. It is a plan
  variant, never the fastest (the extra tool change costs more than
  the corner is worth on most parts), so it is always listed as an
  alternative — and the fastest finish variant is appended as an
  extra plan if none made the top three. The report shows the
  corner radius each plan achieves. Set
  `toolplan.max_corner_radius_mm` to make it a hard gate: any pocket
  whose final tool would round corners beyond that radius must get
  a finish pass, and plans that cannot achieve it are dropped.
  Only tool-imposed radius counts — a round pocket's design radius
  is not gated. Profiles are excluded: Brandon's example was a
  square pocket.
- **Face down first, then drill.** A hole that opens on a pocket
  floor (not on the top face) is now a surface drill:
  `DRILL_D{dia}_D{depth}_START{start}` with `depends_on` pointing
  at the facing pocket, so the order is facing pocket first, drill
  from the new surface second. The real container's Bottom needed
  exactly this: its eight Ø2.25 blind holes open on the Z 8.00
  step face, 1.55 mm deep, drilled after the 1.50 mm facing pocket.
- **Profile last is a hard invariant.** Cut order is a dependency
  sort: facing pocket before its surface drill, parent pocket
  before a pocket-in-pocket child, rough before finish — then
  tool-grouped (BRA-15) to minimise changes: continue with the
  current tool when possible, else start a tool that can finish
  all its non-profile work right now (a tool with locked work
  still to come gets stranded and forces an extra switch — the
  real container's surface drill depends on a pocket, so the
  drill must not go first), smallest finishable group first, so
  the big group (usually the profile tool) runs last and absorbs
  the profiles. A post-sort partition forces every profile to
  the end regardless of what else reordered. Nothing follows the
  profile: after it the part hangs on its tabs. This was already
  the practice; it is now enforced even when surface drills and
  finish passes reorder everything else. Verified: real container
  Plan A 3 changes → 2 (7.6 → 5.6 min); 8-part Plan A 3 → 1
  (13.7 → 9.7 min); all other regressions unchanged (test_part A
  still 1 change / 4.3 min, container A still 1 / 5.4).

## Pocket islands (built 2026-11-08, BRA-8)

A pocket floor can have an inner wire that is not a hole or a
deeper pocket — it can be a rib or boss rising above the floor.
The classifier tests each inner wire with a point-inside check
just above the floor: material there means island. The island's
outline goes into the pocket's DXF layer so VCarve pockets around
it, and a child pocket nested inside an island gets its outline
added too, re-opening the cut region inside the island. The real
container's Bottom has exactly this: its mating rib (r15..18)
rises 1.5 mm above the Z 8.00 step face, and a plain Ø46 pocket
would have machined it away. The Top has the mirror recess, not a
rib, so its facing pocket has no island. See VALIDATION.md §1.

## Two-sided parts (backlog, BRA-13 — not built)

Two-sided work (drill holes from both sides, flip the part) is
not supported yet and is not needed for the container. Design
sketch, in Linear BRA-13: assign each feature a side (A top / B
bottom; side-B features are today's blind_bottom / internal
flags), cut side A (no profile), flip on a registered fixture
(dowel pins), cut side B, profile last across the flip; side-B DXF
mirrored about the flip axis. Registration accuracy is the hard
part; it needs a real two-sided test part before it is built.

## Quick start (Python side)

The Windows quick start is at the top of this file. Linux / Mac:

```bash
cd ~/workspace/multi_layer_dxf
python3 -m venv .venv
.venv/bin/pip install build123d ezdxf
.venv/bin/python make_test_model.py
.venv/bin/python step_to_vcarve.py test/test_part.step -o test/out
# -> test/out/test_part.dxf
# -> test/out/manifest.json
# -> test/out/manifest.txt  (for the VCarve gadget)
# -> test/out/report.md
```

The scripts are pure Python + build123d/ezdxf — no Linux-specific
calls — so they run identically on Windows. No GPU is used; the
classifier is CPU-only and fast (seconds for the test models, ~1
minute for the 978-face Kookabus file).

Then in your CAD tool, for a real part:

1. Model all prismatic features. Do NOT add bevels/chamfers yet.
2. Insert the CAM Snapshot feature (or roll back / version at
   this point).
3. Add bevels/chamfers after it, for the router table.
4. Export the prismatic solid as STEP, in **mm** — in Onshape,
   File > Export in the UI, or the translations API (POST
   .../partstudios/.../translations, formatName STEP, poll until DONE).
5. Run `step_to_vcarve.py part.step -o out/`
6. Read `report.md` first. Anything flagged, check before cutting.

## Naming convention (the contract between the two sides)

Layers in the DXF, and entries in manifest.json:

- `PROFILE_THRU` — outer profile, cut through (the gadget sets its
  cut depth to VCarve's `z` formula — the material thickness — so it
  cuts through whatever stock the job uses; a hardcoded part height
  left 0.5 mm holding the part in 10 mm stock, Nov 22)
- `POCKET_D6.00` — pocket, start 0.00, cut 6.00
- `POCKET_D9.00_START6.00` — pocket-in-pocket, start 6.00, cut 3.00
- `DRILL_D6.00_THRU` — through holes, Ø6.00
- `DRILL_D8.00_D5.00` — blind holes, Ø8.00, depth 5.00

`manifest.json` is the source of truth for the VCarve gadget.
The DXF layer name alone is human-readable; the gadget reads
the manifest, not the layer name, for depths.

## VCarve side

Option A — gadget (recommended for dozens of depths):
Gadgets > multi_layer_dxf, pick manifest.txt. It imports the DXF named
on the manifest's `# dxf:` line, selects the vectors on each layer,
creates toolpaths in order drill -> pockets shallow to deep ->
profile last, recalculates all. It does not save the job or post
G-code — preview, File > Save As the `.crv`, then post. Always
preview before posting G-code. Gadget v0.6 (2026-11-22, live-tested
in VCarve Pro V12.5): the manifest picker is the real `FileDialog()`
API, the layer selection is a helper defined in the gadget itself
(`SelectVectorsOnLayer` is not a VCarve global), tabs are placed as
real objects on the vectors before the profile is created, tools are
named one at a time before their library dialog and remembered for
the next run, profiles cut through with the `z` (material thickness)
formula instead of a hardcoded part height, and the script starts
with the required `-- VECTRIC LUA SCRIPT` line.

## Orientation search and layout (built 2026-11-08, search 2026-11-09, Brandon approved)

`multi_part.py --auto` (or `"auto": true` in `parts.json`) decides
each part's CAM orientation by measurement, not by a heuristic
(`orient_search.py`, BRA-17 — supersedes the `auto_orient.py`
>50% dominant-axis rule, which is kept only for the single-part
`--auto-orient` path, see below):
- Try all 6 axis-aligned orientations (+/-X, +/-Y, +/-Z as the up
  axis). Each is a proper rotation about the bbox centre, so any
  of them is a physical way to put the part on the bed.
- Material prune first: if a material size is known (`--material
  WxDxT`, or config `material` / `stock_size_mm`), an orientation
  survives only if its height <= material thickness AND its
  footprint fits the material W x D in either in-plane spin. The
  real container on 10 mm stock keeps only Z up / Z down (9.5 /
  8.0 mm tall; the X/Y orientations are 46 mm tall). If all 6 are
  pruned the run fails with a named error — the part cannot be cut
  from that material at any orientation.
- Score the survivors by running the full classifier + tool plan
  on each: cut time from the chosen plan (incl. tool-change
  penalties) + a FIXED flip penalty (default 25: flip + re-clamp
  + re-zero + second setup) charged once when the orientation
  leaves ANY feature un-cuttable from the top — holes or pockets
  not from the top — plus small per-feature back-side cutting
  costs (hole 0.5, pocket 5.0) + post-processing penalties per
  method (cnc_3d 30, decision_needed 5, hand_router 3,
  drill_press 3, router_table 2) + 60 if no standard tool plan
  exists. Weights are config `orientation_penalties`. The flip
  is fixed, not per-hole (BRA-21): the old +15/hole priced a
  1-hole flip at 15 and a 16-hole flip at 240, when the flip
  itself costs the same either way. No special-casing for
  magnets or insides-up: the difference falls out of the
  penalties — the flipped container is FASTER on the clock
  (3.5 vs 5.9 min) because it skips the Bottom's 8 magnet
  holes, and worse, its pockets were cut on the WRONG side
  (BRA-21: a downward-opening pocket was emitted as a top
  pocket, which would bore into the Bottom's outside face).
  With the fix the flipped job scores 46.1 against the
  upright's 9.6 at the merged-job level — about 4.8x, the
  difficulty Brandon expects — for the right reasons: a real
  flip cost plus real back-side work. (The search charges the
  flip per part — exact when orientations are mixed, since a
  single flipped part needs its own second setup — but an
  all-flipped sheet shares one flip, so the sum of per-part
  scores overstates that case; 4.8x is the sheet-level
  number.) The flipped orientation is priced, not
  disqualified.
- Ties: if the original orientation (+Z) is within
  `orientation_tie_minutes` (default 0.5) of the best, prefer it
  — do not rotate a part pointlessly. The in-plane spin (rotating
  a part 90 deg on the sheet) is a layout variable, not part of
  the 6: it does not change the cutting, only the footprint.
- The ranking (orientation, score, cut time, un-cut holes, post
  work) and the pruned orientations with reasons are recorded per
  part in the manifest (`orientation_search`) and the report, so a
  wrong pick is visible, not silent.
- Layout (BRA-16, `layout.py`; BRA-20 plan-aware packing): bottom-align
  (Zmin = 0), shelf-pack side by side — fill rows left-to-right, wrap
  when full, a part may rotate 90 deg in Z to fit (recorded as
  `pack_rotate_z_deg` in the manifest). The gap between two parts is
  tool-dependent, not fixed: the merged tool plan is computed first
  (from the per-part classification pre-pass — layers are
  translation-invariant) and each part's profile endmill is taken
  from the CHOSEN plan (`toolplan.plan_profile_tools`; `--plan`
  picks which), then gaps are `max(gap_mm, D_A + D_B + web_min)` with
  `web_min_mm` default 5 mm (`gap_mm` stays as the floor); the same
  rule sets the gap between rows, the clamp-margin check (the margin
  must cover the largest profile tool + `web_min`, or the kerf eats
  the sheet edge), and registration-pin clearance (pin centre to a
  part outline ≥ D_p + pin radius + `pin_clearance_mm`, default
  3 mm). When no merged plan exists (a layer no standard tool fits),
  the per-part fit-rule maxima (`toolplan.profile_tool_diameter` —
  an outer profile takes the largest standard endmill, a through-cut
  slot the largest that fits it) are used instead, and the manifest
  records which source the tools came from (`spacing.
  profile_tools_from`). The chosen merged plan's real profile tools
  are re-checked against the packed gaps before anything is written
  — switching plans re-packs and re-checks the fit. Measured:
  two_part gaps 14.5 mm (plan A, 3/16 in) and eight-parts gaps
  17.7 mm (plan A, 1/4 in), where the fit-rule maxima reserved
  30.4 mm for both.
  With a material size given (`--material WxDxT`, or config
  `material` / `stock_size_mm`), parts sit only inside the usable
  area — material minus `clamp_margin_mm` (default 20 mm) on every
  side — and the run fails with a named error (non-zero exit, no
  DXF/manifest written) if a part is taller than the thickness, a
  footprint does not fit the usable area, or the packed layout
  overflows it. Without a material size the layout is a single row
  and the report suggests a size (packed bounds + clamp margin,
  rounded up to the next 10 mm). Single-part runs take `--material`
  too (same fit-or-error, no clamp margin — there is no layout).
  Two-sided jobs (`"two_sided": true` in parts.json/config)
  reserve two registration-pin positions in the manifest
  (`registration_pins`: x/y, diameter, keep-out radius) — clear of
  every part, inside the usable area, the widest-separated pair
  available; the keep-out radius is the largest profile tool +
  pin radius + clearance; BRA-13 consumes them.
- `parts.json` entries still override per part (any flip/rotate
  key, or `"auto": false`).
- Single-part: `step_to_vcarve.py --auto-orient` still uses the
  `auto_orient.py` heuristic for v1 (dominant axis >50% + best
  side up by opening area); the search is the multi-part path.

Verified 2026-11-09: the container STEP rotated 90 deg about X
(`test/rotated_container.step`) searches back to the exact
`parts.container.json` result — Bottom +Z, Top -Z, 5 layers,
0 flags. The real container with `--auto` gives 8 layers / 6
flags, Plan A 3 tools / 2 changes / 7.0 min, Bottom +Z / Top -Z — the same
as the explicit parts.json flip. The 8-part test now orients the
sideways block to +X and reads it exactly (15x10x4 pocket,
D5 thru hole, 0 flags) — 8 parts, 22 layers, 4 flags, Plan A 1
change / 9.0 min. Kookabus is classify-only (no `--auto` search
— 6x ~90 s per part is too slow); it does not crash.
Runtime note: the search runs the classifier up to 6 times per
part, so the 8-part test takes ~4 minutes.

BRA-21 (2026-11-09) fixed the cost model and a classifier bug
it exposed. A pocket is only emitted when its floor face's
outward normal points up (+Z): a downward-opening pocket is
flagged POCKET NOT FROM TOP and gets no toolpath — the pocket
equivalent of HOLE NOT FROM TOP. Before the fix the flipped
container's Bottom pockets were emitted as top pockets and
would have bored into the outside face. The scorer now charges
the flip once (25) plus small per-feature back-side costs
instead of +15 per un-cut hole, and cnc_3d is 30, not 10.
Kookabus moved with the fix (20 layers / 191 flags, was 29 /
107): 25 downward pockets flagged, 9 wrong pocket layers
removed, 5 through-cuts and 21 post-process items that were
hidden behind those pockets now visible — the old numbers
were wrong, not a regression.

BRA-22 (2026-11-09, Brandon's decision: option 2) made the
fit-rule clearance proportional to the tool instead of a flat
0.5 mm — `toolplan._fits` now uses clearance = min(0.5, 0.5 ×
tool diameter), capped so tools >= 1.0 mm behave exactly as
before. The Kookabus merged job now has a plan (Plan A EM 3/8 in
+ EM 0.50 mm, 2 changes, 215.1 min — the 0.913 mm groove is cut
by the 0.50 mm endmill); 20 layers / 190 flags (was 191 — only
the TOOL PLAN flag is gone); spacing packs from plan A. Every
other section-4 number is unchanged — the rule only affects
pockets in [0.75, 1.0) and [1.2, 1.3) mm, and the Kookabus
groove is the only such pocket in the suite (verified by the
full regression re-run).

## Beveled STEP in, prismatic blank + post-processing plan out (built 2026-11-08)

No rollback needed any more. Give the classifier a STEP of the
FINISHED part — fillets, chamfers, bevels included — and it
recovers the prismatic blank the CNC cuts, then proposes how to
put each removed feature back:
- Profile: the largest outer wire among ALL planar Z faces, not
  just the top face. A filleted top edge shrinks the top face; the
  bottom face still carries the true Ø100. If top and bottom
  outlines differ by >1%, the report says so. If vertical walls
  stick out beyond the profile (both edges filleted), it flags
  that the profile may be undersized instead of guessing.
- Pockets are read from their floors, which a top-edge fillet or
  chamfer does not touch. A small floor fillet does NOT suppress
  the pocket (it becomes a ball-nose post-process item); a tapered
  wall spanning most of the pocket depth still suppresses it.
- Countersunk holes are still thru holes (a coaxial cone from the
  hole's top to the part top is recognised, same as a counterbore).
- Every non-prismatic face is measured and filed into
  `manifest.json` → `post_process` and a "Post-processing plan"
  section in `report.md`, with a default CNC-vs-post call:
  outer-edge fillet/chamfer → router table; pocket top-edge
  fillet/chamfer → handheld router; pocket-floor fillet, tapered
  wall → CNC 3D (ball-nose); countersink →
  drill press; non-Z hole → drill press from the side. A sculpted
  surface on the OUTER edge is a roundover in practice, so it
  defaults to router table too (Brandon, 2026-11-08 — pick a
  roundover bit close to the modelled profile, exact match not
  needed for wood; post-processing is much faster than CNC 3D
  here), with CNC 3D kept as the listed alternative — and the
  alternative says the cost: a face on the bottom of the stock
  would need a two-sided setup (flip + registration) to cut on
  the CNC. A sculpted surface elsewhere (pocket wall, top face)
  stays CNC 3D. Brandon's
  rule (2026-11-08): use the CNC for non-prismatic features when
  it makes sense, post-process when it is simpler — the defaults
  encode that, and `config.json` → `post_method_overrides`
  (`"fillet/outer_top": "cnc_3d"`, …) changes any call.
- Limits, stated plainly: a fillet that consumes a whole face, a
  blended multi-face corner, and a both-edges-filleted profile are
  flagged for a human, not silently reconstructed. Full B-rep
  de-featuring (extending adjacent faces to their sharp
  intersection) is the next step if these cases matter; the
  face-based recovery above covers the common ones.

Verified 2026-11-08 (`make_test_beveled.py`):
- Beveled container (Ø100, pocket Ø60 D6, 8× Ø5, R3 top-edge
  fillet, 2 mm pocket-top chamfer, R2 floor fillet): 3 layers,
  8 holes, 1 pocket, profile CIRCLE r=50 in the DXF, post-process
  plan exactly [R3 outer → router table, pocket chamfer →
  hand router, R2 floor → CNC ball-nose], 4 flags, all explainable.
- Beveled plate (80×60×10, chamfered top edges, Ø8 hole with
  90° countersink, 20×20 pocket D4 with R2 floor fillet):
  3 layers, 1 hole (countersunk, still thru), 1 pocket,
  post-process [chamfer → router table, countersink →
  drill press, floor fillet → CNC ball-nose], 5 flags.
- Bugs found and fixed in this round: a chamfer on a circular
  edge is a CONE, not a plane (small cones are reclassified as
  chamfers); a countersink's top circle was emitted as a spurious
  THROUGH_CUT (hole-coaxial circles are now skipped regardless of
  radius); outer-wall circles are taken from top/bottom faces only
  (taking them from all Z faces made blind-hole bottom discs and
  counterbore floors delete 3 holes from the machined test);
  wire edges whose parametrisation runs opposite the wire created
  phantom chords that mislocated features and could flip DXF arcs
  — `wire_segments` / `wire_sample_points` now orient every edge
  to the wire direction (machined DXF profile arcs verified as
  correct 90° R8 arcs after the fix).

Regressions after this round (all clean): test_part 8 layers /
6 holes / 3 pockets / 1 flag; machined 9 layers / 8 holes /
4 pockets / 10 flags (tapered wall now one entry, floor Z 8.00);
container multi 5 layers / 0 flags; two_part 6 layers / 0 flags.

Option B — toolpath template (only if your depths are standard):
import the layered DXF, load a VCarve toolpath template that
maps each layer to a toolpath. Works, but a template stores
fixed depths, so it breaks on arbitrary depths. That's why
the gadget exists.

## Units

Everything is mm in v1. If your CAD document is in inches,
export STEP in mm, or run with `--scale 25.4` (not yet
implemented — tell me and I'll add it).
Z-up, Z=0 at the bottom of the stock, Z=top at the top face.
VCarve job: Z-zero at top of material, matching the manifest
(depths are measured down from the top face).
