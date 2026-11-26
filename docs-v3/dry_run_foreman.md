# Dry run on the Foreman — V3.10 acceptance (§8.4)

Status: **NOT RUN YET — needs Brandon's machine.** Nothing in this
doc is a dry-run result. It names the exact file, how to reproduce
and verify it, and the procedure to run on the Onefinity Elite
Foreman (Masso). Do not cut from any other file, and do not cut
before the dry run below.

**Refresh 2026-11-26:** the file below supersedes the V3.6 file
(job `20261124-160834-real-container`, masso-mm
`e8a2014103b4…`). The V3.6 job still exists untouched at
`~/workspace/v31-verify-home/jobs/20261124-160834-real-container`
as the V3.6 reference — but it is **not** the file to cut from.
The current file is the refreshed V3.10 acceptance job, re-verified
2026-11-26 on the current tree (layout, margin, guides, and Z-zero
all moved since V3.6 — see `docs-v3/acceptance.md` §0A).

## The file

- **Job:** `20261126-175634-real-container` — the 8-layer real
  container, plan A, 14 operations, 220 moves (66 rapid, 86 feed,
  68 arc). Parts: P01 46×46×9.5 mm, P02 46×46×8.0 mm, on a
  160×90 mm sheet, stock top 9.5 mm. Layout (21.35, 21.35) /
  (85.05, 21.35), clamp margin 15 mm.
- **Post:** `masso-mm` (Onefinity Masso, mm — the default post).
- **File:** `gcode/20261126-175634-real-container-masso-mm.nc`,
  247 lines.
- **sha256:**
  `4cff6b844e5d4926272065e76f1bc77c2ba662fc51a56aaf48de7578e65aa70a`
- **Verified:** round-trip re-simulated — 0 mismatched columns /
  5,760,000 (pitch 0.05 mm, tolerance 0.1 mm). See
  `docs-v3/gcode.md` §7 for what the stamp means. `mldxf gcode
  --verify` rc 0 on all three posts; re-posting masso-mm
  reproduces the file byte-identical.
- **Home:** the job lives under the scratch home
  `~/workspace/v310r-home/jobs/20261126-175634-real-container`
  (a copy of the parity fixture — see `docs-v3/acceptance.md`
  §0A.1). That home is kept.

Reproduce it (deterministic — same bytes, same sha):

```
mldxf gcode <job-dir>            # default post is masso-mm
sha256sum <job-dir>/gcode/20261126-175634-real-container-masso-mm.nc
```

If the sha differs, stop — the file on disk is not the verified
one. The inch variant (`masso-inch`, same job) is
`gcode/20261126-175634-real-container-masso-inch.nc`, sha256
`201f5b1b04632583275f97b640e57098c1a9d30a581ce3d22a3df5a1e220cbff`;
use it only if the Masso is set to inch units. The mm file carries `G21`; the controller must be in
mm mode for it, inch mode for the inch file — a units mismatch
cuts 25.4× wrong, so check the mode before loading.

## What the file assumes

- **Z-zero is the TOP of the material.** Zero X/Y at the sheet
  corner, Z on the stock top. The file's clearance is Z+5.000
  (5 mm above the stock top); the deepest cut is Z−9.500 (the
  stock bottom). If Z is zeroed on the spoilboard instead, every
  cut runs 9.5 mm too deep. The job records `z_zero: top`.
- **Work offset G54.** The file selects G54 and assumes it holds
  the sheet-corner zero above.
- **Tools, in cut order:** T2 — Drill 2.25 mm; T1 — End Mill
  1/8in (3.175 mm); T3 — End Mill 1/4in (6.35 mm). All at
  20,000 rpm. Feeds: drill plunge 240 mm/min; EM3.17 feed
  952.8 mm/min, plunge 317.4 mm/min; EM6.35 feed 1800 mm/min,
  plunge 600 mm/min. The first move is the drill at
  (23.850, 44.350).
- **Tool changes are manual:** the file issues `T<n> M6` and
  the Masso moves to the change position and waits — change the
  bit, press cycle start. There is no ATC and no G43: tool
  length offsets live in the Masso tool table, set by the
  operator for each tool before the run.
- **No coolant words, no canned cycles.** Drills are explicit
  peck moves (G1 plunges), not G83.
- **Workholding is UNPROVEN — do not treat the guides as a safety
  proof.** The file's job records two test clamps at (70,6) and
  (125,84) with verdict **UNPROVEN**: the worst cut demands
  30.47 N of hold-down and the test clamp's hold-down force is
  unrated (unmeasured, not small). The fixture has no left slot,
  so four-side placement is impossible on it. Clamp the sheet
  the way you would for a real cut — at least one clamp on every
  side when your slots allow — and watch the bottom-left of the
  sheet during the air cut, where the worst cut acts with the
  longest lever about the far clamp. See
  `docs-v3/acceptance.md` §0A.2.

## Dry-run procedure

1. **Verify the file.** `sha256sum` the file against the hash
   above. Read the header comment lines (post, job, Z-zero,
   clearance) and confirm they match this doc. Skim the first
   and last 20 lines: the first motion must be
   `G0 X23.850 Y44.350 Z5.000`, the last lines `M5`, park
   `G0 X0.000 Y0.000`, `M30`.
2. **Mount the stock.** 160×90 mm sheet, 10 mm nominal
   (stock top 9.5 mm in the job — the two parts are 9.5 and
   8.0 mm tall; the sim's stock top is the max part height,
   9.5 mm). Clamp clear of the cut area: the parts span
   x 21.35–131.05 mm, y 21.35–67.35 mm; the profile cuts run
   outside the outlines by one tool radius (3.175 mm), so the
   kerf reaches x 18.175–134.225 mm. See the workholding note
   above — the recorded placement is unproven.
3. **Load the tools and set the Masso tool table** for T1/T2/T3
   (length offsets), then set the G54 zero: X/Y at the sheet
   corner, Z on the stock top.
4. **Air cut first.** Run the whole file with the spindle OFF
   and Z raised — use the Masso's dry-run / Z-offset facility
   so the tool stays clear of the stock for the full program —
   and watch the path: the drill pecks at (23.85, 44.35), the pocket
   and profile paths around the two 46 mm squares, three tool
   changes (T2 → T1 → T3), and the park to (0, 0) at the end.
   Anything that does not match the plan (a move off the sheet,
   a plunge where a rapid should be, a missed tool change) is a
   stop-and-report, not a continue.
5. **Cut.** Spindle on, Z at the real zero, same file, no edits.
   Stay at the machine for the first tool change at least — the
   manual change is the step the file cannot verify by itself.
6. **Record the outcome here** (date, file sha, what happened):
   air cut clean / cut clean / problem (with the line number
   and the observed move). A problem goes back to the V3.10
   worker with the file and the line — do not hand-edit the
   .nc and re-cut.

## What the dry run cannot prove

The round-trip proves the posted file replays the toolpaths
through the sim. It does not prove the Masso interprets every
word the way the post intends (M6 stop behaviour, M30 end,
G54 persistence), the tool table is right, or the stock is
where G54 says it is. That is what the air cut is for — and
why step 4 runs before any material is cut. It also does not
prove the workholding: the guides' verdict on this job is
UNPROVEN, so the air cut is the only check that the sheet stays
put.
