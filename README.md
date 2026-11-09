# Onshape -> VCarve Pro, automated (2.5D, prismatic)

No £50/month app. This is the custom pipeline, built for Brandon.

## What it does

```
Onshape (prismatic solid, bevels NOT yet added)
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
  exports STEP, so you can verify the recognizer without Onshape
- `featurescript/CAM_Snapshot.fs` — Onshape custom feature, insert
  before your first bevel/chamfer/fillet. Groups Z levels in-tree
  and creates one CAM_* sketch per Z level (v0.2 — grouping and
  sketch creation are now written, not a stub; still needs a live
  Onshape test before trusting it on a real part, and the
  UNVERIFIED-marked API calls in the file are the things to check).
- `vcarve/Onshape25D.lua` — VCarve Pro gadget (Lua). Reads
  manifest.txt, imports the DXF named on its `# dxf:` line, joins
  vectors, creates drill / pocket / profile toolpaths per layer with
  start_depth / cut_depth from the manifest. v0.2 — implemented from
  the Vectric SDK docs and syntax-checked, but NOT yet run inside
  VCarve. It does not save the job or post G-code; preview, then
  File > Save As the `.crv` yourself.
- `VALIDATION.md` — the ready-to-run checklist for the real container
  STEP (BRA-8), including the regression commands and the Windows
  gadget / Onshape FeatureScript test steps.
- `test/` — outputs from the synthetic test model

## Can I open something directly in VCarve, with toolpaths?

Short answer: not as a `.crv` file written from Python. VCarve's
`.crv` format is proprietary and undocumented — there is no supported
way to write one outside VCarve itself.

The supported way to get a `.crv` *with toolpaths* is the Lua gadget
in `vcarve/Onshape25D.lua`: run it inside VCarve, it imports the DXF,
creates the toolpaths from `manifest.txt`, and recalculates. One click
in VCarve, instead of dozens of manual toolpaths — then you preview
and save the `.crv` yourself (the gadget deliberately does not save
the job or post G-code).

That gadget is v0.2 — implemented from the Vectric SDK docs
(ToolpathManager + VectricJob pages, jimandi.com/SDK mirror) and
syntax-checked with luaparser, but it has not been run inside VCarve
yet (no VCarve on this Linux VM). The two least-certain calls,
`GetFileName()` and `JoinVectors()`, are guarded so the gadget fails
with a message instead of silently doing the wrong thing.
Until it is tested on Windows, the verified path is:

1. `step_to_vcarve.py` → layered DXF + manifest.json
2. VCarve: File > Import > Import Vectors, pick the DXF
3. One toolpath per layer, using manifest.json for start/cut depth
4. Preview, save `.crv`, post G-code

That is 8 toolpaths for the test part, not 40 — the complexity is
already in the vectors.

## Multiple parts in one scene — and CAM direction may not match Onshape

A Part Studio often holds several parts laid out logically, e.g. a
container with a top and a bottom that fit together. Two things follow:

1. **CAM direction is per-part, not per-scene.** The bottom is cut
   face-up. The lid may be modelled upside-down in the scene, or its
   mating face is its bottom — you cut it flipped over, so its CAM
   top is its Onshape bottom face. The tool must not assume the
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
and Top are concentric in the Onshape scene, so scene XY would put
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
`vcarve/Onshape25D.lua` — edit once, reuse for every model.
You can run it for drills only, skip the profile, preview without
saving, etc. Nothing is all-or-nothing.

## Tool plan — recommendations, not a library (built 2026-11-08, BRA-12)

Brandon has no automatic tool changer and does not want to maintain
a tool library (bits wear out and get replaced). So the pipeline
does not ask for one. Instead `toolplan.py` recommends tools from
standard sizes — his bits are imperial Bits & Bits wood bits,
1/16"–1/2", any given bit may be missing — and the manifest carries
the recommendation plus fallback plans:

- **Per layer:** drills get an exact-diameter drill as primary and
  an endmill bore (largest standard endmill that fits inside the
  hole) as fallback. Pockets get the largest standard endmill that
  fits the narrowest spot; profiles get the largest that fits (outer
  profiles take any size, slots must fit the slot).
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
  material leaves as chips. The tab count is not settable through
  the documented ProfileParameterData fields; the gadget tries it in
  a guarded call and VCarve's default applies if ignored.
- **Matching to your VCarve library:** the SDK has no silent
  lookup-by-diameter — `ToolDatabase` only offers `SelectTool()`
  (interactive dialog) and `GetTool(id)`. So gadget v0.3 asks once
  per distinct tool to pick the matching tool from your library;
  Cancel uses the recommendation as-is (a tool created with the
  recommended diameter/feeds). It warns in the final message if the
  tool you picked differs in diameter from the recommendation.
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

Linux / Mac:

```bash
cd ~/workspace/cnc-onshape-vcarve
python3 -m venv .venv
.venv/bin/pip install build123d ezdxf
.venv/bin/python make_test_model.py
.venv/bin/python step_to_vcarve.py test/test_part.step -o test/out
# -> test/out/test_part.dxf
# -> test/out/manifest.json
# -> test/out/manifest.txt  (for the VCarve gadget)
# -> test/out/report.md
```

Windows (Brandon's preference, 2026-11-08 — one machine for Python
and VCarve, no file shuffling between computers):

1. Install Python 3.12 from python.org, checking **"Add python to
   PATH"** (the classic gotcha — without it, `python` is not found).
2. Clone the repo somewhere short, e.g. `C:\cnc\onshape-vcarve-2.5d`.
3. Double-click `setup_windows.bat`. It creates `.venv`, installs
   build123d + ezdxf, and smoke-tests the classifier on the synthetic
   test part (expect: 8 layers, 6 holes, 3 pockets, 1 flag).
4. Per model: `run_vcarve.bat container.step container_out` — that
   runs `multi_part.py --auto` and writes the DXF, manifest and
   report into `container_out`. Read `report.md` first.
5. The DXF/manifest are already on the VCarve machine, so the gadget
   (or manual DXF import) picks them up from the same disk — copy
   `vcarve/Onshape25D.lua` to
   `C:\Users\Public\Documents\Vectric\VCarve Pro\Gadgets\Onshape25D\`
   once, restart VCarve.

The scripts are pure Python + build123d/ezdxf — no Linux-specific
calls — so they run identically on Windows. No GPU is used; the
classifier is CPU-only and fast (seconds for the test models, ~1
minute for the 978-face Kookabus file).

Then in Onshape, for a real part:

1. Model all prismatic features. Do NOT add bevels/chamfers yet.
2. Insert the CAM Snapshot feature (or roll back / version at
   this point).
3. Add bevels/chamfers after it, for the router table.
4. Export the prismatic solid as STEP, in **mm**.
   Onshape API: POST .../partstudios/.../translations,
   formatName STEP, poll until DONE. Or File > Export in the UI.
5. Run `step_to_vcarve.py part.step -o out/`
6. Read `report.md` first. Anything flagged, check before cutting.

## Naming convention (the contract between the two sides)

Layers in the DXF, and entries in manifest.json:

- `PROFILE_THRU` — outer profile, cut through
- `POCKET_D6.00` — pocket, start 0.00, cut 6.00
- `POCKET_D9.00_START6.00` — pocket-in-pocket, start 6.00, cut 3.00
- `DRILL_D6.00_THRU` — through holes, Ø6.00
- `DRILL_D8.00_D5.00` — blind holes, Ø8.00, depth 5.00

`manifest.json` is the source of truth for the VCarve gadget.
The DXF layer name alone is human-readable; the gadget reads
the manifest, not the layer name, for depths.

## VCarve side

Option A — gadget (recommended for dozens of depths):
Gadgets > Onshape25D, pick manifest.txt. It imports the DXF named
on the manifest's `# dxf:` line, joins vectors, creates toolpaths
in order drill -> pockets shallow to deep -> profile last,
recalculates all. It does not save the job or post G-code —
preview, File > Save As the `.crv`, then post. Always preview
before posting G-code.

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
  penalties) + 15 per HOLE NOT FROM TOP flag (a hole with no
  toolpath — that orientation needs a double-sided job or
  extensive post-processing) + post-processing penalties per
  method (cnc_3d 10, decision_needed 5, hand_router 3,
  drill_press 3, router_table 2) + 60 if no standard tool plan
  exists. Weights are config `orientation_penalties`. No
  special-casing for magnets or insides-up: the difference falls
  out of the penalties — the flipped container is FASTER on the
  clock (3.5 vs 5.6 min) because it skips the Bottom's 8 magnet
  holes, so cut-time-only scoring would pick the wrong
  orientation. The flipped orientation is priced, not
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
- Layout: bottom-align (Zmin = 0), pack side by side in a row,
  largest footprint first, gap from config (default 10 mm).
- `parts.json` entries still override per part (any flip/rotate
  key, or `"auto": false`).
- Single-part: `step_to_vcarve.py --auto-orient` still uses the
  `auto_orient.py` heuristic for v1 (dominant axis >50% + best
  side up by opening area); the search is the multi-part path.

Verified 2026-11-09: the container STEP rotated 90 deg about X
(`test/rotated_container.step`) searches back to the exact
`parts.container.json` result — Bottom +Z, Top -Z, 5 layers,
0 flags. The real container with `--auto` gives 8 layers / 6
flags, Plan A 2 changes / 5.6 min, Bottom +Z / Top -Z — the same
as the explicit parts.json flip. The 8-part test now orients the
sideways block to +X and reads it exactly (15x10x4 pocket,
D5 thru hole, 0 flags) — 8 parts, 22 layers, 4 flags, Plan A 1
change / 9.0 min. Kookabus is classify-only (no `--auto` search
— 6x ~90 s per part is too slow); it does not crash.
Runtime note: the search runs the classifier up to 6 times per
part, so the 8-part test takes ~4 minutes.

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

Everything is mm in v1. If your Onshape document is in inches,
export STEP in mm, or run with `--scale 25.4` (not yet
implemented — tell me and I'll add it).
Z-up, Z=0 at the bottom of the stock, Z=top at the top face.
VCarve job: Z-zero at top of material, matching the manifest
(depths are measured down from the top face).
