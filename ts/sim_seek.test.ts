// sim_seek.test.ts — V3.5 delta log + checkpoint seek tests.
//
// The seek engine's contract: a grid sought to move N must be
// bit-identical to a fresh simulation of moves [0, N), for every N
// — forward, backward, and after arbitrary seek sequences. These
// tests run that contract on synthetic jobs (in-repo) and on the
// real container job when its fixture exists (skipped otherwise —
// the reference jobs live outside the repo).
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  prepareSim, simulateRange, createGrid, heightAt,
  type PreparedSim,
} from "./sim.ts";
import { loadJobGeometry } from "./geometry.ts";
import {
  buildSeekData, createSeekState, seekTo, chunkForMove, moveAtTime,
  stockStats, gridsEqual, serializeSeekData, parseSeekData,
  checkpointIndex, loadSeekDataIfFresh, CHUNK_CUT_SECONDS,
  type SeekData,
} from "./sim_seek.ts";

// ---------------------------------------------------------------- synthetic job

/** A minimal v3 job for prepareSim: 20x20x10 stock, one plan "A". */
function fakeJob(ops: {
  tool_id: string; moves: { t: string; x: number; y: number; z: number; i?: number; j?: number; cw?: boolean }[];
}[], planTools: { id: string; kind: string; dia_mm: number; angle_deg?: number; corner_radius_mm?: number }[]) {
  return {
    parts: [{ z_top: 10 }],
    suggested_material: { x: 20, y: 20, thickness: 10 },
    tool_plan: { chosen: "A", plans: [{ id: "A", tools: planTools }] },
    toolpaths: {
      version: 1, plan: "A", clearance_z_mm: 15,
      operations: ops.map((o, i) => ({
        operation: "pocket", layer: `L${i}`, tool_id: o.tool_id,
        feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 10000,
        pass: { kind: "rough", stepdown_index: null },
        z_mm: 5, z_top_mm: 10, z_bottom_mm: 5,
        tabs: null, moves: o.moves, skipped: [], notes: [],
      })),
      skipped: [],
      stats: { operations: ops.length, moves: ops.reduce((n, o) => n + o.moves.length, 0), rapid: 0, feed: 0, arc: 0 },
    },
  };
}

/** A job with enough cut time to span several 1-second chunks:
 * two pocket passes at z=5 and z=2, a ball-nose pass, and an arc. */
function multiChunkJob(): ReturnType<typeof fakeJob> {
  const straight: { t: string; x: number; y: number; z: number }[] = [
    { t: "rapid", x: 2, y: 10, z: 15 },
    { t: "feed", x: 2, y: 10, z: 5 },
  ];
  for (let x = 2; x <= 18; x += 2) {
    straight.push({ t: "feed", x, y: 10, z: 5 });
    straight.push({ t: "feed", x, y: 12, z: 5 });
  }
  const deep: { t: string; x: number; y: number; z: number }[] = [
    { t: "rapid", x: 2, y: 5, z: 15 },
    { t: "feed", x: 2, y: 5, z: 2 },
    { t: "feed", x: 18, y: 5, z: 2 },
    { t: "feed", x: 18, y: 7, z: 2 },
    { t: "feed", x: 2, y: 7, z: 2 },
  ];
  const arc: { t: string; x: number; y: number; z: number; i?: number; j?: number; cw?: boolean }[] = [
    { t: "rapid", x: 5, y: 5, z: 15 },
    { t: "feed", x: 5, y: 5, z: 8 },
    { t: "arc", x: 15, y: 5, z: 8, i: 5, j: 0, cw: true },
  ];
  return fakeJob(
    [
      { tool_id: "EM6.00", moves: straight },
      { tool_id: "EM6.00", moves: deep },
      { tool_id: "BN6.00", moves: arc },
    ],
    [
      { id: "EM6.00", kind: "endmill", dia_mm: 6 },
      { id: "BN6.00", kind: "ball-nose", dia_mm: 6 },
    ],
  );
}

/** Fresh-sim reference: simulate moves [0, n) into a new grid. */
function freshTo(prep: PreparedSim, n: number) {
  const grid = createGrid(prep.stock, prep.pitch);
  simulateRange(grid, prep.flat, prep.tools, 0, n);
  return grid;
}

describe("delta log + seek", () => {
  test("chunks tile [0, moves) and checkpoints bracket the job", () => {
    const prep = prepareSim(multiChunkJob());
    const total = prep.flat.moves.length;
    const { data, stats } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    expect(stats.movesSimulated).toBe(total);
    expect(stats.chunks).toBeGreaterThan(1);
    // Chunks tile the move range without gaps or overlaps.
    let at = 0;
    for (const c of data.chunks) {
      expect(c.startMove).toBe(at);
      expect(c.endMove).toBeGreaterThan(c.startMove);
      at = c.endMove;
    }
    expect(at).toBe(total);
    // Entries are non-negative, and every chunk's entries are
    // columns the chunk actually lowered (counted once per chunk).
    expect(stats.entries).toBe(data.chunks.reduce((n, c) => n + c.cols.length, 0));
    // First checkpoint is the initial stock; last is the final move.
    const cps = data.checkpoints;
    expect(cps[0]).toEqual({ move: 0, time_s: 0, chunk: -1 });
    expect(cps[cps.length - 1].move).toBe(total);
    for (let i = 1; i < cps.length; i++) expect(cps[i].move).toBeGreaterThan(cps[i - 1].move);
    // The builder's own stats agree with the data.
    expect(stats.checkpoints).toBe(cps.length);
    expect(stats.bytes).toBe(serializeSeekData(data).byteLength);
  });

  test("seek to every chunk boundary equals a fresh sim, exactly", () => {
    const prep = prepareSim(multiChunkJob());
    const total = prep.flat.moves.length;
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    const targets = new Set<number>([0, total]);
    for (const c of data.chunks) {
      targets.add(c.startMove);
      targets.add(c.endMove);
    }
    // A mid-chunk target and a few pseudo-random ones.
    targets.add(Math.floor(total / 3));
    targets.add(Math.floor(total / 2));
    targets.add(Math.floor((total * 2) / 3));
    for (const t of [...targets].sort((a, b) => a - b)) {
      const rep = seekTo(data, prep, grid, state, t);
      expect(rep.targetMove).toBe(t);
      expect(state.move).toBe(t);
      expect(gridsEqual(grid, freshTo(prep, t))).toBe(true);
    }
  }, 30000);

  test("backward then forward seeks return to the same grid", () => {
    const prep = prepareSim(multiChunkJob());
    const total = prep.flat.moves.length;
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    const sequence = [total, 0, Math.floor(total / 2), 0, total, 1, total - 1, 0, total];
    for (const t of sequence) {
      seekTo(data, prep, grid, state, t);
      expect(gridsEqual(grid, freshTo(prep, t))).toBe(true);
    }
  }, 30000);

  test("seek clamps out-of-range targets", () => {
    const prep = prepareSim(multiChunkJob());
    const total = prep.flat.moves.length;
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    expect(seekTo(data, prep, grid, state, -5).targetMove).toBe(0);
    expect(seekTo(data, prep, grid, state, total + 99).targetMove).toBe(total);
    expect(gridsEqual(grid, freshTo(prep, total))).toBe(true);
  });

  test("binary round-trip is byte-identical; bad files are refused", () => {
    const prep = prepareSim(multiChunkJob());
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const bytes = serializeSeekData(data);
    const parsed = parseSeekData(bytes);
    expect(Buffer.from(serializeSeekData(parsed)).equals(Buffer.from(bytes))).toBe(true);
    expect(parsed.chunks.length).toBe(data.chunks.length);
    // Checkpoint times round-trip through f32, so compare them
    // with tolerance; moves and chunk indices are exact.
    expect(parsed.checkpoints.length).toBe(data.checkpoints.length);
    for (let i = 0; i < data.checkpoints.length; i++) {
      expect(parsed.checkpoints[i].move).toBe(data.checkpoints[i].move);
      expect(parsed.checkpoints[i].chunk).toBe(data.checkpoints[i].chunk);
      expect(parsed.checkpoints[i].time_s).toBeCloseTo(data.checkpoints[i].time_s, 5);
    }
    // Corruptions are refused with a throw, never applied.
    const badMagic = Buffer.from(bytes);
    badMagic.write("XXXXXXX1", 0, "ascii");
    expect(() => parseSeekData(badMagic)).toThrow(/bad magic/);
    const badFormat = Buffer.from(bytes);
    badFormat.writeUInt32LE(99, 8);
    expect(() => parseSeekData(badFormat)).toThrow(/not supported/);
    expect(() => parseSeekData(bytes.subarray(0, 20))).toThrow(/shorter than/); // truncated header
    expect(() => parseSeekData(bytes.subarray(0, bytes.length - 5))).toThrow(/truncated/); // truncated body
    expect(() => parseSeekData(Buffer.alloc(0))).toThrow(/shorter than/);
  });

  test("checkpointIndex shape matches the job.json contract", () => {
    const prep = prepareSim(multiChunkJob());
    const { data, stats } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const idx = checkpointIndex(data);
    expect(idx.file).toBe("sim/delta.bin");
    expect(idx.format).toBe(1);
    expect(idx.moves).toBe(stats.movesSimulated);
    expect(idx.chunks).toBe(stats.chunks);
    expect(idx.bytes).toBe(stats.bytes);
    expect(idx.chunk_cut_seconds).toBe(1);
    expect(idx.checkpoint_cut_seconds).toBe(2);
    expect(idx.checkpoints[0]).toEqual({ move: 0, time_s: 0, chunk: -1 });
    expect(idx.checkpoints[idx.checkpoints.length - 1].move).toBe(stats.movesSimulated);
  });

  test("moveAtTime maps cut seconds to the first move at/past that time", () => {
    const prep = prepareSim(multiChunkJob());
    const total = prep.flat.moves.length;
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    expect(moveAtTime(data, prep, 0)).toBe(0);
    expect(moveAtTime(data, prep, -1)).toBe(0);
    expect(moveAtTime(data, prep, prep.flat.totalSeconds + 100)).toBe(total);
    // Every returned move's start time is >= the query time and the
    // previous move's is < it (the tightest such move).
    for (const t of [0.5, 1.0, 2.5, 5.0, 10.0]) {
      const m = moveAtTime(data, prep, t);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(total);
      if (m < total) expect(prep.flat.timeAtMoveStart[m]).toBeGreaterThanOrEqual(t - 1e-6);
      if (m > 0) expect(prep.flat.timeAtMoveStart[m - 1]).toBeLessThan(t + 1e-6);
    }
  });

  test("chunkForMove finds the chunk containing each move", () => {
    const prep = prepareSim(multiChunkJob());
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    for (const [i, c] of data.chunks.entries()) {
      expect(chunkForMove(data, c.startMove)).toBe(i);
      expect(chunkForMove(data, c.endMove - 1)).toBe(i);
    }
    // Past the last move is past the last chunk; before the first
    // move clamps to the first chunk.
    expect(chunkForMove(data, data.moves)).toBe(data.chunks.length);
    expect(chunkForMove(data, -1)).toBe(0);
  });

  test("stockStats: untouched grid is zero, simmed grid counts lowered columns", () => {
    const prep = prepareSim(multiChunkJob());
    const untouched = createGrid(prep.stock, prep.pitch);
    const s0 = stockStats(untouched);
    expect(s0.columnsLowered).toBe(0);
    expect(s0.volumeRemovedMm3).toBe(0);
    expect(s0.minHeightMm).toBe(10);
    expect(s0.maxHeightMm).toBe(10);
    const full = freshTo(prep, prep.flat.moves.length);
    const s1 = stockStats(full);
    expect(s1.columnsLowered).toBeGreaterThan(0);
    expect(s1.volumeRemovedMm3).toBeGreaterThan(0);
    expect(s1.minHeightMm).toBeCloseTo(2, 2); // deepest pass z=2
    expect(s1.maxHeightMm).toBe(10);
    expect(s1.volumeFraction).toBeGreaterThan(0);
    expect(s1.volumeFraction).toBeLessThan(1);
    // The groove floors are where the sim says they are: the
    // straight pass cuts y=10..12 to z=5 (checked at y=11, clear
    // of the deep pass, whose 6 mm tool reaches y=10 from y=7),
    // and the deep pass cuts y=5..7 to z=2.
    expect(heightAt(full, 10, 11)).toBeCloseTo(5, 2);
    expect(heightAt(full, 10, 5)).toBeCloseTo(2, 2);
  });

  test("loadSeekDataIfFresh refuses a log built for different toolpaths", () => {
    const prep = prepareSim(multiChunkJob());
    const { data } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    const bytes = serializeSeekData(data);
    expect(loadSeekDataIfFresh(prep, bytes)).not.toBeNull();
    expect(loadSeekDataIfFresh(prep, null)).toBeNull();
    // Stale: the header's move count differs from the prepared sim.
    const staleMoves = Buffer.from(bytes);
    new DataView(staleMoves.buffer).setUint32(44, data.moves + 1, true);
    expect(loadSeekDataIfFresh(prep, staleMoves)).toBeNull();
    // Wrong pitch.
    const wrongPitch = Buffer.from(bytes);
    new DataView(wrongPitch.buffer).setFloat32(20, data.pitchMm * 2, true);
    expect(loadSeekDataIfFresh(prep, wrongPitch)).toBeNull();
    // Wrong grid width.
    const wrongDims = Buffer.from(bytes);
    new DataView(wrongDims.buffer).setUint32(12, data.nx + 1, true);
    expect(loadSeekDataIfFresh(prep, wrongDims)).toBeNull();
    // Corrupt bytes are refused, not thrown.
    const corrupt = Buffer.from(bytes);
    corrupt.write("XXXXXXX1", 0, "ascii");
    expect(loadSeekDataIfFresh(prep, corrupt)).toBeNull();
  });

  test("defaults: chunk is 30 s of cut time", () => {
    expect(CHUNK_CUT_SECONDS).toBe(30);
  });

  test("a zero-move job builds no chunks and one checkpoint", () => {
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM6.00", moves: [] }],
      [{ id: "EM6.00", kind: "endmill", dia_mm: 6 }],
    ));
    const { data, stats } = buildSeekData(prep, { chunkCutSeconds: 1, checkpointCutSeconds: 2 });
    expect(stats.movesSimulated).toBe(0);
    expect(stats.chunks).toBe(0);
    expect(data.checkpoints).toEqual([{ move: 0, time_s: 0, chunk: -1 }]);
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    seekTo(data, prep, grid, state, 0);
    expect(gridsEqual(grid, freshTo(prep, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------- real job

describe("seek on the real container job", () => {
  // The reference jobs live outside the repo; skip when absent
  // (the synthetic tests above cover the logic in-repo).
  const jobDir = join(import.meta.dir, "..", "..", "v31-verify-home", "jobs", "20261124-160834-real-container");
  const hasJob = existsSync(join(jobDir, "job.json"));

  test("seek to every probed target equals a fresh sim, exactly", () => {
    if (!hasJob) {
      console.warn("skipping real-container seek test: reference job not present");
      return;
    }
    const job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
    const { bounds } = loadJobGeometry(jobDir);
    const prep = prepareSim(job, bounds);
    const total = prep.flat.moves.length;
    expect(total).toBe(220);
    const { data } = buildSeekData(prep);
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    const targets = [0, total, 1, 65, 100, 150, 219, data.chunks[0]?.endMove ?? 0];
    for (const t of targets) {
      seekTo(data, prep, grid, state, t);
      expect(gridsEqual(grid, freshTo(prep, t))).toBe(true);
    }
    // Worst-case seek latency on this job stays under 1 s.
    const t0 = performance.now();
    seekTo(data, prep, grid, state, 0);
    seekTo(data, prep, grid, state, total);
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 120000);
});
