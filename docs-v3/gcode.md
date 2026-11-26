# V3.6 — G-code export + native post-processors

Owner: V3.6. Status: landed 2026-11-24 (unpushed; VERSION 2.0.0).
Posts: Onefinity Masso (mm + inch), GRBL (generic hobby), template.
The acceptance G-code file is the real container through Masso-mm;
see `docs-v3/dry_run_foreman.md` for the dry-run procedure (the dry
run itself needs Brandon's Foreman — it cannot run on this VM and
was not faked).

## 1. Post model

A post-processor is a TypeScript module: hooks + machine limits.

- Hooks (`ts/posts/common.ts`, `PostHooks`): `header`, `toolChange`,
  `rapid`, `linear`, `arc`, `plunge` (a feed move whose XY does not
  change — the post uses the plunge feed for it), `spindle`,
  `coolant` (all shipped posts return no coolant words — no coolant
  hardware is assumed), `footer`. Moves in, G-code out.
- Limits (`MachineLimits`): `maxFeedMmMin`, `maxSpindleRpm`,
  `zTravelMm`, `units` (mm/inch), `bedMm` (or null — no bed limit
  when the post does not name one).
- The shared core `postJob` (`ts/posts/common.ts`) walks the job's
  toolpath moves, converts coordinates, enforces limits, and calls
  the hooks. A per-post module defines only its hooks + limits +
  units — a third machine is a new post module, not a generator
  change. Registry: `ts/posts/index.ts` — `POSTS`,
  `DEFAULT_POST_ID = "masso-mm"`, `listPosts()`, `getPost()`
  (unknown id → `post_unknown`, exit 1).

The tool model is `ts/tools.ts` (V3.4); feeds/speeds come from the
toolpath operations (`feed_mm_s`, `plunge_mm_s`, `spindle_rpm`) —
the post never invents a feed. A Z-only feed move uses
`plunge_mm_s`; an XY feed or arc uses `feed_mm_s`. Rapids carry no
F word. F is emitted on every G1/G2/G3 line (in post units/min).

## 2. Posts shipped

| Post | Units | Tool change | Spindle | End |
|---|---|---|---|---|
| `masso-mm` | mm (G21) | `T<n> M6` — Masso moves to the change position and waits for cycle start (manual change, no ATC) | `M3 S<rpm>` | `M5`, park `G0 X0 Y0`, `M30` |
| `masso-inch` | inch (G20) | same | same | same |
| `grbl` | mm (G21) | stock GRBL has no M6 behaviour: `M5`, then `M0 (Change tool to …)` pause; T appears as a comment only | `M3 S<rpm>` | same |
| `template` | mm (G21) | M0 pause, like GRBL | `M3 S<rpm>` | same |

Header (all posts): `G90 G17 G20/G21 G94 G40 G54`, plus comment
lines stating the post, the job, the Z-zero convention, and the
dry-run pointer. **No G43/G49 is ever emitted** — Masso does not
support G43 (Onefinity forum, Tool Change Syntax); tool length
offsets are the operator's Masso tool-table job, not the post's.
No canned cycles are emitted (see §5).

### Machine limits (enforced, never clamped)

A move exceeding a limit is REFUSED with the named error
`post_limit_exceeded` (exit 1) — never silently clamped. The
limits are also applied to the job itself: machine Z may never go
below the stock bottom or above clearance, the job's Z span
(clearance − 0) may not exceed Z travel, and the job's XY travel
span may not exceed the bed when the post names one. The XY
check is a SPAN check (max−min over move endpoints plus arc
bounding boxes), not an absolute-position check: the file's X/Y
are job coordinates relative to the sheet corner and the sheet
can sit anywhere on the bed, so an absolute check would refuse
valid off-origin jobs (the machined job's sheet sits at
(−60,−40) and its X runs to −63 — valid on a 1222 mm bed; what
the post enforces is that the 135 mm travel fits). Sheet
placement is the operator's job. A tool without a plan entry or
without a `tool_number` is `post_tool_missing` (never guessed);
a job with no operations is `post_no_toolpaths`.

| Post | maxFeed | maxSpindle | Z travel | Bed |
|---|---|---|---|---|
| Masso mm/inch | 10,160 mm/min | 30,000 rpm | 165 mm | 1222.4 × 1222.4 mm |
| GRBL / template | 5,000 mm/min | 24,000 rpm | 100 mm | — (none named) |

Sources for the Masso row (Onefinity Elite Foreman): Z-20 slider
165 mm travel, rapids X/Y 400 ipm (10,160 mm/min), Z 300 ipm
(7,620 mm/min) — Onefinity Elite manual p.16 / MindKits listing;
bed 1222.4 × 1222.4 mm; spindle 30,000 rpm is the Makita RT0701C
top speed (10k–30k range). The GRBL/template row is generic
defaults, not measurements — a real machine's post replaces them
with its own numbers. The Z-travel limit is enforced against the
job's Z span; the rapid rate is a feed limit on cutting moves,
not a claim about the machine's rapid rate.

## 3. Z model — the dangerous conversion

Toolpaths use Z=0 at the **stock bottom**; the machine's Z-zero
is the **top of the material** (V3_SCOPE.md §6). The post
converts every Z as:

```
machineZ = jobZ − stockTop        (stockTop = max part z_top)
```

X/Y are unchanged. The operator zeroes X/Y at the sheet corner
and Z on the stock top — stated in every emitted header and in
the dry-run doc. Worked numbers for the reference container
(stock top 9.5 mm): clearance 14.5 → machine **+5.000**; a pocket
floor at job Z 8.0 → **−1.500**; the cut bottom (job Z 0) →
**−9.500**. A cut below the stock bottom (machine Z below
−stockTop) is refused, not clamped.

## 4. Selection

Precedence: `--post` flag > the job's
`machine_profile.post_processor` > the home `machine.json`
`post_processor` > the default `masso-mm`. The effective post is
recorded back into the job's `machine_profile.post_processor`
(when `machine_profile` is a dict). `machine.json` gains
`post_processor` — the field is already defined as
`machine_profile.post_processor: string | null` in
`docs-v3/job_model_v3.md` §7; V3.6 fills it, it does not
redefine it.

## 5. Drills — explicit pecks, not canned cycles

The generator already emits exact peck moves for drills, and the
posts emit them as plain G1 plunges. Masso's canned-cycle support
was PROVEN from the official docs, not assumed:
`docs.masso.com.au/supported-g-codes` lists G73/G81/G82/G83, and
the G83 page (`.../supported-g-codes/g83-peck-drilling-for-deeper-holes`)
specifies `G83 X Y Z R Q K F`, modal, cancelled by G80.

The posts ship explicit pecks anyway, and G83 stays a documented
future option: explicit moves make the round-trip exact (the
parser replays the moves as written), while G83's R/Q/G98 modal
semantics add translation risk with no benefit on 1.55 mm-deep
holes. If a later wave emits G83, the parser must gain canned
cycles first (it currently refuses them — see §8).

## 6. CLI + API + UI

- CLI: `mldxf gcode <job-dir> [--post <post-id>] [--json]`
  (replaces the V3.6 refusal `gcode_unavailable`). Follows the
  `mldxf toolpaths` / `mldxf sim --verify` patterns: the TS
  driver (`ts/gcode.ts`, Bun) posts + verifies; the CLI merges
  the entry into job.json + manifest.json (byte-identical,
  canonical form, validated before publishing via a temp file).
  One entry per post run — a re-post replaces the same
  `post_id`'s entry. The file is listed in `outputs`; the
  effective post is recorded in `machine_profile.post_processor`.
  `mldxf job` lists the runs (post, file, stamp, short sha,
  generated_at).
- API: `POST /api/jobs/:id/gcode` (optional JSON body
  `{"post": "<post-id>"}`), 1:1 with the CLI — 202 + SSE +
  status, following `POST /api/jobs/:id/toolpaths`. A v1 job, or
  a job with no toolpaths yet, is refused synchronously with
  `toolpaths_unavailable` (400); a running job with
  `job_already_running` (409). `GET /api/jobs` list entries
  carry `summary.gcode` (null when never posted).
  Download: `/api/jobs/:id/download/gcode/<job>-<post>.nc` —
  the route accepts multi-segment paths (each segment checked
  against `SAFE_FILE`, `..` refused), and the file must be in
  the job's `outputs`.
- UI (job-prep tab, `server/public/job-prep.js`, following the
  V3.2 Toolpaths section): a G-code section after Toolpaths —
  post selector (default: the job's `machine_profile.post_processor`,
  else `masso-mm`), Generate button, one row per post run (post,
  download link with per-segment URL encoding, verified stamp,
  generated_at, short sha), the Z-zero convention, and the
  dry-run note. A job with no toolpaths says "Generate toolpaths
  first" and gets no button; a v1 job is read-only. A refusal
  lands inline in the section; an unverified round-trip reloads
  the job so the UNVERIFIED entry is visible next to the error.

## 7. Round-trip verification (§6.4)

The posted file is parsed back (`ts/gcode_parse.ts`) and
re-simulated through the V3.4 dexel engine (`ts/sim.ts`); the
resulting stock must match the toolpath sim. Both sims run on
the same stock and pitch — and that stock is the RECORDED one
(`sim.stock`, job_model_v3 §6.2: recorded, not re-derived), not
prepareSim's fresh derivation: the machined job's sheet sits at
(−60,−40), and prepareSim without geometry bounds anchors the
stock at (0,0), a stock that does not even cover the cuts. When
the job has no `sim` section yet, the round-trip falls back to
prepareSim's derivation. The pitch is likewise the recorded
`sim.pitch_mm` when present. The verdict is recorded
per post run in `job.json` `gcode[].verified`.

### Why exact column equality is the wrong criterion

A post rounds every coordinate (mm posts to 0.001 mm, inch posts
to 0.0001 in = 0.00254 mm), and the sim samples arcs as chords
whose phase depends on the arc radius in the 6th decimal. A
column grazing a cut boundary — within ~0.003 mm of the tool
edge, e.g. on the profile ramp's outer edge — flips between the
two sims when the rounding moves the chord phase. The mm posts
verify with 0 flipped columns because their rounding (0.001 mm)
leaves no column in the flip band on the reference jobs; the
inch post flips 784 raw columns out of 5,400,000 (0.015%) on the
reference container — all of them grazing-boundary flips, not
translation errors. So the comparison is two stages, both
reported in the round-trip numbers (`ts/gcode_verify.ts`):

1. **Band:** a column counts as mismatched only when its height
   is outside the 3×3 neighbourhood's height range (± tolerance)
   in the OTHER grid, checked both directions. This excuses a
   cut edge that moved by less than one column — the post's
   rounding (0.0025 mm) and the sim's chord sagitta (pitch/4)
   are far inside one column, so a genuine translation
   difference cannot hide here: it moves an edge or a region,
   not a single column's neighbourhood. Inch on the container:
   784 raw → 28 after the band.
2. **Cluster:** the surviving mismatches must be isolated
   singles — the largest 4-connected cluster of mismatched
   columns must be ≤ 3 (`ROUND_TRIP_MAX_CLUSTER`). Rounding
   fuzz flips isolated columns (observed largest cluster 1 on
   the reference container, inch); any real error produces a
   contiguous run along the moved edge or region.

Tolerance is pitch + 0.05 mm (the same tolerance
`ts/sim_verify.ts` uses). The criterion was calibrated against
deliberate breakage on the reference container (all through
`roundTripVerify`, inch post):

| Case | Raw mismatched | After band | Largest cluster | Verdict |
|---|---|---|---|---|
| masso-mm (honest) | 0 | 0 | 0 | verified |
| masso-inch (honest) | 784 | 28 | 1 | verified |
| Every X +0.06 mm | 25,929 | 1,021 | 22 | **not verified** |
| Every Z −0.2 mm | 1,854,514 | 1,852,972 | 702,896 | **not verified** |
| File truncated to 70% | 1,059,304 | 1,058,814 | 448,601 | **not verified** |

A 0.06 mm path shift — 25× the inch rounding — still fails
(max cluster 22 vs the bar of 3), so the criterion is not a
blanket excuse: it excuses sub-column fuzz and nothing else.
The raw counts are recorded alongside the verdict
(`rawMismatched`, `mismatched`, `clusters`, `maxCluster`,
`maxDiffMm`) so the stamp is auditable, never just a boolean.

### Unverified handling

On a round-trip mismatch the TS driver still writes the file
and prints JSON with the entry (`verified: false`) and the
round-trip numbers, exit 1; the CLI merges the unverified
entry + `outputs`, validates, publishes, then fails
`gcode_unverified` (exit 1). The file is downloadable for
inspection and shown as UNVERIFIED — never presented as ready
to run. In `--json` mode the CLI prints nothing before the
error (a single stdout JSON object, so the server's `runCliJob`
parses it cleanly); in human mode it prints the file and the
numbers first. Limit / unknown-post / tool failures write no
file and no entry.

### Determinism, rerun

Re-posting the same job through the same post reproduces the
same bytes and sha256 (no timestamp in the file; `generated_at`
lives in the job.json entry only). `mldxf rerun` rebuilds the
job and drops the `sim`/`gcode` sections and files — re-post
after a rerun.

## 8. Parser coverage (`ts/gcode_parse.ts`)

The parser handles exactly what the posts emit — no more, no
less. Covered: G0/G1/G2/G3 + X/Y/Z, arcs I/J incremental
(including helical arcs), modal motion/position/feed, G90 (G91
refused), G17 (G18/G19 refused), G20/G21 (required before first
motion), G94, G40, G54–G59, G80; M0/M1, M3/M5, T+M6, M9, M30;
`(...)` comments (nesting-aware strip, unbalanced parens are an
error) and `;` comments; N numbers; tool identity from the
`(Tool change: <id> …)` comment, falling back to the plan
T-number map. NOT covered — a named `gcode_parse_unsupported`
refusal: canned cycles G73/G81/G82/G83, G41/G42, G43/G49, G4,
G38.x, subprograms, G28/G30/G53, G92, G68, G95, G93. Motion
before any tool change, or before any units word, is a
`gcode_parse_error`. The parser converts machine coordinates
back to job coordinates (machine Z + stockTop) and returns
moves in job space for the re-simulation.

## 9. Files

- `ts/posts/common.ts` — post core (`postJob`, `PostDef` /
  `PostHooks` / `MachineLimits` / `JobIn`, `PostError`).
- `ts/posts/masso.ts` — `MASSO_MM`, `MASSO_INCH`.
- `ts/posts/grbl.ts` — `GRBL`.
- `ts/posts/template.ts` — `TEMPLATE` (worked example; its
  header says how to copy it for a new machine).
- `ts/posts/index.ts` — registry.
- `ts/gcode_parse.ts`, `ts/gcode_verify.ts` — parser + the
  band/cluster comparison.
- `ts/gcode.ts` — Bun driver (`bun ts/gcode.ts <job-dir> --post
  <id> [--json]`): loads the job, requires v1 toolpaths
  (`toolpaths_unavailable`), posts, writes
  `gcode/<job-id>-<post-id>.nc`, parses back, round-trips,
  prints one JSON object; exit 0 verified, 1 named failure
  (including `gcode_unverified`), 2 internal.
- `ts/gcode.test.ts` — 20 bun tests (headers, Z conversion,
  inch conversion, tool changes, limit refusals, parser
  round-trip + refusals). The full round-trip sim comparison
  runs against real jobs through the CLI, not here.
- `ts/validate_job.ts` — `validateGcode` shape check (replaces
  the V3.6-absent rejection, exactly as V3.4 did for `sim`):
  array; each entry `post_id` non-empty string, `file` string,
  `sha256` 64-hex, `verified` boolean, `generated_at` ISO
  string; duplicate `post_id` invalid; `gcode` requires
  toolpaths. File existence is NOT checked (the CLI validates
  the merged job from a temp file).
- `mldxf.py` — `cmd_gcode` + `_run_gcode_subprocess` +
  `_resolve_post_id`; `mldxf job` lists the runs.
- `server/server.ts` — `POST /api/jobs/:id/gcode`,
  `startGcodeRun`, multi-segment download route,
  `summary.gcode` in job-list entries.
- `server/public/job-prep.js` — `buildGcode` + `runGcode` /
  `pollGcodeStatus` (mirrors the Toolpaths section).
- `docs-v3/job_model_v3.md` — §6.1 filled, §10 item 5 now
  shape-checks `gcode`, §12 no longer lists `gcode` as
  not-in-v3 (the `verified` stamp enforcement is V3.8's).

## 10. Acceptance (2026-11-24)

Reference container
`~/workspace/v31-verify-home/jobs/20261124-160834-real-container/`
(14 ops / 220 moves, pitch 0.05, stock top 9.5 mm), posted
through all four posts via `mldxf gcode`; all four verified.
Masso-mm sha256
`e8a2014103b4fe2d64985617961a3a429d5dd39072c19a6025be1c0d6a89a3fc`
(247 lines; re-post byte-identical). Masso-inch: 784 raw flips
→ 28 after the band → largest cluster 1 → verified. The other
four reference jobs were posted through Masso-mm via the driver
on scratch copies (the reference jobs are fixtures — never
mutated in place) and verified with 0 mismatched columns:

| Job | Ops / moves | Pitch | Round-trip | sha (first 12) |
|---|---|---|---|---|
| `real_container` | 10 / 158 | 0.05 | 0 mismatched | `76568a9bd476` |
| `machined` | 19 / 419 | 0.05 | 0 mismatched | `a0e612d15ee0` |
| `eight_parts` | 66 / 1154 | 0.05 | 0 mismatched | `92ffedba49f6` |
| `kookabus` | 335 / 75922 | 0.1 | 0 mismatched | `6f334a90d572` |

`mldxf sim --verify` still passes on all five, and the
independent checker still passes on all five (the generator was
not touched). Two real defects were found and fixed while
posting these jobs (2026-11-24): the bed check compared raw job
coordinates against 0–bed and refused the off-origin machined
job — it is now a travel-span check (see §2); and the
round-trip built its grid from prepareSim's derived stock,
which anchors off-origin jobs at (0,0) — it now uses the
recorded `sim.stock` (see §7).
