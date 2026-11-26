// sim_gpu.test.ts — V3.5 GPU backend tests (the pure parts).
//
// The shader itself can only run in a browser with WebGPU — its
// correctness against the CPU backend is the probe's job
// (server/run-webgpu-sim-probe.ts, which compares the two grids
// on the container job). These tests cover everything checkable
// in Bun: segment packing (the packer must walk exactly the
// segments simulateRange sweeps), the profile-kind mapping, the
// bitcast-order property the atomicMin trick depends on, and the
// grid comparison.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareSim } from "./sim.ts";
import { loadJobGeometry } from "./geometry.ts";
import {
  packSegments, unpackSegment, compareGrids, compareGridsBanded,
  gpuProfileKind, gpuProfileParam, GPU_MAX_CLUSTER,
  GPU_SHADER_WGSL, GPU_SEGMENT_BYTES, GPU_WORKGROUP_SIZE,
  isWebGpuAvailable,
} from "./sim_gpu.ts";
import {
  makeFlatEndmill, makeBallNose, makeVBit, makeBullNose,
} from "./tools.ts";

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

describe("gpu profile mapping", () => {
  test("flat / ball / V-bit / bull-nose map to the shader's kinds and params", () => {
    expect(gpuProfileKind(makeFlatEndmill(6))).toBe(0);
    expect(gpuProfileParam(makeFlatEndmill(6))).toBe(0);
    expect(gpuProfileKind(makeBallNose(6))).toBe(1);
    expect(gpuProfileParam(makeBallNose(6))).toBe(0);
    expect(gpuProfileKind(makeVBit(90, 6))).toBe(2);
    expect(gpuProfileParam(makeVBit(90, 6))).toBeCloseTo(1, 9); // tan(45°)
    expect(gpuProfileKind(makeBullNose(6, 1))).toBe(3);
    expect(gpuProfileParam(makeBullNose(6, 1))).toBe(1);
    expect(() => gpuProfileKind({ kind: "laser" } as never)).toThrow(/unknown tool profile kind/);
    expect(() => gpuProfileParam({ kind: "v-bit", angleDeg: null } as never)).toThrow(/no angle/);
  });
});

describe("segment packing", () => {
  const prep = prepareSim(fakeJob(
    [
      { tool_id: "EM6.00", moves: [
        { t: "rapid", x: 2, y: 10, z: 15 },
        { t: "feed", x: 2, y: 10, z: 5 },
        { t: "feed", x: 18, y: 10, z: 5 },
      ] },
      { tool_id: "BN6.00", moves: [
        { t: "rapid", x: 2, y: 5, z: 15 },
        { t: "feed", x: 2, y: 5, z: 8 },
        { t: "arc", x: 18, y: 5, z: 8, i: 8, j: 0, cw: true },
      ] },
      { tool_id: "V6.00", moves: [
        { t: "rapid", x: 10, y: 15, z: 15 },
        { t: "feed", x: 10, y: 15, z: 6 },
        { t: "feed", x: 10, y: 18, z: 6 },
      ] },
    ],
    [
      { id: "EM6.00", kind: "endmill", dia_mm: 6 },
      { id: "BN6.00", kind: "ball-nose", dia_mm: 6 },
      { id: "V6.00", kind: "v-bit", dia_mm: 6, angle_deg: 90 },
    ],
  ));

  test("pack/unpack round-trips every segment's fields", () => {
    const packed = packSegments(prep, 0, prep.flat.moves.length);
    expect(packed.count).toBeGreaterThan(0);
    expect(packed.bytes.byteLength).toBe(packed.count * GPU_SEGMENT_BYTES);
    for (let s = 0; s < packed.count; s++) {
      const seg = unpackSegment(packed.bytes, s);
      expect(seg.radius).toBe(3);
      expect(seg.i0).toBeLessThanOrEqual(seg.i1);
      expect(seg.j0).toBeLessThanOrEqual(seg.j1);
      expect(seg.i1).toBeLessThan(prep.grid.nx);
      expect(seg.j1).toBeLessThan(prep.grid.ny);
      // The bbox contains the segment's endpoints (expanded by R).
      expect(seg.p0.x).toBeGreaterThanOrEqual(
        prep.grid.x0 + (seg.i0 + 0.5) * prep.grid.pitchMm - 3 - prep.grid.pitchMm);
      expect(seg.p1.x).toBeLessThanOrEqual(
        prep.grid.x0 + (seg.i1 + 0.5) * prep.grid.pitchMm + 3 + prep.grid.pitchMm);
    }
    // Kinds present: flat (op 0), ball-nose (op 1), V-bit (op 2).
    const kinds = new Set(Array.from({ length: packed.count }, (_, s) => unpackSegment(packed.bytes, s).profileKind));
    expect(kinds).toEqual(new Set([0, 1, 2]));
  });

  test("clearance rapids pack to no segments; an arc packs several", () => {
    // Moves [0, 1) is only the first op's clearance rapid (z=15).
    expect(packSegments(prep, 0, 1).count).toBe(0);
    // The flat level pass packs its two feed segments.
    const level = packSegments(prep, 1, 3);
    expect(level.count).toBe(2);
    for (let s = 0; s < level.count; s++) {
      expect(unpackSegment(level.bytes, s).profileKind).toBe(0);
    }
    // The arc move (a 180° semicircle, radius 8) samples into
    // several segments at the sagitta-bounded step.
    const arcMoves = prep.flat.moves.map((m, i) => ({ m, i })).filter(({ m }) => m.t === "arc");
    expect(arcMoves.length).toBe(1);
    const arc = packSegments(prep, arcMoves[0].i, arcMoves[0].i + 1);
    expect(arc.count).toBeGreaterThan(2);
    for (let s = 0; s < arc.count; s++) {
      expect(unpackSegment(arc.bytes, s).profileKind).toBe(1);
    }
  });

  test("packing a sub-range packs exactly that range's segments", () => {
    const all = packSegments(prep, 0, prep.flat.moves.length);
    const firstHalf = packSegments(prep, 0, 3);
    const secondHalf = packSegments(prep, 3, prep.flat.moves.length);
    expect(firstHalf.count + secondHalf.count).toBe(all.count);
    // Empty and inverted ranges pack nothing.
    expect(packSegments(prep, 3, 3).count).toBe(0);
    expect(packSegments(prep, 5, 2).count).toBe(0);
    expect(packSegments(prep, 0, 0).count).toBe(0);
  });
});

describe("shader source", () => {
  test("the WGSL is a compute shader with the atomicMin trick", () => {
    expect(GPU_SHADER_WGSL).toContain("@compute");
    expect(GPU_SHADER_WGSL).toContain("@workgroup_size(256)");
    expect(GPU_SHADER_WGSL).toContain("atomicMin");
    expect(GPU_SHADER_WGSL).toContain("bitcast<u32>");
    expect(GPU_SHADER_WGSL).toContain("heightAt");
    expect(GPU_SHADER_WGSL).toContain("segmentCut");
    expect(GPU_WORKGROUP_SIZE).toBe(256);
  });

  test("bitcast<u32> preserves order for non-negative f32 (the atomicMin trick)", () => {
    // The shader's atomicMin works only because IEEE754 bit
    // patterns of non-negative floats sort the same as the
    // floats. Check the property directly on the bit patterns.
    const dv = new DataView(new ArrayBuffer(4));
    const bits = (f: number): number => {
      dv.setFloat32(0, f, true);
      return dv.getUint32(0, true);
    };
    const values = [0, 1e-9, 0.001, 0.5, 1, 2.5, 5, 9.5, 21.8, 100, 1000];
    for (let k = 1; k < values.length; k++) {
      expect(bits(values[k])).toBeGreaterThan(bits(values[k - 1]));
    }
    expect(bits(0)).toBe(0);
    // -0.0 and +0.0 compare equal as floats but differ as bits;
    // the shader clamps with max(cut, 0.0), which yields +0.0.
    expect(Math.max(-0.0, 0.0)).toBe(0);
  });
});

describe("compareGrids", () => {
  test("identical grids compare clean; one diff is reported exactly", () => {
    const a = new Float32Array([9.5, 5, 2, 9.5]);
    const b = new Float32Array([9.5, 5, 2, 9.5]);
    expect(compareGrids(a, b)).toEqual({ mismatches: 0, maxAbsDiffMm: 0, meanAbsDiffMm: 0 });
    const c = new Float32Array([9.5, 5, 0, 9.5]);
    expect(compareGrids(a, c)).toEqual({ mismatches: 1, maxAbsDiffMm: 2, meanAbsDiffMm: 2 });
    const d = new Float32Array([8.5, 4, 2, 9.5]);
    const cmp = compareGrids(a, d);
    expect(cmp.mismatches).toBe(2);
    expect(cmp.maxAbsDiffMm).toBe(1);
    expect(cmp.meanAbsDiffMm).toBe(1);
    expect(() => compareGrids(a, new Float32Array(3))).toThrow(/grid size mismatch/);
  });
});

describe("compareGridsBanded", () => {
  test("identical grids compare clean", () => {
    const a = new Float32Array([9.5, 5, 2, 9.5]);
    const r = compareGridsBanded(a, a.slice(), 2, 2, 0.1);
    expect(r).toEqual({
      columns: 4, rawMismatched: 0, mismatched: 0,
      clusters: 0, maxCluster: 0, maxDiffMm: 0, toleranceMm: 0.1,
    });
  });

  test("a single-column graze flip is absorbed by the band test", () => {
    // A cut the centre column to 5; B grazed it (9.5) — but B cut
    // the left neighbour to 5 and A left the right neighbour at
    // 9.5, so each height lies in the other's 3x3 range.
    const nx = 5, ny = 5;
    const a = new Float32Array(nx * ny).fill(9.5);
    const b = new Float32Array(nx * ny).fill(9.5);
    a[12] = 5.0;
    b[11] = 5.0;
    const r = compareGridsBanded(a, b, nx, ny, 0.1);
    expect(r.rawMismatched).toBe(2); // centre differs, left neighbour differs
    expect(r.mismatched).toBe(0);
    expect(r.maxCluster).toBe(0);
  });

  test("a single-column flip with no supporting neighbours survives", () => {
    // A left the centre at 9.5, B cut it to 5, everything around
    // is cut to 5 in both — the 9.5 lies outside B's 3x3 range.
    const nx = 5, ny = 5;
    const a = new Float32Array(nx * ny).fill(5.0);
    const b = new Float32Array(nx * ny).fill(5.0);
    a[12] = 9.5;
    const r = compareGridsBanded(a, b, nx, ny, 0.1);
    expect(r.rawMismatched).toBe(1);
    expect(r.mismatched).toBe(1);
    expect(r.clusters).toBe(1);
    expect(r.maxCluster).toBe(1);
  });

  test("a 2x2 missed block survives as one cluster of 4", () => {
    // A cut a 2x2 block to 5; B left it at 9.5; surroundings 9.5
    // in both — no neighbour carries the cut height in B.
    const nx = 6, ny = 6;
    const a = new Float32Array(nx * ny).fill(9.5);
    const b = new Float32Array(nx * ny).fill(9.5);
    for (const k of [14, 15, 20, 21]) a[k] = 5.0;
    const r = compareGridsBanded(a, b, nx, ny, 0.1);
    expect(r.rawMismatched).toBe(4);
    expect(r.mismatched).toBe(4);
    expect(r.clusters).toBe(1);
    expect(r.maxCluster).toBe(4);
    expect(r.maxCluster).toBeGreaterThan(GPU_MAX_CLUSTER);
  });

  test("two separated surviving singles are two clusters of 1", () => {
    const nx = 7, ny = 5;
    const a = new Float32Array(nx * ny).fill(5.0);
    const b = new Float32Array(nx * ny).fill(5.0);
    a[8] = 9.5;
    a[26] = 9.5;
    const r = compareGridsBanded(a, b, nx, ny, 0.1);
    expect(r.mismatched).toBe(2);
    expect(r.clusters).toBe(2);
    expect(r.maxCluster).toBe(1);
  });

  test("the cluster bar is 3 (the G-code round-trip's bar)", () => {
    expect(GPU_MAX_CLUSTER).toBe(3);
  });

  test("size mismatch throws", () => {
    const a = new Float32Array(4);
    expect(() => compareGridsBanded(a, new Float32Array(5), 2, 2, 0.1)).toThrow(/grid size mismatch/);
  });
});

describe("availability", () => {
  test("WebGPU is absent in Bun (no navigator.gpu) — the CPU fallback case", () => {
    expect(isWebGpuAvailable()).toBe(false);
  });
});

describe("packing on the real container job", () => {
  // The reference jobs live outside the repo; skip when absent.
  const jobDir = join(import.meta.dir, "..", "..", "v31-verify-home", "jobs", "20261124-160834-real-container");
  const hasJob = existsSync(join(jobDir, "job.json"));

  test("every packed segment sits inside the grid", () => {
    if (!hasJob) {
      console.warn("skipping real-container pack test: reference job not present");
      return;
    }
    const job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
    const { bounds } = loadJobGeometry(jobDir);
    const prep = prepareSim(job, bounds);
    const packed = packSegments(prep, 0, prep.flat.moves.length);
    expect(packed.count).toBeGreaterThan(1000);
    for (let s = 0; s < packed.count; s++) {
      const seg = unpackSegment(packed.bytes, s);
      expect(seg.i0).toBeGreaterThanOrEqual(0);
      expect(seg.i1).toBeLessThan(prep.grid.nx);
      expect(seg.j0).toBeGreaterThanOrEqual(0);
      expect(seg.j1).toBeLessThan(prep.grid.ny);
      expect(seg.radius).toBeGreaterThan(0);
      expect(seg.profileKind).toBe(0); // V3 toolpaths are flat-only
    }
  });
});
