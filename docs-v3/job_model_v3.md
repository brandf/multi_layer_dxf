# job.json v3 — the job model (V3.2)

V3_SCOPE.md §2.2 reserves this shape ("V3 adds a `toolpaths` section
to this same file"); this doc is the formal record of what v3 is,
written after V3.1 produced the first real `toolpaths` sections.
It is the contract V3.3 (3D view), V3.4 (sim) and V3.6 (G-code) build
against. Anything that contradicts this doc is wrong; anything this
doc leaves open is decided by the item that fills it (V3.4 for `sim`,
V3.6 for `gcode`), not by improvisation here.

Validator: `ts/validate_job.ts` (Bun) — `mldxf validate-job <job-dir>`
runs it, and `mldxf toolpaths` runs it on the merged job before
publishing. The validator is the executable form of this doc: where
the doc and the validator disagree, the validator is the bug (file
it), not the doc — fix the validator, do not quietly relax the doc.

## 1. Versions

| `job_version` | Meaning |
|---|---|
| 1 | v1 job: `manifest.json` only, no `job.json`. Read-only. No toolpaths, no rerun, no guides. |
| 2 | v2 job: `job.json` (V2.2 model — embedded inputs + config snapshot + `workholding`). No `toolpaths` key. A complete job on its own. |
| 3 | v3 job: a v2 job **plus** a `toolpaths` section. Presence of `toolpaths` IS the v3 marker. |

Invariants:

- **`toolpaths` present ⟺ `job_version` 3.** A job with `toolpaths`
  and `job_version` 2 is invalid; a job with `job_version` 3 and no
  `toolpaths` is invalid. (A v2 job never gains toolpaths silently:
  `mldxf plan` and `mldxf rerun` never generate them — only
  `mldxf toolpaths` does, and `mldxf rerun` on a v3 job
  regenerates them from the replayed job and requires them to be
  byte-identical to the old section, see §6.)
- **v2 keys are unchanged in meaning.** Every key a v2 job carries
  (`layers`, `tool_plan`, `layout`, `cut_order`, `flags`,
  `config_snapshot`, `machine_profile`, `workholding`,
  `registration_pins`, `outputs`, `inputs_embedded`,
  `source_step[_sha256]`, `created_at`, `cli_version`, `job_id`)
  keeps its V2 meaning in a v3 job. V3 adds keys; it renames,
  retypes, or reinterprets none.
- **`manifest.txt` is frozen.** The gadget contract is byte-stable:
  `mldxf toolpaths`, `mldxf rerun`, and validation never write
  `manifest.txt`. A v1.0.1 gadget runs a v3 job unchanged (the
  gadget reads `manifest.txt` only).
- **`manifest.json` is a byte-identical copy of `job.json`.**
  (V2 rule, unchanged.) The `toolpaths` section is in both, because
  it is in `job.json`.
- **Determinism.** Same job + same config snapshot → identical
  `toolpaths` (all coordinates rounded to 0.001 mm, no timestamps,
  no randomness). Rerun reproduces the section byte-for-byte (§6).

## 2. `toolpaths` (present in v3, absent in v2)

Produced by `ts/toolpaths.ts` via `mldxf toolpaths <job-dir>` from
the job's DXF + `job.json` (layers with `est` geometry, chosen plan,
`cut_order`, tabs) + config snapshot. The generator reads only
job-dir files and never touches Python internals; see
`ts/README.md` for the move model and the per-operation rules.

```json
{
  "version": 1,
  "generator": "ts/toolpaths.ts",
  "plan": "A",
  "clearance_z_mm": 14.5,
  "z_model": "Z=0 at bottom of stock; cut-bottom Z = z_top - start_depth - cut_depth",
  "cut_order": ["drill", "pocket", "profile"],
  "operations": [ "...one entry per plan layer per pass, in cut order..." ],
  "skipped": [ "...every loop the generator could not cut, never silent..." ],
  "stats": {"operations": 15, "moves": 222, "rapid": 60, "feed": 100, "arc": 62}
}
```

| Field | Type | Rule |
|---|---|---|
| `version` | int | **1.** The toolpaths-section schema version (distinct from `job_version`). A reader that does not know version 1 must refuse the section, not guess. |
| `generator` | string | `"ts/toolpaths.ts"`. Identifies the producer; a section produced by anything else is not trusted by the sim/post (V3.4/V3.6 re-check provenance). |
| `plan` | string | The chosen plan id (`tool_plan.chosen`, e.g. `"A"`). The toolpaths were generated from that plan; re-planning to another plan invalidates them (re-generate, do not re-use). |
| `clearance_z_mm` | number | max part `z_top` + 5.0 mm. Rapids are always at or above this plane. |
| `z_model` | string | The Z convention, recorded in the section so no consumer has to assume it: `Z=0 at bottom of stock; cut-bottom Z = z_top - start_depth - cut_depth`. |
| `cut_order` | string[] | The operation order the entries follow — equal to the job's top-level `cut_order` (e.g. `["drill", "pocket", "profile"]`). Entries are grouped by operation in this order, stable within an operation by plan order. A `bore` entry sits in the `drill` group (`cut_order` names drill/pocket/profile; bore is drill-family — helical entry where the drill does not fit). |
| `operations` | object[] | One entry per plan layer per pass (§3). May be empty only for a job with no cuttable layers (a degenerate job — the validator allows it but the generator never emits it for a real plan). |
| `skipped` | object[] | The section-level aggregate of every entry's `skipped` (§4). Empty array when nothing was skipped — the key is always present, so "no skips" and "skips not recorded" are distinguishable. |
| `stats` | object | Counts that must agree with `operations` (§5): `operations` (= `operations.length`), `moves` (total moves across entries), `rapid` / `feed` / `arc` (moves by `t`). |

### 3. One operation entry

```json
{
  "operation": "pocket",
  "layer": "P01_P01__POCKET_D1.50",
  "tool_id": "EM3.17",
  "feed_mm_s": 15.88, "plunge_mm_s": 5.29, "spindle_rpm": 20000,
  "pass": {"kind": "rough", "stepdown_index": 0},
  "z_mm": 8.0, "z_top_mm": 9.5, "z_bottom_mm": 8.0,
  "tabs": null,
  "moves": [ "...ordered, rapid/feed/arc..." ],
  "skipped": [],
  "notes": []
}
```

| Field | Type | Rule |
|---|---|---|
| `operation` | string | One of `drill` \| `bore` \| `pocket` \| `profile`. (`drill` = peck cycle with the drill bit; `bore` = helical entry with an endmill where the drill does not fit; `pocket` = contour-parallel clearing; `profile` = outer profile or centred through-cut slot. There is no `finish` operation — a finish is a `pass.kind` on a pocket/profile entry, see below.) |
| `layer` | string | The job layer this entry cuts, e.g. `P01_P01__POCKET_D1.50`. Must name a layer in the job's `layers`. |
| `tool_id` | string | The planned tool, e.g. `EM3.17`. Must be a tool id in the chosen plan. |
| `feed_mm_s` / `plunge_mm_s` / `spindle_rpm` | number | From the chosen plan's tool entry (config snapshot's `toolplan` values resolved per tool). Z-only feed moves use `plunge_mm_s`; XY feed moves and arcs use `feed_mm_s`. |
| `pass` | object | `{kind, stepdown_index}`. `kind` is `rough` (a stepdown level pass) or `finish` (the single full-depth contour, emitted only where the plan calls for one, i.e. `allowance_mm > 0`). `stepdown_index` counts the Z level (0 = first/top) for rough passes; `null` for drill/bore (one entry spans the hole) and for finish passes (one contour spans all depths). |
| `z_mm` | number \| null | The entry's cutting Z: the level Z for rough passes, the hole bottom for drill/bore (`= z_bottom_mm`), `null` for finish spans (one contour spans all depths). |
| `z_top_mm` / `z_bottom_mm` | number | The cut's top and bottom for this entry's layer, in the same Z model. Pocket/profile: `z_top_mm = part z_top − start_depth` (the layer name's `_START<n>` suffix, 0 when absent) and `z_bottom_mm = z_top_mm − cut_depth` (the layer's `est.depth_mm`). Drill/bore: the peck/helix starts at the stock top, so `z_top_mm` is the part `z_top` itself and `z_bottom_mm = part z_top − start_depth − cut_depth`. In all cases `z_bottom_mm = z_top − start_depth − cut_depth` with the pocket/profile `z_top_mm` already carrying the start — equivalently, cut-bottom Z = `z_top − start_depth − cut_depth` (the `z_model` string). |
| `tabs` | object \| null | Set only on the bottom profile pass; `null` elsewhere. `{count, length_mm, thickness_mm, positions: [{loop, s_mm}]}` — `positions` are arc-length positions of the tab centres along the contour, so count/length can be checked against `manifest.txt` `# tabs:`. |
| `moves` | object[] | Ordered moves (§3.1). Non-empty for every entry (an entry with no moves is a generator bug, not an empty cut). |
| `skipped` | object[] | Loops of this entry's layer the tool could not cut (§4). |
| `notes` | string[] | Free-form generator notes (may be empty). Never load-bearing: nothing downstream may depend on a note's text. |

### 3.1 Moves

```json
{"t": "rapid", "x": 20.0, "y": 20.0, "z": 14.5}
{"t": "feed",  "x": 20.0, "y": 20.0, "z": 8.0}
{"t": "arc",   "x": 20.0, "y": 20.0, "z": 8.0, "i": -21.4, "j": 0.0, "cw": false}
```

- Coordinates are job coordinates in mm, Z=0 at the bottom of
  stock, rounded to 0.001 mm.
- `t` is `rapid` | `feed` | `arc`. A `rapid` is always at or
  above `clearance_z_mm` — a rapid below it is a generator bug
  (the sim, V3.4, catches it as a gouge).
- `arc` is first-class, never a polyline approximation: `(x, y, z)`
  is the end point, `(i, j)` is the centre offset from the arc's
  start point, `cw` is the direction (`true` = G2 clockwise,
  `false` = G3 counter-clockwise). An arc whose end Z differs from
  its start Z is a helical arc (ramps, bore entries); a planar arc
  has equal Zs.
- Entry rules (the no-straight-plunge rule): no straight plunge
  into solid stock — pockets and profiles ramp in, bores helix in;
  a straight plunge is only ever a drill peck. The validator checks
  the cheap structural part of this (rapids at clearance; see
  §7); the sim is the full check.

### 4. Skipped loops — recorded, never silent

A loop the tool cannot cut is recorded, never omitted:

```json
{"layer": "P02_P02__POCKET_D0.60", "loop": 0,
 "reason": "tool_too_large",
 "detail": "no ring fits at wall offset 0.250 mm (tool EM0.50)"}
```

| Field | Type | Rule |
|---|---|---|
| `layer` | string | The job layer the loop belongs to. Present on the section-level aggregate; entry-level skips carry no `layer` (the entry's layer is implied). |
| `loop` | int | The loop index within the layer (0-based, DXF order). |
| `reason` | string | One of `tool_too_large` (no offset ring fits at tool radius — the loop is narrower than the tool) \| `offset_failed` (the offsetter rejected the loop) \| `open_loop` (the loop is not closed). The generator never invents another reason. |
| `detail` | string | Human-readable cause (which tool, which offset). Never load-bearing. |

- The section-level `skipped` is the concatenation of every
  entry's `skipped` with that entry's `layer` attached, in entry
  order. The validator checks the two agree exactly.
- A skipped loop is uncut material by design of the current plan,
  not a generator error: the job still validates, and the UI shows
  the skips (never hides them). V3.10 acceptance must address the
  known case (Kookabus `POCKET_D0.60`: 10 loops narrower than the
  0.50 mm tool — needs a smaller tool or a different strategy).

### 5. `stats` — consistency, not decoration

`stats.operations` = `operations.length`; `stats.moves` = the total
number of moves across all entries; `stats.rapid` / `stats.feed` /
`stats.arc` = the moves of each `t`, and
`rapid + feed + arc = moves`. The validator recomputes all five
from `operations` and rejects a mismatch — a stale or hand-edited
section fails loudly instead of being displayed with wrong totals.

## 6. `gcode` and `sim` — defined here, filled later

Both sections are DEFINED by this doc so V3.3–V3.8 build against a
stable shape, but they stay **absent** from `job.json` until the
item that fills them lands. Do not invent their contents early; a
job with a `gcode` key before V3.6 was invalid (the validator
rejected it outright until its owner item landed — the validator
was updated by that item, in the same change that first wrote the
section). `sim` was filled by V3.4 (§6.2); `gcode` was filled by
V3.6 (§6.1); a present section of either is shape-checked, and a
malformed one is `sim_invalid` / `gcode_invalid`.

### 6.1 `gcode` (owner: V3.6; the `verified` stamp is enforced by V3.8)

One entry per post-processor run:

| Field | Type | Rule |
|---|---|---|
| `post_id` | string | The post-processor id, e.g. `masso-mm`, `masso-inch`, `grbl` (V3.6 names the ids; the machine profile selects one, §7). |
| `file` | string | Job-relative path of the posted file (e.g. `gcode/container-masso-mm.nc`). The file must exist in the job dir and be listed in `outputs`. |
| `sha256` | string | Hex sha256 of the file bytes, so a hand-edited file is detectable. |
| `verified` | boolean | The round-trip re-simulation result (V3_SCOPE.md §6.4): the posted G-code parsed back into moves and re-simulated, stock matching the toolpath sim within tolerance. `false` means unverified — downloadable for inspection, never presented as ready to run. |
| `generated_at` | string | ISO-8601 timestamp of the post run. (A timestamp, unlike `created_at`, because a job can be posted more than once; each entry carries its own.) |

A job with no `gcode` entry has never been posted. `verified` is
the safety stamp: no G-code ships without it (V3.6 records the
round-trip result; V3.8 enforces the stamp). Filled by
`mldxf gcode` (V3.6): one entry per post run — a re-post replaces
the same `post_id`'s entry. The full post model, Z conversion,
and round-trip criterion are in `docs-v3/gcode.md`.

### 6.2 `sim` (owner: V3.4, seek state by V3.5)

Filled by `mldxf sim --verify` (V3.4) on PASS only — a failing
verification writes nothing, so a present `sim` section means the
simmed stock matched the intended geometry within tolerance at the
time it was written. No timestamps: a re-run of the verifier on an
unchanged job produces a byte-identical section.

| Field | Type | Rule |
|---|---|---|
| `stock` | object | The stock the sim ran against: `x_min`, `y_min` (sheet origin in job coordinates), `x_mm`, `y_mm` (sheet size), `top_mm` (stock top = max part `z_top`, NOT the suggested thickness), `suggested_thickness_mm` (the purchase suggestion, recorded for reference, or `null`). Recorded, not re-derived, so a re-run of the sim can be checked against the same stock. |
| `pitch_mm` | number | The dexel pitch actually used (V3_SCOPE.md §5.2 — adaptive per job, column count under ~25M). A coarse sim is never mistaken for a fine one because the pitch is recorded here. |
| `pitch_coarse` | boolean | True when the pitch is coarser than smallest-tool-diameter/10 (the job's smallest tool does not fit the pitch budget — the budget wins and the sim says so). |
| `coarse_reason` | string \| null | Why the pitch is coarse (which pitch the budget forced and what the base pitch would have needed); `null` when `pitch_coarse` is false. |
| `checkpoints` | object \| null | Index into the delta log (V3_SCOPE.md §5.5, docs-v3/sim_seek.md): the sparse checkpoint positions + the delta-log location under the job dir (`sim/` cache). `null` on a pre-V3.5 sim section (the job has no seek state — still valid). The object is `{file: "sim/delta.bin", format: 1, chunk_cut_seconds: 30, checkpoint_cut_seconds: 300, chunks, bytes, moves, checkpoints: [{move, time_s, chunk}]}` — `moves` must equal the toolpaths' `stats.moves` (a log built for different toolpaths is stale and refused), checkpoints start at `{move: 0, chunk: -1}` (the initial stock) and end at the last move, in strictly increasing move order. The dexel grid itself is derived data — recomputed from `toolpaths`, never stored as source of truth; the delta log + checkpoints live under the job dir as `sim/` cache and are rebuildable. |

The validator shape-checks the section (`job.sim`): `stock` with
finite numbers, `pitch_mm` positive finite, `pitch_coarse` a
boolean with a matching `coarse_reason`, `checkpoints` null or the
V3.5 index object (file `"sim/delta.bin"`, format 1, positive
chunk/checkpoint intervals, non-negative chunk count, positive
byte size, move count equal to the toolpaths' `stats.moves`,
checkpoints non-empty, first `{move: 0, chunk: -1}`, last at the
final move, strictly increasing moves); a malformed section is
`sim_invalid`. A `sim` section on a job without toolpaths is
invalid — a sim simulates the toolpaths.

## 7. `machine_profile.post_processor` (owner: V3.6/V3.8)

`machine_profile` is v2, unchanged — plus the post-processor
selection (V3_SCOPE.md §6.4), which is a machine-profile concern,
not a per-job invention:

- `machine_profile.post_processor`: string id of the selected post
  (e.g. `masso-mm`), or `null`/absent when none is selected.
- The V2 Preferences tab already has a "Post processor" free-text
  field in the VCarve section; V3.8 wires it to a real selection.
  Until then the field stays free text in preferences and is NOT
  copied into `machine_profile` by any V3.2 code.
- The validator allows `post_processor` absent, `null`, or a
  string; any other type is invalid.

## 8. Parts, single vs multi, and what the generator normalises

- Multi-part jobs carry `parts: [...]` (each with `z_top`); the
  generator cuts each part's layers in `cut_order`.
- Single-part jobs carry `parts: null` and top-level `z_top`;
  layers carry no `part` field — the generator normalises this to
  one implicit part. The validator accepts both shapes and checks
  `z_top_mm` against the owning part's `z_top` (or the top-level
  `z_top` for single-part jobs) within 0.001 mm.
- Two-sided parts (BRA-13, separate stream) are not precluded:
  `registration_pins` carry forward unchanged, and toolpath
  generation must be able to emit a side-A job with no profile
  when that item lands. Nothing in this schema assumes a profile
  exists.

## 9. Round-trip: rerun (V3_SCOPE.md §8.2)

`mldxf rerun` on a v3 job replays the plan from the retained
inputs + config snapshot (exactly as a v2 rerun does), replays the
guides from their recorded provenance when the job has them, then
**regenerates the toolpaths** from the replayed job and requires
the regenerated section to be byte-identical to the old section
(canonical JSON bytes — sorted keys, 2-space indent, trailing
newline, the same form `job.json` itself is written in). On any
difference the rerun fails with `rerun_toolpaths_mismatch` and
publishes nothing — the old job dir is untouched. The generator is
deterministic, so a mismatch is a real defect (generator,
snapshot, or inputs changed), never noise.

- A v2 job rerun stays v2: it does not gain toolpaths (upgrade is
  explicit — `mldxf toolpaths` on the rerun job).
- A v2 job gains toolpaths via `mldxf toolpaths` (the upgrade
  path): the command runs the generator, validates the merged job
  (§10), and bumps `job_version` to 3. It does not gain them
  silently on plan or rerun.
- `created_at` changes on rerun (a new run happened); the
  toolpaths section does not (it carries no timestamps).

## 10. Validation — `ts/validate_job.ts`

Placement decision: the validator is a **TypeScript module run by
Bun** (`ts/validate_job.ts`), not Python in the CLI shell. Reasons:
(1) new V3 code is TypeScript-first (V3_SCOPE.md §0 decision 6) —
the validator is new V3 logic, and the CLI shell (`mldxf.py`) is
the shell, not the pipeline; (2) one implementation serves both
entry points — the CLI shells out to it (`mldxf validate-job`,
and inside `mldxf toolpaths` / `mldxf rerun` before publishing),
and the API reaches it through the CLI 1:1 (`POST
/api/jobs/:id/toolpaths` runs the CLI, which validates;
`GET /api/jobs/:id/validate` runs `mldxf validate-job --json`);
(3) the TS side already owns the toolpaths model, so the validator
shares its vocabulary (move `t`, arc `i/j/cw`, skip reasons) with
the generator instead of re-defining it in a second language.

Usage:

```
bun ts/validate_job.ts <job-dir> [--json]      # reads <job-dir>/job.json
bun ts/validate_job.ts --file <job.json> [--json]
mldxf validate-job <job-dir> [--json]          # CLI shell over the above
```

Output contract (mirrors the CLI's): exactly one JSON object on
stdout (`{"ok": true, "job_version": 3, "checks": [...]}` on
success; `{"ok": false, "error": "<named>", "message": "...",
"checks": [...]}` on failure), progress on stderr, exit 0/1/2.
Named errors: `job_not_found` (no job.json), `job_invalid` (not
JSON / not an object / `job_version` missing or not 1/2/3),
`job_version_mismatch` (toolpaths ⟺ version 3 violated),
`toolpaths_invalid` (section shape, stats, skip-aggregate, move,
tab, or Z-consistency failure), `gcode_invalid` (a malformed
`gcode` section, or a `gcode` section on a job without toolpaths,
or two entries for the same post) / `sim_invalid` (a malformed
`sim` section, or a `sim` section on a job without toolpaths).

What the validator checks (structural + cross-field; it is not a
geometry checker — the independent checker
`~/workspace/v31-spike/check_toolpaths.py` and the sim, V3.4, own
geometry):

1. `job.json` parses; `job_version` is 2 or 3 (a v1 `manifest.json`
   has no `job.json` to validate — `validate-job` on a v1 dir
   fails `job_not_found` with the v1 message).
2. `toolpaths` present ⟺ version 3; `toolpaths.version` is 1;
   `generator` is `ts/toolpaths.ts`; `plan` equals
   `tool_plan.chosen` when the job names one; `clearance_z_mm` is
   max part `z_top` + 5.0 (±0.001); `cut_order` equals the job's
   top-level `cut_order`.
3. Every operation entry: `operation` in the enum; `layer` names a
   job layer; `tool_id` is a tool in the chosen plan; `pass.kind`
   in {rough, finish} with `stepdown_index` null exactly for
   drill/bore/finish; `z_mm` null exactly for finish spans;
   `z_top_mm`/`z_bottom_mm` follow the Z model of §3
   (pocket/profile cut from part `z_top` − `start_depth`;
   drill/bore start at the stock top, `z_mm` the hole bottom);
   `moves` non-empty; every move has a known `t`
   with finite numbers, arcs carry finite `i/j` and a boolean
   `cw`; every rapid is at or above `clearance_z_mm`;
   `tabs` non-null only on profile entries, with `count` equal to
   `positions.length`.
4. `stats` recomputed from `operations` (all five counts);
   section-level `skipped` equals the concatenation of entry
   `skipped` (same order); every skip reason in the enum.
5. `gcode`, when present, matches the §6.1 shape (one entry per
   post run, latest replaces; `verified` boolean; `generated_at`
   ISO); `sim`, when present, matches the §6.2 shape;
   `machine_profile` `.post_processor`, when present, is a string
   or null.
6. v2 keys present with their v2 types (`layers` array,
   `tool_plan` object, `config_snapshot` object) — the validator
   spot-checks presence, it does not re-validate the whole v2
   model (the V2 battery owns that).

## 11. API shape (for V3.3 — the 3D view fetches this)

- `POST /api/jobs/:id/toolpaths` → 202 `{ok, job: {job_id, job_dir,
  status: "running"}}`; progress over the existing SSE stream
  (`GET /api/jobs/:id/events`, same as a plan run) and pollable at
  `GET /api/jobs/:id/status`; on completion `GET /api/jobs/:id`
  returns the full job with its `toolpaths` section. A v1 job is
  refused synchronously with `toolpaths_unavailable` (400); a
  running job is refused with `job_already_running` (409).
- `POST /api/jobs/:id/gcode` (V3.6, optional JSON body
  `{"post": "<post-id>"}`) → 202, same async shape as toolpaths;
  on completion `GET /api/jobs/:id` returns the full job with its
  `gcode` section. A v1 job, or a job with no toolpaths yet, is
  refused synchronously with `toolpaths_unavailable` (400); a
  running job is refused with `job_already_running` (409). A
  round-trip mismatch fails the run with `gcode_unverified` —
  the entry is still recorded (`verified: false`).
- `GET /api/jobs` list entries carry `summary.toolpaths` (null for
  v2 jobs; `{version, plan, operations, moves, rapid, feed, arc,
  skipped: [{layer, loop, reason}]}` for v3 jobs) so the list can
  show "has toolpaths" without fetching the whole job, and
  `summary.gcode` (null for a job never posted; one `{post_id,
  file, sha256, verified, generated_at}` per post run for a
  posted job).
- `GET /api/jobs/:id/validate` → the validator's JSON
  (`mldxf validate-job --json`, 1:1).
- `GET /api/jobs/:id` returns the whole `job.json`, including the
  full `toolpaths` section — that is what the 3D view renders
  (§4.2 of the scope doc). What the view can assume: §2–§4 of this
  doc (one entry per operation in cut order, arcs first-class,
  rapids at clearance, skips recorded in `skipped`).

## 12. What is NOT in v3 yet (do not build it here)

- The `verified` stamp enforcement (V3.8 — V3.6 records the
  round-trip result; V3.8 enforces that no G-code ships without
  it, and adds the post-config UI).
- `sim` contents (V3.4 — filled; see §6.2) and seek state (V3.5);
  `mldxf sim --verify` writes the section on PASS only.
- The 3D view (V3.3) — it reads this schema, it does not extend it.
- A `finish` operation (there is none — see §3); ball-nose /
  V-bit / bull-nose toolpath generation (V4 — V3 toolpaths are
  flat-endmill 2.5D only, the sim's tool model notwithstanding).
- Any change to the classifier, planner, layout, guides, or
  `manifest.txt`.
