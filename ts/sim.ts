#!/usr/bin/env bun
// V3.4 cut-simulation engine — dexel stock + CPU backend
// (V3_SCOPE.md §5.2, §5.4).
//
// Stock model: a 2D grid of vertical columns (dexels); each column
// stores its current top height in one Float32Array. A move lowers
// every column under the tool footprint to the tool envelope's height
// at that column. Dexel is the scoped call over voxel: voxel at
// 0.05 mm pitch on the container sheet is 1.08B cells dense, dexel is
// 5.4M columns / 21.6 MB — and the dexel's one blind spot,
// overhangs, cannot occur in a 2.5D prismatic job (the classifier
// only emits vertical walls; there are no undercuts for a dexel to
// miss).
//
// Sweep (the hot loop): each move is a segment (arcs are sampled
// from the true circle at a sagitta-bounded step — the chord error
// stays under pitch/4, inside the verification tolerance).
// For each column under the segment, the cut height is the minimum
// over the segment of z(t) + h(d(t)) — tool tip Z plus the profile
// envelope at the column's distance from the tool axis. That
// function is convex in t (h is convex non-decreasing in d, d is
// convex in t, z is linear), so:
//   - flat endmill (h = 0): the minimum is at one end of the
//     t-interval where the column is under the tool — exact, one
//     quadratic solve per column, no sampling;
//   - profiled tools (ball-nose, V-bit, bull-nose): ternary search
//     on the same interval — exact enough (16 iterations) and only
//     paid for tools that need it (all V3.1 jobs are flat).
// No per-sample disc stamping: a long straight move costs one pass
// over its footprint bbox, not (length / step) disc stamps.
//
// Rapids are simulated like any other move: a rapid at clearance is
// above the stock top, so its envelope never reaches a column and it
// cuts nothing (the segment is skipped outright when its lowest tip
// Z is at or above the stock top). A rapid that WOULD cross stock is
// therefore simulated as the gouge it is — the verifier catches it.
//
// The engine is a pure function of the job's toolpaths: same job +
// same config snapshot -> same dexel grid (deterministic). It runs
// in Bun (headless verifier), in the browser (the 3D view), and in
// tests — no I/O, no DOM, no Node/Bun APIs here. The browser runs it
// operation by operation (simulateRange) so the UI stays responsive;
// the headless path runs it in one call.
//
// Adaptive pitch (scope §5.2): pitch starts at 0.05 mm and doubles
// until the column count is under ~25M (~100 MB). The pitch actually
// used is recorded in job.json as sim.pitch_mm, so a coarse sim is
// never mistaken for a fine one. The floor rule: pitch never coarser
// than smallest-tool-diameter / 10 on jobs where the tool fits that
// budget; on jobs where it does not (Kookabus: 0.05 mm would need
// 28.2M columns), the sim says so (pitch_coarse + a reason).

import { flattenToolpaths, sampleMove } from "./view3d/model.ts";
import type { FlatMove, FlatToolpaths } from "./view3d/model.ts";
import { toolTableFromPlan } from "./tools.ts";
import type { ToolProfile, PlanToolIn } from "./tools.ts";

export const BASE_PITCH_MM = 0.05;
export const MAX_COLUMNS = 25_000_000;
/** Verification tolerance is stated by the verifier (pitch + eps);
 * the engine itself carries no tolerance. */

// ---------------------------------------------------------------- stock

export type StockSpec = {
  x_min: number;
  y_min: number;
  /** Sheet size in mm (job coordinates; origin at the sheet corner). */
  x_mm: number;
  y_mm: number;
  /** Stock top in mm (Z=0 at the bottom of stock). */
  top_mm: number;
  /** The purchase suggestion's thickness, when the job records one —
   * NOT the sim stock top (see stockSpecFromJob). */
  suggested_thickness_mm: number | null;
};

/** The stock the sim runs against, from the job (never re-derived
 * downstream — the sim section records this, so a re-run can be
 * checked against the same stock).
 *
 * Sheet XY comes from suggested_material (the sheet the parts were
 * laid out on); the stock TOP is the max part z_top, not
 * suggested_material.thickness. That thickness (10 mm on the
 * container job, where the parts top out at 9.5 mm) is a purchase
 * suggestion for nominal sheet — the whole pipeline (generator,
 * view, VCarve flow) assumes the stock top IS the part top: the
 * toolpaths cut from z_top down, and a rapid at clearance (max
 * z_top + 5) assumes nothing stands above z_top. Simming against
 * 10 mm would show every pocket starting 0.5 mm under uncut stock
 * the toolpaths never address. */
export type GeomBounds = { x_min: number; x_max: number; y_min: number; y_max: number };

/** Stock spec from a job. The stock is the suggested sheet
 * (x_mm x y_mm), and its top is the max part z_top (NOT the
 * suggested thickness — that is a purchase suggestion for nominal
 * sheet; the whole pipeline assumes stock top = part top).
 * Placement: anchored at (0,0) when the geometry fits inside the
 * (0,0)-anchored sheet (the container case: parts laid out at
 * (21.35,21.35) on a 160x90 sheet). When the geometry extends outside
 * it (the machined case: a single part centred on the origin,
 * x -60..60 on a 120x80 sheet, layout None), the sheet shifts
 * minimally to contain the geometry. Without geometry bounds the
 * old (0,0) placement is kept. */
export function stockSpecFromJob(job: Record<string, unknown>, geomBounds?: GeomBounds | null): StockSpec {
  const parts = job.parts as { z_top?: unknown }[] | null | undefined;
  let topMm: number | null = null;
  if (Array.isArray(parts) && parts.length) {
    for (const p of parts) {
      if (typeof p.z_top === "number" && Number.isFinite(p.z_top)) {
        topMm = topMm === null ? p.z_top : Math.max(topMm, p.z_top);
      }
    }
  } else if (typeof job.z_top === "number" && Number.isFinite(job.z_top)) {
    topMm = job.z_top as number;
  }
  if (topMm === null) {
    throw new Error("job has no part z_top (or top-level z_top) — cannot determine the stock top");
  }
  const sug = job.suggested_material as { x?: unknown; y?: unknown; thickness?: unknown } | null | undefined;
  let xMm: number | null = null;
  let yMm: number | null = null;
  let sugThick: number | null = null;
  if (sug && typeof sug === "object") {
    if (typeof sug.x === "number" && Number.isFinite(sug.x) && sug.x > 0) xMm = sug.x;
    if (typeof sug.y === "number" && Number.isFinite(sug.y) && sug.y > 0) yMm = sug.y;
    if (typeof sug.thickness === "number" && Number.isFinite(sug.thickness)) sugThick = sug.thickness;
  }
  if (xMm === null || yMm === null) {
    // No suggested sheet: fall back to the laid-out footprint.
    const layout = job.layout as { x_mm?: unknown; y_mm?: unknown; w_mm?: unknown; d_mm?: unknown }[] | null | undefined;
    if (Array.isArray(layout) && layout.length) {
      let xMax = 0, yMax = 0;
      for (const e of layout) {
        if (typeof e.x_mm === "number" && typeof e.w_mm === "number") xMax = Math.max(xMax, e.x_mm + e.w_mm);
        if (typeof e.y_mm === "number" && typeof e.d_mm === "number") yMax = Math.max(yMax, e.y_mm + e.d_mm);
      }
      if (xMm === null) xMm = xMax > 0 ? xMax : 100;
      if (yMm === null) yMm = yMax > 0 ? yMax : 100;
    } else {
      if (xMm === null) xMm = 100;
      if (yMm === null) yMm = 100;
    }
  }
  // Origin: (0,0) unless the geometry extends outside the
  // (0,0)-anchored sheet, in which case shift minimally to
  // contain it. (If the geometry is wider than the sheet the job
  // does not fit; the shift still aligns one edge and the
  // verifier flags the overflowing features as uncut.)
  let xMin = 0, yMin = 0;
  if (geomBounds) {
    if (geomBounds.x_min < xMin) xMin = geomBounds.x_min;
    if (geomBounds.x_max > xMin + xMm) xMin = geomBounds.x_max - xMm;
    if (geomBounds.y_min < yMin) yMin = geomBounds.y_min;
    if (geomBounds.y_max > yMin + yMm) yMin = geomBounds.y_max - yMm;
  }
  return { x_min: xMin, y_min: yMin, x_mm: xMm, y_mm: yMm, top_mm: topMm, suggested_thickness_mm: sugThick };
}

export type PitchChoice = {
  pitch_mm: number;
  nx: number;
  ny: number;
  columns: number;
  /** True when the pitch is coarser than smallest-tool-diameter / 10
   * (the job's smallest tool does not fit the pitch budget). */
  coarse: boolean;
  coarse_reason: string | null;
};

/** Adaptive pitch: 0.05 mm, doubling until the column count is under
 * MAX_COLUMNS. The floor (smallest tool / 10) is a reporting rule,
 * not a second constraint — on a job where the floor would bust the
 * budget, the budget wins and the sim says so (coarse + reason). */
export function choosePitch(stock: StockSpec, smallestToolDiaMm: number): PitchChoice {
  let pitch = BASE_PITCH_MM;
  let nx = Math.max(1, Math.ceil(stock.x_mm / pitch));
  let ny = Math.max(1, Math.ceil(stock.y_mm / pitch));
  while (nx * ny > MAX_COLUMNS && pitch < 6.4) {
    pitch *= 2;
    nx = Math.max(1, Math.ceil(stock.x_mm / pitch));
    ny = Math.max(1, Math.ceil(stock.y_mm / pitch));
  }
  const floor = smallestToolDiaMm / 10;
  const coarse = pitch > floor + 1e-9;
  return {
    pitch_mm: pitch,
    nx,
    ny,
    columns: nx * ny,
    coarse,
    coarse_reason: coarse
      ? `pitch ${pitch} mm is coarser than smallest-tool-diameter/10 (${floor} mm); ${BASE_PITCH_MM} mm would need ${Math.ceil(stock.x_mm / BASE_PITCH_MM) * Math.ceil(stock.y_mm / BASE_PITCH_MM)} columns, over the ${MAX_COLUMNS} budget`
      : null,
  };
}

// ---------------------------------------------------------------- grid

export type DexelGrid = {
  nx: number;
  ny: number;
  pitchMm: number;
  x0: number;
  y0: number;
  topMm: number;
  /** Column heights, row-major: heights[j * nx + i], i = x, j = y.
   * Column (i, j) covers the square centred at
   * (x0 + (i + 0.5) * pitch, y0 + (j + 0.5) * pitch). */
  heights: Float32Array;
};

export function createGrid(stock: StockSpec, pitch: PitchChoice): DexelGrid {
  const heights = new Float32Array(pitch.columns);
  heights.fill(stock.top_mm);
  return {
    nx: pitch.nx, ny: pitch.ny, pitchMm: pitch.pitch_mm,
    x0: stock.x_min, y0: stock.y_min, topMm: stock.top_mm, heights,
  };
}

/** Height of the column nearest (x, y) — the verifier's probe read. */
export function heightAt(grid: DexelGrid, x: number, y: number): number {
  const i = Math.min(grid.nx - 1, Math.max(0, Math.floor((x - grid.x0) / grid.pitchMm - 0.5)));
  const j = Math.min(grid.ny - 1, Math.max(0, Math.floor((y - grid.y0) / grid.pitchMm - 0.5)));
  return grid.heights[j * grid.nx + i];
}

// ---------------------------------------------------------------- sweep

export type SimStats = {
  movesSimulated: number;
  /** Columns lowered at least once (writes where the height dropped). */
  loweredWrites: number;
};

// ---------------------------------------------------------------- delta log
//
// V3.5 (docs-v3/sim_seek.md): the seek builder records, per move
// chunk, the columns the sim lowered and their pre-chunk heights —
// an undo log. The recorder is an OPTIONAL hook on the hot loop:
// it only fires on an actual lowering (never on a column merely
// tested), so a sim run without a recorder pays nothing for it.
// The mark array records, per column, the chunk id that last
// recorded it; a column lowered twice in one chunk is recorded
// once, with its pre-chunk height — reverting the chunk restores
// the grid to its pre-chunk state exactly, however many times the
// column was lowered inside the chunk.

export type DeltaRecorder = {
  /** Per-column chunk id of the last recording (grid-sized). */
  mark: Int32Array;
  /** The chunk currently being recorded. */
  chunkId: number;
  /** Columns recorded in the current chunk (first-touch order). */
  cols: number[];
  /** Pre-chunk heights for `cols`, parallel. */
  olds: number[];
};

/** A recorder for a grid of `columns` columns. Marks start at -1,
 * so chunk id 0 is the first real chunk. */
export function createDeltaRecorder(columns: number): DeltaRecorder {
  const mark = new Int32Array(columns);
  mark.fill(-1);
  return { mark, chunkId: 0, cols: [], olds: [] };
}

/** Start recording a new chunk: the recorded lists reset, the chunk
 * id advances. The mark array is NOT cleared — chunk ids
 * distinguish chunks, so a column recorded in an earlier chunk is
 * recorded again (with its new pre-chunk height) when it is
 * lowered in this one. */
export function beginDeltaChunk(rec: DeltaRecorder, chunkId: number): void {
  rec.chunkId = chunkId;
  rec.cols.length = 0;
  rec.olds.length = 0;
}

/** Record one lowering, inline in the sweep: only the FIRST
 * lowering of a column in the current chunk is recorded, with the
 * height BEFORE the lowering (the caller passes the pre-write
 * height). Called only when the height actually drops. */
function recordLowering(
  rec: DeltaRecorder | null | undefined,
  idx: number,
  oldHeight: number,
): void {
  if (!rec) return;
  if (rec.mark[idx] !== rec.chunkId) {
    rec.mark[idx] = rec.chunkId;
    rec.cols.push(idx);
    rec.olds.push(oldHeight);
  }
}

/** Arc sampling step (degrees) for an arc of the given radius at
 * the given pitch: the chord sagitta stays under pitch/4, clamped
 * to [0.5, 10] deg — small arcs take big steps, big arcs take small
 * ones. The SIM and the VERIFIER both use this rule, so the
 * verifier's capsule rasterisation samples exactly the chords the
 * sim swept (a coarser step in the verifier would leave a thin
 * band the sim cut but the intended-floor map did not cover). */
export function arcStepDeg(radiusMm: number, pitchMm: number): number {
  if (!(radiusMm > 0)) return 2;
  // Sagitta R*theta^2/8 <= pitch/4  =>  theta <= sqrt(2*pitch/R).
  const theta = Math.sqrt((2 * pitchMm) / radiusMm) * 180 / Math.PI;
  return Math.max(0.5, Math.min(10, theta));
}
function toolInterval(
  ux: number, uy: number, dx: number, dy: number, dd: number, rSq: number,
): [number, number] | null {
  const s = ux * dx + uy * dy;
  const disc = s * s - dd * (ux * ux + uy * uy - rSq);
  if (disc < 0) {
    // Floating-point dust around a tangent touch: treat a tiny
    // negative as zero (the column is grazed, not cut — the
    // interval collapses to a point and the envelope there is
    // above any cut that matters). But only when the tangent
    // point is actually ON the segment: a column whose closest
    // approach on the infinite line is past the endpoint (t
    // outside [0,1]) is further than R from the endpoint itself,
    // so clamping t into [0,1] would invent a graze at the
    // endpoint and cut a column the tool never reaches (the
    // machined through-cut's descent grazed three such columns
    // to its end Z).
    if (disc < -1e-9) return null;
    const t = s / dd;
    if (t < 0 || t > 1) return null;
    return [t, t];
  }
  const root = Math.sqrt(Math.max(0, disc));
  const ta = Math.max(0, (s - root) / dd);
  const tb = Math.min(1, (s + root) / dd);
  if (tb < ta) return null;
  return [ta, tb];
}

/** Lowest envelope height over the segment for a column inside the
 * tool interval [ta, tb]. Flat tools: exact endpoint minimum.
 * Profiled tools: ternary search on the convex envelope (16
 * iterations — the interval is already short). */
function envelopeMin(
  profile: ToolProfile, ta: number, tb: number,
  p0: { x: number; y: number; z: number }, dx: number, dy: number, dz: number,
  cx: number, cy: number,
): number {
  const zAt = (t: number) => p0.z + dz * t;
  if (profile.kind === "flat") {
    return Math.min(zAt(ta), zAt(tb));
  }
  const f = (t: number) => {
    const px = p0.x + dx * t;
    const py = p0.y + dy * t;
    const r = Math.hypot(cx - px, cy - py);
    return zAt(t) + profile.heightAt(r);
  };
  let lo = ta, hi = tb;
  for (let k = 0; k < 16; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return f((lo + hi) / 2);
}

/** Sweep one straight segment (p0 -> p1, tool tip Z in p.z) across
 * the grid. Returns the number of columns lowered. */
function sweepSegment(
  grid: DexelGrid,
  p0: { x: number; y: number; z: number },
  p1: { x: number; y: number; z: number },
  profile: ToolProfile,
  rec?: DeltaRecorder | null,
): number {
  const R = profile.radiusMm;
  const rSq = R * R;
  const zLo = Math.min(p0.z, p1.z);
  // The envelope's lowest point is the tip Z on the centreline
  // (h(0) = 0 for every profile). If even that is at or above the
  // stock top, the segment cannot cut anything — this is what makes
  // clearance rapids ~free.
  if (zLo >= grid.topMm) return 0;
  const { nx, ny, pitchMm: pitch, x0, y0, heights } = grid;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  const dd = dx * dx + dy * dy;
  const colOf = (v: number, origin: number) => Math.floor((v - origin) / pitch - 0.5);
  let i0 = colOf(Math.min(p0.x, p1.x) - R, x0);
  let i1 = colOf(Math.max(p0.x, p1.x) + R, x0);
  let j0 = colOf(Math.min(p0.y, p1.y) - R, y0);
  let j1 = colOf(Math.max(p0.y, p1.y) + R, y0);
  if (i1 < 0 || i0 >= nx || j1 < 0 || j0 >= ny) return 0;
  i0 = Math.max(0, i0); i1 = Math.min(nx - 1, i1);
  j0 = Math.max(0, j0); j1 = Math.min(ny - 1, j1);
  let lowered = 0;
  if (dd < 1e-18) {
    // Vertical (or stationary) move: one disc at the XY, cut to the
    // lowest tip Z + the profile height at each column's radius.
    const zMin = zLo;
    for (let j = j0; j <= j1; j++) {
      const cy = y0 + (j + 0.5) * pitch;
      const ddy = cy - p0.y;
      const row = j * nx;
      for (let i = i0; i <= i1; i++) {
        const cx = x0 + (i + 0.5) * pitch;
        const ddx = cx - p0.x;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > rSq) continue;
        const idx = row + i;
        const cut = profile.kind === "flat"
          ? zMin
          : zMin + profile.heightAt(Math.sqrt(d2));
        if (cut < heights[idx]) {
          recordLowering(rec, idx, heights[idx]);
          heights[idx] = cut;
          lowered++;
        }
      }
    }
    return lowered;
  }
  if (profile.kind === "flat" && dz === 0) {
    // FAST PATH — the overwhelmingly common case (level clearing
    // rings, level profile passes, planar arcs): the envelope is
    // flat at p0.z, so every column under the tool is cut to p0.z
    // and the only question per column is membership — closest
    // approach, squared, no sqrt, no per-column function call, and
    // no per-column division (1/dd is hoisted to a multiply).
    // (Spike: this is what takes the container from 25x to well
    // over the 50x target; the general path below pays a quadratic
    // solve + envelope evaluation per column.)
    const cutZ = p0.z;
    const invDd = 1 / dd;
    for (let j = j0; j <= j1; j++) {
      const cy = y0 + (j + 0.5) * pitch;
      const uy = cy - p0.y;
      const row = j * nx;
      for (let i = i0; i <= i1; i++) {
        const cx = x0 + (i + 0.5) * pitch;
        const ux = cx - p0.x;
        let t = (ux * dx + uy * dy) * invDd;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ux - dx * t;
        const qy = uy - dy * t;
        if (qx * qx + qy * qy > rSq) continue;
        const idx = row + i;
        if (cutZ < heights[idx]) {
          recordLowering(rec, idx, heights[idx]);
          heights[idx] = cutZ;
          lowered++;
        }
      }
    }
    return lowered;
  }
  for (let j = j0; j <= j1; j++) {
    const cy = y0 + (j + 0.5) * pitch;
    const uy = cy - p0.y;
    const row = j * nx;
    for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * pitch;
      const ux = cx - p0.x;
      const iv = toolInterval(ux, uy, dx, dy, dd, rSq);
      if (!iv) continue;
      const idx = row + i;
      const cut = envelopeMin(profile, iv[0], iv[1], p0, dx, dy, dz, cx, cy);
      if (cut < heights[idx]) {
        recordLowering(rec, idx, heights[idx]);
        heights[idx] = cut;
        lowered++;
      }
    }
  }
  return lowered;
}

// ---------------------------------------------------------------- run

export type PreparedSim = {
  stock: StockSpec;
  pitch: PitchChoice;
  grid: DexelGrid;
  flat: FlatToolpaths;
  tools: Map<string, ToolProfile>;
  smallestToolDiaMm: number;
};

/** Prepare a job for simulation: stock + pitch + grid + flattened
 * toolpaths + resolved tool table. Throws on a job without a v1
 * toolpaths section, on a tool the plan does not name, or on a job
 * with no determinable stock. Pure except for the throw — the
 * caller owns the job object. */
/** Prepare a sim from a job: flatten the toolpaths, build the tool
 * table, choose the pitch, create the grid. geomBounds (the DXF
 * geometry bounds, when the caller has them) places the stock so
 * it contains the geometry; without them the stock is anchored at
 * (0,0). */
export function prepareSim(job: Record<string, unknown>, geomBounds?: GeomBounds | null): PreparedSim {
  const tp = job.toolpaths as Parameters<typeof flattenToolpaths>[0] | undefined;
  if (!tp || typeof tp !== "object") {
    throw new Error("job has no toolpaths section — run `mldxf toolpaths` first");
  }
  const flat = flattenToolpaths(tp);
  const plan = job.tool_plan as { chosen?: unknown; plans?: { id?: unknown; tools?: PlanToolIn[] }[] } | undefined;
  const chosen = typeof plan?.chosen === "string" ? plan.chosen : null;
  const planEntry = (plan?.plans ?? []).find((p) => p.id === chosen);
  if (!planEntry || !Array.isArray(planEntry.tools)) {
    throw new Error(`job names no chosen plan with tools (chosen=${JSON.stringify(chosen)})`);
  }
  const toolIds = [...new Set(flat.operations.map((op) => op.toolId))];
  const tools = toolTableFromPlan(planEntry.tools, toolIds);
  let smallest = Infinity;
  for (const t of tools.values()) smallest = Math.min(smallest, t.diameterMm);
  if (!Number.isFinite(smallest)) {
    throw new Error("job uses no tools — nothing to simulate");
  }
  const stock = stockSpecFromJob(job, geomBounds);
  const pitch = choosePitch(stock, smallest);
  const grid = createGrid(stock, pitch);
  return { stock, pitch, grid, flat, tools, smallestToolDiaMm: smallest };
}

/** Simulate flat moves [startMove, endMove) into the grid (cut
 * order). Arcs are sampled from the true circle at a sagitta-bounded
 * step: the step angle is chosen per arc so the chord sagitta stays
 * under pitch/4 (0.0125 mm at 0.05 mm pitch), clamped to [0.5, 10]
 * deg — small arcs take big steps, big arcs take small ones, and the
 * chord error never approaches the verification tolerance. Returns
 * the run stats for the range. The caller loops over operations
 * (flat.operations[].startMove/endMove) when it wants to yield
 * between operations — the engine itself never yields.
 *
 * `recorder` (V3.5, optional): when given, every lowering in this
 * range is recorded into the current chunk (see DeltaRecorder) —
 * the seek builder passes one recorder per chunk. A run without a
 * recorder is the V3.4 behaviour, unchanged. */
export function simulateRange(
  grid: DexelGrid,
  flat: FlatToolpaths,
  tools: Map<string, ToolProfile>,
  startMove: number,
  endMove: number,
  recorder?: DeltaRecorder | null,
): SimStats {
  const stats: SimStats = { movesSimulated: 0, loweredWrites: 0 };
  const end = Math.max(startMove, Math.min(endMove, flat.moves.length));
  for (let mi = Math.max(0, startMove); mi < end; mi++) {
    const m: FlatMove = flat.moves[mi];
    const op = flat.operations[m.opIndex];
    const tool = tools.get(op.toolId);
    if (!tool) {
      throw new Error(`tool ${op.toolId} is used by the toolpaths but has no resolved profile`);
    }
    let stepDeg = 2;
    if (m.t === "arc" && m.radius != null && m.radius > 0) {
      stepDeg = arcStepDeg(m.radius, grid.pitchMm);
    }
    const pts = sampleMove(m, stepDeg);
    for (let k = 0; k + 1 < pts.length; k++) {
      stats.loweredWrites += sweepSegment(grid, pts[k], pts[k + 1], tool, recorder);
    }
    stats.movesSimulated++;
  }
  return stats;
}

/** Simulate every move of a prepared job. */
export function simulateAll(prep: PreparedSim): SimStats {
  return simulateRange(prep.grid, prep.flat, prep.tools, 0, prep.flat.moves.length);
}

// ---------------------------------------------------------------- mesh

export type StockMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  /** Grid stride used for the top surface (1 = every column). */
  stride: number;
  vertexCount: number;
  triangleCount: number;
};

/** The simmed stock as a render mesh: the top heightfield (at an
 * adaptive stride so the vertex count stays under maxVerts), skirts
 * down to Z=0 on all four sides, and a single bottom quad — so the
 * stock reads as a solid in the 3D view, not a floating sheet.
 * Positions are job coordinates (mm), Z=0 at the stock bottom. */
export function dexelToMesh(grid: DexelGrid, maxVerts = 120_000): StockMesh {
  const { nx, ny, pitchMm: pitch, x0, y0, heights } = grid;
  let stride = 1;
  const vertsAt = (s: number) =>
    (Math.floor((nx - 1) / s) + 1) * (Math.floor((ny - 1) / s) + 1);
  while (vertsAt(stride) > maxVerts && stride < 64) stride *= 2;
  const cols = Math.floor((nx - 1) / stride) + 1;
  const rows = Math.floor((ny - 1) / stride) + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  // Top surface.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const gi = Math.min(nx - 1, i * stride);
      const gj = Math.min(ny - 1, j * stride);
      positions.push(
        x0 + (gi + 0.5) * pitch,
        y0 + (gj + 0.5) * pitch,
        heights[gj * nx + gi],
      );
    }
  }
  const topIndex = (i: number, j: number) => j * cols + i;
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      const a = topIndex(i, j), b = topIndex(i + 1, j);
      const c = topIndex(i, j + 1), d = topIndex(i + 1, j + 1);
      indices.push(a, b, d, a, d, c);
    }
  }
  let nextVert = rows * cols;
  // Skirts: each side is a strip from the top edge down to Z=0.
  const skirt = (edge: { x: number; y: number; z: number }[]) => {
    const base = nextVert;
    for (const p of edge) positions.push(p.x, p.y, p.z);
    for (const p of edge) positions.push(p.x, p.y, 0);
    nextVert += edge.length * 2;
    for (let k = 0; k + 1 < edge.length; k++) {
      const t0 = base + k, t1 = base + k + 1;
      const b0 = base + edge.length + k, b1 = base + edge.length + k + 1;
      indices.push(t0, b0, b1, t0, b1, t1);
    }
  };
  const edgePts = (fixed: "x" | "y", at: number, count: number): { x: number; y: number; z: number }[] => {
    const out: { x: number; y: number; z: number }[] = [];
    for (let k = 0; k < count; k++) {
      const gi = fixed === "x" ? at : Math.min(nx - 1, k * stride);
      const gj = fixed === "y" ? at : Math.min(ny - 1, k * stride);
      out.push({
        x: x0 + (gi + 0.5) * pitch,
        y: y0 + (gj + 0.5) * pitch,
        z: heights[gj * nx + gi],
      });
    }
    return out;
  };
  skirt(edgePts("y", 0, cols));
  skirt(edgePts("y", ny - 1, cols));
  skirt(edgePts("x", 0, rows));
  skirt(edgePts("x", nx - 1, rows));
  // Bottom: one quad at Z=0.
  const bBase = nextVert;
  positions.push(
    x0, y0, 0,
    x0 + nx * pitch, y0, 0,
    x0 + nx * pitch, y0 + ny * pitch, 0,
    x0, y0 + ny * pitch, 0,
  );
  nextVert += 4;
  indices.push(bBase, bBase + 2, bBase + 1, bBase, bBase + 3, bBase + 2);
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    stride,
    vertexCount: nextVert,
    triangleCount: indices.length / 3,
  };
}
