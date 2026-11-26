// Automated toolpath-vs-clamp collision check (V3.15 follow-up,
// filed Nov 25, 2026).
//
// A REPORT, not a refusal: for every move in a job's flattened
// toolpaths it finds the nearest approach of the TOOL BODY to any
// clamp box (the boxes `clampBoxes()` draws in the 3D view), and
// counts how many moves pass within a stated threshold of a
// clamp. Nothing here refuses a job or changes a toolpath — the
// visual boxes stay as they are, and this is the number that says
// whether a path runs into one.
//
// What is measured — the tool BODY, not the tool tip. A move is a
// tool-tip path, but the cutter has a radius: the clearance of a
// move is its tip-path distance to the box MINUS the operation's
// tool radius (from the tool id, the same rule `toolDiameterMm`
// uses; a move whose tool carries no diameter is measured tip to
// box, with `toolRadiusMm: null` saying so). A negative clearance
// means the tool body would enter the box as drawn.
//
// Threshold: CLAMP_CHECK_THRESHOLD_MM = 5.0 mm — the same keep-out
// the guides enforce between clamps and cuts (`mldxf_guides.py`
// `clears()`: a clamp must sit at least keep_out from any cut), so
// a move inside it is closer to a clamp than any cut is allowed
// to be. The guides' rule covers cuts; it does NOT cover rapids
// (or homing travel), which is what this check exists to catch.
//
// Honesty limit, stated wherever the result is shown: the boxes
// are the documented default (bed to stock top — the clamp's true
// height is not recorded), so the check is against the box AS
// DRAWN. A move clearing the box is clear of the clamp's minimum
// column only; a real clamp may stand taller, so the check can
// show a collision below the stock top but can never clear a
// rapid above it.
//
// Geometry: the distance is EXACT, not sampled. A segment's
// distance to an axis-aligned box is 0 when the segment enters
// the box (slab test), else the minimum of the endpoint-to-box
// distances, the segment-to-edge distances (12 edges), and — the
// case the first two miss — the perpendicular distance to a face
// when the segment runs parallel to that face and its projection
// overlaps the face. (A rapid at clearance height running over a
// clamp is exactly that case: without the face term the distance
// reads as the distance to the nearest edge, ~5 mm too far.) Arcs
// are sampled along the TRUE circle (`sampleMove`, 5 deg — the
// same sampling the renderer uses; chord error at r = 21.4 mm is
// ~0.02 mm, negligible against a 5 mm threshold) and each chord
// is checked exactly.
//
// Frame: moves and boxes must be in the SAME frame. The view
// shifts both into the display frame (Z-zero) before calling
// `checkClamps`; the headless check uses the job frame for both.
// The distance is translation-invariant, so either is fine —
// mixing frames is not.
import { sampleMove } from "./view3d/model.ts";
import type { ClampBox, FlatToolpaths } from "./view3d/model.ts";

/** Threshold: a move whose tool-body clearance is under this is
 * "passing within X mm of a clamp" (see the header note). */
export const CLAMP_CHECK_THRESHOLD_MM = 5.0;

/** Arc sampling step, degrees — the renderer's sampling, so the
 * checked path is the drawn path. */
const ARC_SAMPLE_DEG = 5;

export type Pt3 = { x: number; y: number; z: number };

type Bounds = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

function boxBounds(box: ClampBox): Bounds {
  return {
    x0: box.xMm - box.wMm / 2, x1: box.xMm + box.wMm / 2,
    y0: box.yMm - box.dMm / 2, y1: box.yMm + box.dMm / 2,
    z0: box.z0Mm, z1: box.z1Mm,
  };
}

const EPS = 1e-12;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function dist(a: Pt3, b: Pt3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Distance from a point to the box (0 inside it). */
export function pointBoxDistance(p: Pt3, box: ClampBox): number {
  const b = boxBounds(box);
  const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
  const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
  const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
  return Math.hypot(dx, dy, dz);
}

function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

/** Closest distance between two segments (Ericson, Real-Time
 * Collision Detection §5.1.9). Handles degenerate (zero-length)
 * segments — the first rapid of a job is one. */
export function segmentSegmentDistance(p1: Pt3, q1: Pt3, p2: Pt3, q2: Pt3): number {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = dot(d1x, d1y, d1z, d1x, d1y, d1z);
  const e = dot(d2x, d2y, d2z, d2x, d2y, d2z);
  const f = dot(d2x, d2y, d2z, rx, ry, rz);
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    return dist(p1, p2);
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1x, d1y, d1z, rx, ry, rz);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1x, d1y, d1z, d2x, d2y, d2z);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return dist(
    { x: p1.x + d1x * s, y: p1.y + d1y * s, z: p1.z + d1z * s },
    { x: p2.x + d2x * t, y: p2.y + d2y * t, z: p2.z + d2z * t },
  );
}

/** Slab test: does the segment enter the box at all? */
function segmentIntersectsBox(a: Pt3, b: Pt3, bounds: Bounds): boolean {
  let tmin = 0;
  let tmax = 1;
  const axes: [number, number, number, number][] = [
    [a.x, b.x - a.x, bounds.x0, bounds.x1],
    [a.y, b.y - a.y, bounds.y0, bounds.y1],
    [a.z, b.z - a.z, bounds.z0, bounds.z1],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return false;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

/** 2D segment vs axis-aligned rectangle (inclusive): true when
 * the segment touches or crosses the rectangle. */
function segHitsRect2D(ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number): boolean {
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(ax, ay) || inside(bx, by)) return true;
  // Orientation test against each rect edge.
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const crosses = (x3: number, y3: number, x4: number, y4: number) => {
    const d1 = orient(ax, ay, bx, by, x3, y3);
    const d2 = orient(ax, ay, bx, by, x4, y4);
    const d3 = orient(x3, y3, x4, y4, ax, ay);
    const d4 = orient(x3, y3, x4, y4, bx, by);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  return crosses(x0, y0, x1, y0) || crosses(x1, y0, x1, y1) ||
    crosses(x1, y1, x0, y1) || crosses(x0, y1, x0, y0);
}

/** Exact distance from a segment to an axis-aligned box. 0 when
 * the segment enters the box. See the header note for why the
 * face-parallel term is needed alongside endpoints and edges. */
export function segmentBoxDistance(a: Pt3, b: Pt3, box: ClampBox): number {
  const bounds = boxBounds(box);
  if (segmentIntersectsBox(a, b, bounds)) return 0;
  let best = Math.min(pointBoxDistance(a, box), pointBoxDistance(b, box));
  // The 12 edges.
  const c: Pt3[] = [
    { x: bounds.x0, y: bounds.y0, z: bounds.z0 },
    { x: bounds.x1, y: bounds.y0, z: bounds.z0 },
    { x: bounds.x1, y: bounds.y1, z: bounds.z0 },
    { x: bounds.x0, y: bounds.y1, z: bounds.z0 },
    { x: bounds.x0, y: bounds.y0, z: bounds.z1 },
    { x: bounds.x1, y: bounds.y0, z: bounds.z1 },
    { x: bounds.x1, y: bounds.y1, z: bounds.z1 },
    { x: bounds.x0, y: bounds.y1, z: bounds.z1 },
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [i, j] of edges) {
    best = Math.min(best, segmentSegmentDistance(a, b, c[i], c[j]));
  }
  // Face-parallel term: the segment runs parallel to a face
  // plane and its projection overlaps the face — the closest
  // approach is the perpendicular distance to that face, which
  // no endpoint or edge sees (the segment's endpoints project
  // outside the face while its middle passes over it).
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  if (Math.abs(dx) < EPS) {
    for (const px of [bounds.x0, bounds.x1]) {
      if (segHitsRect2D(a.y, a.z, b.y, b.z, bounds.y0, bounds.z0, bounds.y1, bounds.z1)) {
        best = Math.min(best, Math.abs(a.x - px));
      }
    }
  }
  if (Math.abs(dy) < EPS) {
    for (const py of [bounds.y0, bounds.y1]) {
      if (segHitsRect2D(a.x, a.z, b.x, b.z, bounds.x0, bounds.z0, bounds.x1, bounds.z1)) {
        best = Math.min(best, Math.abs(a.y - py));
      }
    }
  }
  if (Math.abs(dz) < EPS) {
    for (const pz of [bounds.z0, bounds.z1]) {
      if (segHitsRect2D(a.x, a.y, b.x, b.y, bounds.x0, bounds.y0, bounds.x1, bounds.y1)) {
        best = Math.min(best, Math.abs(a.z - pz));
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- check

export type ClampApproach = {
  /** 0-based move index (the UI shows moveIndex + 1). */
  moveIndex: number;
  type: "rapid" | "feed" | "arc";
  operation: string;
  /** The clamp the move comes nearest to. */
  clampId: string;
  /** Tool-tip path distance to the box, mm. */
  tipDistanceMm: number;
  /** Tool radius subtracted, mm; null when the operation's tool
   * id carries no diameter (then the clearance is the tip
   * distance — the check says so rather than guessing). */
  toolRadiusMm: number | null;
  /** Tool-body clearance, mm: tip distance minus tool radius.
   * Negative means the tool body would enter the box as drawn. */
  clearanceMm: number;
};

export type ClampCheckSummary = {
  thresholdMm: number;
  totalMoves: number;
  clampsChecked: number;
  /** Moves whose tool-body clearance is under the threshold. */
  movesWithin: number;
  /** Smallest clearance over all moves (null with no moves or
   * no clamps). */
  minClearanceMm: number | null;
  /** The move that sets the minimum (null with no moves or no
   * clamps). */
  closest: ClampApproach | null;
  /** Nearest approach per move, in cut order. */
  perMove: ClampApproach[];
};

/** Nearest approach of every move's tool body to any clamp box.
 * Moves and boxes must be in the same frame (the view passes
 * display-frame moves and display-frame boxes; the headless
 * check passes job-frame both). Pure: no DOM, no three.js. */
export function checkClamps(
  flat: FlatToolpaths,
  boxes: ClampBox[],
  thresholdMm: number = CLAMP_CHECK_THRESHOLD_MM,
): ClampCheckSummary {
  const totalMoves = flat.moves.length;
  if (boxes.length === 0 || totalMoves === 0) {
    return {
      thresholdMm, totalMoves, clampsChecked: boxes.length,
      movesWithin: 0, minClearanceMm: null, closest: null, perMove: [],
    };
  }
  const perMove: ClampApproach[] = [];
  let movesWithin = 0;
  let closest: ClampApproach | null = null;
  for (const move of flat.moves) {
    const op = flat.operations[move.opIndex];
    const radius = op && op.toolDiaMm != null ? op.toolDiaMm / 2 : null;
    // Arcs are sampled along the true circle; a straight move is
    // one segment. sampleMove always returns >= 2 points.
    const pts = sampleMove(move, ARC_SAMPLE_DEG);
    let best: { clampId: string; tipDistanceMm: number } | null = null;
    for (let i = 0; i + 1 < pts.length && !(best && best.tipDistanceMm <= 0); i++) {
      for (const box of boxes) {
        const d = segmentBoxDistance(pts[i], pts[i + 1], box);
        if (!best || d < best.tipDistanceMm) best = { clampId: box.id, tipDistanceMm: d };
        if (best.tipDistanceMm <= 0) break;
      }
    }
    // best is set: sampleMove returns >= 2 points and boxes is
    // non-empty, so the loop body runs at least once.
    const tip = best!.tipDistanceMm;
    const clearance = tip - (radius ?? 0);
    const rec: ClampApproach = {
      moveIndex: move.index,
      type: move.t,
      operation: op ? op.operation : "?",
      clampId: best!.clampId,
      tipDistanceMm: tip,
      toolRadiusMm: radius,
      clearanceMm: clearance,
    };
    perMove.push(rec);
    if (clearance < thresholdMm) movesWithin++;
    if (!closest || clearance < closest.clearanceMm) closest = rec;
  }
  return {
    thresholdMm, totalMoves, clampsChecked: boxes.length,
    movesWithin, minClearanceMm: closest ? closest.clearanceMm : null,
    closest, perMove,
  };
}

const fmt1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/** The one-line summary the view shows (move numbers are
 * 1-based, matching the timeline's "Move N/M"). */
export function formatClampCheck(s: ClampCheckSummary): string {
  if (!s.closest || s.minClearanceMm == null) {
    return "No moves to check against the clamps.";
  }
  const at = `closest ${fmt1(s.minClearanceMm)} mm at move ${s.closest.moveIndex + 1} (${s.closest.type}, ${s.closest.clampId})`;
  const hit = s.minClearanceMm < 0
    ? ` — the tool body would enter the box as drawn by ${fmt1(-s.minClearanceMm)} mm`
    : "";
  if (s.movesWithin > 0) {
    return `${s.movesWithin} move${s.movesWithin === 1 ? " passes" : "s pass"} within ${fmt1(s.thresholdMm)} mm of a clamp; ${at}${hit}`;
  }
  return `No move passes within ${fmt1(s.thresholdMm)} mm of a clamp; ${at}${hit}`;
}
