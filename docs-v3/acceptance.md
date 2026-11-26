# V3 acceptance record — V3.10

Owner: V3.10 acceptance worker. Date: 2026-11-25. Status: **ACCEPTANCE
INCOMPLETE — see §0.** Tree: `~/workspace/multi_layer_dxf`
(VERSION 2.0.0, unpushed; no local `.git`). Scope: `V3_SCOPE.md` §8,
`V3_BACKLOG.md` "TRIAGED V3.10". Run log:
`hidden_files/v310_run.log`; battery log:
`hidden_files/battery_v310_2026-11-25.log`.

## 0. Verdict — read this first

V3.10 does **not** close green. Three things stand between this tree
and "V3 done", and none of them is a defect in the cutting path:

1. **The live cut (§8.4) is blocked on Brandon.** No dry run and no
   real part cut from V3 G-code — both need his Foreman. Nothing was
   faked. This is the §8 gate that only he can close.
2. **Three harness checks fail (DOM 80/82, E2E 24/25) on one root
   cause:** the design loop's in-flight round-1 edit changed the
   toolpaths UI to human-readable operation labels ("Pocket",
   "Drill", "Profile"), and three harness assertions still expect
   the old rendering (lowercase operation names in the timeline,
   raw layer ids in the highlighted row). Seeking and row
   highlighting themselves work — the move indices are right and
   exactly one row highlights, on the right operation. The fix
   belongs to the design loop (update the three assertions to the
   new labels, or revert the label change); it is not a product
   defect, and it was not fixed here because the files are the
   design loop's hot files (see §2).
3. **The website walkthrough re-render is deferred** (design loop
   still editing the Job Prep UI — see §7).

Everything else in §8 that can be checked on this VM was checked
and holds: the full battery except those three checks (§1), the
G-code evidence on the real container across all three posts with
both refusal paths re-proven (§3), toolpaths + sim verification
(§4), tabs agreement (§5), the §8.1 numbers unmoved (§6), and the
plan-vs-actual time reconciliation (§6.1) that V3.4 left for V3.10.

## 0A. Refresh — 2026-11-26: cutting path re-verified on the current tree

This section is new; everything above (§0–§10) is the Nov 25
record, kept as history and not rewritten. The Nov 25 numbers went
stale after the Nov 25 landings (kerf/usable-area semantics, margin
15 mm, contact-balance guides, Z-zero), so the cutting-path
verification was re-run from scratch on the current tree. Run log:
`hidden_files/v310r_run.log`; battery log:
`hidden_files/battery_v310r_2026-11-26.log`; scripts
`~/workspace/v310r_refusals.py`, `~/workspace/v310r_repost.py`.

### 0A.1 Evidence job

Fresh job **`20261126-175634-real-container`**, home
`~/workspace/v310r-home` (a scratch copy of the parity fixture
`hidden_files/parity_2026-11-23/home/` — clamps, machine,
preferences, tools only; no carried-over jobs). Flow: `mldxf plan
test/real_container.step --auto` (rc 0, 6m52s — slower than Nov 25's
2m47s; an AgentTS merge was sharing the CPUs) → `mldxf guides` →
`mldxf toolpaths` → `mldxf sim --verify` → `mldxf gcode` × 3 →
`mldxf gcode --verify` × 3. The gadget was never run and VCarve
never opened for this job.

What moved since the Nov 25 evidence job (§3):

| Item | Nov 25 (§3) | Nov 26 (this refresh) |
|---|---|---|
| Layout | (20,20) / (83.7,20) | **(21.35, 21.35) / (85.05, 21.35)** |
| Suggested material | 150×90 | **160×90×10** |
| Clamp margin | 20 mm | **15 mm** (fixed clamp-space number; kerf-only inset) |
| Guides | "restrained" at (135,6)+(15,84) | **(70,6)+(125,84), verdict UNPROVEN** (contact-balance model, V3.16 — see §0A.2) |
| Job Z-zero | bottom frame in the view | **`top`** (recorded as `job.z_zero`, source: home preferences) |
| Plan A total | 464.1 s / 7.7 min | **unchanged: 464.1 s / 7.7 min** (cutting 224.1 s + 2 changes × 120 s) |
| Motion time | 221.7 s | **222.3 s** (the layout moved the paths) |
| Sim probes | 6,618 | **6,617** (0 failed, 0 gouge — one fewer probe on the new layout) |

Toolpaths: 14 ops / 220 moves (66 rapid, 86 feed, 68 arc), stock
top 9.5 mm, clearance 14.5 mm — same shape as Nov 25. Tabs:
`# tabs: P01_P01__PROFILE_THRU|3|5.0|1.0` and
`# tabs: P02_P02__PROFILE_THRU|3|5.0|1.0`, positions s = 27.41,
82.231, 137.052 mm on both profiles — unchanged. Independent
checker (`~/workspace/v31-spike/check_toolpaths.py`): **PASS, 0
failures** (profile offset min 3.175 mm as intended, 68 arc moves
of 220).

### 0A.2 Guides — UNPROVEN, and what that means for the dry run

Placement **(70,6) on the y=6 slot + (125,84) on the y=84 slot**,
verdict **UNPROVEN**. Worst cut 2.58 N at (24.16, 33.56) on
`P01_P01__PROFILE_THRU` — the bottom-left cut Brandon described
Nov 25. The balance demands **30.47 N of hold-down at (70,6)** and
7.42 N at (125,84) (safety factor 2.0, μ 0.2); the test clamp's
hold-down force is **unrated — unmeasured, not small**. Origin
keep-out 23.012 mm. `sides_without_slot: ["left"]` — the fixture
has no left slot, so four-side placement is impossible on it and
the balance says so.

**Read this plainly: the placement is unproven, not proven.** The
dry run must not treat the guides as a safety proof. The air cut
(`docs-v3/dry_run_foreman.md` step 4) is where a shift would
show — watch the bottom-left of the sheet, where the worst cut
acts with the longest lever about the far clamp. Do not cut from
this file before the dry run, and do not present the guides as
having passed anything.

### 0A.3 Posted files — all verified

| Post | File | Lines | sha256 | Round-trip (band+cluster) | Verified |
|---|---|---|---|---|---|
| masso-mm | `gcode/20261126-175634-real-container-masso-mm.nc` | 247 | `4cff6b844e5d4926272065e76f1bc77c2ba662fc51a56aaf48de7578e65aa70a` | 0 / 5,760,000 mismatched, max cluster 0 | true |
| masso-inch | `gcode/20261126-175634-real-container-masso-inch.nc` | 247 | `201f5b1b04632583275f97b640e57098c1a9d30a581ce3d22a3df5a1e220cbff` | 28 after band, max cluster 1 | true |
| grbl | `gcode/20261126-175634-real-container-grbl.nc` | 250 | `e7f53fe8dd40d2b86c4af7f7b954f37b1a90f802861ac0e773274673d703639d` | 0 / 5,760,000 mismatched, max cluster 0 | true |

`mldxf gcode --verify` rc 0 for all three posts (shas match the
recorded entries). Column count is 5,760,000 now (was 5,400,000)
because the sheet is 160×90, not 150×90. The inch post's
28-after-band / max cluster 1 is the same calibrated shape V3.6
recorded — sub-column rounding fuzz, not a translation error.
Re-posting masso-mm on a scratch copy reproduces the file
**byte-identical** (sha `4cff6b844e5d…`).

Z-zero (headers + file scan): every header states
`(Z-zero: TOP of material. Zero X/Y at the sheet corner, Z on the stock top.)`
and `(Stock top 9.5 mm (job Z); clearance 5.000 mm above Z-zero.)`.
First motion `G0 X23.850 Y44.350 Z5.000` (was X22.500 Y43.000 —
the layout moved); last lines `M5`, `G0 X0.000 Y0.000`, `M30`.
Min/max Z: masso-mm −9.500 / +5.000. Tool changes in cut order:
T2 Drill 2.25 mm, T1 End Mill 1/8in, T3 End Mill 1/4in, all
20,000 rpm. Feeds unchanged: drill plunge 240 mm/min; EM3.17 feed
952.8 mm/min, plunge 317.4 mm/min; EM6.35 feed 1800 mm/min,
plunge 600 mm/min.

`mldxf sim --verify` on the fresh job: **PASS** — pitch
0.05 mm, **6,617 probes, 0 failed, 0 gouge columns**; sim ran in
7,985 ms (58.118× real time). Delta log: 8 chunks, 3,294,017
entries, 39,528,444 bytes; checkpoints at move 0 and move 220,
cut time 222.34 s.

### 0A.4 Refusal paths — re-proven on the new job

All three on scratch copies of the new evidence job
(`~/workspace/v310r-refuse-*`; the evidence job itself is
untouched — its three shas still match the recorded entries):

- **Corrupted file → sha mismatch.** Appended a tampered
  `G1 X10.000 Y10.000 Z-9.500 F1800` to the grbl `.nc`:
  first `mldxf gcode --verify --post grbl` → rc 1,
  `gcode_sha_mismatch` (on-disk `1d4cbf27575f…` vs recorded
  `e7f53fe8dd40…`); entry flipped to `verified: false`.
  Second `--verify` → rc 1 again, now `gcode_unverified`
  (35,870 columns after the band, max 9.5 mm — the same 35,870
  figure V3.10 recorded for the same tamper).
- **Moved toolpath → re-sim mismatch.** One pocket feed move
  +5 mm in X, in `job.json` + `manifest.json`, file bytes
  unchanged (`P01_P01__POCKET_D1.50`, x 65.763 → 70.763):
  `mldxf gcode --verify --post masso-mm` → rc 1,
  `gcode_unverified` (66,432 of 5,760,000 columns differ after
  the band, largest cluster 66,432, max 1.499978 mm); entry
  flipped to `verified: false`. Note: V3.10 recorded 66,323
  for the same +5 mm move on the old layout — the count moved
  because the layout moved, not because the check changed; the
  refusal shape is identical.
- **Limits refused, never clamped.** Both drill ops'
  `feed_mm_s` 4 → 300 (18,000 mm/min) in `job.json` +
  `manifest.json`, re-post masso-mm → rc 1,
  `post_limit_exceeded` ("feed 18000.0 mm/min exceeds masso-mm
  max feed 10160 mm/min — refused, not clamped"); all three
  `.nc` files and all three entries byte-identical afterwards.

### 0A.5 The other four reference jobs — V3.6 shas reproduced exactly

Scratch copies of `~/workspace/v31-jobs/{real_container,machined,
eight_parts,kookabus}` (workspace copies, not /tmp — the Kookabus
job alone is ~343 MB and /tmp is a 512 MB tmpfs): `sim --verify`
then `mldxf gcode --post masso-mm` each. All four sim-verified
(0 failed, 0 gouge) and all four posted verified with
**byte-identical shas to V3.6's record**:

| Job | Masso-mm sha (first 12) | Lines / moves parsed | Round-trip |
|---|---|---|---|
| real_container | `76568a9bd476` | 185 / 159 | 0 / 5,400,000 |
| machined | `a0e612d15ee0` | 442 / 420 | 0 / 3,840,000 |
| eight_parts | `92ffedba49f6` | 1185 / 1155 | 0 / 23,200,000 |
| kookabus | `6f334a90d572` | 75953 / 75923 | 0 / 7,050,000 |

Full Kookabus sha:
`6f334a90d572c325a36976f20a7c689213cdc8ea0808ef814020cf4b3ce44c98`.
Nothing else moved: the Nov 25 landings (layout, guides, Z-zero)
touch the plan and the fresh job, not the stored toolpaths these
re-posts replay.

### 0A.6 Battery — GREEN, 531 checks, 0 failures

Run 2026-11-26 ~18:23–19:18 UTC, sequential legs, own homes/ports
throughout (v25 3137, v28 8511, DOM 3939/3940/9246, E2E
3941/3942/9247, probe 3943/3944/9248; v25 home
`~/workspace/v310r-v25-home`, v28 home
`~/workspace/v310r-v28-home`, copied harnesses with HOME+LOG lines
only; v24 workdir `~/workspace/v310r-v24-work`). The
toolpath-vs-clamp collision-check worker's probe #2 ran
concurrently on disjoint homes/ports/profiles (4895/4896/9323,
`HOME=fakehome`) and edited nothing during the battery — the
tree's last edit stayed `ts/clamp_check.ts` / `ts/view3d/entry.ts` /
`ts/view3d/build.ts` 2026-11-26 18:01 UTC from battery start to
close, so the battery ran on a quiet tree.

| Leg | Result |
|---|---|
| verify_v25 | **81/81** |
| verify_v28 | **127/127** |
| verify_v24 | **31/31** |
| job-prep DOM harness | **86/86** |
| job-prep E2E | **25/25** |
| view3d render probe | **33/33** |
| bun test | **116/116** (20,057 expect() calls, 6 files) |
| tsc | **clean, exit 0** |
| config checks | **32/32** |

Total: **531 pass, 0 fail** (tsc clean/not counted). Zero `FAIL`
lines in `hidden_files/battery_v310r_2026-11-26.log`. No battery
ports listening at close. No shipped code was changed in this
refresh — only the three docs (this §0A in acceptance.md,
dry_run_foreman.md, release-notes-v3.0.0-draft.md).

One reconciliation from the probe leg: the open "sim CPU-fallback
defect" (no CPU fallback when the GPU path throws) is **closed by
evidence, not by this refresh**. The probe passes `GPU fallback:
status names the CPU fallback, not "Sim failed"` and `seeked final
stock is still the final stock`, and `ts/view3d/entry.ts` carries
the labelled fallback ("the CPU fallback is labelled, never
silent", "status reports the fallback honestly instead of 'Sim
failed'"). The fallback landed in the design-loop/fix-round work
since the defect was filed; this battery proves it live.

### 0A.7 Status changes since §0 was written (no edits to §0)

- §0 item 2 (the three stale harness assertions) is **closed**:
  the design loop's round-2 coordinator battery (2026-11-25 00:05
  PST, `hidden_files/battery_v3r2_2026-11-24.log`) is fully green,
  476/476 — the three assertions already carry the new intended
  text in the repo; no fix round was needed.
- §0 item 3 (website walkthrough re-render) is **closed**: the
  walkthrough was re-rendered 2026-11-25 23:22 PT
  (`files/V3_WEBSITE_WALKTHROUGH.html`, 12 screenshots, job
  `20261126-071911-real-container`).
- Still open, all Brandon-blocked: the Foreman dry run + live cut
  (§8.4 — the file to run is now the §0A.3 masso-mm file, see
  `docs-v3/dry_run_foreman.md`), the `.pp` evaluation (V3.7a),
  GPU ≥500× sim, the V3.11 rename decision.

## 1. Acceptance battery — 473/476 checks, 3 failures, 0 other defects

Sequential legs, own homes/ports throughout (the Nov 24/25
collisions came from sharing the default v28 home — not repeated
here). No other mldxf session was running when the legs started
(checked `ss`/`ps` 2026-11-25 06:59 UTC).

| Leg | Command / ports | Result |
|---|---|---|
| verify_v25 | `python3 /tmp/v310-verify_v25.py --port 3127`, home `~/workspace/v310-v25-home` (copied harness, HOME+LOG lines only) | **81/81** |
| verify_v28 | `python3 /tmp/v310-verify_v28.py --port 8501`, home `~/workspace/v310-v28-home` (copied harness, HOME+LOG lines only) | **115/115** |
| verify_v24 | `python3 verify_v24.py --workdir /tmp/v310-v24-work` | **31/31** |
| job-prep DOM harness | `bun server/run-job-prep-e2e.ts --mode dom --app-port 3919 --proxy-port 3920 --debug-port 9236` | **80/82 — 2 fail (§2)** |
| job-prep E2E | `bun server/run-job-prep-e2e.ts --mode e2e --app-port 3921 --proxy-port 3922 --debug-port 9237` | **24/25 — 1 fail (§2)** |
| view3d render probe | `bun server/run-view3d-probe.ts --app-port 3923 --proxy-port 3924 --debug-port 9238` | **24/24** |
| bun test | `bun test` | **91/91** |
| tsc | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **clean, exit 0** |
| config checks (extra, not in the standard battery) | `python3 test_mldxf_config.py` | **27/27** |

Total: **473 pass, 3 fail** (476 counted checks; tsc is clean/not
counted). No battery ports listening at close. No shipped code was
changed in this wave.

### Tree-changed-mid-battery (recorded, not hidden)

The design-loop round-1 fixer edited all four of its hot files
**during** this battery: `server/public/job-prep.js` 07:10:52 UTC,
`style.css` 07:10:22, `jobs.js` 07:11:42, `ts/view3d/entry.ts`
07:14:07 (md5s differ from the run-start recording; the mtimes
above are the post-edit times, unchanged since). This worker edited
none of them. Consequence for reading the table: verify_v25 ran on
the pre-edit tree; verify_v28 / verify_v24 straddled the edit
window; DOM / E2E / probe / bun test / tsc ran on the post-edit
tree. The three failures are post-edit results, against the tree
as the fixer left it.

## 2. The three failures — one root cause, behaviour correct

Failing checks (DOM re-run reproduces identically, 80/82 both
times — deterministic, not environmental):

- DOM: `v3.3 scrub seeks by move index and highlights the operation row`
- DOM: `v3.3 jump-to-operation seeks to the operation`
- E2E: `e2e jump-to-operation seeks to the last operation`

Root cause, proven with a scratch CDP probe
(`/tmp/v310-dom-probe.ts`, no shipped file edited — probe log in
the battery log): the view's timeline now renders the
design loop's human label (`humanOpLabel` in `ts/view3d/entry.ts`,
comment-marked "(m1)", `VIEW3D_VERSION` 4 → 5) — "Pocket",
"Drill", "Profile" — and the toolpaths table rows now show the
same short label instead of the raw layer id. The harness asserts
the old rendering case-sensitively: `tl.indexOf('pocket')`,
`tl.indexOf('drill')`, `tl.indexOf('profile')`, and
`rows[0].textContent.indexOf('P01_P01__POCKET_D1.50')` /
`('PROFILE_THRU')`.

Probe evidence (live harness page, `?mode=dom`):

- Scrub to 4: timeline `Move 5/5 · Pocket · Ø3.17 · P01 · 0:03.7 / 0:12.2`
  — move index correct, "Pocket" capitalised, lowercase 'pocket'
  absent. Exactly **1** `.tp-row-current` row, and it is the pocket
  row: `pocketPocket · Ø3.17 · P01EM3.17rough #03 (1 rapid, 1 feed, 1 arc)`
  — full row text, no `P01_P01__POCKET_D1.50` anywhere in it.
- Jump to operation 0: timeline `Move 1/5 · Drill · Ø2.25 · P01 · 0:00.0 / 0:12.2`
  — move index correct, "Drill" capitalised.
- E2E jump to operation 13: timeline
  `Move 201/220 · Profile · Ø6.35 · P02 · 3:28.5 / 3:41.7` — the
  last operation, correct move, "Profile" capitalised.

So seeking lands on the right move and the highlight lands on the
right row; only the assertions' text expectations are stale. The
harness elsewhere already asserts the new style
(`e2e layer plane rows are short labels with the full id as a tooltip`
passes), which is consistent with the label change being
deliberate. The three stale assertions need the design loop's call
(update them to the human labels, or revert the labels) — and the
DOM + E2E legs need a re-run against the landed tree after that
call. This worker did not touch the harness expectations: the
harness is the acceptance oracle, and weakening it mid-round to
match an in-flight edit would hide the change.

## 3. G-code acceptance evidence — fresh job, all three posts

Evidence job (fresh on this tree, home `~/workspace/v310-home`):
**`20261125-073936-real-container`** — `test/real_container.step`,
`--auto`, Plan A, 14 operations / 220 moves (66 rapid, 86 feed,
68 arc), stock top 9.5 mm, clearance 14.5 mm. Flow: `mldxf plan`
(rc 0, 2m47s) → `mldxf toolpaths` → `mldxf sim --verify`
(§4) → `mldxf gcode` × 3. The gadget was never run and VCarve
never opened for this job (§8.6).

### 3.1 Posted files — all verified

| Post | File | Lines | sha256 | Round-trip (band+cluster) | Verified |
|---|---|---|---|---|---|
| masso-mm | `gcode/20261125-073936-real-container-masso-mm.nc` | 247 | `0347dd03d6083e3e77744842ae5703ce1e5e411d116514aa3abebdd115faa2d6` | 0 / 5,400,000 mismatched, max cluster 0 | true |
| masso-inch | `gcode/20261125-073936-real-container-masso-inch.nc` | 247 | `a85803a24db8d3784a3a62689b1cb7b7d655194fe51cf6372b5f81ee14d2c99f` | 28 after band, max cluster 1 | true |
| grbl | `gcode/20261125-073936-real-container-grbl.nc` | 250 | `02dc308b8e11acb0ce67b6e996b0b5e67f3dd560f98c7df640f9a9f1d13d4abd` | 0 / 5,400,000 mismatched, max cluster 0 | true |

`mldxf gcode --verify` rc 0 for all three posts (shas match the
recorded entries). Re-posting masso-mm reproduces the same bytes
and sha (`0347dd03d608…`). The inch post's 28-after-band / max
cluster 1 is the same calibrated shape V3.6 recorded (784 raw
flips → 28 → cluster 1) — sub-column rounding fuzz, not a
translation error. The masso-mm sha differs from the V3.6
reference sha (`e8a2014103b4…`) because this is a different job id
(the header carries the job id); the reference fixture's files
are untouched — see §3.4.

Z-zero (headers + file scan): every header states
`(Z-zero: TOP of material. Zero X/Y at the sheet corner, Z on the stock top.)`
and `(Stock top 9.5 mm (job Z); clearance 5.000 mm above Z-zero.)`.
First motion `G0 X22.500 Y43.000 Z5.000`; last lines `M5`,
`G0 X0.000 Y0.000`, `M30`. Min/max Z: masso-mm −9.500 / +5.000,
grbl −9.500 / +5.000, masso-inch −0.3740 / +0.1969 in
(= −9.5 / +5.0 mm). Tool changes in cut order: T2 Drill 2.25 mm,
T1 End Mill 1/8in, T3 End Mill 1/4in, all 20,000 rpm.

### 3.2 Refusal paths — re-proven on scratch copies (evidence job untouched)

All three on copies of the evidence job (`/tmp/v310-refuse-*`,
removed after):

- **Corrupted file → sha mismatch.** Appended a tampered
  `G1 X10.000 Y10.000 Z-9.500 F1800` to the grbl `.nc`:
  first `mldxf gcode --verify --post grbl` → rc 1,
  `gcode_sha_mismatch` (on-disk `ef7091f71eea…` vs recorded
  `02dc308b8e11…`); entry flipped to `verified: false` with the
  on-disk sha recorded. Second `--verify` → rc 1 again, now
  `gcode_unverified` (the round-trip fails on the tampered move:
  35,870 columns after the band, max 9.5 mm) — the refusal is
  stable; the sha check having passed on the second run is the
  designed behaviour (the first run records the on-disk sha),
  not a pass.
- **Moved toolpath → re-sim mismatch.** One pocket feed move
  +5 mm in X, in `job.json` + `manifest.json`, file bytes
  unchanged: `mldxf gcode --verify --post masso-mm` → rc 1,
  `gcode_unverified` (66,323 of 5,400,000 columns differ after
  the band, largest cluster 66,323, max 1.499978 mm); entry
  flipped to `verified: false`. Same 66,323 figure V3.8 recorded
  for the same +5 mm move — reproduced exactly.
- **Limits refused, never clamped.** Drill `feed_mm_s` 4 → 300
  (18,000 mm/min) in `job.json` + `manifest.json`, re-post
  masso-mm → rc 1, `post_limit_exceeded` ("feed 18000.0 mm/min
  exceeds masso-mm max feed 10160 mm/min — refused, not
  clamped"); all three `.nc` files and all three entries
  byte-identical afterwards.

The v28 leg independently re-proved the same three refusal shapes
on this tree (§1, 115/115 — its §11 checks).

### 3.3 The other four reference jobs — re-posted, V3.6 shas reproduced exactly

Scratch copies of `~/workspace/v31-jobs/{real_container,machined,
eight_parts,kookabus}` (v3, toolpaths present, no `sim`/`gcode`
yet): `sim --verify` then `mldxf gcode --post masso-mm` each.
All four sim-verified (0 failed probes, 0 gouge) and all four
posted verified with **byte-identical shas to V3.6's record**
(first 12 shown; full shas in the run log):

| Job | Ops / moves | sim --verify | Masso-mm sha (first 12) | Lines / moves parsed | Round-trip |
|---|---|---|---|---|---|
| real_container | 10 / 158 | pitch 0.05, 3509 probes, 0 failed, 0 gouge | `76568a9bd476` | 185 / 159 | 0 / 5,400,000 |
| machined | 19 / 419 | pitch 0.05, 3628 probes, 0 failed, 0 gouge | `a0e612d15ee0` | 442 / 420 | 0 / 3,840,000 |
| eight_parts | 66 / 1154 | pitch 0.05, 3285 probes, 0 failed, 0 gouge | `92ffedba49f6` | 1185 / 1155 | 0 / 23,200,000 |
| kookabus | 335 / 75922 | pitch 0.1 coarse, 2874 probes, 0 failed, 0 gouge | `6f334a90d572` | 75953 / 75923 | 0 / 7,050,000 |

Full kookabus sha:
`6f334a90d572c325a36976f20a7c689213cdc8ea0808ef814020cf4b3ce44c98`.
Full shas for the other three are in the run log. Incident (not a
product failure): the first kookabus copy failed with `No space
left on device` — `/tmp` is a 512M tmpfs and the 343 MB job plus
the other scratch copies filled it; re-ran from a workspace copy
and it passed. Scratch copies removed after; the evidence job is
kept at `~/workspace/v310-home`.

### 3.4 Reference fixture intact (read-only check)

`~/workspace/v31-verify-home/jobs/20261124-160834-real-container`
(the V3.6 acceptance job named in `docs-v3/dry_run_foreman.md`)
was not mutated: masso-mm `e8a2014103b4…` and masso-inch
`30519a0b2db8…` both match on disk, both `verified: true`. The
dry-run file and its sha in the dry-run doc are still the verified
ones.

## 4. Toolpaths + simulation — fresh job

- Toolpaths: 14 ops / 220 moves, 0 skipped loops, deterministic
  (re-generation byte-identical — asserted by the v28 leg on the
  same job shape, 14 ops / 220 moves).
- Independent checker (`~/workspace/v31-spike/check_toolpaths.py`,
  ezdxf-based, no TS code): **PASS, 0 failures** on the fresh
  evidence job (profile offset min 3.175 mm as intended, 68 arc
  moves of 220).
- `mldxf sim --verify` on the fresh job: **PASS** — pitch
  0.05 mm, **6,618 probes, 0 failed, 0 gouge columns**; re-running
  it leaves `job.json` bytes untouched (sha identical before/after).
  The `sim` section records pitch 0.05, stock top 9.5 mm, and the
  delta log (8 chunks, 3,154,748 entries, 37,857,216 bytes;
  checkpoints at move 0 and move 220, cut time 221.7 s).
- Sim speed / seek (V3.4/V3.5 record, cited — this run's view3d
  probe leg re-exercised the sim end-to-end, 24/24, including sim
  completing, seek to moves 0/100/220 showing uncut/partial/final
  stock, and the GPU→CPU fallback): CPU backend ≥50× real time
  confirmed (slowest eight_parts 78×; container 209×, Kookabus
  3812× — `docs-v3/sim.md`); seek worst 359 ms < 1 s on all five
  jobs; Kookabus delta log 330.8 MB within the 500 MB budget
  (`docs-v3/sim_seek.md`); ball-nose and V-bit simulated on
  synthetic tools, proving the tool model plugs in (`docs-v3/sim.md`).
- GPU ≥500× real time: **UNMEASURED on this VM** — WebGPU here is
  SwiftShader (software), 7–13×, which `docs-v3/sim_gpu.md` says
  explicitly is not a GPU result. Needs Brandon's Windows laptop
  + the ready probe (`bun server/run-webgpu-sim-probe.ts`). The
  VCarve sim baseline is likewise unmeasured (needs his
  machine/timing). No SwiftShader number is presented as a GPU
  result anywhere in this record.

## 5. Tabs — gadget path and in-house path agree (§8.5)

Fresh evidence job, re-proven (not copied from V3.1):

- `manifest.txt`: `# tabs: P01_P01__PROFILE_THRU|3|5.0|1.0` and
  `# tabs: P02_P02__PROFILE_THRU|3|5.0|1.0`.
- `toolpaths` bottom profile passes, both parts: count 3,
  length 5.0 mm, thickness 1.0 mm, positions s = 27.41, 82.231,
  137.052 mm.
- The independent checker verifies tabs vs manifest (PASS, §4).

## 6. §8.1 numbers unmoved — confirmed on this tree

| Job | Expected (§8.1) | Measured this run | How |
|---|---|---|---|
| container, Plan A | 3 tools / 7.0 min | 3 tools, 418.8 s = 7.0 min | fresh `--auto` plan, evidence job |
| Kookabus merged, Plan A | 215.1 min | 12,904.1 s = 215.07 min | v31 reference job's plan (planner untouched by V3) |
| eight_parts, Plan A | 9.0 min | 542.3 s = 9.04 min, 2 tools, 1 change, 8 parts, 22 layers, 4 flags | fresh `--auto` plan (`20261125-074443-eight-parts`, 6m35s) |

Note on eight_parts: the older v31 reference job shows Plan A
584.0 s = 9.73 min — that job was planned with `auto: False`, i.e.
the heuristic orientation, and the §4 note says exactly that
("was 1 change / 9.7 min under the heuristic — the correct
orientation gives cleaner layers"). It is not a regression; the
`--auto` run above gives 9.04 min.

### 6.1 Plan vs actual cut time — reconciled (V3.4 left this for V3.10)

Motion time from the tool's own duration model
(`ts/view3d/model.ts` `flattenToolpaths` — feed/plunge per move,
arcs by true length, rapids at 50 mm/s; scratch script
`/tmp/v310-cuttime.ts`). The plan's per-layer cutting estimate
understates the generated motion on every job; the plan total
(estimate + 120 s per tool change, an assumption, not a
measurement) understates the whole job by 1–44%.

| Job | Plan cut-est | Motion | Δ vs cut-est | Plan total | Motion + changes | Δ vs total |
|---|---|---|---|---|---|---|
| fresh container (14/220) | 178.8 s | 221.7 s | +42.9 s (+24.0%) | 418.8 s (7.0 min) | 461.7 s | +10.2% |
| real_container (10/158) | 146.0 s | 167.6 s | +21.6 s (+14.8%) | 386.0 s (6.4 min) | 407.6 s | +5.6% |
| machined (19/419) | 224.5 s | 228.8 s | +4.3 s (+1.9%) | 344.5 s (5.7 min) | 348.8 s | +1.3% |
| eight_parts (66/1154, heuristic plan) | 464.0 s | 722.4 s | +258.4 s (+55.7%) | 584.0 s (9.7 min) | 842.4 s | +44.3% |
| kookabus (335/75922) | 12,664.1 s | 16,922.8 s | +4,258.7 s (+33.6%) | 12,904.1 s (215.1 min) | 17,162.8 s | +33.0% |

Reading: the motion time is exact for the moves as generated
(ramps, entry traversals, retracts, the V3.4 fix-round's flat
traversals on every ring run). The plan's cutting estimate is the
planner's per-layer model, which never saw those moves. The gap
grows with pocket/ring count (eight_parts, Kookabus) and is small
on the machined job. The headline plan numbers (§8.1) are still
the numbers — they are the planner's estimates, and they have not
moved — but they are estimates: a job quoted at 215.1 min takes
~282 min of motion plus tool changes by the toolpath clock. The
live cut (§8.4) is the measurement that will settle what the
machine actually takes; until then the toolpath-derived motion
time is the honest number to quote alongside the plan. No code
was changed to close this gap — it is a planner-estimate
limitation, filed here as a known limit (§8), not silently
absorbed into the plan numbers.

## 7. Deferred and blocked — not done, not faked

| Item | Blocker (exact) |
|---|---|
| Foreman dry run (§8.4) | Needs Brandon's Onefinity Elite Foreman + his time. Procedure + file + sha are in `docs-v3/dry_run_foreman.md` (job `20261124-160834-real-container`, masso-mm `e8a2014103b4…`, 247 lines). Nothing run, nothing simulated as done. |
| Live cut from V3 G-code (§8.4) | Same blocker — the dry run first, then a real part. Budget for the fix round V1's/V2's live tests needed (§10.3). |
| Website walkthrough re-render | **DEFERRED by task direction.** The design-loop round-1 fixer is actively editing the Job Prep UI (`job-prep.js`/`style.css` hot as of Nov 25 ~06:00 UTC, edited again 07:10–07:14 UTC during this battery). Re-rendering now would capture a half-fixed UI. The screenshot runner (`bun server/run-screenshots.ts`) was NOT run; `files/V3_WEBSITE_WALKTHROUGH.html` was NOT touched (mtime 2026-11-25 06:47:41 UTC). Re-render after the design loop's round lands. |
| V3.7a `.pp` evaluation | Blocked on Brandon's two `.pp` files (Onefinity Masso (inch) Latest V6, (mm) Latest V3) + VCarve version + stock-vs-customised word — see `docs-v3/pp_evaluation.md` §7. Prep document only, no findings. V3.7b interpreter: not designed, not built, gated. |
| GPU ≥500× sim (§5.4) | Unmeasured here (SwiftShader only — §4). Needs Brandon's Windows laptop + the ready probe. |
| VCarve sim baseline (§5.4) | Unmeasured — needs Brandon's machine/timing. |
| V3.11 rename decision | Brandon decides; not build work. |
| V3.9 port (OCCT.js) | Moved to V4 (Brandon, Nov 24, 2026). No port work in V3. |

## 8. Known limits carried forward (honest list)

- **Hold force unknown.** The guides report the worst-case force
  (2.58 N on the container fixture) with status "unknown —
  verify by hand" (V3.13). Restraint is now modelled (opposing
  edges required, `restrained` / `restrained-with-warning` /
  `unrestrained`, named refusal `guides_unrestrained`), but the
  actual hold of the test clamp is still unverified by hand.
- **Finish pass destroys tabs (latent, V3.1/V3.4).** A finish pass
  (allowance > 0) traverses at zBot and would destroy tabs. No
  reference job has a profile finish op, so it does not affect
  this acceptance; recorded in `docs-v3/sim.md` ("Latent, NOT
  fixed"). A V3.1 follow-up.
- **Kookabus D0.60 loops.** 9 of 10 `POCKET_D0.60` loops are
  skipped `tool_too_large` (0.50 mm tool cannot fit 0.42–0.49 mm
  channels); loop 9 stays cut (0.50 mm tool fits a 0.533 mm
  channel, disc-over-cut max 0.0066 mm). Needs a smaller tool or
  a different strategy; uncut material by design of the current
  plan.
- **Classifier defect — DXF ARC spans can be frame-mirrored.**
  The generator carries the repair (`repairArcsInLayer` /
  `repairArcSpans`); the classifier itself is untouched. Filed as
  its own item, not fixed here.
- **Kookabus THROUGH_CUT loop 1 (1.438 mm slot).** Erosion
  self-intersects at tight bends; through-cuts use centred passes
  so unaffected, but a pocket ring sequence on such a loop would
  end early.
- **Plan times are estimates (§6.1).** The planner's cutting
  estimate understates generated motion by 2–56% per job; the
  toolpath-derived motion time is the number to quote alongside
  the plan until the live cut measures the real machine time.
- **No-sim-section round-trip fallback.** A job with no `sim`
  section still verifies through `prepareSim`'s derived stock
  (documented in `docs-v3/post_config.md` §4) — a real
  translation check, not a pass-through, but the recorded-stock
  path is the stronger one.
- **Preferences VCarve post name (V3.8 trade-off).** The
  Preferences "Post processor" field now records a native post
  id; the VCarve `.pp` name for the gadget path is no longer
  recorded anywhere. If the gadget path ever needs it again, it
  needs its own field.
- **`.pp` files are not a V3 path unless V3.7a gates them in**
  (§7). Native Masso (inch/mm) + GRBL + template posts are the
  shipped path.
- **The §4 suite's 25 manual steps were not re-run step-by-step
  in this wave.** The battery legs re-prove the §4 headline
  numbers (§6) and the regression checks the verify scripts
  encode; a full manual 25-step re-run was last done at V2
  (VALIDATION.md §4). The numbers the suite asserts have not
  moved per §6.
- **Guides refuse on placeholder T-track slots** (correct
  behaviour — Brandon's real measurements still open, V2
  carry-forward).

## 9. §8 item-by-item

| §8 | Item | Status |
|---|---|---|
| 8.1 | §4 suite green, numbers unmoved | **Holds** — §6 (container 7.0, Kookabus 215.1, eight_parts 9.0 on this tree; full 25-step manual re-run not done — §8 limit above) |
| 8.2 | Toolpaths generated + verified by simulation (container, machined plate, eight_parts, Kookabus) | **Holds** — §4 + §3.3 (sim --verify PASS on all five, 0 failed, 0 gouge; determinism asserted by v28 leg) |
| 8.3 | Sim quality + speed + seek | **Holds except GPU** — CPU ≥50× confirmed, ball-nose + V-bit simulated, seek < 1 s, CPU/GPU stock equality per V3.5 (band+cluster); GPU ≥500× **unmeasured** (§4) |
| 8.4 | G-code posted + dry-run + live cut | **Partial** — posted + round-trip verified (§3); dry run + live cut **blocked on Brandon** (§7) |
| 8.5 | Gadget and in-house paths agree on tabs | **Holds** — §5 |
| 8.6 | VCarve optional, gadget still works | **Holds** — evidence job went STEP → G-code with no gadget/VCarve; gadget path unchanged (manifest.txt frozen, asserted by v25/v28 legs) |
| 8.7 | Docs + release | **This record + the release-notes draft** (`docs-v3/release-notes-v3.0.0-draft.md`); README / VALIDATION / CHANGELOG / VERSION 3.0.0 updates and the tag + release page are release steps, not done here (no tag/release in this wave) |
| 8.8 | Design judging stays blinded | No design judging in this wave |

## 10. Files and evidence locations

- This record: `docs-v3/acceptance.md`.
- Release notes draft (notes only, no tag/release):
  `docs-v3/release-notes-v3.0.0-draft.md`.
- Run log: `~/workspace/goals/onshape-to-vcarve-2-5d-automation/hidden_files/v310_run.log`.
- Battery log: `~/workspace/goals/onshape-to-vcarve-2-5d-automation/hidden_files/battery_v310_2026-11-25.log`.
- Evidence home (kept): `~/workspace/v310-home` — job
  `20261125-073936-real-container` (toolpaths, sim, gcode × 3
  verified) and job `20261125-074443-eight-parts` (fresh --auto
  plan, 9.04 min).
- Battery homes (kept): `~/workspace/v310-v25-home`,
  `~/workspace/v310-v28-home`.
- Scratch copies (removed after use): `/tmp/v310-refuse-*`,
  `/tmp/v310-repost-*`, `~/workspace/v310-repost-kookabus`,
  `/tmp/v310-verify_v25.log`, `/tmp/v310-verify_v28.log`,
  `/tmp/v310-dom-probe.ts`, `/tmp/v310-cuttime.ts` (scratch
  scripts, kept in /tmp for the record).
- Hot files NOT touched: `server/public/job-prep.js`, `jobs.js`,
  `style.css`, `ts/view3d/entry.ts` — edited during this battery
  only by the design-loop fixer (§1). Screenshot runner NOT run;
  `files/V3_WEBSITE_WALKTHROUGH.html` NOT touched. No push, tag,
  or release. No edits to `BACKLOG.md`, `V3_SCOPE.md`, or
  `V3_BACKLOG.md`.
