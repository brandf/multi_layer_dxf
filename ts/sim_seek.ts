#!/usr/bin/env bun
// V3.5 rewind/seek — segment-indexed delta log + sparse checkpoints
// (V3_SCOPE.md §5.5, design (B)).
//
// The sim records, per move-chunk, the columns it lowered and their
// heights BEFORE and AFTER the chunk — an undo AND a redo log in one
// file. A column lowered twice in one chunk is recorded once, with
// its pre-chunk height, so reverting the chunk restores the grid to
// its pre-chunk state exactly, however many times the column was
// lowered inside the chunk. Heights are stored as exact Float32
// values (no quantisation): a seeked grid is bit-identical to a
// fresh sim to the same move, which the tests assert.
//
// Seeking (seekTo):
//   forward  = re-simulate to the end of the current chunk, then
//              apply whole chunks' NEW heights, then re-simulate
//              within the target chunk — at most ONE chunk of
//              re-simulation, the rest is memory writes;
//   backward = revert whole chunks' OLD heights back to the chunk
//              containing the target, then re-simulate forward
//              within that chunk — again at most one chunk.
// A chunk is ~30 s of cut time, so the re-simulation bound is a
// fraction of a second on the CPU backend (the slowest reference
// job, eight_parts, sims at ~90x real time: a 30 s chunk re-sims
// in ~0.3 s). Checkpoints are sparse (every 5 minutes of cut
// time): a checkpoint is a MOVE INDEX + its chunk, not a stored
// grid — the grid at a checkpoint is materialised by applying the
// delta log from a known state, and materialised grids are cached
// with a bounded count (LRU) by the caller, never all at once.
// Full checkpoints alone were evaluated and rejected: a checkpoint
// every 30 s of a 215-minute job at 21.6 MB/grid is ~9.3 GB.
//
// The binary format (sim/delta.bin, see serializeSeekData): a
// header (magic + grid dims + pitch + chunk/checkpoint intervals
// + counts), then one record per chunk (move range, time range,
// entry count, then entries of u32 column + f32 old height +
// f32 new height), then the checkpoint list. The job.json `sim`
// section carries the checkpoint index (checkpointIndex): the
// file, the format, the intervals, the counts, the byte size, the
// move count (a staleness check — a log built for different
// toolpaths is refused, never silently applied), and the
// checkpoints themselves. The dexel grid itself is derived data —
// recomputed from the toolpaths, never stored as source of truth;
// the delta log + checkpoints live under the job dir as sim/
// cache and are rebuildable (`mldxf sim --verify` rebuilds them).
//
// No I/O, no DOM, no Node/Bun APIs in this module except the
// optional file helpers at the bottom (used by the CLI entry, not
// by the browser view — the view builds seek data in memory during
// Simulate and never reads the file).

import {
  prepareSim, simulateRange, createDeltaRecorder, beginDeltaChunk,
} from "./sim.ts";
import type { DexelGrid, PreparedSim } from "./sim.ts";

/** Target cut time per delta chunk (seconds). Chunks are cut at
 * move boundaries: moves accumulate until the chunk's cut time
 * reaches this, so a chunk is at least one move. */
export const CHUNK_CUT_SECONDS = 30;
/** Sparse checkpoint interval (seconds of cut time). */
export const CHECKPOINT_CUT_SECONDS = 300;
/** The delta-log format version (job.json + the binary header). */
export const DELTA_FORMAT_VERSION = 1;
/** 8-byte magic at the start of sim/delta.bin. */
export const DELTA_MAGIC = "MLDXFDL1";
/** Job-relative path of the delta log under a job dir. */
export const DELTA_FILE = "sim/delta.bin";

export type SeekChunk = {
  /** First move of the chunk (inclusive, index into flat.moves). */
  startMove: number;
  /** Last move of the chunk (exclusive). */
  endMove: number;
  /** Cut time at the chunk start (seconds, from timeAtMoveStart). */
  startTimeS: number;
  /** Cut time at the chunk end (seconds). */
  endTimeS: number;
  /** Columns lowered in this chunk (first-touch order). */
  cols: Uint32Array;
  /** Pre-chunk heights for `cols` (exact Float32). */
  oldHeights: Float32Array;
  /** Post-chunk heights for `cols` (exact Float32). */
  newHeights: Float32Array;
};

export type CheckpointEntry = {
  /** Move index the checkpoint sits at (moves [0, move) applied). */
  move: number;
  /** Cut time at the checkpoint (seconds). */
  time_s: number;
  /** Index of the chunk ENDING at this move (-1 for move 0: no
   * chunk applied yet — the grid is the initial stock). */
  chunk: number;
};

export type SeekData = {
  format: 1;
  nx: number;
  ny: number;
  pitchMm: number;
  topMm: number;
  x0: number;
  y0: number;
  chunkCutSeconds: number;
  checkpointCutSeconds: number;
  /** Total moves the log covers. */
  moves: number;
  /** Total cut time (seconds). */
  totalSeconds: number;
  chunks: SeekChunk[];
  checkpoints: CheckpointEntry[];
  /** Serialized size in bytes (serializeSeekData length). */
  bytes: number;
};

/** The job.json `sim.checkpoints` object for a built log: the
 * index into the delta log (V3_SCOPE.md §5.5). `moves` is the
 * staleness check — a log whose move count differs from the job's
 * current toolpaths stats.moves was built for different toolpaths
 * and is refused, never applied. */
export type CheckpointIndex = {
  file: string;
  format: number;
  chunk_cut_seconds: number;
  checkpoint_cut_seconds: number;
  chunks: number;
  bytes: number;
  moves: number;
  checkpoints: CheckpointEntry[];
};

// ---------------------------------------------------------------- build

export type BuildSeekStats = {
  movesSimulated: number;
  loweredWrites: number;
  chunks: number;
  entries: number;
  checkpoints: number;
  bytes: number;
  buildMs: number;
};

/** Build the delta log for a prepared sim: run the sim chunk by
 * chunk with the recorder, finalising each chunk's new heights
 * from the grid. The returned grid IS prep.grid (fully simmed);
 * the chunks describe how to reach any earlier state from it (or
 * any later state from the initial grid). Deterministic: same
 * job + same config snapshot -> same chunks, same bytes.
 * `chunkCutSeconds` / `checkpointCutSeconds` are overridable for
 * tests; the defaults are the module constants.
 *
 * The build is a steppable state machine (createSeekBuilder /
 * stepSeekBuilder) so the browser view can yield between chunks
 * and keep the page responsive on big jobs; buildSeekData is the
 * synchronous driver, buildSeekDataAsync the yielding one. */
export type SeekBuilder = {
  prep: PreparedSim;
  rec: ReturnType<typeof createDeltaRecorder>;
  chunks: SeekChunk[];
  checkpoints: CheckpointEntry[];
  nextCheckpointAt: number;
  move: number;
  loweredWrites: number;
  entries: number;
  t0: number;
  chunkCutSeconds: number;
  checkpointCutSeconds: number;
};

export function createSeekBuilder(
  prep: PreparedSim,
  opts: { chunkCutSeconds?: number; checkpointCutSeconds?: number } = {},
): SeekBuilder {
  const chunkCutSeconds = opts.chunkCutSeconds ?? CHUNK_CUT_SECONDS;
  const checkpointCutSeconds = opts.checkpointCutSeconds ?? CHECKPOINT_CUT_SECONDS;
  if (!(chunkCutSeconds > 0) || !(checkpointCutSeconds > 0)) {
    throw new Error("chunk / checkpoint intervals must be positive seconds");
  }
  return {
    prep,
    rec: createDeltaRecorder(prep.grid.heights.length),
    chunks: [],
    checkpoints: [{ move: 0, time_s: 0, chunk: -1 }],
    nextCheckpointAt: checkpointCutSeconds,
    move: 0,
    loweredWrites: 0,
    entries: 0,
    t0: performance.now(),
    chunkCutSeconds,
    checkpointCutSeconds,
  };
}

/** Build one chunk. Returns true when the build is finished (all
 * moves simmed) — the caller then reads the result with
 * finishSeekBuilder. A chunk is at least one move: moves
 * accumulate until the chunk's cut time reaches the target. */
export function stepSeekBuilder(b: SeekBuilder): boolean {
  const { grid, flat, tools } = b.prep;
  const totalMoves = flat.moves.length;
  const totalSeconds = flat.totalSeconds;
  if (b.move >= totalMoves) return true;
  const chunkId = b.chunks.length;
  const startMove = b.move;
  const startTime = flat.timeAtMoveStart[startMove];
  let endMove = startMove + 1;
  while (
    endMove < totalMoves &&
    flat.timeAtMoveStart[endMove] - startTime < b.chunkCutSeconds
  ) {
    endMove++;
  }
  const endTime = flat.timeAtMoveStart[endMove];
  beginDeltaChunk(b.rec, chunkId);
  const st = simulateRange(grid, flat, tools, startMove, endMove, b.rec);
  b.loweredWrites += st.loweredWrites;
  const n = b.rec.cols.length;
  const cols = new Uint32Array(n);
  const olds = new Float32Array(n);
  const news = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = b.rec.cols[k];
    cols[k] = c;
    olds[k] = b.rec.olds[k];
    news[k] = grid.heights[c];
  }
  b.entries += n;
  b.chunks.push({
    startMove, endMove, startTimeS: startTime, endTimeS: endTime,
    cols, oldHeights: olds, newHeights: news,
  });
  // Sparse checkpoints: the first chunk end at or past each
  // multiple of the checkpoint interval (the chunk end is the
  // checkpoint — a checkpoint always sits on a chunk boundary,
  // so the grid there is exactly the applied chunks). One
  // checkpoint per chunk end: a chunk spanning two interval
  // multiples still checkpoints once (the grid there is the
  // same for both multiples), so the interval clock advances
  // past every multiple this chunk end covers — otherwise two
  // checkpoints would sit at the same move and the index's
  // strictly-increasing move order would break.
  if (endTime >= b.nextCheckpointAt - 1e-9 && b.nextCheckpointAt < totalSeconds) {
    b.checkpoints.push({ move: endMove, time_s: endTime, chunk: chunkId });
    do {
      b.nextCheckpointAt += b.checkpointCutSeconds;
    } while (b.nextCheckpointAt <= endTime + 1e-9);
  }
  b.move = endMove;
  if (b.move >= totalMoves) {
    const last = b.checkpoints[b.checkpoints.length - 1];
    if (last.move !== totalMoves) {
      b.checkpoints.push({
        move: totalMoves, time_s: totalSeconds, chunk: b.chunks.length - 1,
      });
    }
    return true;
  }
  return false;
}

/** Read the finished result out of a builder (after
 * stepSeekBuilder returns true). */
export function finishSeekBuilder(b: SeekBuilder): { data: SeekData; stats: BuildSeekStats } {
  const { grid } = b.prep;
  const data: SeekData = {
    format: 1,
    nx: grid.nx, ny: grid.ny, pitchMm: grid.pitchMm, topMm: grid.topMm,
    x0: grid.x0, y0: grid.y0,
    chunkCutSeconds: b.chunkCutSeconds,
    checkpointCutSeconds: b.checkpointCutSeconds,
    moves: b.prep.flat.moves.length,
    totalSeconds: b.prep.flat.totalSeconds,
    chunks: b.chunks,
    checkpoints: b.checkpoints,
    bytes: 0,
  };
  data.bytes = serializedSize(data);
  const stats: BuildSeekStats = {
    movesSimulated: data.moves,
    loweredWrites: b.loweredWrites,
    chunks: b.chunks.length,
    entries: b.entries,
    checkpoints: b.checkpoints.length,
    bytes: data.bytes,
    buildMs: performance.now() - b.t0,
  };
  return { data, stats };
}

export function buildSeekData(
  prep: PreparedSim,
  opts: { chunkCutSeconds?: number; checkpointCutSeconds?: number } = {},
): { data: SeekData; stats: BuildSeekStats } {
  const b = createSeekBuilder(prep, opts);
  while (!stepSeekBuilder(b)) {
    // Synchronous: the whole build runs in one call (the CLI path).
  }
  return finishSeekBuilder(b);
}

/** The yielding build (the browser view): one chunk per macrotask,
 * so the page stays responsive on big jobs. `onChunk(done, total)`
 * is called after each chunk for progress. */
export async function buildSeekDataAsync(
  prep: PreparedSim,
  opts: { chunkCutSeconds?: number; checkpointCutSeconds?: number } = {},
  onChunk?: (doneMoves: number, totalMoves: number) => void,
): Promise<{ data: SeekData; stats: BuildSeekStats }> {
  const b = createSeekBuilder(prep, opts);
  for (;;) {
    const finished = stepSeekBuilder(b);
    if (onChunk) onChunk(b.move, b.prep.flat.moves.length);
    if (finished) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  return finishSeekBuilder(b);
}

/** The checkpoint index for job.json's `sim.checkpoints`. */
export function checkpointIndex(data: SeekData): CheckpointIndex {
  return {
    file: DELTA_FILE,
    format: DELTA_FORMAT_VERSION,
    chunk_cut_seconds: data.chunkCutSeconds,
    checkpoint_cut_seconds: data.checkpointCutSeconds,
    chunks: data.chunks.length,
    bytes: data.bytes,
    moves: data.moves,
    checkpoints: data.checkpoints.map((c) => ({ ...c })),
  };
}

// ---------------------------------------------------------------- binary format
//
// Layout (little-endian throughout):
//   0   8  magic "MLDXFDL1"
//   8   4  u32 format (= 1)
//   12  4  u32 nx
//   16  4  u32 ny
//   20  4  f32 pitchMm
//   24  4  f32 topMm
//   28  4  f32 x0
//   32  4  f32 y0
//   36  4  f32 chunkCutSeconds
//   40  4  f32 checkpointCutSeconds
//   44  4  u32 moves
//   48  4  u32 chunkCount
//   52  4  u32 checkpointCount
//   56  per chunk: u32 startMove, u32 endMove, f32 startTimeS,
//       f32 endTimeS, u32 entryCount, then entryCount x
//       (u32 col, f32 oldH, f32 newH) — 12 bytes each
//   then per checkpoint: u32 move, f32 time_s, i32 chunk

const HEADER_BYTES = 56;
const CHUNK_HEADER_BYTES = 20;
const ENTRY_BYTES = 12;
const CHECKPOINT_BYTES = 12;

/** Serialized byte size of a seek data set (no allocation). */
export function serializedSize(data: SeekData): number {
  let n = HEADER_BYTES + data.checkpoints.length * CHECKPOINT_BYTES;
  for (const c of data.chunks) {
    n += CHUNK_HEADER_BYTES + c.cols.length * ENTRY_BYTES;
  }
  return n;
}

/** Serialize seek data to the binary format. Deterministic. */
export function serializeSeekData(data: SeekData): Uint8Array {
  const out = new Uint8Array(data.bytes);
  const dv = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode(DELTA_MAGIC), 0);
  dv.setUint32(8, DELTA_FORMAT_VERSION, true);
  dv.setUint32(12, data.nx, true);
  dv.setUint32(16, data.ny, true);
  dv.setFloat32(20, data.pitchMm, true);
  dv.setFloat32(24, data.topMm, true);
  dv.setFloat32(28, data.x0, true);
  dv.setFloat32(32, data.y0, true);
  dv.setFloat32(36, data.chunkCutSeconds, true);
  dv.setFloat32(40, data.checkpointCutSeconds, true);
  dv.setUint32(44, data.moves, true);
  dv.setUint32(48, data.chunks.length, true);
  dv.setUint32(52, data.checkpoints.length, true);
  let off = HEADER_BYTES;
  for (const c of data.chunks) {
    dv.setUint32(off, c.startMove, true);
    dv.setUint32(off + 4, c.endMove, true);
    dv.setFloat32(off + 8, c.startTimeS, true);
    dv.setFloat32(off + 12, c.endTimeS, true);
    dv.setUint32(off + 16, c.cols.length, true);
    off += CHUNK_HEADER_BYTES;
    for (let k = 0; k < c.cols.length; k++) {
      dv.setUint32(off, c.cols[k], true);
      dv.setFloat32(off + 4, c.oldHeights[k], true);
      dv.setFloat32(off + 8, c.newHeights[k], true);
      off += ENTRY_BYTES;
    }
  }
  for (const cp of data.checkpoints) {
    dv.setUint32(off, cp.move, true);
    dv.setFloat32(off + 4, cp.time_s, true);
    dv.setInt32(off + 8, cp.chunk, true);
    off += CHECKPOINT_BYTES;
  }
  if (off !== out.length) {
    throw new Error(`serializeSeekData: wrote ${off} bytes, expected ${out.length}`);
  }
  return out;
}

/** Parse the binary format. Throws on a bad magic, an unknown
 * format, a truncated file, or a chunk whose moves do not tile
 * [0, moves) in order — a corrupt log is refused, never applied. */
export function parseSeekData(bytes: Uint8Array): SeekData {
  if (bytes.length < HEADER_BYTES) {
    throw new Error(`delta log is ${bytes.length} bytes, shorter than the ${HEADER_BYTES}-byte header`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.slice(0, 8));
  if (magic !== DELTA_MAGIC) {
    throw new Error(`delta log has bad magic ${JSON.stringify(magic)}, expected ${JSON.stringify(DELTA_MAGIC)}`);
  }
  const format = dv.getUint32(8, true);
  if (format !== DELTA_FORMAT_VERSION) {
    throw new Error(`delta log format ${format} is not supported (this build reads ${DELTA_FORMAT_VERSION})`);
  }
  const nx = dv.getUint32(12, true);
  const ny = dv.getUint32(16, true);
  const pitchMm = dv.getFloat32(20, true);
  const topMm = dv.getFloat32(24, true);
  const x0 = dv.getFloat32(28, true);
  const y0 = dv.getFloat32(32, true);
  const chunkCutSeconds = dv.getFloat32(36, true);
  const checkpointCutSeconds = dv.getFloat32(40, true);
  const moves = dv.getUint32(44, true);
  const chunkCount = dv.getUint32(48, true);
  const checkpointCount = dv.getUint32(52, true);
  if (nx <= 0 || ny <= 0 || !(pitchMm > 0) || !(topMm > 0)) {
    throw new Error(`delta log has impossible grid dims (nx=${nx} ny=${ny} pitch=${pitchMm} top=${topMm})`);
  }
  let off = HEADER_BYTES;
  const chunks: SeekChunk[] = [];
  let expectMove = 0;
  for (let ci = 0; ci < chunkCount; ci++) {
    if (off + CHUNK_HEADER_BYTES > bytes.length) {
      throw new Error(`delta log is truncated inside chunk ${ci}'s header`);
    }
    const startMove = dv.getUint32(off, true);
    const endMove = dv.getUint32(off + 4, true);
    const startTimeS = dv.getFloat32(off + 8, true);
    const endTimeS = dv.getFloat32(off + 12, true);
    const entryCount = dv.getUint32(off + 16, true);
    off += CHUNK_HEADER_BYTES;
    if (startMove !== expectMove || endMove <= startMove || endMove > moves) {
      throw new Error(`delta log chunk ${ci} has moves [${startMove}, ${endMove}) — expected a chunk starting at ${expectMove}`);
    }
    if (off + entryCount * ENTRY_BYTES > bytes.length) {
      throw new Error(`delta log is truncated inside chunk ${ci}'s entries`);
    }
    const cols = new Uint32Array(entryCount);
    const olds = new Float32Array(entryCount);
    const news = new Float32Array(entryCount);
    for (let k = 0; k < entryCount; k++) {
      cols[k] = dv.getUint32(off, true);
      olds[k] = dv.getFloat32(off + 4, true);
      news[k] = dv.getFloat32(off + 8, true);
      if (cols[k] >= nx * ny) {
        throw new Error(`delta log chunk ${ci} entry ${k} names column ${cols[k]} outside the ${nx * ny}-column grid`);
      }
      off += ENTRY_BYTES;
    }
    chunks.push({ startMove, endMove, startTimeS, endTimeS, cols, oldHeights: olds, newHeights: news });
    expectMove = endMove;
  }
  if (expectMove !== moves) {
    throw new Error(`delta log chunks end at move ${expectMove}, expected ${moves}`);
  }
  if (off + checkpointCount * CHECKPOINT_BYTES > bytes.length) {
    throw new Error("delta log is truncated inside its checkpoint list");
  }
  const checkpoints: CheckpointEntry[] = [];
  for (let i = 0; i < checkpointCount; i++) {
    checkpoints.push({
      move: dv.getUint32(off, true),
      time_s: dv.getFloat32(off + 4, true),
      chunk: dv.getInt32(off + 8, true),
    });
    off += CHECKPOINT_BYTES;
  }
  if (off !== bytes.length) {
    throw new Error(`delta log has ${bytes.length - off} trailing bytes after its checkpoint list`);
  }
  const totalSeconds = checkpoints.length ? checkpoints[checkpoints.length - 1].time_s : 0;
  return {
    format: 1, nx, ny, pitchMm, topMm, x0, y0,
    chunkCutSeconds, checkpointCutSeconds,
    moves, totalSeconds, chunks, checkpoints,
    bytes: bytes.length,
  };
}

// ---------------------------------------------------------------- seek engine

export type SeekState = {
  /** Moves [0, move) are applied to the grid. */
  move: number;
};

export function createSeekState(): SeekState {
  return { move: 0 };
}

export type SeekReport = {
  targetMove: number;
  fromMove: number;
  /** Moves re-simulated (at most one chunk's worth, both ways). */
  resimulatedMoves: number;
  /** Whole chunks applied forward (new heights). */
  appliedChunks: number;
  /** Whole chunks reverted backward (old heights). */
  revertedChunks: number;
  seekMs: number;
};

/** The chunk containing move `m`: the chunk with
 * startMove <= m < endMove. move == moves returns chunks.length
 * (past the last chunk); move == 0 returns 0 when chunks exist. */
export function chunkForMove(data: SeekData, m: number): number {
  const chunks = data.chunks;
  if (!chunks.length) return 0;
  if (m >= data.moves) return chunks.length;
  let lo = 0, hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (m < c.startMove) hi = mid - 1;
    else if (m >= c.endMove) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(chunks.length - 1, lo));
}

/** Apply one chunk forward: every recorded column takes its
 * post-chunk height. Exact — the heights are the Float32 values
 * the sim wrote. */
export function applyChunkForward(grid: DexelGrid, chunk: SeekChunk): void {
  const { heights } = grid;
  for (let k = 0; k < chunk.cols.length; k++) {
    heights[chunk.cols[k]] = chunk.newHeights[k];
  }
}

/** Revert one chunk: every recorded column takes its pre-chunk
 * height. Exact, for the same reason. */
export function revertChunk(grid: DexelGrid, chunk: SeekChunk): void {
  const { heights } = grid;
  for (let k = 0; k < chunk.cols.length; k++) {
    heights[chunk.cols[k]] = chunk.oldHeights[k];
  }
}

/** Seek the grid (mutated in place) from `state.move` to
 * `targetMove`. The grid must currently hold the stock after
 * `state.move` moves — the caller owns that invariant (a fresh
 * grid starts at move 0, the initial stock). Returns what the
 * seek did, for diagnostics and latency measurement. At most one
 * chunk is ever re-simulated; every other move crossed is a
 * memory write through the delta log. */
export function seekTo(
  data: SeekData,
  prep: PreparedSim,
  grid: DexelGrid,
  state: SeekState,
  targetMove: number,
): SeekReport {
  const t0 = performance.now();
  const target = Math.max(0, Math.min(data.moves, Math.floor(targetMove)));
  const from = state.move;
  const rep: SeekReport = {
    targetMove: target, fromMove: from,
    resimulatedMoves: 0, appliedChunks: 0, revertedChunks: 0, seekMs: 0,
  };
  if (target === from) {
    rep.seekMs = performance.now() - t0;
    return rep;
  }
  const { flat, tools } = prep;
  if (target > from) {
    // Forward: re-simulate to the end of the current chunk, then
    // apply whole chunks, then re-simulate within the target chunk.
    let cur = from;
    const curChunk = chunkForMove(data, cur);
    if (curChunk < data.chunks.length) {
      const end = Math.min(data.chunks[curChunk].endMove, target);
      if (end > cur) {
        rep.resimulatedMoves += end - cur;
        simulateRange(grid, flat, tools, cur, end);
        cur = end;
      }
    }
    while (cur < target) {
      const next = chunkForMove(data, cur);
      if (next >= data.chunks.length) break;
      const c = data.chunks[next];
      if (c.endMove <= target) {
        applyChunkForward(grid, c);
        rep.appliedChunks++;
        cur = c.endMove;
      } else {
        rep.resimulatedMoves += target - cur;
        simulateRange(grid, flat, tools, cur, target);
        cur = target;
      }
    }
    state.move = cur;
  } else {
    // Backward: revert whole chunks until the chunk containing
    // the target, then re-simulate forward within that chunk.
    let cur = from;
    while (cur > target) {
      const k = chunkForMove(data, cur - 1);
      const c = data.chunks[k];
      revertChunk(grid, c);
      rep.revertedChunks++;
      cur = c.startMove;
    }
    if (cur < target) {
      rep.resimulatedMoves += target - cur;
      simulateRange(grid, flat, tools, cur, target);
      cur = target;
    }
    state.move = cur;
  }
  rep.seekMs = performance.now() - t0;
  return rep;
}

/** Seek to a cut time (seconds): the first move whose start time
 * is at or past the time. Clamped to [0, moves]. */
export function moveAtTime(data: SeekData, prep: PreparedSim, timeS: number): number {
  const t = Math.max(0, timeS);
  const times = prep.flat.timeAtMoveStart;
  if (t >= prep.flat.totalSeconds) return data.moves;
  let lo = 0, hi = data.moves;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- stock stats

export type StockStats = {
  /** Columns lowered below the stock top at least once. */
  columnsLowered: number;
  minHeightMm: number;
  maxHeightMm: number;
  /** Material removed, mm^3 (sum of (top - h) * pitch^2). */
  volumeRemovedMm3: number;
  /** Fraction of the stock volume removed. */
  volumeFraction: number;
};

/** Stock state at the current seek position: a full-grid scan.
 * (The scan is O(columns) — ~50-200 ms on the reference jobs —
 * so the CLI reports it once per seek, and the view does not call
 * it per frame.) */
export function stockStats(grid: DexelGrid): StockStats {
  const { heights, pitchMm, topMm } = grid;
  // Compare against the f32-rounded top: the grid stores
  // Float32(topMm), and a column reverted to its pre-chunk height
  // reads Float32(topMm) — which is a hair BELOW the f64 topMm
  // (21.8 as f32 is 21.79999924), so a bare `h < topMm` counts
  // every untouched column as lowered. The sim writes f32 values,
  // so f32(topMm) is the exact "untouched" height.
  const top = Math.fround(topMm);
  let lowered = 0;
  let min = Infinity, max = -Infinity;
  let removed = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < top) lowered++;
    if (h < min) min = h;
    if (h > max) max = h;
    // Same f32 top: an untouched column contributes exactly 0.
    removed += top - h;
  }
  const cellArea = pitchMm * pitchMm;
  const volumeRemoved = removed * cellArea;
  const stockVolume = heights.length * cellArea * top;
  return {
    columnsLowered: lowered,
    minHeightMm: min,
    maxHeightMm: max,
    volumeRemovedMm3: volumeRemoved,
    volumeFraction: stockVolume > 0 ? volumeRemoved / stockVolume : 0,
  };
}

/** Exact grid equality (Float32Array element-wise): a seeked grid
 * must equal a fresh sim to the same move bit-for-bit. */
export function gridsEqual(a: DexelGrid, b: DexelGrid): boolean {
  if (a.nx !== b.nx || a.ny !== b.ny || a.heights.length !== b.heights.length) return false;
  for (let i = 0; i < a.heights.length; i++) {
    if (a.heights[i] !== b.heights[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------- file helpers (CLI only)

export async function writeDeltaLog(jobDir: string, data: SeekData): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(jobDir, "sim");
  await mkdir(dir, { recursive: true });
  const bytes = serializeSeekData(data);
  await writeFile(join(dir, "delta.bin"), bytes);
  return join(dir, "delta.bin");
}

export async function readDeltaLog(jobDir: string): Promise<Uint8Array | null> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const buf = await readFile(join(jobDir, DELTA_FILE));
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Load a delta log for a prepared sim, or null when it is absent
 * or stale (dims / pitch / move count differ from the prepared
 * sim — a log built for different toolpaths is refused, never
 * silently applied). */
export function loadSeekDataIfFresh(prep: PreparedSim, bytes: Uint8Array | null): SeekData | null {
  if (!bytes) return null;
  let data: SeekData;
  try {
    data = parseSeekData(bytes);
  } catch {
    return null;
  }
  const g = prep.grid;
  if (
    data.nx !== g.nx || data.ny !== g.ny ||
    Math.abs(data.pitchMm - g.pitchMm) > 1e-9 ||
    Math.abs(data.topMm - g.topMm) > 1e-9 ||
    data.moves !== prep.flat.moves.length
  ) {
    return null;
  }
  return data;
}

/** Build seek data for a job object (the CLI path): prepare the
 * sim from the job + geometry bounds, then build. The caller owns
 * the geometry bounds (the verifier's loadJobGeometry). */
export function buildSeekDataForJob(
  job: Record<string, unknown>,
  geomBounds?: { x_min: number; x_max: number; y_min: number; y_max: number } | null,
): { data: SeekData; stats: BuildSeekStats; prep: PreparedSim } {
  const prep = prepareSim(job, geomBounds);
  const { data, stats } = buildSeekData(prep);
  return { data, stats, prep };
}
