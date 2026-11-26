// V3.3 view model — the 3D view's pure logic (no DOM, no three.js).
//
// This module is the part of the view that can be tested without a
// browser: flattening the job's toolpaths into one move list with
// true arcs, durations, colours, and the playback state machine.
// The browser entry (entry.ts) renders what this module computes;
// it adds no geometry of its own.
//
// Move model (docs-v3/job_model_v3.md §3.1): moves are rapid/feed
// with XYZ (mm, Z=0 at the bottom of stock — the JOB frame); arcs
// are first-class ((x,y,z) end point, (i,j) centre offset from
// the arc's start, cw direction) and stay arcs here — sampleArc()
// samples the TRUE circle (centre + radius + sweep), never a
// stored polyline. A helical arc (end Z != start Z) interpolates
// Z along the sweep. The RENDERER (entry.ts) shifts these moves
// into the job's Z-zero frame (ts/z_zero.ts) for display; this
// module stays job-frame, so cut time and the sim agree with it.
//
// Conventions, stated so the renderer and the tests agree:
// - A move's start is the previous move's end. The FIRST move's
//   start is the tool parked at clearance above its end XY
//   (clearance_z_mm from the toolpaths section): the job's first
//   move is always a rapid to (x, y, clearance), so this loses
//   nothing and gives the first rapid a real start.
// - Durations: a feed move runs at the operation's feed_mm_s (a
//   Z-only feed at plunge_mm_s); an arc at feed_mm_s; a rapid at
//   RAPID_FEED_MM_S (50 mm/s — rapids carry no feed in the move
//   model, so the timeline uses this stated constant, not a guess
//   per move). The timeline is a cut-time estimate for playback,
//   not a machine cycle-time prediction.
// - Seeking is a move-index jump (V3_SCOPE.md §4.4 as scoped for
//   this wave): set the index, recompute the tool position — never
//   replay from the beginning. The checkpoint + delta design is
//   the SIM's seeking (V3.5), not this wave's.

export type Pt3 = { x: number; y: number; z: number };
export type MoveIn =
  | { t: "rapid"; x: number; y: number; z: number }
  | { t: "feed"; x: number; y: number; z: number }
  | { t: "arc"; x: number; y: number; z: number; i: number; j: number; cw: boolean };
export type OperationIn = {
  operation: string;
  layer: string;
  tool_id: string;
  feed_mm_s: number;
  plunge_mm_s: number;
  spindle_rpm: number;
  pass: { kind: string; stepdown_index: number | null };
  moves: MoveIn[];
};
export type ToolpathsIn = {
  version: number;
  plan: string;
  clearance_z_mm: number;
  operations: OperationIn[];
  skipped: { layer: string; loop: number; reason: string }[];
  stats: { operations: number; moves: number; rapid: number; feed: number; arc: number };
};

export type FlatMove = {
  index: number;
  opIndex: number;
  t: "rapid" | "feed" | "arc";
  start: Pt3;
  end: Pt3;
  /** Arc centre (XY) — present only for arcs. */
  center: { x: number; y: number } | null;
  /** Arc radius — present only for arcs. */
  radius: number | null;
  /** Arc direction — present only for arcs. */
  cw: boolean | null;
  /** Sweep angle in radians (signed: negative for CW). Arcs only. */
  sweep: number | null;
  /** True path length in mm (arc length for arcs). */
  lengthMm: number;
  /** Cut time in seconds at the move's feed. */
  durationS: number;
  /** True when the arc's end Z differs from its start Z. */
  helical: boolean;
};
export type OpMeta = {
  index: number;
  operation: string;
  layer: string;
  toolId: string;
  toolDiaMm: number | null;
  feedMmS: number;
  startMove: number;
  endMove: number;
  color: string;
};
export type FlatToolpaths = {
  moves: FlatMove[];
  operations: OpMeta[];
  totalSeconds: number;
  clearanceZ: number;
  /** Cumulative cut time at the START of each move (length moves+1). */
  timeAtMoveStart: number[];
};

/** Rapids carry no feed in the move model; the playback timeline
 * runs them at this stated constant (see the header note). */
export const RAPID_FEED_MM_S = 50;

/** Colours by operation (V3_SCOPE.md §4.2: colour by operation
 * and by tool). The tool shade is a lightness shift of the
 * operation colour, keyed deterministically by tool id, so the
 * same tool is the same shade in every job. */
const OPERATION_COLORS: Record<string, string> = {
  drill: "#c0392b",
  bore: "#e67e22",
  pocket: "#1a5fb4",
  profile: "#27ae60",
};
export function operationColor(operation: string): string {
  return OPERATION_COLORS[operation] ?? "#7f8c8d";
}

/** Diameter in mm from a tool id (V3.1 ids embed it: EM3.17,
 * EM6.35, D2.25). Null when the id carries no trailing number —
 * the renderer falls back to a default diameter and says so. */
export function toolDiameterMm(toolId: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*$/.exec(String(toolId ?? ""));
  if (!m) return null;
  const d = parseFloat(m[1]);
  return Number.isFinite(d) && d > 0 ? d : null;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => {
    const v = amount >= 0
      ? Math.round(c + (255 - c) * amount)
      : Math.round(c * (1 + amount));
    return Math.max(0, Math.min(255, v));
  };
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
export function colorFor(operation: string, toolId: string): string {
  const base = operationColor(operation);
  // Deterministic shade in [-0.25, +0.25] from the tool id.
  let h = 0;
  for (const ch of String(toolId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const amount = ((h % 51) - 25) / 100;
  return shade(base, amount);
}

const TAU = Math.PI * 2;
const norm = (a: number) => { let x = a % TAU; if (x < 0) x += TAU; return x; };

/** Flatten a toolpaths section into one move list (cut order).
 * Throws on a section that is not version 1, or whose moves are
 * malformed — the view never renders a section it cannot read. */
export function flattenToolpaths(tp: ToolpathsIn): FlatToolpaths {
  if (!tp || tp.version !== 1 || !Array.isArray(tp.operations)) {
    throw new Error("toolpaths section is not a version-1 section");
  }
  const clearanceZ = tp.clearance_z_mm;
  if (typeof clearanceZ !== "number" || !Number.isFinite(clearanceZ)) {
    throw new Error("toolpaths section has no clearance_z_mm");
  }
  const moves: FlatMove[] = [];
  const operations: OpMeta[] = [];
  const timeAtMoveStart: number[] = [0];
  let totalSeconds = 0;
  let prev: Pt3 | null = null;
  tp.operations.forEach((op, opIndex) => {
    if (!Array.isArray(op.moves)) throw new Error(`operation ${opIndex} has no moves array`);
    const startMove = moves.length;
    const toolDiaMm = toolDiameterMm(op.tool_id);
    operations.push({
      index: opIndex,
      operation: op.operation,
      layer: op.layer,
      toolId: op.tool_id,
      toolDiaMm,
      feedMmS: op.feed_mm_s,
      startMove,
      endMove: startMove,
      color: colorFor(op.operation, op.tool_id),
    });
    for (const m of op.moves) {
      const end: Pt3 = { x: m.x, y: m.y, z: m.z };
      if (![end.x, end.y, end.z].every(Number.isFinite)) {
        throw new Error(`operation ${opIndex} has a move with a non-finite coordinate`);
      }
      const start: Pt3 = prev ?? { x: end.x, y: end.y, z: clearanceZ };
      let lengthMm: number;
      let durationS: number;
      let center: { x: number; y: number } | null = null;
      let radius: number | null = null;
      let cw: boolean | null = null;
      let sweep: number | null = null;
      let helical = false;
      if (m.t === "arc") {
        center = { x: start.x + m.i, y: start.y + m.j };
        radius = Math.hypot(m.i, m.j);
        if (!(radius > 0)) throw new Error(`operation ${opIndex} has a zero-radius arc`);
        cw = m.cw;
        const a0 = Math.atan2(start.y - center.y, start.x - center.x);
        const a1 = Math.atan2(end.y - center.y, end.x - center.x);
        // Full circle when start == end (the canned/container
        // arcs do this): sweep is the whole circle, not zero.
        const samePoint = Math.hypot(end.x - start.x, end.y - start.y) < 1e-9;
        sweep = samePoint
          ? (cw ? -TAU : TAU)
          : cw ? -norm(a0 - a1) : norm(a1 - a0);
        const planar = radius * Math.abs(sweep);
        const dz = end.z - start.z;
        lengthMm = Math.hypot(planar, dz);
        helical = Math.abs(dz) > 1e-9;
        durationS = lengthMm / op.feed_mm_s;
      } else if (m.t === "rapid") {
        lengthMm = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
        durationS = lengthMm / RAPID_FEED_MM_S;
      } else if (m.t === "feed") {
        lengthMm = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
        const zOnly = Math.abs(end.x - start.x) < 1e-9 && Math.abs(end.y - start.y) < 1e-9;
        durationS = lengthMm / (zOnly ? op.plunge_mm_s : op.feed_mm_s);
      } else {
        throw new Error(`operation ${opIndex} has an unknown move type ${(m as { t: unknown }).t}`);
      }
      moves.push({
        index: moves.length, opIndex, t: m.t, start, end,
        center, radius, cw, sweep, lengthMm, durationS, helical,
      });
      totalSeconds += durationS;
      timeAtMoveStart.push(totalSeconds);
      prev = end;
    }
    operations[opIndex].endMove = moves.length;
  });
  return { moves, operations, totalSeconds, clearanceZ, timeAtMoveStart };
}

/** Motion summary (V3.14): the duration model's totals, broken
 * down by tool, by operation, and by layer. Every second here is
 * a sum of FlatMove.durationS — the same numbers the playback
 * timeline uses — so the headless cut-time tool (ts/cuttime.ts),
 * the toolpath generator (which records the summary in the
 * section), and the validator (which recomputes it) all agree by
 * construction. `byLayer` is keyed by layer name (unique per job);
 * each entry also carries the move counts the calibration in
 * docs-v3/cuttime_feedback.md fits against. */
export type MotionSummary = {
  totalSeconds: number;
  byTool: Record<string, number>;
  byOperation: Record<string, number>;
  byLayer: Record<string, { seconds: number; moves: number; rapid: number; feed: number; arc: number; rapidS: number; feedS: number; arcS: number }>;
};
export function summarizeMotion(flat: FlatToolpaths): MotionSummary {
  const byTool: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  const byLayer: MotionSummary["byLayer"] = {};
  for (const m of flat.moves) {
    const op = flat.operations[m.opIndex];
    byTool[op.toolId] = (byTool[op.toolId] ?? 0) + m.durationS;
    byOperation[op.operation] = (byOperation[op.operation] ?? 0) + m.durationS;
    const l = (byLayer[op.layer] ??= { seconds: 0, moves: 0, rapid: 0, feed: 0, arc: 0, rapidS: 0, feedS: 0, arcS: 0 });
    l.seconds += m.durationS;
    l.moves++;
    l[m.t]++;
    if (m.t === "rapid") l.rapidS += m.durationS;
    else if (m.t === "feed") l.feedS += m.durationS;
    else l.arcS += m.durationS;
  }
  return { totalSeconds: flat.totalSeconds, byTool, byOperation, byLayer };
}

/** Sample a flat arc move along its TRUE circle (centre + radius
 * + sweep), at most maxStepDeg between samples. The returned
 * points start at the move's start and end at its end; a helical
 * arc interpolates Z along the sweep. A non-arc move returns
 * [start, end]. */
export function sampleMove(move: FlatMove, maxStepDeg = 5): Pt3[] {
  if (move.t !== "arc" || !move.center || move.radius == null || move.sweep == null) {
    return [move.start, move.end];
  }
  const span = move.sweep;
  const n = Math.max(2, Math.ceil(Math.abs(span) / ((maxStepDeg * Math.PI) / 180)));
  const a0 = Math.atan2(move.start.y - move.center.y, move.start.x - move.center.x);
  const pts: Pt3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (span * i) / n;
    const f = i / n;
    pts.push({
      x: move.center.x + move.radius * Math.cos(a),
      y: move.center.y + move.radius * Math.sin(a),
      z: move.start.z + (move.end.z - move.start.z) * f,
    });
  }
  return pts;
}

/** The tool-tip position part-way through a move (fraction 0..1
 * of the move's length). Arcs interpolate along the sweep, so the
 * tool follows the true arc during playback, not a chord. */
export function positionAt(move: FlatMove, fraction: number): Pt3 {
  const f = Math.max(0, Math.min(1, fraction));
  if (move.t === "arc" && move.center && move.radius != null && move.sweep != null) {
    const a0 = Math.atan2(move.start.y - move.center.y, move.start.x - move.center.x);
    const a = a0 + move.sweep * f;
    return {
      x: move.center.x + move.radius * Math.cos(a),
      y: move.center.y + move.radius * Math.sin(a),
      z: move.start.z + (move.end.z - move.start.z) * f,
    };
  }
  return {
    x: move.start.x + (move.end.x - move.start.x) * f,
    y: move.start.y + (move.end.y - move.start.y) * f,
    z: move.start.z + (move.end.z - move.start.z) * f,
  };
}

// ---------------------------------------------------------------- playback
//
// A pure state machine: no timers, no DOM. The renderer owns the
// clock (requestAnimationFrame) and calls tick(dtSeconds); the
// machine only ever moves its index — seeking is an O(1) index
// jump, never a replay (V3_SCOPE.md §4.4, this wave's scoping:
// move-index jump; the checkpoint + delta design is V3.5's sim
// seeking, not this wave's).

export type PlaybackState = {
  /** Index of the current move (0..moves.length; == length means done). */
  index: number;
  /** Fraction (0..1) through the current move. */
  fraction: number;
  playing: boolean;
  /** Playback speed multiplier (cut time runs this many × faster). */
  speed: number;
};

export function createPlayback(flat: FlatToolpaths): {
  state: PlaybackState;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  /** Seek to a move index (clamped). O(1) — never replays. */
  seek: (index: number, fraction?: number) => void;
  /** Jump to the first move of an operation (clamped to a real op). */
  jumpToOperation: (opIndex: number) => void;
  /** Advance by dtSeconds of WALL time at the current speed. */
  tick: (dtSeconds: number) => void;
  /** Cut time elapsed at the current position, seconds. */
  elapsedS: () => number;
} {
  const state: PlaybackState = { index: 0, fraction: 0, playing: false, speed: 1 };
  const clampIndex = (i: number) => Math.max(0, Math.min(flat.moves.length, Math.floor(i)));
  return {
    state,
    play() {
      if (state.index >= flat.moves.length) {
        state.index = 0;
        state.fraction = 0;
      }
      state.playing = true;
    },
    pause() { state.playing = false; },
    setSpeed(speed: number) {
      if (Number.isFinite(speed) && speed > 0) state.speed = speed;
    },
    seek(index: number, fraction = 0) {
      state.index = clampIndex(index);
      state.fraction = Math.max(0, Math.min(1, fraction || 0));
      if (state.index >= flat.moves.length) state.playing = false;
    },
    jumpToOperation(opIndex: number) {
      const op = flat.operations[Math.max(0, Math.min(flat.operations.length - 1, Math.floor(opIndex)))];
      if (!op) return;
      state.index = op.startMove;
      state.fraction = 0;
    },
    tick(dtSeconds: number) {
      if (!state.playing || dtSeconds <= 0) return;
      let remaining = dtSeconds * state.speed;
      while (remaining > 0 && state.index < flat.moves.length) {
        const move = flat.moves[state.index];
        const leftInMove = move.durationS * (1 - state.fraction);
        if (remaining < leftInMove) {
          state.fraction += remaining / move.durationS;
          remaining = 0;
        } else {
          remaining -= leftInMove;
          state.index += 1;
          state.fraction = 0;
        }
      }
      if (state.index >= flat.moves.length) {
        state.index = flat.moves.length;
        state.fraction = 0;
        state.playing = false;
      }
    },
    elapsedS() {
      if (state.index >= flat.moves.length) return flat.totalSeconds;
      return flat.timeAtMoveStart[state.index] + flat.moves[state.index].durationS * state.fraction;
    },
  };
}

// ---------------------------------------------------------------- layer planes

export type LayerPlane = {
  layer: string;
  operation: string | null;
  part: string | null;
  zTopMm: number;
  zBottomMm: number;
  /** Sampled outline points per loop ([x, y] pairs, implicitly closed). */
  loops: number[][][];
  loopCount: number;
};

/** Normalise a GET /api/jobs/:id/geometry payload into layer
 * planes. Throws on a malformed payload — the view never renders
 * planes it cannot read. */
export function layerPlanes(geometry: unknown): LayerPlane[] {
  const g = geometry as { layers?: unknown };
  if (!g || !Array.isArray(g.layers)) {
    throw new Error("geometry payload has no layers array");
  }
  return (g.layers as Record<string, unknown>[]).map((l) => {
    if (typeof l.layer !== "string") throw new Error("geometry layer has no layer name");
    const loops = l.loops as { points?: unknown }[];
    if (!Array.isArray(loops)) throw new Error(`geometry layer ${l.layer} has no loops array`);
    return {
      layer: l.layer,
      operation: typeof l.operation === "string" ? l.operation : null,
      part: typeof l.part === "string" ? l.part : null,
      zTopMm: l.z_top_mm as number,
      zBottomMm: l.z_bottom_mm as number,
      loops: loops.map((loop) => {
        if (!Array.isArray(loop.points)) throw new Error(`geometry layer ${l.layer} has a loop with no points`);
        return (loop.points as number[][]).map((p) => [p[0], p[1]]);
      }),
      loopCount: (l.loop_count as number) ?? loops.length,
    };
  });
}

/** Format cut time as m:ss.s for the timeline. */
export function formatCutTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- clamps + plan total

/** Stock top in mm, from the tallest part (the same rule the
 * renderer uses for the stock box): parts carry z_top; a job
 * without parts falls back to job.z_top, then 10. */
export function stockTopMm(job: Record<string, unknown>): number {
  const parts = job.parts as { z_top?: number }[] | null | undefined;
  if (Array.isArray(parts) && parts.length) {
    return Math.max(...parts.map((p) => (typeof p.z_top === "number" ? p.z_top : 0)));
  }
  return typeof job.z_top === "number" ? (job.z_top as number) : 10;
}

export type ClampBox = {
  /** Clamp id (or "clamp N" when the entry carries none). */
  id: string;
  /** Centre position in job mm (sheet coords, origin bottom-left). */
  xMm: number;
  yMm: number;
  /** Footprint in mm, already oriented [x-size, y-size] — the
   * guides swap the inventory footprint at emit time, so this
   * is used exactly as recorded, never swapped again (the same
   * rule the 2D preview's clamp rects follow). */
  wMm: number;
  dMm: number;
  /** The box spans z0..z1 (bed to stock top). */
  z0Mm: number;
  z1Mm: number;
};

/** Clamp boxes for the 3D view, from the job's guides step
 * (`job.workholding.clamps`, accepting `positions` as the list
 * key — the same source the 2D preview's clamp rects read).
 * Returns [] when the job carries no workholding (guides never
 * ran) — the view draws nothing rather than guessing.
 *
 * HEIGHT: no clamp definition carries a height — the inventory
 * (clamps.json) records footprint only, and the job's clamp
 * entries carry no height either — so the box height is a
 * documented default, not a measurement: bed (z=0) to stock top.
 * A clamp must reach at least the stock top to hold the stock,
 * so the box is the MINIMUM column the clamp occupies: a cut
 * entering that column at or below the stock top would hit a
 * real clamp. A real clamp may stand taller (its screw/bolt
 * above the stock), so the box can show a collision below the
 * stock top but can never clear a rapid above it — the box
 * claims no height beyond the stock top. */
export function clampBoxes(job: Record<string, unknown>): ClampBox[] {
  const wh = job.workholding as { clamps?: unknown; positions?: unknown } | null | undefined;
  if (!wh || typeof wh !== "object") return [];
  const list = wh.clamps ?? wh.positions;
  if (!Array.isArray(list)) return [];
  const z1 = stockTopMm(job);
  const out: ClampBox[] = [];
  list.forEach((c, i) => {
    const e = (c ?? {}) as Record<string, unknown>;
    const x = e.x_mm as number;
    const y = e.y_mm as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const fp = e.footprint_mm as [number, number] | undefined;
    const w = Array.isArray(fp) && Number.isFinite(fp[0]) && fp[0] > 0 ? fp[0] : 20;
    const d = Array.isArray(fp) && Number.isFinite(fp[1]) && fp[1] > 0 ? fp[1] : 12;
    out.push({
      id: typeof e.clamp_id === "string" && e.clamp_id ? e.clamp_id
        : typeof e.method === "string" && e.method ? e.method
        : `clamp ${i + 1}`,
      xMm: x, yMm: y, wMm: w, dMm: d, z0Mm: 0, z1Mm: z1,
    });
  });
  return out;
}

export type PlanTotal = {
  /** Chosen plan's total, cutting + tool changes (seconds). */
  totalS: number;
  /** Cutting part of the total (seconds). */
  cuttingS: number;
  /** Tool changes charged in the total. */
  changes: number;
};

/** The chosen plan's total from `job.tool_plan` (V3.14 shape:
 * { plans: [{ id, total_seconds, cutting_seconds,
 * tool_changes }], chosen }). Null when the job carries no
 * usable plan total — the timeline then labels the cutting time
 * alone instead of inventing a plan number. */
export function chosenPlanTotal(job: Record<string, unknown>): PlanTotal | null {
  const tp = job.tool_plan as {
    plans?: { id?: string; total_seconds?: number; cutting_seconds?: number; tool_changes?: number }[];
    chosen?: string;
  } | null | undefined;
  if (!tp || typeof tp !== "object" || !Array.isArray(tp.plans) || typeof tp.chosen !== "string") return null;
  const plan = tp.plans.find((p) => p.id === tp.chosen);
  if (!plan) return null;
  const { total_seconds, cutting_seconds, tool_changes } = plan;
  if (![total_seconds, cutting_seconds, tool_changes].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return { totalS: total_seconds as number, cuttingS: cutting_seconds as number, changes: tool_changes as number };
}
