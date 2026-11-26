# Offset spike — verdict (V3.1, Phase 1)

Date: 2026-11-24. Spike code: `~/workspace/v31-spike/spike.ts`
(Bun 1.4.4, dependency-free TypeScript; run
`bun spike.ts <dxf>...`). Reference DXFs: the fresh v2 jobs'
`test/real_container_out/`, `test/machined_out/`,
`test/eight_parts_out/`, `test/external/kookabus_bra20_out/`.

## Verdict

**TypeScript works. Proceed to Phase 2 with Candidate B
(hand-rolled offsets for the shape classes the classifier emits).**
No Python fallback is needed. Offsetting is fast everywhere
including the Kookabus stress case, and every offset the generator
actually needs (inward rings for pockets, outward offsets for outer
profiles, centred passes for through-cuts) is produced and validated
on all four jobs. The remaining failures are all outward offsets of
pocket outlines — a direction the generator never uses — and are
rejected loudly rather than silently wrong.

## Candidates

### A — vendored Clipper2 JS port: evaluated from documentation only, NOT runtime-tested

Two candidates were identified from public documentation:
`clipper2-ts` v2.0.1-19 (pure TypeScript port of Clipper2, ESM,
`inflatePaths`) and `clipper2-js` (TS port; Socket notes some
polygon tests still failing). `clipper2@0.0.3` (KaivnD) was rejected
on vendoring grounds (2.5 MB WASM binary blob from an obscure author,
async WASM init).

**A runtime test of Candidate A was blocked in this VM**: an exec
result that installed the packages was flagged by a system
execution-risk check, and I was instructed not to run, import, build,
test, or vendor that downloaded content. I removed the download
directory entirely and have not used those packages since. So
Candidate A stands as a **documented future option, evaluated from
its published documentation/API only** — not runtime-tested here.
The choice of B rests on B being tested and sufficient, not on A
being tested and found wanting.

### B — hand-rolled offsets (CHOSEN)

Exact segment offsets (line → parallel line; arc → same centre,
radius ± d, with the radius sign taken from the centre side, not
from the stored sweep), joins by intersecting neighbouring offset
curves (line–line, line–circle, circle–circle), round joins where
neighbours do not meet, arcs whose offset radius vanishes dropped
with neighbours meeting at a miter, and three guards that reject
invalid offsets instead of emitting them (self-intersection,
minimum-distance-to-wall, inside/outside side check). See
"Geometry rules the spike proved" below.

## Timing (latest full run, 2026-11-24)

Grand total for all four DXFs: **~0.32 s** (runs vary 0.31–0.72 s
with machine load; offsetting itself is a small fraction of a
generator run).

| DXF | rings produced | time |
|---|---|---|
| real_container (24 entities) | 37 | 64 ms |
| machined (33 entities) | 29 | 8 ms |
| eight_parts (63 entities) | 71 | 28 ms |
| Kookabus merged (255 entities, 40 LWPOLYLINEs, 190 flags) | 90 | 149 ms |

Ring counts are inward rings at stepover spacing (40% of tool
diameter) plus the outward check per loop. Kookabus is the stress
case and is not a performance problem.

## Validation metrics

Per loop the spike checks: every ring point stays inside the outline
(`pointInPolygon`), every ring point stays ≥ |d| from the wall
(minDev, the safety metric — ~0.00–0.03 mm everywhere that passes),
and the outward offset has larger area than the outline. maxDev is
expected at miters (up to |d|·(sec(θ/2)−1), e.g. 3.419 mm on
L-shaped profiles, 2.423 mm on POCKET_D18.80) and is not a defect.

Final state: **fails = 0 on every layer except four outward-offset
rejections on pocket outlines** (see "Known limits").

## Geometry rules the spike proved (the generator reuses these)

- **Classifier DXF ARC spans can be frame-mirrored.** Verified
  against the STEP with build123d: machined `PROFILE_THRU` corner
  arcs and Kookabus `POCKET_D18.80` / `PROFILE_THRU` fillet arcs are
  stored mirrored (e.g. a 0..90° STEP arc stored as 90..180°).
  Repair: a stored endpoint coinciding with no other segment's
  endpoint dangles; if exactly two other endpoints lie on the arc's
  circle, re-derive the span between them, picking the sweep whose
  magnitude equals the stored span (both can match at 90°; prefer
  CCW, the assembler reverses as needed). **This is a classifier
  defect to flag to the parent — V3.1 must NOT fix the classifier;
  the generator must carry this repair.**
- **LWPOLYLINE `close=True` is meaningless.** The writer calls
  `add_lwpolyline(pts, close=True)` for EVERY discretised spline
  edge, which is an OPEN piece of a loop. Never add the closing
  chord — it cuts across the piece and spawns spurious open chains.
  Treat each LWPL as an open chain of its points; a genuinely closed
  loop closes by assembly.
- **Loop assembly must pick the smallest turn at junctions.**
  Greedy first-match turns back along the other wall of a thin slot
  and builds out-and-back sliver loops. Prefer the candidate whose
  direction has the largest dot product with the current direction.
- **Zero-area loops are not features (added 2026-11-24).**
  `assemble()` filters closed loops with |area| ≤ 1e-6 mm²: a
  duplicated segment builds an out-and-back sliver (eight_parts
  P07 pocket's y=30 midline appears twice in the DXF). With the
  filter, P07 pocket assembles to 1 loop (the 4×10 rect, area 40)
  instead of 2, and the generator no longer records a spurious
  `tool_too_large` skip for it.
- **Closing join:** the i=0 join sets the first segment's start but
  never trims the last segment's end — trim the last segment to the
  first segment's start after the join loop.
- **Arc endpoint trimming must use `branchAngle()`** (keep the atan2
  angle on the same 2π branch as the endpoint it replaces) or arcs
  sweep the long way round.
- **Parallel-curve guard:** every point of a valid offset lies at
  distance ≥ |d| − 0.05 mm from the original boundary. Crossed
  offsets (offset distance exceeding local half-width) build spurious
  inverted loops whose points sit closer than |d| to the wall — the
  guard rejects them.
- **Join tolerance:** a miter past a dropped arc needs extending by
  up to ~|d| + the dropped arc's radius (6.175 mm for d=3.175), not
  |d| + 0.5. Join-candidate tolerance is 2|d| + 5 mm; the
  min-distance guard remains the backstop against a wrong candidate.
- **Round joins at convex corners for OUTWARD offsets only.** The
  miter point sits |d|·sec(θ/2) from the vertex, so the tool would
  leave a triangle of material at the corner (1.31 mm at a 90°
  corner with a 1/4 in tool). Outward + convex + miter beyond |d|
  → roll the tool around the vertex on an arc of radius |d|.
  Inward offsets keep the miter (standard contour-parallel clearing).
  Only at a genuine sharp vertex: where an arc was dropped between
  the two neighbours, its offset radius went negative and the corner
  becomes sharp, so the miter IS the join (a round arc around the
  dropped arc's centre would gouge the corner).
- **Round-join gouge check (added 2026-11-24).** A round join is
  only valid if its sampled arc (5° steps) stays at distance ≥
  |d| − 0.05 mm from the rest of the original boundary; a convex
  corner shadowed by a nearby wall gouges with a round join but is
  fine with the miter — keep the miter then. (This fixed Kookabus
  P02 `PROFILE_THRU` outward by 4.7625 mm: the round join around
  the corner (322.05, 36.675) next to the 4 mm-deep notch dipped to
  4.415 mm from the notch bottom wall, a 0.35 mm gouge; the miter
  at (326.8125, 41.4375) is clear. It also fixed machined
  `POCKET_D5.00` outward, fails 1 → 0.)
- **Arc sweep direction is re-derived after the joins.** An offset
  arc's a0/a1 may require the opposite sweep from the original arc
  (its radius grew past the joins' angles — e.g. eight_parts P02
  pocket at d=−8.255: the offset arc spans 43..47° while the
  original spans 0..90° the other way; keeping ccw=false sweeps
  355°). Pick the sweep whose midpoint lies nearer the original
  arc's midpoint; set the flag only, keep a0/a1 in loop order.
- **Miter trim for grown arcs.** When an offset arc grows past the
  point where its two neighbouring offset lines meet (erosion
  distance past a small corner radius), the lines cross on their own
  segments and the arc lies closer than |d| to the other wall. The
  true boundary is the miter: drop the arc, join the lines at their
  intersection. (This fixed eight_parts P02 pocket k2 and added
  5 rings to that job's total.)
- **Side guard.** An inward offset must stay inside the loop, an
  outward one outside it. At a tooth where the strip is ~2|d| wide
  the erosion pinches off and the miter lands on the wrong side —
  the offset is rejected (returns null) instead of emitting a ring
  with points outside the outline. (This fixed Kookabus
  THROUGH_CUT loop 3, whose zigzag strip pinches at its teeth.)

## Known limits (all fail loudly; none silently wrong)

1. **Outward offsets of tiny pocket outlines are rejected
   (3 fails total, all Kookabus `POCKET_D0.60` loops 0, 4, 9:
   the grown loop self-intersects — thin slivers).** Machined
   `POCKET_D5.00` outward formerly failed the same way (the round
   join around the convex corner (−22, 20) came within 3.086 mm
   of the notch wall 2 mm below it, a 0.089 mm gouge); the
   round-join gouge check above now falls back to the miter and
   it passes (fails 1 → 0, verified 2026-11-24). The generator
   never uses outward offsets for pockets (pockets are inward
   only; profiles are simple outlines, all of which pass outward),
   so these do not block Phase 2.
2. **Erosion of discretised-spline loops can self-intersect at
   tight bends.** Kookabus `THROUGH_CUT` loop 1 (the 1.438 mm slot):
   k0 (d=−0.25) works, k1 (d=−0.45) self-intersects and returns null
   although 0.54 mm of slot remains. Through-cuts use centred
   passes, so this does not affect that layer; for a pocket the ring
   sequence would end early and the generator must surface the
   remaining core width rather than silently leave a ridge.
3. **Loops narrower than the tool vanish correctly — and the
   generator must say so.** Kookabus `POCKET_D0.60`: 8 of 11 tiny
   loops (average width ~0.42–0.49 mm) have no k0 ring for the
   0.50 mm endmill — the tool physically does not fit. The plan
   chose EM0.50 (the smallest tool in the config). A loop with no
   ring must be a named, recorded condition in the toolpaths output
   (skipped with a reason), not a silent omission — open question
   for the generator's error contract (see the V3.1 final report).
4. **General polygonal islands beyond concentric circles** use
   sampled clearance checks (the spike checks ring points against
   island outlines at 48 samples). The container's step pocket
   (3 concentric circles, r=23 / 17.97 / 15; rib min_width 5.03)
   classifies by nesting-depth parity (even = outer, odd = island)
   and works; arbitrary island shapes are not stress-tested beyond
   the four jobs.
5. **Non-simple / self-touching outlines fail loudly** rather than
   producing a wrong path. The guards above are the mechanism.

## Notes for Phase 2

- Reuse the spike's parser (`parseDxf`, `entitiesToSegs`,
  `parseLwpl`), assembly (`assemble`, `repairArcsInLayer`),
  and `offsetLoop` (with its guards), cleaned up — do not rewrite
  the geometry from scratch.
- The spike's heuristic tool (1/4 in for most layers) is too big
  for narrow pockets (`POCKET_D9.70`, P03 `POCKET_D4.20` show
  rings=0 in the spike); the generator uses the plan's tools, so
  this is a spike artifact, not an engine failure.
- Bore entries in plans have operation `"drill"` + kind `"bore"`
  (tool = endmill) vs kind `"drill"` (peck drill) — the generator
  must key off the plan entry's `kind`.
- Z model (decided during the spike): Z=0 at the bottom of stock;
  per-part `z_top` and thickness from `job.json` parts; layer
  `start_depth`/`cut_depth` are depths below the part top, so
  cut-bottom Z = `z_top − cut_depth`. No clearance plane exists in
  the config (only `pin_clearance_mm`); planned value:
  clearance_z = max part `z_top` + 5.0 mm, documented in the
  generator and in the toolpaths metadata.
