// Unit tests for the V3.4 cut-simulation engine (ts/sim.ts, ts/tools.ts)
// and the verifier's raster helpers (ts/sim_verify.ts).
// Run: bun test ts/sim.test.ts
import { describe, test, expect } from "bun:test";
import {
  makeFlatEndmill, makeBallNose, makeVBit, makeBullNose,
  profileForPlanTool, toolTableFromPlan,
} from "./tools.ts";
import {
  BASE_PITCH_MM, MAX_COLUMNS, stockSpecFromJob, choosePitch, createGrid,
  heightAt, prepareSim, simulateAll, arcStepDeg,
} from "./sim.ts";
import { fillDisc, capsuleRowInterval } from "./sim_verify.ts";
import type { DexelGrid } from "./sim.ts";

// ---------------------------------------------------------------- profiles

describe("tool profiles", () => {
  test("flat endmill: envelope is flat, radius is constant", () => {
    const t = makeFlatEndmill(6);
    expect(t.kind).toBe("flat");
    expect(t.radiusMm).toBe(3);
    expect(t.heightAt(0)).toBe(0);
    expect(t.heightAt(2.9)).toBe(0);
    expect(t.heightAt(3)).toBe(0);
    expect(t.radiusAt(0)).toBe(3);
    expect(t.radiusAt(5)).toBe(3);
  });

  test("ball-nose: h(r) = R - sqrt(R^2 - r^2), inverse radiusAt", () => {
    const t = makeBallNose(6); // R = 3
    expect(t.heightAt(0)).toBe(0);
    expect(t.heightAt(3)).toBeCloseTo(3, 9);
    expect(t.heightAt(1.5)).toBeCloseTo(3 - Math.sqrt(9 - 2.25), 9);
    expect(t.heightAt(2.9)).toBeCloseTo(3 - Math.sqrt(9 - 8.41), 9);
    // radiusAt is the inverse: radiusAt(heightAt(r)) == r
    for (const r of [0.5, 1, 1.5, 2, 2.5, 2.9]) {
      expect(t.radiusAt(t.heightAt(r))).toBeCloseTo(r, 9);
    }
    expect(t.radiusAt(0)).toBe(0);
    expect(t.radiusAt(3)).toBe(3);
  });

  test("V-bit 90 deg: h(r) = r, inverse radiusAt", () => {
    const t = makeVBit(90, 6);
    expect(t.heightAt(0)).toBe(0);
    expect(t.heightAt(1)).toBeCloseTo(1, 9);
    expect(t.heightAt(2)).toBeCloseTo(2, 9);
    expect(t.heightAt(3)).toBeCloseTo(3, 9);
    expect(t.radiusAt(2)).toBeCloseTo(2, 9);
    expect(t.radiusAt(10)).toBe(3); // capped at the stated diameter
  });

  test("V-bit 60 deg: h(r) = r / tan(30 deg)", () => {
    const t = makeVBit(60, 6);
    expect(t.heightAt(1)).toBeCloseTo(1 / Math.tan(Math.PI / 6), 9);
    expect(t.radiusAt(1)).toBeCloseTo(Math.tan(Math.PI / 6), 9);
  });

  test("bull-nose: flat middle, torus fillet, inverses", () => {
    const t = makeBullNose(6, 1); // R = 3, rc = 1, flat to r = 2
    expect(t.heightAt(0)).toBe(0);
    expect(t.heightAt(2)).toBe(0);
    expect(t.heightAt(2.5)).toBeCloseTo(1 - Math.sqrt(1 - 0.25), 9);
    expect(t.heightAt(3)).toBeCloseTo(1, 9);
    for (const r of [2.2, 2.5, 2.8, 2.95]) {
      expect(t.radiusAt(t.heightAt(r))).toBeCloseTo(r, 9);
    }
  });

  test("bull-nose normalises: rc = 0 is flat, rc = R is ball-nose", () => {
    const flat = makeBullNose(6, 0);
    expect(flat.kind).toBe("flat");
    expect(flat.heightAt(2.9)).toBe(0);
    const ball = makeBullNose(6, 3);
    expect(ball.kind).toBe("ball-nose");
    expect(ball.heightAt(1.5)).toBeCloseTo(3 - Math.sqrt(9 - 2.25), 9);
  });

  test("profileForPlanTool maps kinds and throws on unknown kind", () => {
    expect(profileForPlanTool({ id: "EM6", kind: "endmill", dia_mm: 6 }).kind).toBe("flat");
    expect(profileForPlanTool({ id: "D3", kind: "drill", dia_mm: 3 }).kind).toBe("flat");
    expect(profileForPlanTool({ id: "BN6", kind: "ball-nose", dia_mm: 6 }).kind).toBe("ball-nose");
    expect(profileForPlanTool({ id: "V90", kind: "v-bit", dia_mm: 6, angle_deg: 90 }).kind).toBe("v-bit");
    expect(profileForPlanTool({ id: "BR6", kind: "bull-nose", dia_mm: 6, corner_radius_mm: 1 }).kind).toBe("bull-nose");
    expect(() => profileForPlanTool({ id: "X", kind: "laser", dia_mm: 3 })).toThrow(/unknown kind/);
    expect(() => profileForPlanTool({ id: "V", kind: "v-bit", dia_mm: 6 })).toThrow(/angle_deg/);
    expect(() => profileForPlanTool({ id: "B", kind: "bull-nose", dia_mm: 6 })).toThrow(/corner_radius_mm/);
  });

  test("toolTableFromPlan throws on a tool the plan does not name", () => {
    expect(() =>
      toolTableFromPlan([{ id: "EM6.00", kind: "endmill", dia_mm: 6 }], ["EM6.00", "EM9.53"]),
    ).toThrow(/not in the chosen plan/);
  });
});

// ---------------------------------------------------------------- pitch

describe("pitch selection", () => {
  test("container sheet takes the base pitch, not coarse", () => {
    const stock = stockSpecFromJob({
      parts: [{ z_top: 9.5 }],
      suggested_material: { x: 150, y: 90, thickness: 10 },
    });
    expect(stock.top_mm).toBe(9.5);
    const p = choosePitch(stock, 3.17);
    expect(p.pitch_mm).toBe(BASE_PITCH_MM);
    expect(p.coarse).toBe(false);
    expect(p.coarse_reason).toBeNull();
  });

  test("kookabus sheet doubles to 0.1 mm and reports coarse", () => {
    const stock = stockSpecFromJob({
      parts: [{ z_top: 21.8 }],
      suggested_material: { x: 470, y: 150, thickness: 22 },
    });
    const p = choosePitch(stock, 0.5);
    expect(p.pitch_mm).toBe(0.1);
    expect(p.coarse).toBe(true);
    expect(p.coarse_reason).toMatch(/over the 25000000 budget/);
    expect(p.columns).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  test("stock top is the max part z_top, not the suggested thickness", () => {
    const stock = stockSpecFromJob({
      parts: [{ z_top: 14 }],
      suggested_material: { x: 120, y: 80, thickness: 15 },
    });
    expect(stock.top_mm).toBe(14);
    expect(stock.suggested_thickness_mm).toBe(15);
  });
});

// ---------------------------------------------------------------- synthetic sims

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

describe("simulation", () => {
  test("flat endmill cuts a flat-bottomed groove to the move Z", () => {
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM6.00", moves: [
        { t: "rapid", x: 2, y: 10, z: 15 },
        { t: "feed", x: 2, y: 10, z: 5 },
        { t: "feed", x: 18, y: 10, z: 5 },
      ] }],
      [{ id: "EM6.00", kind: "endmill", dia_mm: 6 }],
    ));
    simulateAll(prep);
    // Groove floor is flat at 5 across the tool width.
    for (const x of [5, 10, 15]) {
      expect(heightAt(prep.grid, x, 10)).toBeCloseTo(5, 2);
      expect(heightAt(prep.grid, x, 8)).toBeCloseTo(5, 2);
      expect(heightAt(prep.grid, x, 12)).toBeCloseTo(5, 2);
    }
    // Outside the groove the stock is untouched.
    expect(heightAt(prep.grid, 10, 2)).toBeCloseTo(10, 9);
    expect(heightAt(prep.grid, 10, 18)).toBeCloseTo(10, 9);
  });

  test("ball-nose and V-bit cut the same pass to different floors (profile plugs in)", () => {
    const moves = [
      { t: "rapid", x: 2, y: 10, z: 15 },
      { t: "feed", x: 2, y: 10, z: 5 },
      { t: "feed", x: 18, y: 10, z: 5 },
    ];
    const ball = prepareSim(fakeJob(
      [{ tool_id: "BN6.00", moves }],
      [{ id: "BN6.00", kind: "ball-nose", dia_mm: 6 }],
    ));
    simulateAll(ball);
    // Ball-nose floor: centre 5.0, rising with h(r) off-centre.
    expect(heightAt(ball.grid, 10, 10)).toBeCloseTo(5, 2);
    expect(heightAt(ball.grid, 10, 11)).toBeCloseTo(5 + (3 - Math.sqrt(9 - 1)), 1);
    expect(heightAt(ball.grid, 10, 12)).toBeCloseTo(5 + (3 - Math.sqrt(9 - 4)), 1);
    const vbit = prepareSim(fakeJob(
      [{ tool_id: "V6.00", moves }],
      [{ id: "V6.00", kind: "v-bit", dia_mm: 6, angle_deg: 90 }],
    ));
    simulateAll(vbit);
    // V-bit 90 deg floor: h(r) = r. The centre probe reads 5.025,
    // not 5.000: the probed column's centre sits 0.025 mm (half a
    // pitch) off the tool axis and the cone rises linearly there.
    expect(heightAt(vbit.grid, 10, 10)).toBeCloseTo(5, 1);
    expect(heightAt(vbit.grid, 10, 11)).toBeCloseTo(6, 1);
    expect(heightAt(vbit.grid, 10, 12)).toBeCloseTo(7, 1);
  });

  test("a vertical feed bores a flat-bottomed hole", () => {
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM3.17", moves: [
        { t: "rapid", x: 10, y: 10, z: 15 },
        { t: "feed", x: 10, y: 10, z: 2 },
        { t: "rapid", x: 10, y: 10, z: 15 },
      ] }],
      [{ id: "EM3.17", kind: "endmill", dia_mm: 3.17 }],
    ));
    simulateAll(prep);
    expect(heightAt(prep.grid, 10, 10)).toBeCloseTo(2, 2);
    expect(heightAt(prep.grid, 11, 10)).toBeCloseTo(2, 2);
    expect(heightAt(prep.grid, 14, 10)).toBeCloseTo(10, 9);
  });

  test("a feed at tab height leaves the tab; a feed at the floor cuts it", () => {
    // The tab span is x 8-12 at z = 1, but the lift/drop points sit
    // a tool radius (3 mm) beyond it (x = 5 and x = 15): the z = 0
    // feeds' endpoint discs reach 3 mm into the span, so lifting
    // exactly at the span ends would cut the tab to 0 — the same
    // defect the generator's extendTabSpans fixes.
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM6.00", moves: [
        { t: "rapid", x: 2, y: 10, z: 15 },
        { t: "feed", x: 2, y: 10, z: 0 },
        { t: "feed", x: 5, y: 10, z: 0 },
        { t: "feed", x: 5, y: 10, z: 1 },
        { t: "feed", x: 15, y: 10, z: 1 },
        { t: "feed", x: 15, y: 10, z: 0 },
        { t: "feed", x: 18, y: 10, z: 0 },
      ] }],
      [{ id: "EM6.00", kind: "endmill", dia_mm: 6 }],
    ));
    simulateAll(prep);
    expect(heightAt(prep.grid, 3, 10)).toBeCloseTo(0, 2);
    expect(heightAt(prep.grid, 10, 10)).toBeCloseTo(1, 2); // the tab
    expect(heightAt(prep.grid, 17, 10)).toBeCloseTo(0, 2);
  });

  test("an arc feed cuts a curved groove", () => {
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM6.00", moves: [
        { t: "rapid", x: 15, y: 10, z: 15 },
        { t: "feed", x: 15, y: 10, z: 5 },
        // Full circle, centre (10,10), radius 5, CCW.
        { t: "arc", x: 15, y: 10, z: 5, i: -5, j: 0, cw: false },
      ] }],
      [{ id: "EM6.00", kind: "endmill", dia_mm: 6 }],
    ));
    simulateAll(prep);
    // On the circle the groove is at 5; inside it (away from the
    // ring) the stock is untouched.
    expect(heightAt(prep.grid, 15, 10)).toBeCloseTo(5, 1);
    expect(heightAt(prep.grid, 10, 15)).toBeCloseTo(5, 1);
    expect(heightAt(prep.grid, 5, 10)).toBeCloseTo(5, 1);
    expect(heightAt(prep.grid, 10, 10)).toBeCloseTo(10, 9);
  });

  test("a column past a segment's end is not grazed (off-segment tangent)", () => {
    const prep = prepareSim(fakeJob(
      [{ tool_id: "EM6.35", moves: [
        { t: "rapid", x: 0, y: 0, z: 15 },
        { t: "feed", x: 0, y: 0, z: 5 },
        { t: "feed", x: 10, y: 0, z: 5 },
      ] }],
      [{ id: "EM6.35", kind: "endmill", dia_mm: 6.35 }],
    ));
    simulateAll(prep);
    // Column nearest (13.5, 0) is 3.48 mm from the endpoint (10, 0)
    // — past the tool radius 3.175 — so it stays uncut.
    expect(heightAt(prep.grid, 13.5, 0)).toBeCloseTo(10, 9);
    // Column nearest (12, 0) is 1.98 mm from the endpoint — cut.
    expect(heightAt(prep.grid, 12, 0)).toBeCloseTo(5, 2);
  });

  test("two runs of the same job are identical (determinism)", () => {
    const build = () => prepareSim(fakeJob(
      [{ tool_id: "EM6.00", moves: [
        { t: "rapid", x: 2, y: 10, z: 15 },
        { t: "feed", x: 2, y: 10, z: 5 },
        { t: "feed", x: 18, y: 10, z: 5 },
        { t: "arc", x: 18, y: 10, z: 5, i: 0, j: -5, cw: true },
      ] }],
      [{ id: "EM6.00", kind: "endmill", dia_mm: 6 }],
    ));
    const a = build(); simulateAll(a);
    const b = build(); simulateAll(b);
    expect(a.grid.heights).toEqual(b.grid.heights);
  });

  test("arcStepDeg bounds the chord sagitta", () => {
    // Sagitta R*theta^2/8 <= pitch/4 for the returned step.
    for (const [R, pitch] of [[1, 0.05], [5, 0.05], [23, 0.05], [100, 0.1]] as const) {
      const deg = arcStepDeg(R, pitch);
      expect(deg).toBeGreaterThanOrEqual(0.5);
      expect(deg).toBeLessThanOrEqual(10);
      const sagitta = R * (1 - Math.cos((deg * Math.PI / 180) / 2));
      expect(sagitta).toBeLessThanOrEqual(pitch / 4 + 1e-9);
    }
  });
});

// ---------------------------------------------------------------- verifier raster helpers

function smallGrid(x0: number, y0: number, xMm: number, yMm: number, top: number): DexelGrid {
  const pitch = { pitch_mm: 0.05, nx: Math.ceil(xMm / 0.05), ny: Math.ceil(yMm / 0.05), columns: 0, coarse: false, coarse_reason: null };
  pitch.columns = pitch.nx * pitch.ny;
  return createGrid({ x_min: x0, y_min: y0, x_mm: xMm, y_mm: yMm, top_mm: top, suggested_thickness_mm: null }, pitch);
}

describe("verifier raster helpers", () => {
  test("fillDisc on a negative-origin grid fills the right rows", () => {
    // Grid y in [-40, 10): it holds both the hole (cy = -20) and
    // the y ~ 0 band where the old x-helper-for-rows bug put it.
    const grid = smallGrid(-60, -40, 20, 50, 14);
    const F = new Float32Array(grid.nx * grid.ny).fill(14);
    fillDisc(grid, F, -50, -20, 3, 0);
    // The hole centre is filled; the y ~ 0 band is untouched.
    const centreIdx = (Math.floor((-20 - grid.y0) / 0.05 - 0.5)) * grid.nx + Math.floor((-50 - grid.x0) / 0.05 - 0.5);
    expect(F[centreIdx]).toBe(0);
    const wrongIdx = (Math.floor((0 - grid.y0) / 0.05 - 0.5)) * grid.nx + Math.floor((-50 - grid.x0) / 0.05 - 0.5);
    expect(F[wrongIdx]).toBe(14);
  });

  test("fillDisc includes a column whose centre is exactly on the disc edge", () => {
    // Grid y in [-40, 10): row 800's centre is y = 0.025.
    const grid = smallGrid(-60, -40, 20, 50, 14);
    const F = new Float32Array(grid.nx * grid.ny).fill(14);
    // Disc edge at x = -51.175, which is exactly column 176's
    // centre; its centre is r from the disc centre, so it is in.
    fillDisc(grid, F, -48.675, 0.025, 2.5, 0);
    const i = 176, j = 800;
    expect(F[j * grid.nx + i]).toBe(0);
  });

  test("capsuleRowInterval returns the edge row exactly R from a horizontal segment", () => {
    const iv = capsuleRowInterval({ x: 0, y: 26 }, { x: 100, y: 26 }, 3.175, 29.175);
    expect(iv).not.toBeNull();
    expect(iv![0]).toBeCloseTo(0, 6);
    expect(iv![1]).toBeCloseTo(100, 6);
  });
});
