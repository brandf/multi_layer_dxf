// Unit tests for ts/view3d/model.ts (V3.3). Run: bun test ts/view3d/
// No DOM, no three.js, no browser — the model is pure logic.
import { describe, test, expect } from "bun:test";
import {
  flattenToolpaths, sampleMove, positionAt, createPlayback,
  toolDiameterMm, colorFor, operationColor, layerPlanes,
  formatCutTime, summarizeMotion, RAPID_FEED_MM_S,
  clampBoxes, chosenPlanTotal, stockTopMm,
} from "./model.ts";
import type { ToolpathsIn } from "./model.ts";

// Small fixture shaped like the DOM harness's CANNED_V3: a drill
// (rapid + plunge) and a pocket (rapid + feed + a FULL-CIRCLE arc
// — start == end, centre offset (-21.4, 0), radius 21.4).
const FIXTURE: ToolpathsIn = {
  version: 1, plan: "A", clearance_z_mm: 14.5,
  operations: [
    {
      operation: "drill", layer: "P01_P01__DRILL_D2.25_D1.55_START1.50", tool_id: "D2.25",
      feed_mm_s: 4, plunge_mm_s: 4, spindle_rpm: 20000,
      pass: { kind: "rough", stepdown_index: null },
      moves: [
        { t: "rapid", x: 22.5, y: 43, z: 14.5 },
        { t: "feed", x: 22.5, y: 43, z: 6.45 },
      ],
    },
    {
      operation: "pocket", layer: "P01_P01__POCKET_D1.50", tool_id: "EM3.17",
      feed_mm_s: 15.88, plunge_mm_s: 5.29, spindle_rpm: 20000,
      pass: { kind: "rough", stepdown_index: 0 },
      moves: [
        { t: "rapid", x: 20, y: 20, z: 14.5 },
        { t: "feed", x: 20, y: 20, z: 8 },
        { t: "arc", x: 20, y: 20, z: 8, i: -21.4, j: 0, cw: false },
      ],
    },
  ],
  skipped: [{ layer: "P01_P01__POCKET_D1.50", loop: 0, reason: "tool_too_large" }],
  stats: { operations: 2, moves: 5, rapid: 2, feed: 2, arc: 1 },
};

describe("flattenToolpaths", () => {
  test("flattens in cut order with per-operation spans", () => {
    const flat = flattenToolpaths(FIXTURE);
    expect(flat.moves.length).toBe(5);
    expect(flat.operations.length).toBe(2);
    expect(flat.operations[0].startMove).toBe(0);
    expect(flat.operations[0].endMove).toBe(2);
    expect(flat.operations[1].startMove).toBe(2);
    expect(flat.operations[1].endMove).toBe(5);
    expect(flat.clearanceZ).toBe(14.5);
  });

  test("first move starts parked at clearance above its end XY", () => {
    const flat = flattenToolpaths(FIXTURE);
    expect(flat.moves[0].start).toEqual({ x: 22.5, y: 43, z: 14.5 });
    expect(flat.moves[0].end).toEqual({ x: 22.5, y: 43, z: 14.5 });
    // A move's start is the previous move's end.
    expect(flat.moves[2].start).toEqual({ x: 22.5, y: 43, z: 6.45 });
  });

  test("full-circle arc has sweep 2π and true radius/length", () => {
    const flat = flattenToolpaths(FIXTURE);
    const arc = flat.moves[4];
    expect(arc.t).toBe("arc");
    expect(arc.center!.x).toBeCloseTo(-1.4, 9);
    expect(arc.center!.y).toBeCloseTo(20, 9);
    expect(arc.radius).toBeCloseTo(21.4, 9);
    expect(arc.sweep).toBeCloseTo(2 * Math.PI, 9);
    expect(arc.cw).toBe(false);
    expect(arc.helical).toBe(false);
    expect(arc.lengthMm).toBeCloseTo(21.4 * 2 * Math.PI, 6);
  });

  test("durations use feed for XY, plunge for Z-only, rapid constant", () => {
    const flat = flattenToolpaths(FIXTURE);
    // Move 0: zero-length rapid at clearance -> 0 s.
    expect(flat.moves[0].durationS).toBe(0);
    // Move 1: Z-only feed 14.5 -> 6.45 = 8.05 mm at plunge 4 mm/s.
    expect(flat.moves[1].durationS).toBeCloseTo(8.05 / 4, 9);
    // Move 2: rapid from (22.5,43,6.45) to (20,20,14.5) at 50 mm/s.
    const len = Math.hypot(2.5, 23, 8.05);
    expect(flat.moves[2].durationS).toBeCloseTo(len / RAPID_FEED_MM_S, 9);
    expect(flat.totalSeconds).toBeCloseTo(
      flat.moves.reduce((a, m) => a + m.durationS, 0), 9,
    );
    expect(flat.timeAtMoveStart.length).toBe(6);
    expect(flat.timeAtMoveStart[5]).toBeCloseTo(flat.totalSeconds, 9);
  });

  test("helical arc interpolates Z and adds it to the length", () => {
    const tp: ToolpathsIn = {
      version: 1, plan: "A", clearance_z_mm: 10,
      operations: [{
        operation: "bore", layer: "L", tool_id: "EM3.17",
        feed_mm_s: 10, plunge_mm_s: 5, spindle_rpm: 20000,
        pass: { kind: "rough", stepdown_index: null },
        moves: [
          { t: "rapid", x: 0, y: 0, z: 10 },
          // Quarter circle, radius 5, CCW, dropping 2 mm.
          { t: "arc", x: 5, y: 5, z: 8, i: 0, j: 5, cw: false },
        ],
      }],
      skipped: [],
      stats: { operations: 1, moves: 2, rapid: 1, feed: 0, arc: 1 },
    };
    const flat = flattenToolpaths(tp);
    const arc = flat.moves[1];
    expect(arc.helical).toBe(true);
    expect(arc.sweep).toBeCloseTo(Math.PI / 2, 9);
    expect(arc.lengthMm).toBeCloseTo(Math.hypot(5 * Math.PI / 2, 2), 9);
  });

  test("refuses a non-v1 section and an unknown move type", () => {
    expect(() => flattenToolpaths({ ...FIXTURE, version: 2 })).toThrow();
    const bad = JSON.parse(JSON.stringify(FIXTURE)) as ToolpathsIn;
    (bad.operations[0].moves[0] as unknown as { t: string }).t = "teleport";
    expect(() => flattenToolpaths(bad)).toThrow(/unknown move type/);
  });
});

describe("sampleMove / positionAt (true arcs)", () => {
  test("arc samples lie on the true circle, start to end", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pts = sampleMove(flat.moves[4]);
    expect(pts.length).toBeGreaterThan(10);
    expect(pts[0]).toEqual({ x: 20, y: 20, z: 8 });
    for (const p of pts) {
      expect(Math.hypot(p.x - -1.4, p.y - 20)).toBeCloseTo(21.4, 6);
    }
    // Last sample is the end point (full circle closes on itself).
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(20, 6);
    expect(last.y).toBeCloseTo(20, 6);
  });

  test("positionAt follows the arc, not the chord", () => {
    const flat = flattenToolpaths(FIXTURE);
    const mid = positionAt(flat.moves[4], 0.25);
    // Quarter of a full CCW circle from (20,20): angle 90 deg from
    // start angle 0 -> (centre.x, centre.y + r) = (-1.4, 41.4).
    expect(mid.x).toBeCloseTo(-1.4, 6);
    expect(mid.y).toBeCloseTo(41.4, 6);
    expect(mid.z).toBe(8);
    // A chord midpoint would be (20, 20) — the arc midpoint is not.
    expect(Math.hypot(mid.x - 20, mid.y - 20)).toBeGreaterThan(10);
  });

  test("positionAt on a linear move interpolates", () => {
    const flat = flattenToolpaths(FIXTURE);
    const p = positionAt(flat.moves[1], 0.5);
    expect(p).toEqual({ x: 22.5, y: 43, z: (14.5 + 6.45) / 2 });
  });
});

describe("playback state machine", () => {
  test("seek is a move-index jump (no replay)", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pb = createPlayback(flat);
    pb.seek(4);
    expect(pb.state.index).toBe(4);
    expect(pb.state.fraction).toBe(0);
    expect(pb.elapsedS()).toBeCloseTo(flat.timeAtMoveStart[4], 9);
    pb.seek(999);
    expect(pb.state.index).toBe(5);
    pb.seek(-3);
    expect(pb.state.index).toBe(0);
  });

  test("jumpToOperation lands on the operation's first move", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pb = createPlayback(flat);
    pb.jumpToOperation(1);
    expect(pb.state.index).toBe(2);
    pb.jumpToOperation(99);
    expect(pb.state.index).toBe(2); // clamped to the last op
  });

  test("tick advances by cut time at speed, then stops at the end", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pb = createPlayback(flat);
    pb.setSpeed(2);
    pb.play();
    // 1 s of wall time at 2x = 2 s of cut time.
    pb.tick(1);
    expect(pb.elapsedS()).toBeCloseTo(2, 9);
    expect(pb.state.playing).toBe(true);
    pb.tick(1e6);
    expect(pb.state.index).toBe(5);
    expect(pb.state.playing).toBe(false);
    expect(pb.elapsedS()).toBeCloseTo(flat.totalSeconds, 9);
    // Play again restarts from the beginning.
    pb.play();
    expect(pb.state.index).toBe(0);
    expect(pb.state.playing).toBe(true);
  });

  test("pause freezes the position", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pb = createPlayback(flat);
    pb.play();
    pb.tick(0.5);
    const at = pb.elapsedS();
    pb.pause();
    pb.tick(10);
    expect(pb.elapsedS()).toBe(at);
  });

  test("setSpeed ignores non-positive values", () => {
    const flat = flattenToolpaths(FIXTURE);
    const pb = createPlayback(flat);
    pb.setSpeed(4);
    pb.setSpeed(0);
    pb.setSpeed(-2);
    expect(pb.state.speed).toBe(4);
  });
});

describe("colours and tool diameters", () => {
  test("operation colours are distinct and stable", () => {
    const ops = ["drill", "bore", "pocket", "profile"];
    const colours = ops.map(operationColor);
    expect(new Set(colours).size).toBe(4);
    expect(operationColor("drill")).toBe(operationColor("drill"));
    expect(operationColor("unknown-op")).toBe("#7f8c8d");
  });

  test("colour by operation+tool is deterministic per tool", () => {
    expect(colorFor("pocket", "EM3.17")).toBe(colorFor("pocket", "EM3.17"));
    // Same operation, different tool: a (possibly) different shade.
    expect(typeof colorFor("pocket", "EM6.35")).toBe("string");
  });

  test("tool diameter parses from the tool id", () => {
    expect(toolDiameterMm("EM3.17")).toBe(3.17);
    expect(toolDiameterMm("EM6.35")).toBe(6.35);
    expect(toolDiameterMm("D2.25")).toBe(2.25);
    expect(toolDiameterMm("EM0.50")).toBe(0.5);
    expect(toolDiameterMm("weird")).toBeNull();
  });
});

describe("layerPlanes", () => {
  test("normalises a geometry payload, throws on a malformed one", () => {
    const planes = layerPlanes({
      layers: [
        {
          layer: "P01_P01__POCKET_D1.50", operation: "pocket", part: "P01_P01",
          z_top_mm: 9.5, z_bottom_mm: 8,
          loops: [{ closed: true, points: [[20, 20], [66, 20], [66, 66]] }],
          loop_count: 1,
        },
      ],
    });
    expect(planes.length).toBe(1);
    expect(planes[0].zTopMm).toBe(9.5);
    expect(planes[0].loops).toEqual([[[20, 20], [66, 20], [66, 66]]]);
    expect(() => layerPlanes({})).toThrow();
    expect(() => layerPlanes({ layers: [{ layer: 7 }] })).toThrow();
  });
});

describe("formatCutTime", () => {
  test("formats m:ss.s", () => {
    expect(formatCutTime(0)).toBe("0:00.0");
    expect(formatCutTime(65.25)).toBe("1:05.3");
    expect(formatCutTime(418.8)).toBe("6:58.8");
    expect(formatCutTime(NaN)).toBe("?");
  });
});

describe("clampBoxes / chosenPlanTotal / stockTopMm", () => {
  // Synthetic job shaped like a guided real-container job:
  // bottom-slot clamp at (15, 6) with the inventory footprint,
  // side-slot clamp at (144, 75) with the footprint already
  // swapped to [12, 20] by the guides. (Positions are test data,
  // not the current guides placement.)
  const GUIDED_JOB = {
    parts: [
      { z_top: 9.5 },
      { z_top: 8.0 },
    ],
    tool_plan: {
      chosen: "A",
      plans: [
        { id: "A", total_seconds: 464.1, cutting_seconds: 224.1, tool_changes: 2 },
        { id: "B", total_seconds: 519.8, cutting_seconds: 279.8, tool_changes: 2 },
      ],
    },
    workholding: {
      clamps: [
        { clamp_id: "test-tt-clamp", footprint_mm: [20, 12], x_mm: 15, y_mm: 6 },
        { clamp_id: "test-tt-clamp", footprint_mm: [12, 20], x_mm: 144, y_mm: 75 },
      ],
    },
  };

  test("clamp boxes match the 2D rects: same centre, same oriented footprint", () => {
    const boxes = clampBoxes(GUIDED_JOB);
    expect(boxes.length).toBe(2);
    // Bottom-slot clamp: centre (15, 6), 20 wide (x) by 12 deep (y).
    expect(boxes[0]).toEqual({ id: "test-tt-clamp", xMm: 15, yMm: 6, wMm: 20, dMm: 12, z0Mm: 0, z1Mm: 9.5 });
    // Side-slot clamp: the footprint stays as recorded ([12, 20]),
    // never swapped again — the 2D preview's rule.
    expect(boxes[1]).toEqual({ id: "test-tt-clamp", xMm: 144, yMm: 75, wMm: 12, dMm: 20, z0Mm: 0, z1Mm: 9.5 });
  });

  test("height is bed to stock top (the tallest part) — the documented default", () => {
    expect(stockTopMm(GUIDED_JOB)).toBe(9.5);
    expect(clampBoxes(GUIDED_JOB)[0].z1Mm).toBe(9.5);
    expect(stockTopMm({ z_top: 12 })).toBe(12);
    expect(stockTopMm({})).toBe(10);
  });

  test("missing footprint falls back to 20 x 12, like the 2D preview", () => {
    const boxes = clampBoxes({
      parts: [{ z_top: 10 }],
      workholding: { clamps: [{ clamp_id: "c1", x_mm: 50, y_mm: 50 }] },
    });
    expect(boxes).toEqual([{ id: "c1", xMm: 50, yMm: 50, wMm: 20, dMm: 12, z0Mm: 0, z1Mm: 10 }]);
  });

  test("no workholding (guides never ran) means no boxes — never guessed", () => {
    expect(clampBoxes({ parts: [{ z_top: 10 }] })).toEqual([]);
    expect(clampBoxes({ parts: [{ z_top: 10 }], workholding: null })).toEqual([]);
    expect(clampBoxes({ parts: [{ z_top: 10 }], workholding: { clamps: [] } })).toEqual([]);
  });

  test("entries without a finite position are skipped, positions list accepted", () => {
    const boxes = clampBoxes({
      parts: [{ z_top: 10 }],
      workholding: {
        positions: [
          { clamp_id: "a", x_mm: 10, y_mm: 10, footprint_mm: [20, 12] },
          { clamp_id: "b", x_mm: "far", y_mm: 10 },
          { clamp_id: "c" },
        ],
      },
    });
    expect(boxes.length).toBe(1);
    expect(boxes[0].id).toBe("a");
  });

  test("chosen plan total reads the chosen plan, null without one", () => {
    expect(chosenPlanTotal(GUIDED_JOB)).toEqual({ totalS: 464.1, cuttingS: 224.1, changes: 2 });
    expect(chosenPlanTotal({})).toBeNull();
    expect(chosenPlanTotal({ tool_plan: { chosen: "Z", plans: [{ id: "A", total_seconds: 1, cutting_seconds: 1, tool_changes: 0 }] } })).toBeNull();
    expect(chosenPlanTotal({ tool_plan: { chosen: "A", plans: [{ id: "A", total_seconds: NaN, cutting_seconds: 1, tool_changes: 0 }] } })).toBeNull();
  });
});

describe("summarizeMotion", () => {
  // Hand-computed from the fixture durations: drill plunge
  // 8.05 mm at 4 mm/s = 2.0125 s (the first rapid is zero-length);
  // pocket rapid hypot(2.5, 23, 8.05) / 50 + plunge 6.5 / 5.29
  // + full-circle arc 2π·21.4 / 15.88 = 10.1859 s.
  test("sums durations by tool, operation, and layer", () => {
    const s = summarizeMotion(flattenToolpaths(FIXTURE));
    expect(s.totalSeconds).toBeCloseTo(12.1984, 3);
    expect(s.byTool["D2.25"]).toBeCloseTo(2.0125, 4);
    expect(s.byTool["EM3.17"]).toBeCloseTo(10.1859, 3);
    expect(s.byOperation["drill"]).toBeCloseTo(2.0125, 4);
    expect(s.byOperation["pocket"]).toBeCloseTo(10.1859, 3);
    const drill = s.byLayer["P01_P01__DRILL_D2.25_D1.55_START1.50"];
    expect(drill.seconds).toBeCloseTo(2.0125, 4);
    expect(drill.moves).toBe(2);
    expect(drill.rapid).toBe(1);
    expect(drill.feed).toBe(1);
    expect(drill.arc).toBe(0);
    const pocket = s.byLayer["P01_P01__POCKET_D1.50"];
    expect(pocket.seconds).toBeCloseTo(10.1859, 3);
    expect(pocket.moves).toBe(3);
    expect(pocket.rapid).toBe(1);
    expect(pocket.feed).toBe(1);
    expect(pocket.arc).toBe(1);
  });

  test("by-tool and by-operation breakdowns sum to the total", () => {
    const s = summarizeMotion(flattenToolpaths(FIXTURE));
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(sum(s.byTool)).toBeCloseTo(s.totalSeconds, 9);
    expect(sum(s.byOperation)).toBeCloseTo(s.totalSeconds, 9);
    expect(Object.values(s.byLayer).reduce((a, l) => a + l.seconds, 0)).toBeCloseTo(s.totalSeconds, 9);
  });
});
