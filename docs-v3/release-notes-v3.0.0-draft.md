# v3.0.0 — DRAFT release notes (notes only — no tag, no release page yet)

**Status: DRAFT for the v3.0.0 release, 2026-11-25 (V3.10), refreshed
2026-11-26.** Do not publish as-is: the release is gated on the
acceptance items in `docs-v3/acceptance.md` §0 — the Foreman dry
run + live cut (needs Brandon), ~~the three stale harness
assertions (design loop's call)~~ **[closed 2026-11-25 — round-2
battery green, 476/476]**, and ~~the website walkthrough
re-render (after the design loop's round lands)~~ **[closed
2026-11-25 — re-rendered 23:22 PT]**. When those close, this draft
becomes the release page text with the gate items struck through,
not rewritten.

## What V3 is

V3 generates the toolpaths itself, shows them in one three.js 3D
view with a cut simulation driven from those toolpaths, and posts
G-code through general post-processors — so a job can go STEP →
cutting with nothing more than this tool. VCarve becomes an
optional soft dependency instead of the only path. The gadget
workflow from V1/V2 keeps working unchanged alongside it.

V3 builds on pushed V2 (commit `aa499634`, released v2.0.0). The
Python pipeline stays the geometry backend; new V3 code is
TypeScript-first. The V3.9 toolchain port (OCCT.js) moved to V4 —
no port work in V3.

## What landed, wave by wave

- **V3.1 — in-house toolpath generation** (`ts/toolpaths.ts`,
  `mldxf toolpaths`): drills (peck cycles), bores (helical entry),
  pockets (contour-parallel clearing + finish contour, islands
  respected), profiles (offset, ramp entry, tabs). Arcs are
  first-class moves, never polylines. Deterministic: rerun
  reproduces the toolpaths byte-for-byte. Verified by an
  independent ezdxf-based checker on all five reference jobs
  (container, machined plate, eight_parts, Kookabus merged, and
  the 8-layer real container).
- **V3.2 — job model v3 + CLI + API + rerun** (`job.json` v3:
  `toolpaths`, `gcode`, `sim` sections; `mldxf toolpaths` /
  `validate-job`; `POST /api/jobs/:id/toolpaths`,
  `GET /api/jobs/:id/validate`). `manifest.txt` (the gadget
  contract) is frozen; a v1.0.1 gadget runs a v3 job unchanged.
- **V3.3 — one three.js 3D view**: toolpaths as 3D paths (rapids
  faint, feed solid, arcs true), colour by operation/tool, the
  tool model on the path, one toggleable layer plane per DXF
  layer at its Z depth, playback (play/pause/scrub/seek, speed,
  jump-to-operation). three.js vendored locally, no CDN at runtime.
  No WebGL → message + toolpath list; the CLI still generates
  toolpaths and G-code without any browser. No 2D toolpath view,
  by decision.
- **V3.4 — cut-simulation engine**: dexel (heightfield) stock,
  adaptive pitch (0.05 mm on small jobs, 25M-column budget),
  extensible tool profiles — a tool is `r(z)` profile data, so
  flat, ball-nose, V-bit, and bull-nose simulate in one model.
  `mldxf sim --verify` compares the simmed stock against the
  intended geometry (0 failed probes, 0 gouge on all five
  reference jobs). CPU backend ≥50× real time, confirmed
  (slowest eight_parts 78×).
- **V3.5 — faster-than-real-time + rewind/seek**: segment-indexed
  delta log + sparse checkpoints (every 5 min of cut time); worst
  seek 359 ms on the reference jobs; Kookabus delta log 330.8 MB
  within the 500 MB budget. GPU backend (WebGPU compute) built
  with a CPU fallback that names itself honestly when WebGPU is
  absent.
- **V3.6 — G-code export + native post-processors**: Onefinity
  Masso (mm + inch), GRBL, and a template post. M6 manual-change
  stop (no ATC), no G43, no canned cycles (drills are explicit
  peck moves). Limits are refused, never clamped
  (`post_limit_exceeded`). Every posted file is parsed back and
  re-simulated (round-trip, band + cluster); unverified G-code is
  refused and marked UNVERIFIED, never presented as ready to run.
- **V3.8 — post-processor config + verification stamp**: the
  machine profile names the post (Preferences + machine-profile
  dropdowns, mirrored into `machine.json`); `mldxf gcode --verify`
  re-checks a posted file as it sits on disk (sha first, then
  parse + round-trip) and catches a file corrupted — or toolpaths
  changed — after posting. Z-zero (top of material) is stated in
  every emitted header.
- **V3.13 — sheet-restraint model for the guides** (safety-critical,
  Brandon-directed): clamps must restrain the sheet on opposing
  edges, not just support parts near their profile cuts; verdicts
  `restrained` / `restrained-with-warning` / `unrestrained`, with a
  named refusal when no opposing pair is reachable under keep-out.
  (Superseded by V3.16 — the edge premise was false: a top-down
  clamp serves no edge laterally. The guides now compute a contact
  balance from clamp-type primitives, with verdicts
  `proven` / `unproven` / `insufficient`.)
- **V3.16 — contact-balance model for the guides** (safety-critical,
  Brandon-directed): rebuilds the V3.13 edge-restraint model on
  clamp-type primitives — top-down = hold-down + friction (mu x
  hold-down), edge-push = lateral on exactly one edge, pin = 2D
  lateral at a point. Contacts are local one-sided points with
  moment arms; the verdict (`proven` / `unproven` / `insufficient`)
  comes from balancing the worst cut's force and moments about the
  placed contacts, with a stated safety factor of 2.0 and the
  required hold-down per clamp surfaced in `job.json`, the CLI and
  the website. Unknown hold force = unproven (unmeasured, not
  small); the old `guides_unrestrained` refusal is gone — an
  unproven placement warns with the numbers instead.
- **V3.12 — stale "Interrupted" Jobs rows**: verified already
  fixed by the V2.12 round-1 home-scoping; no code changed.

## The acceptance file (the part you cut from)

- Job `20261126-175634-real-container` (fresh on the release
  tree, re-verified 2026-11-26 — see acceptance §0A): 14 operations
  / 220 moves, Plan A 7.7 min (V3.14 calibrated estimate; motion
  222.3 s), layout (21.35, 21.35) / (85.05, 21.35) on a 160×90×10
  sheet, clamp margin 15 mm, sim-verified
  (6,617 probes, 0 failed, 0 gouge), posted verified through all
  three posts — masso-mm
  `4cff6b844e5d4926272065e76f1bc77c2ba662fc51a56aaf48de7578e65aa70a`
  (247 lines), masso-inch
  `201f5b1b04632583275f97b640e57098c1a9d30a581ce3d22a3df5a1e220cbff`
  (247 lines), grbl
  `e7f53fe8dd40d2b86c4af7f7b954f37b1a90f802861ac0e773274673d703639d`
  (250 lines). Z-zero is the top of the material in every header
  (the job records `z_zero: top`); first motion
  `G0 X23.850 Y44.350 Z5.000`, deepest cut `Z-9.500`. Guides on
  this job place (70,6)+(125,84) with verdict **UNPROVEN** — the
  worst cut demands 30.47 N of hold-down and the test clamp is
  unrated; the placement is unproven, not proven (acceptance
  §0A.2).
- The dry-run file is the refreshed V3.10 file above (job
  `20261126-175634-real-container`, masso-mm
  `4cff6b844e5d4926272065e76f1bc77c2ba662fc51a56aaf48de7578e65aa70a`)
  — see `docs-v3/dry_run_foreman.md` for the procedure. The V3.6
  file (job `20261124-160834-real-container`, masso-mm
  `e8a2014103b4…`) is superseded; it still exists untouched as the
  V3.6 reference. **Do not cut before the dry run.**
- The other four reference jobs re-post verified through Masso-mm
  with byte-identical shas to the V3.6 record (real_container,
  machined, eight_parts, Kookabus).

## Honest limits — read before cutting

- **No live cut has happened from V3 G-code yet.** The dry run and
  the real part need Brandon's Foreman. The round-trip proves the
  posted file replays the toolpaths through the sim; it does not
  prove the Masso interprets every word the way the post intends.
  Air-cut first, per `docs-v3/dry_run_foreman.md`.
- **GPU sim speed (≥500×) is unmeasured.** WebGPU on this VM is
  SwiftShader (software), 7–13× — that is not a GPU result. The
  ≥500× target needs measuring on Brandon's Windows laptop.
  The CPU backend is the honest path on this machine, and it
  clears its ≥50× target on every reference job.
- **Plan times are estimates.** The planner's cutting estimate
  understates the generated motion by 2–56% per job (worst
  eight_parts, Kookabus — see `docs-v3/acceptance.md` §6.1); a job
  quoted at 215.1 min takes ~282 min of motion plus tool changes
  by the toolpath clock. The live cut is the measurement that
  settles the real machine time.
- **Hold force is unknown.** The guides now compute a contact
  balance (V3.16) that demands a hold-down number at the worst
  cut, but the actual hold of the test clamp is still
  "verify by hand" — the balance comes back `unproven` until the
  clamp's hold-down force is rated or measured.
- **Feeds/speeds are the conservative diameter-scaled defaults**
  until Brandon supplies proven values per tool/material.
  The live cut is where they get tuned.
- **VCarve `.pp` files are not a V3 path.** The evaluation
  (V3.7a) is blocked on Brandon's two Masso `.pp` files; if it
  gates the interpreter out, `.pp` stays a documented non-goal
  and the native posts are the path.
- **Known latent defects carried forward:** a finish pass would
  destroy tabs (no reference job has one — a V3.1 follow-up);
  9 of 10 Kookabus `POCKET_D0.60` loops are uncut by design of
  the current plan (tool too large); the generator carries a
  repair for a classifier ARC-mirroring defect (the classifier
  itself is untouched).
- **The website walkthrough was re-rendered 2026-11-25 23:22 PT**
  after the design loop closed; it shows the current UI including
  the UNPROVEN guides balance and the top-corner origin. It
  predates this refresh's new acceptance job (the numbers moved,
  the UI did not).

## What is NOT in V3

- AI inside the interface, MCP support (deferred to V4, then V5).
- The toolchain port to TypeScript / OCCT.js (moved to V4).
- True 3D roughing/finishing, two-sided parts (BRA-13, separate),
  4th axis, ATC support, cloud/multi-user, a 2D toolpath view.
- A rename decision (V3.11 — Brandon decides).

## Upgrade note

V3 is additive over V2: the classifier, planner, and gadget path
are untouched; a v1.0.1 gadget runs a v3 job unchanged, and
`manifest.txt` is byte-identical before and after toolpath
generation. `VERSION` goes to 3.0.0 with this release (tag
`v3.0.0`); per the release policy, labelling something V3 is a
release — no release for every push.
