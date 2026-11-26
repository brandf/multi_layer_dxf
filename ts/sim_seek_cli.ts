#!/usr/bin/env bun
// V3.5 headless seek — `mldxf sim --seek <job-dir> --move N | --time T`
// (no browser). Loads the job's delta log (sim/delta.bin, built by
// `mldxf sim --verify`) when it is present and fresh for the current
// toolpaths, otherwise rebuilds the seek data in memory from the
// toolpaths (same build, same bytes — the log is a rebuildable
// cache, never source of truth). Seeks the stock to the requested
// move (or cut time) and reports the stock state there.
//
// Output: exactly one JSON object on stdout (progress on stderr),
// exit 0 on a seek, 1 on a named load error, 2 on an internal
// error. Read-only: it never writes job.json (a rebuild in memory
// does not publish a delta log — `mldxf sim --verify` does that).
import { loadJobGeometry } from "./geometry.ts";
import { prepareSim, createGrid } from "./sim.ts";
import {
  buildSeekData, seekTo, createSeekState, stockStats, moveAtTime,
  loadSeekDataIfFresh, readDeltaLog, DELTA_FILE,
} from "./sim_seek.ts";
import type { PreparedSim } from "./sim.ts";

class NamedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new NamedError(code, message);
}

function parseArgs(argv: string[]): { jobDir: string; move: number | null; timeS: number | null } {
  const jobDir = argv.find((a) => !a.startsWith("-"));
  if (!jobDir) fail("usage_error", "usage: bun ts/sim_seek_cli.ts <job-dir> --move N | --time T");
  const mi = argv.indexOf("--move");
  const ti = argv.indexOf("--time");
  if ((mi < 0) === (ti < 0)) {
    fail("usage_error", "give exactly one of --move N (move index) or --time T (cut seconds)");
  }
  let move: number | null = null;
  let timeS: number | null = null;
  if (mi >= 0) {
    move = Number(argv[mi + 1]);
    if (!Number.isFinite(move) || move < 0 || Math.floor(move) !== move) {
      fail("usage_error", `--move needs a non-negative integer (got ${JSON.stringify(argv[mi + 1])})`);
    }
  } else {
    timeS = Number(argv[ti + 1]);
    if (!Number.isFinite(timeS) || timeS < 0) {
      fail("usage_error", `--time needs a non-negative number of seconds (got ${JSON.stringify(argv[ti + 1])})`);
    }
  }
  return { jobDir, move, timeS };
}

async function main(): Promise<void> {
  const { jobDir, move, timeS } = parseArgs(process.argv.slice(2));
  try {
    const loaded = loadJobGeometry(jobDir);
    const job = loaded.job;
    const tp = job.toolpaths as { stats?: { moves?: unknown } } | undefined;
    if (!tp || typeof tp !== "object") {
      fail("toolpaths_unavailable", `${jobDir} has no toolpaths — the sim simulates the toolpaths. Run \`mldxf toolpaths\` first`);
    }
    const prep: PreparedSim = prepareSim(job, loaded.bounds);
    const grid = createGrid(prep.stock, prep.pitch);
    const state = createSeekState();
    // The delta log, when present and fresh; otherwise rebuild in
    // memory (same build the verifier runs — the log is a cache).
    const bytes = await readDeltaLog(jobDir);
    let data = loadSeekDataIfFresh(prep, bytes);
    let deltaLog: "loaded" | "rebuilt";
    if (data) {
      deltaLog = "loaded";
    } else {
      data = buildSeekData(prep).data;
      deltaLog = "rebuilt";
    }
    const target = move !== null ? move : moveAtTime(data, prep, timeS!);
    const rep = seekTo(data, prep, grid, state, target);
    const st = stockStats(grid);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    console.log(JSON.stringify({
      ok: true,
      job_id: loaded.job_id,
      move: rep.targetMove,
      time_s: r3(prep.flat.timeAtMoveStart[rep.targetMove]),
      total_moves: data.moves,
      total_seconds: r3(prep.flat.totalSeconds),
      delta_log: deltaLog,
      delta_file: deltaLog === "loaded" ? DELTA_FILE : null,
      stock: {
        pitch_mm: grid.pitchMm,
        columns: grid.heights.length,
        columns_lowered: st.columnsLowered,
        min_height_mm: r3(st.minHeightMm),
        max_height_mm: r3(st.maxHeightMm),
        volume_removed_mm3: r3(st.volumeRemovedMm3),
        volume_fraction: r3(st.volumeFraction),
      },
      seek: {
        from_move: rep.fromMove,
        resimulated_moves: rep.resimulatedMoves,
        applied_chunks: rep.appliedChunks,
        reverted_chunks: rep.revertedChunks,
        seek_ms: r3(rep.seekMs),
      },
    }));
    process.exit(0);
  } catch (e) {
    if (e instanceof NamedError) {
      console.log(JSON.stringify({ ok: false, error: e.code, message: e.message }));
      process.exit(1);
    }
    const err = e as Error;
    console.log(JSON.stringify({ ok: false, error: "internal_error", message: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` }));
    process.exit(2);
  }
}

if (import.meta.main) void main();
