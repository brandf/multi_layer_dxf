# V3.8 — post-processor config + sim-verification stamp

Owner: V3.8. Status: landed 2026-11-25 (unpushed; VERSION 2.0.0).
Scope: V3_SCOPE.md §6.4 (the safety bar) + §2.2 (`gcode` entry) + §6.1
(post model). Builds on V3.6 (posts, round-trip verification) — this
wave wires the selection and the enforcement, it does not re-post.

## 1. The post ids (the authority is the TS registry)

`ts/posts/index.ts` POSTS: `masso-mm`, `masso-inch`, `grbl`,
`template`. Every other list mirrors it:

- `mldxf_config.py` `KNOWN_POST_PROCESSORS` (same four, same order) —
  `test_mldxf_config.py` §6l asserts the two lists agree, so a post
  added to the registry without updating the Python mirror fails
  there, not at post time.
- `server/public/app.js` `NATIVE_POSTS` (ids + labels) — the two
  dropdowns (Preferences + machine profile) build from it; the V3.8
  verify_v28 checks assert the served file offers exactly these ids.
- `server/public/job-prep.js` `GCODE_POSTS` (V3.6, unchanged).

## 2. Selection — the machine profile names the post

Precedence (unchanged from V3.6, now actually working):
`--post` > the job's `machine_profile.post_processor` > the home
`machine.json` `post_processor` > the default `masso-mm`. The
effective post is recorded back into the job's `machine_profile`.

What was broken before V3.8: `load_machine()` used strict key
checking and `post_processor` was not an allowed key, so a
`machine.json` carrying it failed validation — and
`_resolve_post_id` swallowed that failure and silently posted the
default (proven live: home `machine.json` saying `grbl`, job
profile stripped, `mldxf gcode` posted `masso-mm`, rc 0).
Fixed: `post_processor` is an allowed, optional key (absent or
null = no selection); a present value must name a known post
(`mldxf machine validate` rejects an unknown name with a message
naming the known ids). `_resolve_post_id` now re-raises a
validation failure from `load_machine` — only a missing home /
missing file (`home_not_initialized`) falls through to the
default. An unknown name from `--post` or the job profile is
refused by the TS driver as `post_unknown` (exit 1). So the same
mistake has two named errors by layer — `config_error` at the
config layer, `post_unknown` at the post layer — both loud, exit
1, never a silent fallback. `machine.example.json` ships
`"post_processor": "masso-mm"`; `mldxf machine show` prints it.

## 3. The UI — one choice, two editors, one stored value

- **Preferences tab, VCarve section** (`server/public/app.js`):
  the "Post processor" free-text field (with its `CHANGE_ME`
  sentinel) is now a dropdown of the four native posts. The stored
  value is a native post id. A stored `CHANGE_ME` sentinel or a
  legacy VCarve post name matches no option, so the select shows
  "Not set" until a real post is chosen — never the placeholder
  token.
- **Clamps & machine tab** (`server/public/app.js`): the machine
  profile editor gains the same dropdown (`data-role="machine-post"`),
  bound to `machine.post_processor` (empty = null = no selection).
- **The mirror** (`server/server.ts` `mirrorPostToMachine`): saving
  Preferences with a value naming a known native post also writes
  it into `machine.json` `post_processor` (validated with the CLI's
  own `mldxf machine validate` in a temp home, version bumped).
  That is what makes the Preferences choice real — the machine
  profile is where the selection lives, and the CLI honors it.
  Anything else (a legacy VCarve post name, the sentinel, blank)
  leaves `machine.json` untouched. The mirror is best-effort: a
  machine file that cannot be read or validated keeps its old
  value and the preferences save still stands.
- **Job-prep G-code section** (`server/public/job-prep.js`,
  V3.6, unchanged): a post dropdown (default: the job's
  `machine_profile.post_processor`, else `masso-mm`), one row per
  post run with the Verified / UNVERIFIED stamp, the Z-zero note,
  and the dry-run note.

Known trade-off (per the scope/task direction, recorded, not
hidden): the Preferences field used to record the VCarve `.pp`
NAME for the gadget path (e.g. "Onefinity Masso (inch) Latest
V6"). After V3.8 it records the native post id instead. Nothing
reads that value as code (a repo-wide grep finds only the config
validator — no Lua/Python consumer), so nothing breaks; but the
VCarve post name for the gadget path is no longer recorded
anywhere. If the gadget path ever needs it recorded again, it
needs its own field — do not reuse this one. A legacy VCarve name
stored in the field is replaced by "" (not set) on the next
Preferences save (the save re-dispatches every field's change
event); the UI shows "Not set" before that save, so the change is
visible, not silent.

## 4. The verification stamp — posting, and re-verifying

Posting (`mldxf gcode`, V3.6, unchanged): the driver posts, parses
the file back, and round-trip re-simulates it
(`ts/gcode_verify.ts` — band + cluster, calibrated in
`docs-v3/gcode.md` §7); the `gcode` entry carries `verified`, and
an unverified round-trip is published as `verified: false` and
then refused with `gcode_unverified` (exit 1). The UI shows the
UNVERIFIED badge and the file is download-only, never ready to run.

Re-verifying (`mldxf gcode --verify`, V3.8): the recorded file as
it sits on disk, against the toolpaths as they sit in `job.json`
now — entry exists? file exists? sha256 matches the entry? parse
+ round-trip? Named refusals, exit 1: `gcode_not_posted`,
`gcode_file_missing`, `gcode_sha_mismatch`, `gcode_unverified`.
The recorded `verified` stamp is synced to the observed result
(validated before publishing, `manifest.json` byte-identical); a
clean re-verification writes nothing — not even `generated_at`.
The driver (`ts/gcode.ts --verify`) writes nothing itself.

Why `--verify` exists: posting only verifies the file it just
wrote. A file corrupted afterwards kept its `verified: true`
stamp, and a toolpath changed afterwards made the stamp describe
a different job. Both are caught by re-verification: a byte
change trips the sha check (`gcode_sha_mismatch`); a toolpath
change with identical bytes trips the round-trip
(`gcode_unverified`). The sha check runs first, so a tampered
file is refused even before parsing.

What `--verify` deliberately does NOT do: a job with no `sim`
section still verifies through the round-trip's fallback
(`prepareSim`'s derived stock — `docs-v3/gcode.md` §7). Both sims
run on the same stock, so a wrong post still fails; the fallback
is a real translation check, not a pass-through, and §6.4's bar
is the round-trip match, which it satisfies. No change was made
there.

## 5. Z-zero and limits (V3.6, verified live in V3.8)

- Z-zero is the top of the material: stated in every emitted
  header (`ts/posts/common.ts` `headerComments` — "Z-zero: TOP
  of material. Zero X/Y at the sheet corner, Z on the stock
  top.") and in the post's conversion (`machineZ = jobZ -
  stockTop`). Verified on real generated files in the V3.8 run
  log (clearance +5.000, floor −1.500, bottom −9.500 on the
  9.5 mm container).
- Limits are refused, never clamped (`post_limit_exceeded`, exit
  1): feed, spindle, Z span vs travel, XY travel span vs bed,
  machine Z never below the stock bottom or above clearance.
  Verified live in V3.8 with over-limit feed and spindle cases.

## 6. Files

- `mldxf_config.py` — `KNOWN_POST_PROCESSORS`, `post_processor`
  in `_MACHINE_KEYS`, validation in `load_machine`.
- `machine.example.json` — ships `post_processor: masso-mm`.
- `test_mldxf_config.py` — §6k–§6l (validation + registry drift
  guard).
- `mldxf.py` — `_resolve_post_id` (loud failure), `machine show`
  line, `mldxf gcode --verify` (`_run_gcode_verify_subprocess`,
  `_cmd_gcode_verify`, `_publish_job_validated` factored out of
  `cmd_gcode`).
- `ts/gcode.ts` — `--verify` mode (read-only driver).
- `server/server.ts` — `mirrorPostToMachine` in `libraryPut`
  (Preferences save).
- `server/public/app.js` — `NATIVE_POSTS` + Preferences dropdown
  + machine-profile dropdown; `field()` select accepts
  `[value, label]` option pairs.
- `server/verify_v28.py` — §4e V3.8 checks (see its docstring §11).
- `docs-v3/gcode.md` §4/§6 — selection + UI (update at V3.10 if
  the wording drifts; this note is the V3.8 record).
