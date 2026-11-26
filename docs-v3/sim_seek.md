# V3.5 — delta log + checkpoints: seeking to any move's stock (docs-v3/sim_seek.md)

The sim is a dexel sweep: every move lowers some columns of a
Float32 height grid. Re-simulating from the start to reach move N
costs the whole sim (seconds on big jobs); the view needs the
stock at the scrub position in under a second, and the CLI needs
the same headlessly. The delta log records, per move-chunk, every
column the chunk lowered and its heights before and after — an
undo AND redo log in one file — so a seek is memory writes plus
at most one chunk re-simulated.

## Design

- **Chunks** (~30 s of cut time, at move boundaries, min 1 move):
  a chunk records the columns it lowered, once each, with their
  pre-chunk (old) AND post-chunk (new) heights — exact Float32,
  no quantisation. A column lowered twice in one chunk is recorded
  once, with its pre-chunk height. A seeked grid is therefore
  bit-identical to a fresh sim to the same move (the test asserts
  exact `gridsEqual` at every chunk boundary and at random moves,
  forward and backward).
- **Checkpoints** (every 5 min of cut time, always on chunk
  boundaries): `{move, time_s, chunk}` where `chunk` is the index
  of the chunk ending at that move (-1 for move 0). The first
  checkpoint is always move 0 (the initial stock); the last is
  always the final move. One checkpoint per chunk end — a chunk
  spanning two checkpoint intervals still checkpoints once (the
  grid there is the same for both multiples); the interval clock
  advances past every multiple the chunk end covers. (Found by
  test 2026-11-24: the first build pushed one checkpoint per
  crossed interval and two checkpoints landed at the same move,
  breaking the index's strictly-increasing move order — fixed in
  `stepSeekBuilder`, covered by the tiling test.)
- **Seek** (`seekTo`): forward = re-simulate to the end of the
  current chunk, apply whole chunks' NEW heights, re-simulate
  within the target chunk; backward = revert whole chunks' OLD
  heights back to the chunk containing the target, then
  re-simulate forward within it. At most ONE chunk is ever
  re-simulated; everything else is memory writes. `moveAtTime`
  maps cut seconds to the first move at/past that time (binary
  search over `timeAtMoveStart`).
- **Staleness**: a log is refused, never applied, when its grid
  dims, pitch, or move count differ from the prepared sim
  (`loadSeekDataIfFresh`; the job.json index's `moves` must equal
  the toolpaths' `stats.moves` — the validator checks this too).
  The log is a rebuildable cache, never source of truth: the
  toolpaths are, and `mldxf sim --verify` rebuilds it on PASS.

## Binary format — `sim/delta.bin` (v1)

Little-endian throughout. Deterministic bytes: the same job +
config snapshot produces the same file.

```
 0   8  magic "MLDXFDL1"
 8   4  u32 format (= 1)
12   4  u32 nx
16   4  u32 ny
20   4  f32 pitchMm
24   4  f32 topMm
28   4  f32 x0
32   4  f32 y0
36   4  f32 chunkCutSeconds
40   4  f32 checkpointCutSeconds
44   4  u32 moves
48   4  u32 chunkCount
52   4  u32 checkpointCount
56  per chunk: u32 startMove, u32 endMove, f32 startTimeS,
    f32 endTimeS, u32 entryCount, then entryCount x
    (u32 col, f32 oldH, f32 newH) — 12 bytes each
    then per checkpoint: u32 move, f32 time_s, i32 chunk
```

Header 56 B, chunk header 20 B, entry 12 B, checkpoint 12 B.
`parseSeekData` throws on a bad magic, an unknown format, a
truncated file, or chunks that do not tile `[0, moves)` — a
corrupt log is refused, never applied.

The job.json `sim.checkpoints` index points at the file
(`docs-v3/job_model_v3.md` §6.2):

```json
{ "file": "sim/delta.bin", "format": 1,
  "chunk_cut_seconds": 30, "checkpoint_cut_seconds": 300,
  "chunks": 8, "bytes": 39528444, "moves": 220,
  "checkpoints": [{ "move": 0, "time_s": 0, "chunk": -1 }, ...] }
```

## Size budget (measured 2026-11-24, 30 s chunks / 5 min checkpoints)

Per-write logging is out: the reference jobs make 12–106M
lowered writes, so the log records each lowered column once per
chunk instead. Budget: **≤ 500 MB on the largest reference job**
(Kookabus, 75,922 moves).

| job | chunks | entries | bytes | worst seek |
|---|---|---|---|---|
| real-container (verify-home) | 8 | 3,154,748 | 37.9 MB | 290 ms |
| real_container | 6 | 2,542,315 | 30.5 MB | 195 ms |
| machined | 8 | 2,563,618 | 30.8 MB | 359 ms |
| eight_parts | 24 | 10,552,058 | 126.6 MB | 199 ms |
| kookabus | 532 | 27,565,933 | 330.8 MB | 287 ms |

Every seeked grid bit-identical to a fresh sim at every probed
target; worst seek 359 ms < 1 s on all five jobs.

## Rejected alternatives (measured, not assumed)

- **Full checkpoints alone** (a materialised grid every 30 s):
  a 215-min job at 21.6 MB/grid is ~9.3 GB. Rejected by the
  scope; the delta log is ~60× smaller on Kookabus.
- **Per-chunk value dictionary** (store each distinct height once
  + an index per entry): heights are high-entropy — ramps and
  helices give near-unique values per column (worst chunk 906k
  distinct values) — it saves only ~19% on Kookabus (315 → 255
  MB). Rejected as not worth the complexity.
- **Bbox-cell cost model for chunk sizing** (size chunks by
  footprint cells instead of cut seconds): ns/cell varies 27–64
  across jobs (2.4× spread); cell-based chunking would shrink
  Kookabus but grow the container. Rejected.

## Where it lives

- `ts/sim_seek.ts` — `SeekData`/`SeekChunk`/`CheckpointEntry`,
  `createSeekBuilder` / `stepSeekBuilder` / `finishSeekBuilder`
  (steppable, for the view's yielding build) / `buildSeekData`
  (sync driver, the CLI path) / `buildSeekDataAsync` (one chunk
  per macrotask + progress), `seekTo`, `moveAtTime`,
  `chunkForMove`, `stockStats`, `gridsEqual`,
  `serializeSeekData` / `parseSeekData` / `serializedSize`,
  `checkpointIndex`, `loadSeekDataIfFresh`, `writeDeltaLog` /
  `readDeltaLog` (CLI-only file helpers), `buildSeekDataForJob`.
- `ts/sim.ts` — the recorder hook: `DeltaRecorder`
  (`createDeltaRecorder`, `beginDeltaChunk`), called only inside
  the three actual-lowering branches of `sweepSegment`; zero cost
  without a recorder. `simulateRange` takes an optional recorder.
- `ts/sim_verify.ts` — builds the seek data in its single sim run
  and writes `sim/delta.bin` on PASS only, returning the checkpoint
  index in the `sim` section (was `null` before V3.5).
- `ts/sim_seek_cli.ts` — `bun ts/sim_seek_cli.ts <job-dir>
  --move N | --time T`: loads `sim/delta.bin` when fresh, else
  rebuilds in memory, seeks from 0, prints one JSON object with
  the stock stats and the seek report. Read-only (never writes
  job.json). Wired as `mldxf sim --seek --move N | --time T`.
- `ts/view3d/entry.ts` — the view builds the seek data (async,
  chunked) after Simulate and seeks the shown stock on scrub,
  playback, and op-jump (see docs-v3/view3d.md).
- `ts/validate_job.ts` — shape-checks the checkpoint index and
  cross-checks `moves` against the toolpaths' `stats.moves`.
- `ts/sim_seek.test.ts` — chunk tiling, exact seek at every chunk
  boundary + random moves, backward-then-forward, clamping,
  binary round-trip + corruption refusal, checkpoint-index shape,
  `moveAtTime`, `chunkForMove`, `stockStats`, stale-log refusal,
  zero-move job, and the real-container exactness test.
