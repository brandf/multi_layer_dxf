// Unit tests for ts/clamp_check.ts. Run: bun test ts/clamp_check.ts
// No DOM, no three.js, no browser — the check is pure logic.
import { describe, test, expect } from "bun:test";
import {
  segmentBoxDistance, segmentSegmentDistance, pointBoxDistance,
  checkClamps, formatClampCheck, CLAMP_CHECK_THRESHOLD_MM,
} from "./clamp_check.ts";
import { flattenToolpaths, clampBoxes } from "./view3d/model.ts";
import type { ToolpathsIn } from "./view3d/model.ts";

// One clamp box: centre (50, 50), 20 x 12 footprint, bed to
// stock top 9.5 — the shape `clampBoxes` builds for a guided job.
const BOX = { id: "c1", xMm: 50, yMm: 50, wMm: 20, dMm: 12, z0Mm: 0, z1Mm: 9.5 };

describe("segmentBoxDistance", () => {
  test("a segment far from the box reads its true distance", () => {
    // Segment along x at y = 80, z = 5: nearest box point is the
    // (x, 56, 5) edge — 24 mm away in y.
    expect(segmentBoxDistance({ x: 0, y: 80, z: 5 }, { x: 100, y: 80, z: 5 }, BOX))
      .toBeCloseTo(24, 9);
  });

  test("a segment entering the box reads 0", () => {
    expect(segmentBoxDistance({ x: 0, y: 50, z: 5 }, { x: 100, y: 50, z: 5 }, BOX)).toBe(0);
    // Endpoint inside the box.
    expect(segmentBoxDistance({ x: 50, y: 50, z: 5 }, { x: 90, y: 90, z: 5 }, BOX)).toBe(0);
    // Diagonal through a corner.
    expect(segmentBoxDistance({ x: 30, y: 30, z: -5 }, { x: 70, y: 70, z: 20 }, BOX)).toBe(0);
  });

  test("a rapid at clearance over the box reads the z gap, not the edge distance", () => {
    // The face-parallel case: the segment runs at z = 14.5 over
    // the box (top 9.5), its endpoints projecting outside the
    // footprint — the nearest edge is ~5 mm further away in XY
    // than the true 5 mm straight down.
    const d = segmentBoxDistance({ x: 20, y: 50, z: 14.5 }, { x: 80, y: 50, z: 14.5 }, BOX);
    expect(d).toBeCloseTo(5, 9);
  });

  test("a segment beside the box at an angle reads the edge distance", () => {
    // Diagonal in XY at z = 5, passing the box's +x face: the
    // closest pair is the segment point (60, 62) region to the
    // (60, 56, 5) edge — distance is the perpendicular gap.
    const d = segmentBoxDistance({ x: 70, y: 70, z: 5 }, { x: 90, y: 90, z: 5 }, BOX);
    // Closest box point to the line y = x (x >= 60): (60, 56, 5)
    // is not on the line's perpendicular — the exact minimum is
    // the distance from (70, 70) to the box, sqrt(10^2 + 14^2)
    // = 17.20, attained at the segment's start endpoint.
    expect(d).toBeCloseTo(Math.hypot(10, 14), 9);
  });

  test("matches dense sampling from above on a diagonal pass", () => {
    // Exact must never exceed a sampled distance, and must be
    // within one sample step of it (sample step 0.25 mm here).
    const a = { x: 10, y: 90, z: 20 }, b = { x: 95, y: 10, z: 2 };
    const exact = segmentBoxDistance(a, b, BOX);
    let sampled = Infinity;
    const n = 400;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      sampled = Math.min(sampled, pointBoxDistance({
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
      }, BOX));
    }
    expect(exact).toBeLessThanOrEqual(sampled + 1e-9);
    expect(sampled - exact).toBeLessThan(0.5);
  });
});

describe("segmentSegmentDistance", () => {
  test("parallel, skew, and degenerate segments", () => {
    expect(segmentSegmentDistance(
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
      { x: 0, y: 3, z: 0 }, { x: 10, y: 3, z: 0 })).toBeCloseTo(3, 9);
    expect(segmentSegmentDistance(
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
      { x: 5, y: 5, z: 0 }, { x: 5, y: 15, z: 0 })).toBeCloseTo(5, 9);
    // Zero-length first segment (a zero-length rapid).
    expect(segmentSegmentDistance(
      { x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 },
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBeCloseTo(Math.hypot(2, 2), 9);
  });
});

// Straight-move fixture: a drill plunge at (50, 30), two feeds
// along y = 30 at z = 5 (14 mm from the box edge in y, EM6.35),
// a vertical rapid up, a rapid along x = 80 at clearance, and a
// rapid straight over the box at clearance (the face-parallel
// case: tip 5 mm above the box top).
const MOVES: ToolpathsIn = {
  version: 1, plan: "A", clearance_z_mm: 14.5,
  operations: [
    {
      operation: "drill", layer: "L_DRILL", tool_id: "D2.25",
      feed_mm_s: 4, plunge_mm_s: 4, spindle_rpm: 20000,
      pass: { kind: "rough", stepdown_index: null },
      moves: [
        { t: "rapid", x: 50, y: 30, z: 14.5 },
        { t: "feed", x: 50, y: 30, z: 5 },
      ],
    },
    {
      operation: "profile", layer: "L_PROFILE", tool_id: "EM6.35",
      feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 20000,
      pass: { kind: "rough", stepdown_index: null },
      moves: [
        { t: "feed", x: 20, y: 30, z: 5 },
        { t: "feed", x: 80, y: 30, z: 5 },
        { t: "rapid", x: 80, y: 30, z: 14.5 },
        { t: "rapid", x: 80, y: 50, z: 14.5 },
        { t: "rapid", x: 20, y: 50, z: 14.5 },
      ],
    },
  ],
  skipped: [],
  stats: { operations: 2, moves: 7, rapid: 4, feed: 3, arc: 0 },
};

// Arc fixture: a plunge at (80, 50), a feed to (65, 50, 5), then
// a full-circle arc centred (55, 50) r = 10 at z = 5 — the circle
// passes through the box (its leftmost point (45, 50, 5) is
// inside the footprint), so the sampled arc reads tip distance 0.
const ARC_MOVES: ToolpathsIn = {
  version: 1, plan: "A", clearance_z_mm: 14.5,
  operations: [
    {
      operation: "pocket", layer: "L_POCKET", tool_id: "EM3.17",
      feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 20000,
      pass: { kind: "rough", stepdown_index: 0 },
      moves: [
        { t: "rapid", x: 80, y: 50, z: 14.5 },
        { t: "feed", x: 80, y: 50, z: 5 },
        { t: "feed", x: 65, y: 50, z: 5 },
        { t: "arc", x: 65, y: 50, z: 5, i: -10, j: 0, cw: false },
      ],
    },
  ],
  skipped: [],
  stats: { operations: 1, moves: 4, rapid: 1, feed: 2, arc: 1 },
};

describe("checkClamps", () => {
  test("threshold is the guides keep-out, stated in the module", () => {
    expect(CLAMP_CHECK_THRESHOLD_MM).toBe(5);
  });

  test("a move that clears reads its clearance; a rapid over the box counts", () => {
    const flat = flattenToolpaths(MOVES);
    const s = checkClamps(flat, [BOX]);
    expect(s.totalMoves).toBe(7);
    expect(s.clampsChecked).toBe(1);
    // Move 0: zero-length rapid parked at (50, 30, 14.5) — the
    // point is 14 mm from the box in y and 5 mm above its top,
    // so tip hypot(14, 5); drill radius 1.125.
    expect(s.perMove[0].clearanceMm).toBeCloseTo(Math.hypot(14, 5) - 2.25 / 2, 9);
    // Move 1: vertical plunge at (50, 30) — tip 14 mm from the
    // box edge (y 44 -> 30), clearance 14 - 1.125.
    expect(s.perMove[1].clearanceMm).toBeCloseTo(14 - 2.25 / 2, 9);
    // Moves 2-3: feeds along y = 30 at z = 5, EM6.35: tip 14,
    // clearance 14 - 3.175 — outside the threshold.
    expect(s.perMove[2].clearanceMm).toBeCloseTo(14 - 6.35 / 2, 9);
    expect(s.perMove[3].clearanceMm).toBeCloseTo(14 - 6.35 / 2, 9);
    // Move 4: vertical rapid at (80, 30): tip hypot(20, 14).
    expect(s.perMove[4].clearanceMm).toBeCloseTo(Math.hypot(20, 14) - 6.35 / 2, 9);
    // Move 5: rapid along x = 80 at clearance: tip hypot(20, 5).
    expect(s.perMove[5].clearanceMm).toBeCloseTo(Math.hypot(20, 5) - 6.35 / 2, 9);
    // Move 6: rapid at clearance straight over the box, EM6.35:
    // tip 5 mm above the box top (the face-parallel case),
    // clearance 5 - 3.175 = 1.825 — inside the threshold (the
    // tool body nearly grazes the box as drawn, though the tip
    // path looks clear).
    expect(s.perMove[6].tipDistanceMm).toBeCloseTo(5, 9);
    expect(s.perMove[6].clearanceMm).toBeCloseTo(5 - 6.35 / 2, 9);
    expect(s.movesWithin).toBe(1);
    expect(s.minClearanceMm).toBeCloseTo(5 - 6.35 / 2, 9);
    expect(s.closest!.moveIndex).toBe(6);
    expect(s.closest!.type).toBe("rapid");
  });

  test("an arc through the box reads tip 0 and a negative clearance", () => {
    const flat = flattenToolpaths(ARC_MOVES);
    const s = checkClamps(flat, [BOX]);
    expect(s.totalMoves).toBe(4);
    // Move 2: feed ending 5 mm from the box face (x 65 -> 60),
    // EM3.17: clearance 5 - 1.585 = 3.415 — inside the threshold.
    expect(s.perMove[2].tipDistanceMm).toBeCloseTo(5, 9);
    expect(s.perMove[2].clearanceMm).toBeCloseTo(5 - 3.17 / 2, 9);
    // Move 3: full-circle arc r = 10 centred (55, 50) at z = 5 —
    // the sampled circle passes through the box (its leftmost
    // point (45, 50, 5) is inside the footprint), tip distance
    // 0, clearance -1.585: the tool body would enter the box.
    expect(s.perMove[3].tipDistanceMm).toBe(0);
    expect(s.perMove[3].toolRadiusMm).toBeCloseTo(3.17 / 2, 9);
    expect(s.perMove[3].clearanceMm).toBeCloseTo(-3.17 / 2, 9);
    expect(s.movesWithin).toBe(2);
    expect(s.closest!.moveIndex).toBe(3);
    expect(s.closest!.type).toBe("arc");
  });

  test("an unknown tool diameter measures tip to box and says so", () => {
    const noDia: ToolpathsIn = {
      version: 1, plan: "A", clearance_z_mm: 14.5,
      operations: [{
        operation: "profile", layer: "L", tool_id: "CUSTOM",
        feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 20000,
        pass: { kind: "rough", stepdown_index: null },
        moves: [{ t: "feed", x: 20, y: 30, z: 5 }, { t: "feed", x: 80, y: 30, z: 5 }],
      }],
      skipped: [], stats: { operations: 1, moves: 2, rapid: 0, feed: 2, arc: 0 },
    };
    const s = checkClamps(flattenToolpaths(noDia), [BOX]);
    expect(s.perMove[1].toolRadiusMm).toBeNull();
    expect(s.perMove[1].clearanceMm).toBe(s.perMove[1].tipDistanceMm);
    expect(s.perMove[1].tipDistanceMm).toBeCloseTo(14, 9);
  });

  test("no clamps means no check — never guessed", () => {
    const flat = flattenToolpaths(MOVES);
    const s = checkClamps(flat, []);
    expect(s.clampsChecked).toBe(0);
    expect(s.movesWithin).toBe(0);
    expect(s.minClearanceMm).toBeNull();
    expect(s.closest).toBeNull();
    expect(s.perMove).toEqual([]);
    expect(formatClampCheck(s)).toBe("No moves to check against the clamps.");
  });

  test("the summary line names the count and the closest move (1-based)", () => {
    const flat = flattenToolpaths(MOVES);
    expect(formatClampCheck(checkClamps(flat, [BOX]))).toBe(
      "1 move passes within 5.0 mm of a clamp; closest 1.8 mm at move 7 (rapid, c1)",
    );
    const arcFlat = flattenToolpaths(ARC_MOVES);
    expect(formatClampCheck(checkClamps(arcFlat, [BOX]))).toBe(
      "2 moves pass within 5.0 mm of a clamp; closest -1.6 mm at move 4 (arc, c1) — the tool body would enter the box as drawn by 1.6 mm",
    );
  });

  test("no move within the threshold still reports the closest", () => {
    const far: ToolpathsIn = {
      version: 1, plan: "A", clearance_z_mm: 14.5,
      operations: [{
        operation: "profile", layer: "L", tool_id: "EM3.17",
        feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 20000,
        pass: { kind: "rough", stepdown_index: null },
        moves: [{ t: "feed", x: 0, y: 0, z: 5 }, { t: "feed", x: 10, y: 0, z: 5 }],
      }],
      skipped: [], stats: { operations: 1, moves: 2, rapid: 0, feed: 2, arc: 0 },
    };
    const s = checkClamps(flattenToolpaths(far), [BOX]);
    expect(s.movesWithin).toBe(0);
    expect(formatClampCheck(s)).toMatch(/^No move passes within 5\.0 mm of a clamp; closest /);
  });

  test("clampBoxes output feeds the check unchanged", () => {
    const job = {
      parts: [{ z_top: 9.5 }],
      workholding: {
        clamps: [{ clamp_id: "test-tt-clamp", footprint_mm: [20, 12], x_mm: 50, y_mm: 50 }],
      },
    };
    const boxes = clampBoxes(job);
    expect(boxes).toEqual([{ id: "test-tt-clamp", xMm: 50, yMm: 50, wMm: 20, dMm: 12, z0Mm: 0, z1Mm: 9.5 }]);
    const s = checkClamps(flattenToolpaths(MOVES), boxes);
    expect(s.clampsChecked).toBe(1);
    expect(s.closest!.clampId).toBe("test-tt-clamp");
  });
});
