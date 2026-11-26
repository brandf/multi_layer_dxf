#!/usr/bin/env bun
// V3.4 headless verifier — `mldxf sim --verify <job-dir>` (no browser).
//
// Runs the dexel engine (ts/sim.ts) over the job's toolpaths and
// compares the simmed stock against the intended geometry from the
// job's layers (DXF geometry via ts/geometry.ts, the V3.3 extractor):
// pocket depths, hole diameters, profile outline — within a
// tolerance (the dexel pitch + a stated epsilon). A mismatch is a
// generator bug (or a sim bug — told apart by the independent
// checker in ~/workspace/v31-spike/check_toolpaths.py). This is the
// watcher for V3.1 §3.3's offsetting risk.
//
// How it checks (V3_SCOPE.md §5.6):
//   1. Simulate every move (rapids included — a rapid below the
//      stock top gouges, and the sim shows it).
//   2. Build the intended-floor map F: for every column, the
//      lowest height any feature covering it should reach — pocket
//      floors (even-odd fill of the layer loops), hole bottoms
//      (discs), profile kerf (the toolpath capsule, floor 0 or the
//      layer floor), tab zones (tab thickness, read from the bottom
//      pass's lift segments). Skipped loops are NOT covered —
//      uncut by design, they must stay at stock height. Uncovered
//      columns keep F = stock top.
//   3. Probes (cut deep enough, one-sided): pocket interiors inset
//      by tool radius + 2*pitch from every wall, hole centres,
//      bottom-pass toolpath points (expected = the move's Z there,
//      so tab lifts expect the tab height). A probe fails when the
//      simmed height is ABOVE floor + tolerance — material the
//      toolpaths should have removed but did not.
//   4. Global no-gouge (one-sided the other way): every column's
//      simmed height must be >= F - tolerance. Material the
//      toolpaths should not have touched (F = stock top), floors
//      cut too deep, tabs destroyed, low rapids — all show up here.
//      Unreachable material (pocket corners the tool cannot reach)
//      passes by design: it sits ABOVE its floor, which the
//      one-sided check allows; only the inset probes demand depth.
//
// Tolerance: pitch_mm + 0.05 mm, stated in the output. The engine
// is exact to its sampling (sagitta-bounded arc chords, analytic
// segment sweep), so the tolerance covers the dexel quantisation
// (a probe reads the nearest column, up to pitch/2 away) and the
// loop sampling (5 deg), not engine error.
//
// Output: exactly one JSON object on stdout (progress on stderr),
// exit 0 when the stock matches, 1 on a verification mismatch
// (`sim_mismatch`) or a named load error, 2 on an internal error.
// The `sim` object in the output IS the sim section for job.json
// (stock, pitch_mm, pitch_coarse, coarse_reason, checkpoints) —
// the Python CLI writes it into job.json + manifest.json on a pass
// only; a failed verification writes nothing. `checkpoints` is
// the V3.5 checkpoint index (docs-v3/job_model_v3.md §6.2); the
// verifier also writes the delta log itself (sim/delta.bin) on a
// pass — the log + the index are the seek state, built by the
// same single sim run (buildSeekData, ts/sim_seek.ts).
import { loadJobGeometry } from "./geometry.ts";
import {
  prepareSim, heightAt, arcStepDeg,
} from "./sim.ts";
import type { DexelGrid, PreparedSim } from "./sim.ts";
import { buildSeekData, checkpointIndex, serializeSeekData, DELTA_FILE } from "./sim_seek.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sampleMove } from "./view3d/model.ts";
import type { FlatMove } from "./view3d/model.ts";
import { loopPoints, segPoints, pointInPolygon, distToLoop, distToSeg } from "./offset.ts";
import type { Pt, Seg } from "./offset.ts";

type OpEntry = {
  operation: string;
  layer: string;
  tool_id: string;
  z_top_mm: number;
  z_bottom_mm: number;
  z_mm: number | null;
  tabs: { count: number; length_mm: number; thickness_mm: number; positions: { loop: number; s_mm: number }[] } | null;
  moves: FlatMove[];
  skipped: { loop: number; reason: string }[];
};

/** Loop points sampled at the sagitta-bounded step (the same rule
 * the sim sweeps by), not the 5 deg default: a chord polygon sits
 * inside the true loop by up to its sagitta, and the tool reaches
 * the true wall — a coarse polygon would leave a thin band the sim
 * cut but the intended-floor map did not cover. */
function loopPointsFine(loop: { segs: Seg[] }, pitch: number): Pt[] {
  const pts: Pt[] = [];
  for (const s of loop.segs) {
    const step = s.kind === "arc" ? arcStepDeg(s.r, pitch) : 5;
    pts.push(...segPoints(s, step).slice(0, -1));
  }
  return pts;
}

/** Arc sampling step for a toolpath move (the sim's rule). */
function stepFor(m: FlatMove, pitch: number): number {
  return m.t === "arc" && m.radius != null && m.radius > 0
    ? arcStepDeg(m.radius, pitch)
    : 5;
}

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

// ---------------------------------------------------------------- raster
//
// All rasterisation is row-wise over the dexel grid: for each grid
// row, the feature's intersection with that row is a set of x-spans,
// and the columns whose centres fall in a span are written. The
// grid is the same one the sim ran on, so a span maps exactly.

type Span = [number, number];

/** Column (or row) indices whose centres fall in [a, b]. The
 * origin and count differ per axis — x uses (x0, nx), y uses
 * (y0, ny) — so they are parameters, not read off the grid's x.
 * (fillDisc once passed its y-range through the x helper, which
 * silently filled the disc 400 rows off on a negative-origin
 * grid and was invisible on the (0,0) container.)
 * The 1e-9 slack (5e-11 mm) is floating-point noise only: when a
 * span edge lands exactly on a column centre, (a-origin)/pitch
 * can come out an epsilon above the integer (176.50000000000006
 * for -51.175 on a -60 grid), and the bare ceil would drop the
 * column the sim's distance test keeps. The slack is far below
 * the 0.001 mm toolpath rounding, so it changes no real
 * geometry. */
function indicesInSpan(origin: number, pitch: number, maxIndex: number, a: number, b: number): [number, number] {
  const i0 = Math.ceil((a - origin) / pitch - 0.5 - 1e-9);
  const i1 = Math.floor((b - origin) / pitch - 0.5 + 1e-9);
  return [Math.max(0, i0), Math.min(maxIndex, i1)];
}

function colsInSpan(grid: DexelGrid, x0: number, x1: number): [number, number] {
  return indicesInSpan(grid.x0, grid.pitchMm, grid.nx - 1, x0, x1);
}

function rowsInSpan(grid: DexelGrid, y0: number, y1: number): [number, number] {
  return indicesInSpan(grid.y0, grid.pitchMm, grid.ny - 1, y0, y1);
}

/** Even-odd fill of closed polygons (outer loops + islands together:
 * the even-odd rule makes an island a hole automatically). Skipped /
 * open loops are excluded by the caller. Sets F = min(F, value).
 * Spans and the row range are expanded by pitch/2: the fill polygon
 * is a chord sampling of the true loop, so its edges sit up to a
 * sagitta inside the true wall — without the expansion, the thin
 * band between the chord polygon and the true wall would read as
 * uncut (F = stock top) although the tool reaches the true wall.
 * The expansion only ever over-covers by half a column, in the
 * one-sided-safe direction (an over-covered column reads high,
 * which the no-gouge check allows). */
export function fillEvenOdd(grid: DexelGrid, F: Float32Array, polys: Pt[][], value: number): void {
  if (!polys.length) return;
  const { nx, pitchMm: pitch, y0 } = grid;
  // Row range over all polygons.
  let yLo = Infinity, yHi = -Infinity;
  for (const poly of polys) for (const p of poly) {
    if (p.y < yLo) yLo = p.y;
    if (p.y > yHi) yHi = p.y;
  }
  const j0 = Math.max(0, Math.floor((yLo - pitch / 2 - y0) / pitch - 0.5));
  const j1 = Math.min(grid.ny - 1, Math.floor((yHi + pitch / 2 - y0) / pitch - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * pitch;
    xs.length = 0;
    for (const poly of polys) {
      const n = poly.length;
      for (let k = 0; k < n; k++) {
        const a = poly[k], b = poly[(k + 1) % n];
        // Half-open rule: count the edge when y is in [min, max) —
        // a vertex on the scanline is counted once, never twice.
        if ((a.y <= y) !== (b.y <= y)) {
          xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * nx;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [i0, i1] = colsInSpan(grid, xs[k] - pitch / 2, xs[k + 1] + pitch / 2);
      for (let i = i0; i <= i1; i++) {
        const idx = row + i;
        if (value < F[idx]) F[idx] = value;
      }
    }
  }
}

/** Even-odd spans of closed polygons per row (for the profile
 * kerf: the kerf is the capsule MINUS the outline). Returns a map
 * row -> sorted spans. */
export function outlineSpansByRow(grid: DexelGrid, polys: Pt[][]): Map<number, Span[]> {
  const out = new Map<number, Span[]>();
  if (!polys.length) return out;
  const { pitchMm: pitch, y0 } = grid;
  let yLo = Infinity, yHi = -Infinity;
  for (const poly of polys) for (const p of poly) {
    if (p.y < yLo) yLo = p.y;
    if (p.y > yHi) yHi = p.y;
  }
  const j0 = Math.max(0, Math.floor((yLo - y0) / pitch - 0.5));
  const j1 = Math.min(grid.ny - 1, Math.floor((yHi - y0) / pitch - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * pitch;
    xs.length = 0;
    for (const poly of polys) {
      const n = poly.length;
      for (let k = 0; k < n; k++) {
        const a = poly[k], b = poly[(k + 1) % n];
        if ((a.y <= y) !== (b.y <= y)) {
          xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const spans: Span[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) spans.push([xs[k], xs[k + 1]]);
    out.set(j, spans);
  }
  return out;
}

/** Fill a disc (a drill/bore hole) with F = min(F, value). */
export function fillDisc(grid: DexelGrid, F: Float32Array, cx: number, cy: number, r: number, value: number): void {
  const { nx, pitchMm: pitch, x0, y0 } = grid;
  const [i0, i1] = colsInSpan(grid, cx - r, cx + r);
  const [j0, j1] = rowsInSpan(grid, cy - r, cy + r);
  const rSq = r * r;
  for (let j = j0; j <= j1; j++) {
    const dy = (y0 + (j + 0.5) * pitch) - cy;
    const row = j * nx;
    for (let i = i0; i <= i1; i++) {
      const dx = (x0 + (i + 0.5) * pitch) - cx;
      if (dx * dx + dy * dy > rSq) continue;
      const idx = row + i;
      if (value < F[idx]) F[idx] = value;
    }
  }
}

/** The x-interval of a toolpath segment's capsule (the segment
 * dilated by R) on the horizontal line y = cy, or null when the
 * capsule does not reach that row. The interval's endpoints are
 * among the endpoint-disc and tube candidate x values; candidates
 * are kept only when they are really within R of the segment
 * (verified by direct distance), so the [min, max] of the kept
 * candidates IS the interval (the capsule's intersection with a
 * line is a single interval). */
export function capsuleRowInterval(
  p0: { x: number; y: number }, p1: { x: number; y: number },
  R: number, cy: number,
): Span | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dd = dx * dx + dy * dy;
  const cand: number[] = [];
  for (const e of [p0, p1]) {
    const ddy = cy - e.y;
    // 1e-9 slack: at a row exactly R from an endpoint, ddy comes
    // out an epsilon over R in floating point (3.175000000000002
    // > 3.175) and the disc contributes nothing — and for a
    // horizontal segment the tube branch below is skipped
    // (dy = 0), so the whole row reads as no capsule at all
    // (eight_parts: a 672-column gouge along a through-cut's edge
    // row). The slack is far below any geometric tolerance.
    if (Math.abs(ddy) <= R + 1e-9) {
      const s = Math.sqrt(Math.max(0, R * R - ddy * ddy));
      cand.push(e.x - s, e.x + s);
    }
  }
  if (dy !== 0 && dd > 0) {
    const len = Math.sqrt(dd);
    const base = ((cy - p0.y) * dx) / dy;
    cand.push(p0.x + base - (R * len) / dy, p0.x + base + (R * len) / dy);
  }
  let lo = Infinity, hi = -Infinity;
  for (const x of cand) {
    if (distToSeg({ x, y: cy }, p0, p1) <= R + 1e-9) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  if (!Number.isFinite(lo)) return null;
  return [lo, hi];
}

/** Rasterise a toolpath polyline's capsule into F: every column
 * within R of the polyline gets F = min(F, value) — minus the
 * outline spans when `outside` is given (an outer profile's kerf
 * is outside the part outline only; the tool never cuts inside
 * it). `apply` chooses the combine (min for floors, max for tabs). */
export function rasteriseCapsule(
  grid: DexelGrid, F: Float32Array,
  pts: { x: number; y: number }[], R: number, value: number,
  outside: Map<number, Span[]> | null,
  apply: "min" | "max",
  skipMask: Uint8Array | null = null,
): void {
  if (pts.length < 2) return;
  const { nx, pitchMm: pitch, y0 } = grid;
  for (let k = 0; k + 1 < pts.length; k++) {
    const p0 = pts[k], p1 = pts[k + 1];
    const yLo = Math.min(p0.y, p1.y) - R;
    const yHi = Math.max(p0.y, p1.y) + R;
    const j0 = Math.max(0, Math.floor((yLo - y0) / pitch - 0.5));
    const j1 = Math.min(grid.ny - 1, Math.floor((yHi - y0) / pitch - 0.5));
    for (let j = j0; j <= j1; j++) {
      const cy = y0 + (j + 0.5) * pitch;
      const iv = capsuleRowInterval(p0, p1, R, cy);
      if (!iv) continue;
      // The capsule interval, minus the outline spans (outer only).
      let spans: Span[] = [iv];
      if (outside) {
        const cut = outside.get(j);
        if (cut) {
          const kept: Span[] = [];
          for (const [a, b] of spans) {
            let cur: Span[] = [[a, b]];
            for (const [s0, s1] of cut) {
              const next: Span[] = [];
              for (const [c0, c1] of cur) {
                if (s1 <= c0 || s0 >= c1) { next.push([c0, c1]); continue; }
                if (c0 < s0) next.push([c0, Math.min(c1, s0)]);
                if (c1 > s1) next.push([Math.max(c0, s1), c1]);
              }
              cur = next;
              if (!cur.length) break;
            }
            kept.push(...cur);
          }
          spans = kept;
        }
      }
      const row = j * nx;
      for (const [a, b] of spans) {
        const [i0, i1] = colsInSpan(grid, a, b);
        for (let i = i0; i <= i1; i++) {
          const idx = row + i;
          if (skipMask && skipMask[idx]) continue;
          if (apply === "min") {
            if (value < F[idx]) F[idx] = value;
          } else if (value > F[idx]) {
            F[idx] = value;
          }
        }
      }
    }
  }
}

/** Rasterise a capsule into a boolean mask (1 = covered). Same
 * row-wise sweep as rasteriseCapsule, without the outline
 * subtraction: the mask is only ever read where a tab capsule is,
 * and a tab capsule never extends inside the part outline (its
 * inner edge is the loop itself). */
export function rasteriseCapsuleMask(
  grid: DexelGrid, mask: Uint8Array,
  pts: { x: number; y: number }[], R: number,
): void {
  if (pts.length < 2) return;
  const { nx, pitchMm: pitch, y0 } = grid;
  for (let k = 0; k + 1 < pts.length; k++) {
    const p0 = pts[k], p1 = pts[k + 1];
    const yLo = Math.min(p0.y, p1.y) - R;
    const yHi = Math.max(p0.y, p1.y) + R;
    const j0 = Math.max(0, Math.floor((yLo - y0) / pitch - 0.5));
    const j1 = Math.min(grid.ny - 1, Math.floor((yHi - y0) / pitch - 0.5));
    for (let j = j0; j <= j1; j++) {
      const cy = y0 + (j + 0.5) * pitch;
      const iv = capsuleRowInterval(p0, p1, R, cy);
      if (!iv) continue;
      const [i0, i1] = colsInSpan(grid, iv[0], iv[1]);
      const row = j * nx;
      for (let i = i0; i <= i1; i++) mask[row + i] = 1;
    }
  }
}

// ---------------------------------------------------------------- verify

type LayerResult = {
  layer: string;
  operation: string | null;
  floor_mm: number | null;
  probes: number;
  failed: number;
  worst_mm: number;
  note: string | null;
};

function main(): void {
  const argv = process.argv.slice(2);
  const jobDirArg = argv.find((a: string) => !a.startsWith("-"));
  if (!jobDirArg) {
    console.log(JSON.stringify({ ok: false, error: "usage_error", message: "usage: bun ts/sim_verify.ts <job-dir>" }));
    process.exit(1);
  }
  const jobDir = jobDirArg;
  try {
    const loaded = loadJobGeometry(jobDir);
    const job = loaded.job;
    const prep: PreparedSim = prepareSim(job, loaded.bounds);
    const { grid, flat, tools } = prep;
    const pitch = prep.pitch.pitch_mm;
    const tol = pitch + 0.05;
    const t0 = performance.now();
    // V3.5: the sim runs chunk by chunk with the delta recorder —
    // the same sweep as simulateAll (the final grid is identical),
    // plus the delta log + checkpoints for seeking. The build stats
    // carry the sim timing (sim_ms below is the build time).
    const { data: seekData, stats: seekStats } = buildSeekData(prep);
    const simStats = { movesSimulated: seekStats.movesSimulated, loweredWrites: seekStats.loweredWrites };
    const simMs = performance.now() - t0;

    // Intended-floor map F (init = stock top: uncovered = uncut).
    const F = new Float32Array(grid.heights.length);
    F.fill(grid.topMm);

    const tp = job.toolpaths as { operations: OpEntry[]; skipped: { layer: string; loop: number; reason: string }[] };
    const entriesByLayer = new Map<string, OpEntry[]>();
    for (const op of tp.operations ?? []) {
      if (!entriesByLayer.has(op.layer)) entriesByLayer.set(op.layer, []);
      entriesByLayer.get(op.layer)!.push(op);
    }
    const skippedByLayer = new Map<string, Set<number>>();
    for (const s of tp.skipped ?? []) {
      if (!skippedByLayer.has(s.layer)) skippedByLayer.set(s.layer, new Set());
      skippedByLayer.get(s.layer)!.add(s.loop);
    }

    const results: LayerResult[] = [];
    let totalProbes = 0, totalFailed = 0;

    for (const jl of loaded.layers) {
      const entries = entriesByLayer.get(jl.layer) ?? [];
      const skipped = skippedByLayer.get(jl.layer) ?? new Set<number>();
      const res: LayerResult = {
        layer: jl.layer, operation: entries[0]?.operation ?? jl.operation ?? null,
        floor_mm: null, probes: 0, failed: 0, worst_mm: 0, note: null,
      };
      results.push(res);
      if (!entries.length) {
        res.note = "no toolpaths entries — must stay uncut (the global check enforces it)";
        continue;
      }
      const floor = Math.min(...entries.map((e) => e.z_bottom_mm));
      res.floor_mm = floor;
      const op = entries[0].operation;
      const loopPts = jl.loops.map((loop) => loopPoints(loop));
      // Fine-sampled loops for the F build (fill + outline spans):
      // the chord polygon must track the true loop to a sagitta,
      // not to 5 deg, or the wall band is mis-covered (see
      // loopPointsFine). Probes keep the 5-deg points — their inset
      // (R + 2*pitch) dwarfs the sampling error.
      const loopPtsFineList = jl.loops.map((loop) => loopPointsFine(loop, pitch));
      // Tool radii across the layer's entries (rough + finish may
      // differ — the smallest defines what is reachable).
      let rMin = Infinity;
      for (const e of entries) {
        const t = tools.get(e.tool_id);
        if (t) rMin = Math.min(rMin, t.radiusMm);
      }
      if (!Number.isFinite(rMin)) {
        fail("tool_unknown", `layer ${jl.layer} uses a tool with no resolved profile`);
      }

      if (op === "pocket") {
        // Fill the non-skipped closed loops (even-odd: islands
        // are holes automatically). A skipped loop stays uncut.
        const polys: Pt[][] = [];
        jl.loops.forEach((loop, li) => {
          if (loop.closed && !skipped.has(li)) polys.push(loopPtsFineList[li]);
        });
        fillEvenOdd(grid, F, polys, floor);
        if (!polys.length) {
          res.note = "all loops skipped — uncut by design (see toolpaths.skipped)";
          continue;
        }
        // Probes: interior points inset by R + 2*pitch from every
        // wall (outer + islands) — the tool centre can reach there,
        // so the floor must be reached. Cap 2000 per layer.
        const inset = rMin + 2 * pitch;
        const cand: Pt[] = [];
        let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
        for (const poly of polys) for (const p of poly) {
          if (p.x < xLo) xLo = p.x; if (p.x > xHi) xHi = p.x;
          if (p.y < yLo) yLo = p.y; if (p.y > yHi) yHi = p.y;
        }
        const step = 0.5;
        for (let y = yLo + step / 2; y <= yHi; y += step) {
          for (let x = xLo + step / 2; x <= xHi; x += step) {
            const p = { x, y };
            let insideCount = 0;
            for (const poly of polys) if (pointInPolygon(p, poly)) insideCount++;
            if (insideCount % 2 === 0) continue;
            let ok = true;
            for (const pts of loopPts) {
              if (distToLoop(p, pts) <= inset) { ok = false; break; }
            }
            if (ok) cand.push(p);
          }
        }
        const stride = Math.max(1, Math.ceil(cand.length / 2000));
        for (let k = 0; k < cand.length; k += stride) {
          const p = cand[k];
          const h = heightAt(grid, p.x, p.y);
          res.probes++;
          if (h > floor + tol) {
            res.failed++;
            if (h - floor > res.worst_mm) res.worst_mm = h - floor;
            if (process.env.SIM_VERIFY_DEBUG) {
              console.error(`[debug] failed probe ${jl.layer}: (${p.x.toFixed(2)},${p.y.toFixed(2)}) expected floor=${floor.toFixed(2)} sim h=${h.toFixed(2)}`);
            }
          }
        }
        if (!res.probes) res.note = "no interior probe point fits (pocket too small for the tool to reach an inset point)";
      } else if (op === "drill" || op === "bore") {
        jl.loops.forEach((loop, li) => {
          if (!loop.closed || skipped.has(li)) return;
          const pts = loopPts[li];
          let cx = 0, cy = 0;
          for (const p of pts) { cx += p.x; cy += p.y; }
          cx /= pts.length; cy /= pts.length;
          let r = 0;
          for (const p of pts) r += Math.hypot(p.x - cx, p.y - cy);
          r /= pts.length;
          fillDisc(grid, F, cx, cy, r, floor);
          // Probes: centre + 4 points at r/2.
          const probes: Pt[] = [
            { x: cx, y: cy },
            { x: cx + r / 2, y: cy }, { x: cx - r / 2, y: cy },
            { x: cx, y: cy + r / 2 }, { x: cx, y: cy - r / 2 },
          ];
          for (const p of probes) {
            const h = heightAt(grid, p.x, p.y);
            res.probes++;
            if (h > floor + tol) {
              res.failed++;
              if (h - floor > res.worst_mm) res.worst_mm = h - floor;
            }
          }
        });
        if (!res.probes) res.note = "all loops skipped — uncut by design (see toolpaths.skipped)";
      } else if (op === "profile") {
        // Through-cut slots are centred on the outline; outer
        // profiles run at tool radius outside it (the generator's
        // rule, mirrored here: /THROUGH_CUT/ in the layer name).
        const isThroughCut = /THROUGH_CUT/.test(jl.layer);
        const outlinePolys: Pt[][] = [];
        jl.loops.forEach((loop, li) => {
          if (loop.closed) outlinePolys.push(loopPtsFineList[li]);
        });
        const outside = isThroughCut ? null : outlineSpansByRow(grid, outlinePolys);
        // Bottom pass = the entry carrying tabs, else the lowest z.
        const bottom = entries.find((e) => e.tabs !== null)
          ?? entries.reduce((a, b) => ((a.z_mm ?? Infinity) < (b.z_mm ?? Infinity) ? a : b));
        const bottomTool = tools.get(bottom.tool_id);
        if (!bottomTool) fail("tool_unknown", `layer ${jl.layer} uses tool ${bottom.tool_id} with no resolved profile`);
        const R = bottomTool.radiusMm;
        // Kerf from every pass's feed/arc moves (rapids excluded:
        // a rapid's capsule is air, not a cut — rasterising it
        // would erase the no-stray-cut check under its path).
        // flat.moves carry opIndex = the index into
        // toolpaths.operations, so moves per entry are a filter.
        // The capsule is rasterised WITHOUT subtracting the outline
        // spans: the offset contour sits exactly one tool radius
        // outside the loop, so the capsule never goes inside the
        // part except for the chord-sagitta strip (up to pitch/4)
        // at the loop itself — and the sim genuinely cuts that
        // strip (its chords sag the same way). Subtracting the
        // outline removes exactly the strip the sim cuts and
        // manufactures a false gouge around every circular profile.
        const opIndex = new Map<OpEntry, number>();
        tp.operations.forEach((e, i) => opIndex.set(e, i));
        const movesOf = (e: OpEntry): FlatMove[] => {
          const idx = opIndex.get(e);
          return flat.moves.filter((m) => m.opIndex === idx);
        };
        for (const e of entries) {
          const moves = movesOf(e);
          for (const m of moves) {
            if (m.t === "rapid") continue;
            const pts = sampleMove(m, stepFor(m, pitch));
            rasteriseCapsule(grid, F, pts, R, floor, null, "min");
          }
        }
        // Tabs: the bottom pass rides at floor + thickness over the
        // tab spans (vertical lifts at the span boundaries in the
        // moves, then level contour segments at floor + thickness).
        // A tab segment is one that sits LEVEL at exactly the tab
        // height — merely being above the floor is NOT a tab: the
        // bottom pass also reaches the contour by a helical descent
        // that traverses the whole kerf while descending, and
        // mistaking the descent for tabs raises F to the tab height
        // across the whole kerf (a real bug this verifier had:
        // 877k false gouge columns before this condition).
        // The tab survives only where no other move cut below the
        // tab height: the lift/drop discs at the span ends (at the
        // floor) reach one tool radius into the span, and the
        // non-tab segments cut the kerf to the floor on both sides
        // of it. So the tab mask is the tab atoms' capsules MINUS
        // the capsules of every move that dips below the tab height
        // (this layer's own entries only — pockets and drills cut
        // inside the part and cannot reach the profile kerf).
        // A two-sided probe at each atom's middle then checks the
        // tab EXISTS at the tab height: a one-sided probe (h <=
        // tabZ) passes when the tab is cut away to 0, which is
        // exactly the failure the old generator had (its lifts sat
        // at the span boundaries, so the end discs ate the whole
        // 5 mm span under a 6.35 mm tool).
        if (bottom.tabs) {
          const thick = bottom.tabs.thickness_mm;
          const tabZ = floor + thick;
          let tabSkipped = 0;
          const cutBelowTab = new Uint8Array(grid.heights.length);
          for (const e of entries) {
            for (const m of movesOf(e)) {
              if (m.t !== "rapid" && Math.min(m.start.z, m.end.z) < tabZ - 1e-9) {
                rasteriseCapsuleMask(grid, cutBelowTab, sampleMove(m, stepFor(m, pitch)), R);
              }
            }
          }
          // Maximal runs of level segments at tabZ in the bottom
          // entry = the tab atoms (the generator lifts one radius
          // outside each span, so an atom spans the plan span plus
          // one radius on each side, and its middle is the span
          // middle — safely clear of the lift/drop discs).
          const moves = movesOf(bottom);
          const tabAtoms: { x: number; y: number }[][] = [];
          let run: { x: number; y: number }[] = [];
          const flush = () => { if (run.length >= 2) tabAtoms.push(run); run = []; };
          for (const m of moves) {
            if (m.t === "rapid") { flush(); continue; }
            const pts = sampleMove(m, stepFor(m, pitch));
            for (let k = 0; k + 1 < pts.length; k++) {
              const a = pts[k], b = pts[k + 1];
              if (Math.abs(a.z - b.z) < 1e-9
                && Math.abs(a.z - tabZ) < 0.01 && Math.abs(b.z - tabZ) < 0.01) {
                if (!run.length) run.push(a);
                run.push(b);
              } else {
                flush();
              }
            }
          }
          flush();
          for (const atom of tabAtoms) {
            for (let k = 0; k + 1 < atom.length; k++) {
              rasteriseCapsule(grid, F, [atom[k], atom[k + 1]], R, thick, outside, "max", cutBelowTab);
            }
            // The atom's middle is the point at half its arclength
            // — NOT atom[len/2]: a line segment samples to 2 points,
            // so atom[len/2] is the segment's END (the drop point,
            // cut to the floor), and the two-sided probe fails
            // spuriously on a healthy tab. (The container's atoms
            // are arcs with many points, so this never showed there.)
            let total = 0;
            for (let k = 0; k + 1 < atom.length; k++) total += Math.hypot(atom[k + 1].x - atom[k].x, atom[k + 1].y - atom[k].y);
            let mid = atom[atom.length - 1];
            if (total > 0) {
              let acc = 0;
              for (let k = 0; k + 1 < atom.length; k++) {
                const segLen = Math.hypot(atom[k + 1].x - atom[k].x, atom[k + 1].y - atom[k].y);
                if (acc + segLen >= total / 2) {
                  const t = segLen > 0 ? (total / 2 - acc) / segLen : 0;
                  mid = {
                    x: atom[k].x + t * (atom[k + 1].x - atom[k].x),
                    y: atom[k].y + t * (atom[k + 1].y - atom[k].y),
                  };
                  break;
                }
                acc += segLen;
              }
            }
            // A tab atom on an outer profile sits on the offset
            // contour — outside the stock when the part IS the sheet
            // (the machined plate). There is no stock there to
            // probe; heightAt would clamp it to the edge column and
            // fail spuriously. Skip it (counted, not hidden).
            if (mid.x < grid.x0 || mid.x >= grid.x0 + grid.nx * grid.pitchMm
              || mid.y < grid.y0 || mid.y >= grid.y0 + grid.ny * grid.pitchMm) {
              tabSkipped++;
              continue;
            }
            // Only probe atoms long enough to be a tab. The bottom
            // entry's helical descent and the tabbed traversal's
            // boundary splits leave hairline level fragments at the
            // tab height (0.02–0.06 mm) that are not tabs — a ramp
            // crossing z=1, or a sub-segment sliver — and the tool
            // cuts straight through them to the floor, so a
            // two-sided probe on one fails by the full tab
            // thickness (Kookabus P02 through-cut: 20 such
            // fragments vs 3 real 5.5 mm tabs). A real tab is
            // length_mm long (plus the tool-radius extension), so
            // an atom under half the tab length is a fragment.
            const minTabLen = (bottom.tabs?.length_mm ?? 0) * 0.5;
            if (total < minTabLen) continue;
            const h = heightAt(grid, mid.x, mid.y);
            res.probes++;
            if (Math.abs(h - tabZ) > tol) {
              res.failed++;
              if (Math.abs(h - tabZ) > res.worst_mm) res.worst_mm = Math.abs(h - tabZ);
              if (process.env.SIM_VERIFY_DEBUG) {
                console.error(`[debug] failed tab probe ${jl.layer}: atom ${tabAtoms.indexOf(atom)} mid=(${mid.x.toFixed(2)},${mid.y.toFixed(2)}) expected tabZ=${tabZ.toFixed(2)} sim h=${h.toFixed(2)} atomLen=${total.toFixed(2)}`);
              }
            }
          }
          if (process.env.SIM_VERIFY_DEBUG) {
            console.error(`[debug] ${jl.layer}: tabAtoms=${tabAtoms.length} tabZ=${tabZ} R=${R}`);
          }
          res.note = `${bottom.tabs.count} tab(s) of ${thick} mm on the bottom pass${tabSkipped ? `; ${tabSkipped} tab probe(s) outside the stock (part is the sheet), skipped` : ""}`;
        }
        // Probes: bottom-pass toolpath points (expected = the
        // move's Z there — floor, or the tab height over a tab).
        // Points outside the stock are skipped (an outer profile's
        // tool centre sits a radius outside the part, which is
        // outside the sheet when the part IS the sheet — there is
        // no stock there to probe, and heightAt would clamp to the
        // uncut edge column and fail spuriously).
        const probes: { x: number; y: number; z: number }[] = [];
        const moves = movesOf(bottom);
        let lastKept: { x: number; y: number } | null = null;
        let skippedOut = 0;
        for (const m of moves) {
          if (m.t === "rapid") continue;
          const pts = sampleMove(m, stepFor(m, pitch));
          for (const p of pts) {
            if (p.x < grid.x0 || p.x >= grid.x0 + grid.nx * grid.pitchMm
              || p.y < grid.y0 || p.y >= grid.y0 + grid.ny * grid.pitchMm) { skippedOut++; continue; }
            if (!lastKept || Math.hypot(p.x - lastKept.x, p.y - lastKept.y) >= 2) {
              probes.push(p);
              lastKept = p;
            }
          }
        }
        for (const p of probes.slice(0, 2000)) {
          const h = heightAt(grid, p.x, p.y);
          res.probes++;
          // The expected height is the move's Z, raised to the
          // intended floor F at that point: a probe on a z=0 move
          // that sits inside a tab's disc (within a tool radius of
          // a level segment at the tab height) is cut to the tab
          // height, not the floor, and F already encodes the tabs
          // (the tab pass raises F over the tab capsule). Without
          // the max, such probes fail by exactly the tab thickness
          // (Kookabus P02 through-cut: 20 probes at 1 mm).
          const gx = Math.floor((p.x - grid.x0) / grid.pitchMm);
          const gy = Math.floor((p.y - grid.y0) / grid.pitchMm);
          const expected = Math.max(p.z, F[gy * grid.nx + gx]);
          if (h > expected + tol) {
            res.failed++;
            if (h - expected > res.worst_mm) res.worst_mm = h - expected;
            if (process.env.SIM_VERIFY_DEBUG) {
              console.error(`[debug] failed probe ${jl.layer}: (${p.x.toFixed(2)},${p.y.toFixed(2)}) expected z=${expected.toFixed(2)} sim h=${h.toFixed(2)}`);
            }
          }
        }
        if (!res.probes) {
          res.note = (res.note ? res.note + "; " : "") +
            (skippedOut > 0
              ? `no bottom-pass probe points (${skippedOut} sampled point(s) outside the stock — part is the sheet, skipped)`
              : "no bottom-pass probe points (empty moves)");
        }
      } else {
        res.note = `unknown operation ${JSON.stringify(op)} — no feature built (the global check still guards it)`;
      }
      totalProbes += res.probes;
      totalFailed += res.failed;
      if (process.env.SIM_VERIFY_DEBUG) {
        let covered = 0;
        for (let i = 0; i < F.length; i++) if (F[i] < grid.topMm) covered++;
        console.error(`[debug] after ${jl.layer}: covered=${covered} probes=${res.probes} failed=${res.failed}`);
      }
    }

    // Global no-gouge: every column >= F - tol, except columns
    // within the boundary uncertainty band of a loop wall. Both
    // the sim and the verifier sample arcs as chords (sagitta <=
    // pitch/4), so at a feature boundary the two disagree by up to
    // a sagitta: the sim's toolpath chord reaches a sagitta past
    // the wall, and the fill's chord polygon stops a sagitta short
    // of it (the span expansion only partly compensates, because a
    // diagonal chord's sag projects to more than pitch/2 in x).
    // A column within (sagitta + pitch/2) of a loop wall is
    // therefore indistinguishable from the sampling error and is
    // not a gouge. This cannot hide a real defect: a real gouge
    // (a rapid groove, a ring plowing an island) cuts columns
    // millimetres from any wall, so it is still flagged by the
    // columns outside the band. Boundary columns are counted
    // separately and reported, never silently dropped.
    const sagitta = pitch / 4;
    const boundaryTol = sagitta + pitch / 2;
    const loopPtsAll: { pts: Pt[]; x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const jl of loaded.layers) {
      for (const loop of jl.loops) {
        const pts = loopPointsFine(loop, pitch);
        if (!pts.length) continue;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of pts) {
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
        }
        loopPtsAll.push({ pts, x0, x1, y0, y1 });
      }
    }
    const isBoundary = (x: number, y: number): boolean => {
      const p = { x, y };
      for (const l of loopPtsAll) {
        if (x < l.x0 - boundaryTol || x > l.x1 + boundaryTol || y < l.y0 - boundaryTol || y > l.y1 + boundaryTol) continue;
        if (distToLoop(p, l.pts) < boundaryTol) return true;
      }
      return false;
    };
    let gougeColumns = 0;
    let boundaryColumns = 0;
    let worstGouge = 0;
    const gougeSample: string[] = [];
    let gougeSeen = 0;
    for (let i = 0; i < grid.heights.length; i++) {
      const d = grid.heights[i] - F[i];
      if (d < -tol) {
        const gx = i % grid.nx, gy = Math.floor(i / grid.nx);
        const cx = grid.x0 + (gx + 0.5) * grid.pitchMm;
        const cy = grid.y0 + (gy + 0.5) * grid.pitchMm;
        if (isBoundary(cx, cy)) { boundaryColumns++; continue; }
        gougeColumns++;
        if (-d > worstGouge) worstGouge = -d;
        if (process.env.SIM_VERIFY_DEBUG) {
          gougeSeen++;
          // Spread the samples across the grid (every ~75th gouge
          // column) instead of the first 20 in index order, so the
          // samples show every region, not just the lowest rows.
          if (gougeSample.length < 20 && gougeSeen % 75 === 1) {
            gougeSample.push(`(${cx.toFixed(2)},${cy.toFixed(2)}) h=${grid.heights[i].toFixed(2)} F=${F[i].toFixed(2)}`);
          }
        }
      }
    }
    if (process.env.SIM_VERIFY_DEBUG) {
      console.error(`[debug] gouge samples: ${gougeSample.join(" ")}`);
      console.error(`[debug] boundary columns (within ${boundaryTol.toFixed(4)} mm of a loop wall, excused): ${boundaryColumns}`);
      const isRealGouge = (i: number): boolean => {
        if (grid.heights[i] - F[i] >= -tol) return false;
        const gx = i % grid.nx, gy = Math.floor(i / grid.nx);
        return !isBoundary(grid.x0 + (gx + 0.5) * grid.pitchMm, grid.y0 + (gy + 0.5) * grid.pitchMm);
      };
      const byF = new Map<string, number>();
      const byH = new Map<string, number>();
      for (let i = 0; i < grid.heights.length; i++) {
        if (isRealGouge(i)) {
          byF.set(F[i].toFixed(2), (byF.get(F[i].toFixed(2)) ?? 0) + 1);
          byH.set(grid.heights[i].toFixed(2), (byH.get(grid.heights[i].toFixed(2)) ?? 0) + 1);
        }
      }
      console.error(`[debug] gouge by F: ${[...byF.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
      const topH = [...byH.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.error(`[debug] gouge by h (top 8): ${topH.map(([k, v]) => `${k}:${v}`).join(" ")}`);
      const byCell = new Map<string, number>();
      for (let i = 0; i < grid.heights.length; i++) {
        if (isRealGouge(i)) {
          const gx = i % grid.nx, gy = Math.floor(i / grid.nx);
          const cx = Math.floor((grid.x0 + (gx + 0.5) * grid.pitchMm) / 10) * 10;
          const cy = Math.floor((grid.y0 + (gy + 0.5) * grid.pitchMm) / 10) * 10;
          const key = `${cx},${cy}`;
          byCell.set(key, (byCell.get(key) ?? 0) + 1);
        }
      }
      console.error(`[debug] gouge by 10mm cell: ${[...byCell.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
      // When the count is small, list every column: a residual
      // handful is usually a boundary artefact, and the list is
      // what diagnoses it.
      if (gougeColumns <= 50) {
        const all: string[] = [];
        for (let i = 0; i < grid.heights.length; i++) {
          if (isRealGouge(i)) {
            const gx = i % grid.nx, gy = Math.floor(i / grid.nx);
            all.push(`(${(grid.x0 + (gx + 0.5) * grid.pitchMm).toFixed(2)},${(grid.y0 + (gy + 0.5) * grid.pitchMm).toFixed(2)}) h=${grid.heights[i].toFixed(2)} F=${F[i].toFixed(2)}`);
          }
        }
        console.error(`[debug] gouge all (${gougeColumns}): ${all.join(" ")}`);
      }
    }

    const plan = job.tool_plan as { chosen?: unknown; plans?: { id?: unknown; total_seconds?: number }[] } | undefined;
    const planTotal = (plan?.plans ?? []).find((p) => p.id === plan?.chosen)?.total_seconds;
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const failedLayers = results.filter((r) => r.failed > 0);
    const ok = failedLayers.length === 0 && gougeColumns === 0;
    // V3.5: on PASS only, write the delta log (sim/delta.bin) into
    // the job dir and carry its checkpoint index in the sim section.
    // A failing verification writes nothing — no log, no section —
    // so a present log always belongs to a verified sim. The write
    // is sync and its failure is an internal error (exit 2): the
    // section references the file, so a missing file would be a lie.
    let checkpoints: ReturnType<typeof checkpointIndex> | null = null;
    if (ok) {
      checkpoints = checkpointIndex(seekData);
      try {
        mkdirSync(join(jobDir, "sim"), { recursive: true });
        writeFileSync(join(jobDir, DELTA_FILE), serializeSeekData(seekData));
      } catch (e) {
        const err = e as Error;
        throw new Error(`failed to write the delta log (${DELTA_FILE}): ${err?.message ?? String(e)}`);
      }
    }
    const simSection = {
      stock: {
        x_min: prep.stock.x_min,
        y_min: prep.stock.y_min,
        x_mm: prep.stock.x_mm,
        y_mm: prep.stock.y_mm,
        top_mm: prep.stock.top_mm,
        suggested_thickness_mm: prep.stock.suggested_thickness_mm,
      },
      pitch_mm: pitch,
      pitch_coarse: prep.pitch.coarse,
      coarse_reason: prep.pitch.coarse_reason,
      checkpoints,
    };
    console.log(JSON.stringify({
      ok,
      error: ok ? null : "sim_mismatch",
      message: ok
        ? `simmed stock matches the intended geometry (${totalProbes} probes, 0 failed; ${gougeColumns} gouge columns; ${boundaryColumns} boundary columns within ${r3(boundaryTol)} mm of a wall, excused)`
        : [
            ...failedLayers.map((r) => `${r.layer}: ${r.failed}/${r.probes} probes above floor (worst ${r3(r.worst_mm)} mm)`),
            ...(gougeColumns ? [`global: ${gougeColumns} columns below intended floor (worst ${r3(worstGouge)} mm)`] : []),
          ].join("; "),
      job_id: loaded.job_id,
      sim: simSection,
      tolerance_mm: r3(tol),
      timing: {
        sim_ms: r3(simMs),
        ratio_vs_plan: typeof planTotal === "number" && simMs > 0 ? r3(planTotal / (simMs / 1000)) : null,
        ratio_vs_moves: simMs > 0 ? r3(flat.totalSeconds / (simMs / 1000)) : null,
        moves: simStats.movesSimulated,
        lowered_writes: simStats.loweredWrites,
      },
      // V3.5: the delta log + checkpoint index built by this run
      // (null on a failed verification — nothing was written).
      seek: ok ? {
        file: DELTA_FILE,
        chunks: seekStats.chunks,
        entries: seekStats.entries,
        checkpoints: seekStats.checkpoints,
        bytes: seekStats.bytes,
        build_ms: r3(seekStats.buildMs),
      } : null,
      layers: results.map((r) => ({
        layer: r.layer,
        operation: r.operation,
        floor_mm: r.floor_mm,
        probes: r.probes,
        failed: r.failed,
        worst_mm: r3(r.worst_mm),
        note: r.note,
      })),
      global: {
        columns: grid.heights.length,
        gouge_columns: gougeColumns,
        boundary_columns: boundaryColumns,
        boundary_tol_mm: r3(boundaryTol),
        worst_gouge_mm: r3(worstGouge),
      },
      counts: { probes: totalProbes, failed_probes: totalFailed },
    }));
    process.exit(ok ? 0 : 1);
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

if (import.meta.main) main();
