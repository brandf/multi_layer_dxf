#!/usr/bin/env bun
// V3.6 round-trip verification — §6.4 (V3_SCOPE.md).
//
// The posted G-code is parsed back into moves (ts/gcode_parse.ts)
// and re-simulated through the V3.4 dexel engine (ts/sim.ts); the
// resulting stock must match the toolpath sim's stock within
// tolerance. If it does not, the post is wrong — the G-code is not
// shipped (recorded `verified: false`, CLI exit 1).
//
// How it compares: both sims run on the SAME stock and pitch —
// and that stock is the RECORDED one (job.json `sim.stock`,
// docs-v3/job_model_v3.md §6.2: recorded, not re-derived), NOT
// prepareSim's fresh derivation. The distinction matters for
// off-origin jobs: the machined job's sheet sits at (-60,-40),
// and prepareSim without geometry bounds anchors the stock at
// (0,0) — a stock that does not even cover the cuts. The
// round-trip re-simulates against the stock the toolpath sim
// actually verified against; when the job has no `sim` section
// yet (posted before any sim run), it falls back to prepareSim's
// derivation. The pitch is likewise the recorded `sim.pitch_mm`
// when present, else choosePitch on the same stock. The
// comparison is the verifier's tolerance (pitch_mm + 0.05 mm,
// the same tolerance ts/sim_verify.ts uses) on column heights —
// but a raw column-by-column comparison is the WRONG verdict for
// an inch post, and the reason matters:
//
// A post rounds every coordinate (mm posts to 0.001 mm, inch
// posts to 0.0001 in = 0.00254 mm), and the sim samples arcs as
// chords whose phase depends on the arc radius in the 6th
// decimal. A column grazing a cut boundary — within ~0.003 mm of
// the tool edge, e.g. on the profile ramp's outer edge — flips
// between the two sims when the rounding moves the chord phase.
// On the reference container through masso-inch that is 784 raw
// flipped columns out of 5.4M (0.015%), all isolated singles.
// A real translation error looks nothing like that: shifting
// every X by 0.06 mm leaves 1,021 mismatches in contiguous runs
// (largest cluster 22); shifting Z by 0.2 mm leaves 1.85M; a
// truncated file leaves 1.06M. So the verdict is two stages,
// both reported:
//   1. BAND: a column counts as mismatched only when its height
//      is outside the 3x3 neighbourhood's height range (plus
//      tolerance) in the OTHER grid, checked both directions.
//      This excuses a cut edge that moved by less than one
//      column — the post's rounding (0.0025 mm) and the sim's
//      chord sagitta (pitch/4) are far inside one column, so a
//      genuine translation difference cannot hide here: it moves
//      an edge or a region, not a single column's neighbourhood.
//   2. CLUSTER: the surviving mismatches must be isolated
//      singles — the largest 4-connected cluster of mismatched
//      columns must be <= 3. Rounding fuzz flips isolated
//      columns (observed largest cluster 1 on the reference
//      container, inch); any real error produces a contiguous
//      run along the moved edge or region (observed >= 22 for a
//      0.06 mm shift). The raw counts are recorded alongside the
//      verdict so the stamp is auditable, never just a boolean.
//
// The parsed moves are re-flattened with the view model's
// flattenToolpaths (the same flattening the toolpath sim uses),
// grouped into one synthetic operation per consecutive tool
// segment. Feed values in the synthetic operations come from the
// parsed modal F (mm/min -> mm/s); they drive durations only —
// the dexel sweep does not depend on feed — so a missing F falls
// back to the job's feed for that tool, and a tool with no feed
// anywhere falls back to 10 mm/s. A parsed move naming a tool
// the plan does not name throws (the sim never guesses a tool).
//
// No I/O, no DOM, no Node/Bun APIs.

import { prepareSim, simulateRange, createGrid, choosePitch } from "./sim.ts";
import type { PreparedSim, StockSpec, PitchChoice } from "./sim.ts";
import { flattenToolpaths } from "./view3d/model.ts";
import type { ToolpathsIn } from "./view3d/model.ts";
import type { ParsedGcode } from "./gcode_parse.ts";

/** The stock the toolpath sim recorded for this job
 * (`sim.stock`, job_model_v3 §6.2), or null when the job has no
 * `sim` section yet. Shape-checked here, not trusted blindly:
 * a malformed recorded stock falls back to prepareSim's
 * derivation (and the validator would flag the section anyway).
 * Exported for the driver too — the post's bed-span check does
 * not need it (spans are origin-free), but the round-trip's grid
 * must be built on exactly this stock. */
export function recordedSimStock(job: Record<string, unknown>): StockSpec | null {
  const sim = job.sim;
  if (typeof sim !== "object" || sim === null) return null;
  const stock = (sim as Record<string, unknown>).stock;
  if (typeof stock !== "object" || stock === null) return null;
  const s = stock as Record<string, unknown>;
  const nums = ["x_min", "y_min", "x_mm", "y_mm", "top_mm"].every(
    (k) => typeof s[k] === "number" && Number.isFinite(s[k] as number),
  );
  if (!nums || (s.x_mm as number) <= 0 || (s.y_mm as number) <= 0 || (s.top_mm as number) <= 0) return null;
  const sug = s.suggested_thickness_mm;
  return {
    x_min: s.x_min as number,
    y_min: s.y_min as number,
    x_mm: s.x_mm as number,
    y_mm: s.y_mm as number,
    top_mm: s.top_mm as number,
    suggested_thickness_mm: typeof sug === "number" && Number.isFinite(sug) ? sug : null,
  };
}

/** The pitch the toolpath sim recorded (`sim.pitch_mm`), or null
 * — the round-trip then re-derives it with choosePitch on the
 * same stock (which reproduces the recorded pitch: same stock,
 * same smallest tool). */
export function recordedSimPitchMm(job: Record<string, unknown>): number | null {
  const sim = job.sim;
  if (typeof sim !== "object" || sim === null) return null;
  const p = (sim as Record<string, unknown>).pitch_mm;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

function pitchFor(stock: StockSpec, pitchMm: number | null, smallestToolDiaMm: number): PitchChoice {
  if (pitchMm !== null) {
    const nx = Math.max(1, Math.ceil(stock.x_mm / pitchMm));
    const ny = Math.max(1, Math.ceil(stock.y_mm / pitchMm));
    return {
      pitch_mm: pitchMm, nx, ny, columns: nx * ny,
      coarse: pitchMm > smallestToolDiaMm / 10 + 1e-9,
      coarse_reason: null,
    };
  }
  return choosePitch(stock, smallestToolDiaMm);
}

export type RoundTripResult = {
  verified: boolean;
  /** Dexel columns compared. */
  columns: number;
  /** Columns differing by more than the tolerance, before the band test. */
  rawMismatched: number;
  /** Columns still mismatched after the 3x3 band test (stage 1). */
  mismatched: number;
  /** 4-connected clusters among the stage-1 mismatches. */
  clusters: number;
  /** Largest stage-1 mismatch cluster, in columns (stage 2). */
  maxCluster: number;
  /** Largest absolute height difference, mm (raw, before the band test). */
  maxDiffMm: number;
  toleranceMm: number;
  pitchMm: number;
  /** Moves parsed from the G-code file. */
  movesParsed: number;
  /** Moves in the job's toolpaths. */
  movesToolpaths: number;
};

export const ROUND_TRIP_EPS_MM = 0.05;
/** Stage-2 bar: the largest mismatch cluster a rounding-fuzz
 * verdict tolerates (see the header — observed fuzz clusters
 * are singles; a 0.06 mm path shift already clusters 22). */
export const ROUND_TRIP_MAX_CLUSTER = 3;

function compareGrids(
  heightsA: Float32Array,
  heightsB: Float32Array,
  nx: number,
  ny: number,
  tol: number,
): { rawMismatched: number; mismatched: number; clusters: number; maxCluster: number; maxDiffMm: number } {
  const n = nx * ny;
  let rawMismatched = 0;
  let maxDiff = 0;
  const bad = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(heightsA[k] - heightsB[k]);
    if (d > maxDiff) maxDiff = d;
    if (d <= tol) continue;
    rawMismatched++;
    // Stage 1 — band: A's height must lie in B's 3x3 height
    // range (plus tol) AND B's in A's, else the column is a
    // genuine mismatch, not a sub-column edge shift.
    const i = k % nx;
    const j = (k / nx) | 0;
    let loB = Infinity, hiB = -Infinity, loA = Infinity, hiA = -Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const b = heightsB[jj * nx + ii];
        const a = heightsA[jj * nx + ii];
        if (b < loB) loB = b;
        if (b > hiB) hiB = b;
        if (a < loA) loA = a;
        if (a > hiA) hiA = a;
      }
    }
    const hA = heightsA[k];
    const hB = heightsB[k];
    if (!((hA >= loB - tol && hA <= hiB + tol) && (hB >= loA - tol && hB <= hiA + tol))) {
      bad[k] = 1;
    }
  }
  // Stage 2 — clusters: 4-connected runs among the survivors.
  let mismatched = 0;
  let clusters = 0;
  let maxCluster = 0;
  const seen = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (!bad[k]) continue;
    mismatched++;
    if (seen[k]) continue;
    clusters++;
    let size = 0;
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const ci = c % nx;
      const cj = (c / nx) | 0;
      const neighbours = [c + 1, c - 1, c + nx, c - nx];
      const inRow = [ci + 1 < nx, ci - 1 >= 0, true, true];
      for (let q = 0; q < 4; q++) {
        if (!inRow[q]) continue;
        const kk = neighbours[q];
        if (kk < 0 || kk >= n) continue;
        if (q === 2 && cj + 1 >= ny) continue;
        if (q === 3 && cj - 1 < 0) continue;
        if (bad[kk] && !seen[kk]) {
          seen[kk] = 1;
          stack.push(kk);
        }
      }
    }
    if (size > maxCluster) maxCluster = size;
  }
  return {
    rawMismatched,
    mismatched,
    clusters,
    maxCluster,
    maxDiffMm: Math.round(maxDiff * 1e6) / 1e6,
  };
}

/** Re-simulate parsed G-code moves against the toolpath sim and
 * compare the two stocks. `job` is the job object (with
 * toolpaths + tool_plan); `parsed` is the parser's output for a
 * file posted from that job. Throws on a job without toolpaths
 * or a parsed tool the plan does not name — those are caller
 * errors, not mismatches. */
export function roundTripVerify(
  job: Record<string, unknown>,
  parsed: ParsedGcode,
): RoundTripResult {
  const prep: PreparedSim = prepareSim(job);
  // Stock + pitch: the recorded sim's, when the job has one
  // (see the header — an off-origin job's derived stock does not
  // cover its cuts). Both grids are built on it, and the
  // toolpath moves are simulated into gridA explicitly
  // (simulateRange) rather than via simulateAll(prep), whose
  // grid is prepareSim's.
  const recStock = recordedSimStock(job);
  const stock = recStock ?? prep.stock;
  const pitchChoice = recStock
    ? pitchFor(stock, recordedSimPitchMm(job), prep.smallestToolDiaMm)
    : prep.pitch;
  const gridA = createGrid(stock, pitchChoice);
  simulateRange(gridA, prep.flat, prep.tools, 0, prep.flat.moves.length);
  const pitch = pitchChoice.pitch_mm;
  const tolerance = pitch + ROUND_TRIP_EPS_MM;

  // Synthetic toolpaths section from the parsed moves: one
  // operation per consecutive run of the same tool, in cut order.
  const toolpaths = job.toolpaths as { operations: { tool_id: string; feed_mm_s: number; plunge_mm_s: number; spindle_rpm: number }[] };
  const jobFeed = new Map<string, { feed: number; plunge: number; spindle: number }>();
  for (const op of toolpaths.operations ?? []) {
    if (!jobFeed.has(op.tool_id)) {
      jobFeed.set(op.tool_id, { feed: op.feed_mm_s, plunge: op.plunge_mm_s, spindle: op.spindle_rpm });
    }
  }
  const ops: ToolpathsIn["operations"] = [];
  for (const m of parsed.moves) {
    const last = ops[ops.length - 1];
    const feedMmS = m.feedMmMin !== null
      ? m.feedMmMin / 60
      : (jobFeed.get(m.toolId)?.feed ?? 10);
    if (last && last.tool_id === m.toolId) {
      last.moves.push(
        m.t === "arc"
          ? { t: "arc", x: m.x, y: m.y, z: m.z, i: m.i ?? 0, j: m.j ?? 0, cw: m.cw ?? false }
          : { t: m.t, x: m.x, y: m.y, z: m.z },
      );
    } else {
      const jf = jobFeed.get(m.toolId);
      ops.push({
        operation: "profile",
        layer: "",
        tool_id: m.toolId,
        feed_mm_s: feedMmS,
        plunge_mm_s: jf?.plunge ?? feedMmS,
        spindle_rpm: jf?.spindle ?? 0,
        pass: { kind: "rough", stepdown_index: null },
        moves: [
          m.t === "arc"
            ? { t: "arc", x: m.x, y: m.y, z: m.z, i: m.i ?? 0, j: m.j ?? 0, cw: m.cw ?? false }
            : { t: m.t, x: m.x, y: m.y, z: m.z },
        ],
      });
    }
  }
  const flatB = flattenToolpaths({
    version: 1,
    plan: "round-trip",
    clearance_z_mm: (job.toolpaths as { clearance_z_mm: number }).clearance_z_mm,
    operations: ops,
    skipped: [],
    stats: { operations: ops.length, moves: parsed.moves.length, rapid: 0, feed: 0, arc: 0 },
  });
  const gridB = createGrid(stock, pitchChoice);
  simulateRange(gridB, flatB, prep.tools, 0, flatB.moves.length);

  const cmp = compareGrids(gridA.heights, gridB.heights, gridA.nx, gridA.ny, tolerance);
  return {
    verified: cmp.maxCluster <= ROUND_TRIP_MAX_CLUSTER,
    columns: gridA.heights.length,
    rawMismatched: cmp.rawMismatched,
    mismatched: cmp.mismatched,
    clusters: cmp.clusters,
    maxCluster: cmp.maxCluster,
    maxDiffMm: cmp.maxDiffMm,
    toleranceMm: Math.round(tolerance * 1e6) / 1e6,
    pitchMm: pitch,
    movesParsed: parsed.moves.length,
    movesToolpaths: prep.flat.moves.length,
  };
}
