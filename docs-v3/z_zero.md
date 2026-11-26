# Z-zero — one setting, two frames (Nov 25, 2026)

Brandon's workflow zeroes X/Y on the sheet corner and Z with a
probe on top of the stock. The project used to split-brain on
this: the G-code posts already put Z-zero on the stock top, but
the 3D view put the origin at the bottom of the stock. This doc
is the single place that says where Z-zero lives and who reads
it.

## The two frames

- **Job frame**: Z=0 at the BOTTOM of stock (the bed). Toolpaths,
  the sim, geometry, and cut time all live here. A move's Z is a
  height above the bed. Nothing here changes with the setting.
- **Display / machine frame**: Z=0 at the job's Z-zero. The 3D
  view and the G-code posts render in this frame. XY is the same
  in both frames: the origin stays the sheet's bottom-left
  corner — zero X/Y at the sheet corner either way.

## The setting

One field, `z_zero`, `"top"` | `"bottom"`, on the job
(`job.z_zero`, recorded by `mldxf plan`). Default `"top"`.

Precedence for a new job, in order:

1. The `--config` file's `vcarve.z_zero` — when a config file is
   given. (Note: the --config file is otherwise unvalidated at
   plan time — the v1 child loads it with plain `json.loads` — so
   `mldxf.py` validates this one key fail-fast, mirroring
   `mldxf_config`'s rule.)
2. The home `preferences.json` `vcarve.z_zero` — the fallback.
   This is the one key in preferences.json the pipeline reads:
   everything else in that file is provenance-only (see
   `_build_config_snapshot`). A bad value there never reaches the
   resolution: `load_preferences` validates it when the snapshot
   loads the libraries, so the run fails first.
3. `"top"`.

The resolved value and its source are recorded in the job's
`config_snapshot` (`z_zero`, `z_zero_source`: `"config file"` |
`"home preferences"` | `"default"`), so a job always says where
its zero came from. `mldxf rerun` replays the recorded snapshot,
so a rerun keeps the original job's zero even if the preferences
changed since. The Preferences UI select writes
`preferences.json` (the fallback path); its description states
the precedence. The VCarve gadget has no `z_zero` reference and
is out of scope — VCarve owns Z-zero in its own job setup.

A job without the field predates the setting and reads as
`"top"` everywhere — which is also what the posts have always
emitted, so old jobs re-post byte-identical. A job carrying any
other value is corrupt: `ts/z_zero.ts` throws rather than
silently picking a frame, and `ts/validate_job.ts` refuses it
(`job.z_zero`) at publish time.

## Who reads it

| Consumer | Behaviour |
|---|---|
| `ts/z_zero.ts` (`zZeroOf`, `displayZ`) | The single resolver. Missing → `"top"`; anything else throws. `displayZ(jobZ, stockTop, zZero)` is `jobZ - stockTop` under top, `jobZ` under bottom. |
| `mldxf.py` (`_effective_z_zero`, `_assemble_job`) | Resolves per the precedence above, records `job.z_zero` + the snapshot fields. |
| `ts/posts/common.ts` (`machineZ`, header) | `machineZ` is `displayZ` in the post's units. Header states `TOP of material` or `BOTTOM of material (bed)` per the setting. Under top the emitted bytes are identical to before this change. |
| `ts/gcode.ts` | Resolves the setting from the job (corrupt → `job_invalid`, never a post under the wrong zero) and passes it to the post and the parser. |
| `ts/gcode_parse.ts` | Parses machine Z back to job Z: adds the stock top back under top, adds nothing under bottom. Default `"top"` (existing callers/tests unchanged). |
| `ts/gcode_verify.ts` | Unchanged — it compares parsed moves (already job-frame after the parse) against the toolpaths, so it is frame-agnostic. |
| `ts/view3d/entry.ts` | Renders in the display frame: the flat moves are shifted once at mount (playback, tool marker, lines, and current position all read them), and the stock box, bed grid, clamp boxes, sim mesh, layer planes, light, and camera follow. The origin crosshair stays at (0, 0, 0) — machine zero in both frames: the top corner of the stock under top, the bed corner under bottom. Layer rows label Z in the display frame. `sceneInfo()` reports the frame (`zZero`, `stockTopZ`). |
| `ts/view3d/model.ts`, `ts/geometry.ts`, `ts/sim.ts`, `ts/cuttime.ts` | Job-frame, unchanged. The sim's heights are heights above the bed either way; only its rendered mesh shifts. |
| `server/public/job-prep.js` | The Downloads Z-zero note reads the job's `z_zero` (missing → top text). |
| `server/public/app.js` | The Preferences select writes the fallback; a home that never set it shows `"top"`. |

## Verification

- Default top: re-post the V3.10 acceptance job
  (`20261125-073936-real-container`) and the other four
  reference jobs — the `.nc` bytes must be identical to the
  recorded shas (docs-v3/acceptance.md §3).
- Bottom: one fresh real-container job planned with a `--config`
  file setting `vcarve.z_zero` to `"bottom"` — view, post, and
  verify must agree (origin at the bed corner, header states
  BOTTOM, `mldxf gcode --verify` rc 0 on all three posts).
- Unit: `ts/gcode.test.ts` "bottom Z-zero" — a bottom post keeps
  job Z, states BOTTOM, and only parses back with `zZero:
  "bottom"`; a top post is unchanged.
