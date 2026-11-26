// V3.5 GPU backend — WebGPU compute shader for the dexel sim
// (V3_SCOPE.md §5.4). The performance path: one workgroup per
// sampled segment, the dexel grid as a storage buffer, the tool
// envelope as per-segment parameters.
//
// SAME dexel buffer layout as the CPU backend (ts/sim.ts): the
// heights are one Float32Array, row-major, same nx/ny/pitch/
// origin — so a job simulated on one backend and displayed on the
// other is the same job, and the acceptance compares them
// (server/webgpu-sim-probe.html runs both backends on the
// container job and compares the grids).
//
// The shader mirrors the CPU sweep segment for segment, branch
// for branch (vertical disc / flat level fast path / general
// tool-interval + envelope-min, same arc sampling rule on the CPU
// side when packing). Two deliberate differences, both stated:
//   1. The CPU computes in f64 and stores f32; the shader computes
//      in f32 throughout. A column exactly on a footprint boundary
//      can therefore be included by one backend and not the other.
//      The acceptance comparison is within the verification
//      tolerance (pitch + 0.05 mm), not bit equality — the probe
//      reports the exact-equality stats separately (mismatch count
//      and max abs diff), so the real gap is measured, not assumed.
//   2. Column writes are atomicMin on the bitcast<u32> of the cut
//      height. That preserves float order ONLY for non-negative
//      floats — which holds here: heights are job Z, and Z >= 0 by
//      construction (Z=0 is the stock bottom; a cut below 0 would
//      be a generator bug the verifier catches). The shader clamps
//      the operand at 0.0, so a hypothetical negative cut can never
//      corrupt the ordering; it would read as 0.0, the same floor
//      the stock already has.
//
// WebGPU is optional: when it is absent (this VM's headless
// Chromium has no navigator.gpu at all — see docs-v3/sim_gpu.md),
// the CPU backend is the fallback and the UI says so. This module
// never fakes a GPU result: simulateGpu throws a named error when
// there is no adapter/device, and the probe reports UNAVAILABLE
// (exit 0, measurement deferred) rather than a number.
//
// The pure parts (segment packing, the WGSL source, the grid
// comparison) run in Bun and are unit-tested (ts/sim_gpu.test.ts);
// only the device acquisition + dispatch need a browser.

import { prepareSim, arcStepDeg } from "./sim.ts";
import type { PreparedSim } from "./sim.ts";
import { sampleMove } from "./view3d/model.ts";
import type { FlatMove } from "./view3d/model.ts";
import type { ToolProfile } from "./tools.ts";

// The TS DOM lib in this repo declares the WebGPU interfaces
// (GPUDevice, GPUBuffer, ...) but NOT the GPUBufferUsage /
// GPUMapMode value namespaces — so they are declared here (type
// only; at runtime the browser provides the real globals). The
// values are the WebGPU spec constants.
declare const GPUBufferUsage: {
  MAP_READ: number; MAP_WRITE: number; COPY_SRC: number; COPY_DST: number;
  INDEX: number; VERTEX: number; UNIFORM: number; STORAGE: number;
  INDIRECT: number; QUERY_RESOLVE: number;
};
declare const GPUMapMode: { READ: number; WRITE: number };

// ---------------------------------------------------------------- availability

/** True when this runtime exposes WebGPU (navigator.gpu exists).
 * False in Bun, in Node, and in browsers without WebGPU. TRUE in
 * this VM's headless Chromium when launched with
 * --enable-unsafe-webgpu --use-angle=swiftshader (the probe
 * driver's flags) — Dawn/SwiftShader exposes navigator.gpu and
 * compute dispatches run (slowly, in software). A false here is
 * the honest CPU-fallback case, not an error. */
export function isWebGpuAvailable(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof (navigator as unknown as { gpu?: unknown }).gpu !== "undefined" &&
      (navigator as unknown as { gpu?: unknown }).gpu !== null
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- WGSL

/** Profile kinds, as the shader's u32 (mirrors ts/tools.ts). */
export const GPU_PROFILE_FLAT = 0;
export const GPU_PROFILE_BALL = 1;
export const GPU_PROFILE_VBIT = 2;
export const GPU_PROFILE_BULL = 3;

export function gpuProfileKind(profile: ToolProfile): number {
  switch (profile.kind) {
    case "flat": return GPU_PROFILE_FLAT;
    case "ball-nose": return GPU_PROFILE_BALL;
    case "v-bit": return GPU_PROFILE_VBIT;
    case "bull-nose": return GPU_PROFILE_BULL;
    default: throw new Error(`unknown tool profile kind ${JSON.stringify((profile as { kind: unknown }).kind)}`);
  }
}

/** The shader's second parameter: V-bit tan(theta/2), bull-nose
 * corner radius, 0 for flat / ball-nose. Mirrors ts/tools.ts. */
export function gpuProfileParam(profile: ToolProfile): number {
  if (profile.kind === "v-bit") {
    if (profile.angleDeg === null) throw new Error("V-bit profile has no angle");
    return Math.tan(((profile.angleDeg / 2) * Math.PI) / 180);
  }
  if (profile.kind === "bull-nose") {
    if (profile.cornerRadiusMm === null) throw new Error("bull-nose profile has no corner radius");
    return profile.cornerRadiusMm;
  }
  return 0;
}

/** One workgroup per segment, 256 invocations striding over the
 * segment's footprint bbox. */
export const GPU_WORKGROUP_SIZE = 256;
/** Max workgroups per dispatch (the guaranteed
 * maxComputeWorkgroupsPerDimension). Segments are chunked into
 * dispatches of at most this many. */
export const GPU_MAX_DISPATCH = 65535;
/** Bytes per packed segment (16 x f32/u32 scalars, no padding). */
export const GPU_SEGMENT_BYTES = 64;

/** The compute shader. `segments` is the packed segment array
 * (packSegments); `heights` is the dexel grid as atomic<u32>
 * bit patterns of f32 heights; `params` carries the grid dims. */
export const GPU_SHADER_WGSL = /* wgsl */ `
struct Segment {
  p0x: f32, p0y: f32, p0z: f32,
  p1x: f32, p1y: f32, p1z: f32,
  radius: f32,
  profileKind: u32,
  profileParam: f32,
  i0: u32, i1: u32, j0: u32, j1: u32,
  pad0: u32, pad1: u32, pad2: u32,
};

struct Params {
  nx: u32,
  ny: u32,
  pitch: f32,
  x0: f32,
  y0: f32,
  topMm: f32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<storage, read_write> heights: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<uniform> params: Params;

const INF: f32 = 3.4028234663852886e+38;

// Envelope height h(r) above the tip at radius r (ts/tools.ts).
fn heightAt(kind: u32, param: f32, radius: f32, r: f32) -> f32 {
  if (kind == 0u) { return 0.0; } // flat
  if (kind == 1u) { // ball-nose: R - sqrt(R^2 - r^2)
    if (r <= 0.0) { return 0.0; }
    if (r >= radius) { return radius; }
    return radius - sqrt(radius * radius - r * r);
  }
  if (kind == 2u) { // V-bit: r / tan(theta/2)
    if (r <= 0.0) { return 0.0; }
    return r / param;
  }
  // bull-nose: flat to R - rc, then the torus fillet.
  let rc = param;
  let rFlat = radius - rc;
  if (r <= rFlat) { return 0.0; }
  if (r >= radius) { return rc; }
  let dr = r - rFlat;
  return rc - sqrt(rc * rc - dr * dr);
}

// The cut height for one column under one segment, or INF when the
// column is outside the tool. Mirrors sweepSegment in ts/sim.ts:
// the vertical-disc branch, the flat level fast path, and the
// general tool-interval + envelope-min path (flat: exact endpoint
// minimum; profiled: 16-iteration ternary search on the convex
// envelope).
fn segmentCut(seg: Segment, cx: f32, cy: f32) -> f32 {
  let dx = seg.p1x - seg.p0x;
  let dy = seg.p1y - seg.p0y;
  let dz = seg.p1z - seg.p0z;
  let dd = dx * dx + dy * dy;
  let R = seg.radius;
  let rSq = R * R;
  let ux = cx - seg.p0x;
  let uy = cy - seg.p0y;
  if (dd < 1e-18) {
    // Vertical (or stationary) move: one disc at the XY.
    let d2 = ux * ux + uy * uy;
    if (d2 > rSq) { return INF; }
    let zMin = min(seg.p0z, seg.p1z);
    if (seg.profileKind == 0u) { return zMin; }
    return zMin + heightAt(seg.profileKind, seg.profileParam, R, sqrt(d2));
  }
  if (seg.profileKind == 0u && dz == 0.0) {
    // Fast path: flat level segment — membership only, the cut is p0.z.
    var t = (ux * dx + uy * dy) / dd;
    t = clamp(t, 0.0, 1.0);
    let qx = ux - dx * t;
    let qy = uy - dy * t;
    if (qx * qx + qy * qy > rSq) { return INF; }
    return seg.p0z;
  }
  // General path: the t-interval where the column is under the tool.
  let s = ux * dx + uy * dy;
  let disc = s * s - dd * (ux * ux + uy * uy - rSq);
  var ta: f32;
  var tb: f32;
  if (disc < 0.0) {
    if (disc < -1e-9) { return INF; }
    let t = s / dd;
    if (t < 0.0 || t > 1.0) { return INF; }
    ta = t;
    tb = t;
  } else {
    let root = sqrt(max(0.0, disc));
    ta = max(0.0, (s - root) / dd);
    tb = min(1.0, (s + root) / dd);
    if (tb < ta) { return INF; }
  }
  if (seg.profileKind == 0u) {
    // Flat: the minimum is at one end of the interval.
    return min(seg.p0z + dz * ta, seg.p0z + dz * tb);
  }
  // Profiled: ternary search on the convex envelope (16 iterations).
  var lo = ta;
  var hi = tb;
  for (var k = 0; k < 16; k++) {
    let m1 = lo + (hi - lo) / 3.0;
    let m2 = hi - (hi - lo) / 3.0;
    let px1 = seg.p0x + dx * m1;
    let py1 = seg.p0y + dy * m1;
    let r1 = sqrt((cx - px1) * (cx - px1) + (cy - py1) * (cy - py1));
    let f1 = seg.p0z + dz * m1 + heightAt(seg.profileKind, seg.profileParam, R, r1);
    let px2 = seg.p0x + dx * m2;
    let py2 = seg.p0y + dy * m2;
    let r2 = sqrt((cx - px2) * (cx - px2) + (cy - py2) * (cy - py2));
    let f2 = seg.p0z + dz * m2 + heightAt(seg.profileKind, seg.profileParam, R, r2);
    if (f1 < f2) { hi = m2; } else { lo = m1; }
  }
  let tm = (lo + hi) / 2.0;
  let px = seg.p0x + dx * tm;
  let py = seg.p0y + dy * tm;
  let r = sqrt((cx - px) * (cx - px) + (cy - py) * (cy - py));
  return seg.p0z + dz * tm + heightAt(seg.profileKind, seg.profileParam, R, r);
}

@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let seg = segments[wg.x];
  // The packer skips segments above the stock top and segments
  // with an empty bbox; this guards the (unreachable) empty case.
  let bw = seg.i1 - seg.i0 + 1u;
  let bh = seg.j1 - seg.j0 + 1u;
  let count = bw * bh;
  if (count == 0u) { return; }
  for (var k = li; k < count; k += 256u) {
    let i = seg.i0 + (k % bw);
    let j = seg.j0 + (k / bw);
    let cx = params.x0 + (f32(i) + 0.5) * params.pitch;
    let cy = params.y0 + (f32(j) + 0.5) * params.pitch;
    let cut = segmentCut(seg, cx, cy);
    if (cut < INF) {
      // atomicMin on the bitcast<u32> of a non-negative f32 is a
      // min on the float: IEEE754 bit patterns preserve order
      // above zero. The clamp keeps a hypothetical negative cut
      // (a generator bug — the CPU would write it, the verifier
      // would catch it) from corrupting the ordering.
      let idx = j * params.nx + i;
      atomicMin(&heights[idx], bitcast<u32>(max(cut, 0.0)));
    }
  }
}
`;

// ---------------------------------------------------------------- packing (pure)
//
// Mirrors simulateRange's segment walk (ts/sim.ts): arcs are
// sampled from the true circle at the sagitta-bounded step, and a
// segment is packed only when it can cut (its lowest tip Z is
// below the stock top and its footprint bbox is non-empty) —
// exactly the CPU's skip rules, so the packed segment list and the
// CPU's swept segments agree. The bbox uses the same colOf rule
// as sweepSegment.

export type PackedSegments = {
  /** 64 bytes per segment (GPU_SEGMENT_BYTES). */
  bytes: Uint8Array;
  count: number;
};

export function packSegments(
  prep: PreparedSim,
  startMove: number,
  endMove: number,
): PackedSegments {
  const { grid, flat, tools } = prep;
  const pitch = grid.pitchMm;
  const out: number[] = [];
  const dv = new DataView(new ArrayBuffer(GPU_SEGMENT_BYTES));
  let count = 0;
  const colOf = (v: number, origin: number) => Math.floor((v - origin) / pitch - 0.5);
  const end = Math.max(startMove, Math.min(endMove, flat.moves.length));
  for (let mi = Math.max(0, startMove); mi < end; mi++) {
    const m: FlatMove = flat.moves[mi];
    const op = flat.operations[m.opIndex];
    const tool = tools.get(op.toolId);
    if (!tool) {
      throw new Error(`tool ${op.toolId} is used by the toolpaths but has no resolved profile`);
    }
    const stepDeg = m.t === "arc" && m.radius != null && m.radius > 0
      ? arcStepDeg(m.radius, pitch)
      : 2;
    const pts = sampleMove(m, stepDeg);
    const R = tool.radiusMm;
    const kind = gpuProfileKind(tool);
    const param = gpuProfileParam(tool);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p0 = pts[k], p1 = pts[k + 1];
      // Same skip as sweepSegment: the envelope's lowest point is
      // the tip Z on the centreline; at or above the stock top it
      // cannot cut anything (clearance rapids are ~free).
      if (Math.min(p0.z, p1.z) >= grid.topMm) continue;
      let i0 = colOf(Math.min(p0.x, p1.x) - R, grid.x0);
      let i1 = colOf(Math.max(p0.x, p1.x) + R, grid.x0);
      let j0 = colOf(Math.min(p0.y, p1.y) - R, grid.y0);
      let j1 = colOf(Math.max(p0.y, p1.y) + R, grid.y0);
      if (i1 < 0 || i0 >= grid.nx || j1 < 0 || j0 >= grid.ny) continue;
      i0 = Math.max(0, i0); i1 = Math.min(grid.nx - 1, i1);
      j0 = Math.max(0, j0); j1 = Math.min(grid.ny - 1, j1);
      dv.setFloat32(0, p0.x, true);
      dv.setFloat32(4, p0.y, true);
      dv.setFloat32(8, p0.z, true);
      dv.setFloat32(12, p1.x, true);
      dv.setFloat32(16, p1.y, true);
      dv.setFloat32(20, p1.z, true);
      dv.setFloat32(24, R, true);
      dv.setUint32(28, kind, true);
      dv.setFloat32(32, param, true);
      dv.setUint32(36, i0, true);
      dv.setUint32(40, i1, true);
      dv.setUint32(44, j0, true);
      dv.setUint32(48, j1, true);
      dv.setUint32(52, 0, true);
      dv.setUint32(56, 0, true);
      dv.setUint32(60, 0, true);
      for (let b = 0; b < GPU_SEGMENT_BYTES; b++) out.push(dv.getUint8(b));
      count++;
    }
  }
  return { bytes: new Uint8Array(out), count };
}

/** Decode one packed segment (tests + the probe's diagnostics). */
export function unpackSegment(bytes: Uint8Array, index: number): {
  p0: { x: number; y: number; z: number };
  p1: { x: number; y: number; z: number };
  radius: number; profileKind: number; profileParam: number;
  i0: number; i1: number; j0: number; j1: number;
} {
  const off = index * GPU_SEGMENT_BYTES;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + off, GPU_SEGMENT_BYTES);
  return {
    p0: { x: dv.getFloat32(0, true), y: dv.getFloat32(4, true), z: dv.getFloat32(8, true) },
    p1: { x: dv.getFloat32(12, true), y: dv.getFloat32(16, true), z: dv.getFloat32(20, true) },
    radius: dv.getFloat32(24, true),
    profileKind: dv.getUint32(28, true),
    profileParam: dv.getFloat32(32, true),
    i0: dv.getUint32(36, true),
    i1: dv.getUint32(40, true),
    j0: dv.getUint32(44, true),
    j1: dv.getUint32(48, true),
  };
}

// ---------------------------------------------------------------- comparison

export type GridComparison = {
  /** Columns whose heights differ at all (f32 equality). */
  mismatches: number;
  /** Largest absolute height difference (mm). */
  maxAbsDiffMm: number;
  /** Mean absolute difference over mismatching columns (mm). */
  meanAbsDiffMm: number;
};

/** Compare a GPU-produced heights array against a CPU-produced
 * one (same grid dims). The acceptance bar is the verification
 * tolerance (pitch + 0.05 mm); exact equality is reported, not
 * assumed (f32 vs f64 arithmetic — see the header). */
export function compareGrids(
  gpuHeights: Float32Array,
  cpuHeights: Float32Array,
): GridComparison {
  if (gpuHeights.length !== cpuHeights.length) {
    throw new Error(`grid size mismatch: GPU ${gpuHeights.length} columns vs CPU ${cpuHeights.length}`);
  }
  let mismatches = 0;
  let maxAbs = 0;
  let sumAbs = 0;
  for (let i = 0; i < gpuHeights.length; i++) {
    const d = Math.abs(gpuHeights[i] - cpuHeights[i]);
    if (gpuHeights[i] !== cpuHeights[i]) {
      mismatches++;
      if (d > maxAbs) maxAbs = d;
      sumAbs += d;
    }
  }
  return {
    mismatches,
    maxAbsDiffMm: maxAbs,
    meanAbsDiffMm: mismatches ? sumAbs / mismatches : 0,
  };
}

export type BandedGridComparison = {
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
};

/** Stage-2 bar: the largest mismatch cluster a rounding-fuzz
 * verdict tolerates. Mirrors ROUND_TRIP_MAX_CLUSTER in
 * ts/gcode_verify.ts — same rationale, same number. */
export const GPU_MAX_CLUSTER = 3;

/** Two-stage grid comparison — the verdict criterion for
 * CPU-vs-GPU equality. Stage 1 (band): a column differing by
 * more than the tolerance is only a genuine mismatch when its
 * height lies outside the OTHER grid's 3x3 neighbourhood height
 * range (plus tol), in both directions — a sub-column edge shift
 * (one column cut by one backend and grazed by the other) is
 * absorbed, because the neighbours carry the same height. Stage
 * 2 (clusters): 4-connected runs among the survivors; isolated
 * singles are rounding fuzz, a real missed feature clusters.
 *
 * This is the SAME criterion as the G-code round-trip
 * (ts/gcode_verify.ts `compareGrids`, docs-v3/gcode.md §7) —
 * kept in sync by hand, same stage order, same connectivity,
 * same bar. It exists because f32-vs-f64 equality is not
 * achievable at envelope grazes: on the container job the CPU
 * cuts a column the GPU leaves at the stock top when the column
 * centre sits ~2 nm inside the tool envelope in f64 and ~3.5 nm
 * outside it in f32 (the packed endpoints are f32-rounded) —
 * no f32 implementation can decide that column the same way, so
 * the verdict must not be raw max-abs-diff. The raw numbers
 * (compareGrids) stay visible as diagnostics alongside.
 *
 * The band test and the flood fill are O(columns); the 3x3 scan
 * is the same shape as the verifier's. */
export function compareGridsBanded(
  heightsA: Float32Array,
  heightsB: Float32Array,
  nx: number,
  ny: number,
  tol: number,
): BandedGridComparison {
  const n = nx * ny;
  if (heightsA.length !== n || heightsB.length !== n) {
    throw new Error(`grid size mismatch: A ${heightsA.length} / B ${heightsB.length} columns vs ${nx}x${ny} = ${n}`);
  }
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
    columns: n,
    rawMismatched,
    mismatched,
    clusters,
    maxCluster,
    maxDiffMm: Math.round(maxDiff * 1e6) / 1e6,
    toleranceMm: tol,
  };
}

// ---------------------------------------------------------------- dispatch (browser)

export type GpuSimResult = {
  /** Simmed heights (a copy — the caller owns it). */
  heights: Float32Array;
  /** Wall time incl. upload + dispatches + readback (ms). */
  ms: number;
  /** Cut time / wall time (the §5.4 ratio). */
  ratioVsPlan: number;
  /** Segments dispatched (after the CPU's skip rules). */
  segments: number;
  /** Compute dispatches issued (segments chunked at 65535). */
  dispatches: number;
  /** Adapter description for the report. */
  adapter: string;
};

/** Request a WebGPU device, or throw a named error explaining why
 * there is none. Never returns a fake device. */
export async function requestGpuDevice(): Promise<GPUDevice> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error("WebGPU is not available in this browser (navigator.gpu is absent) — the CPU backend is the fallback");
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU is present but requestAdapter() returned no adapter — the CPU backend is the fallback");
  }
  return adapter.requestDevice();
}

/** A human-readable adapter label for the report (vendor + device
 * + description when the browser exposes them). */
export function adapterLabel(device: GPUDevice): string {
  const info = device.adapterInfo as
    | { vendor?: string; device?: string; description?: string }
    | undefined;
  if (!info) return "unknown adapter";
  return [info.vendor, info.device, info.description]
    .filter((s) => typeof s === "string" && s)
    .join(" ") || "unknown adapter";
}

/** Simulate a prepared job on the GPU: pack the moves into
 * segments, dispatch them in chunks, read the heights back. The
 * grid starts at the stock top, exactly like the CPU backend's
 * createGrid. `onProgress(doneSegments, totalSegments)` is called
 * between dispatches (the caller yields to the page there). */
export async function simulateGpu(
  prep: PreparedSim,
  device?: GPUDevice,
  onProgress?: (done: number, total: number) => void,
): Promise<GpuSimResult> {
  const t0 = performance.now();
  const dev = device ?? (await requestGpuDevice());
  const { grid, flat } = prep;
  const packed = packSegments(prep, 0, flat.moves.length);
  const columns = grid.nx * grid.ny;
  const heightsBytes = columns * 4;
  // The heights buffer doubles as the shader's storage: the shader
  // reads/writes it as atomic<u32> bit patterns of f32 heights.
  const heightsBuf = dev.createBuffer({
    size: heightsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const initial = new Float32Array(columns);
  initial.fill(grid.topMm);
  dev.queue.writeBuffer(heightsBuf, 0, initial);
  const readBuf = dev.createBuffer({
    size: heightsBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const paramsBuf = dev.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const params = new DataView(new ArrayBuffer(32));
  params.setUint32(0, grid.nx, true);
  params.setUint32(4, grid.ny, true);
  params.setFloat32(8, grid.pitchMm, true);
  params.setFloat32(12, grid.x0, true);
  params.setFloat32(16, grid.y0, true);
  params.setFloat32(20, grid.topMm, true);
  dev.queue.writeBuffer(paramsBuf, 0, params.buffer);
  const module = dev.createShaderModule({ code: GPU_SHADER_WGSL });
  const pipeline = dev.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  // One segment buffer, reused across dispatches (max one chunk).
  // The buffer is rewritten per chunk, so each chunk gets its OWN
  // submit: queue order guarantees dispatch k sees chunk k's data
  // (a single submit after all the writeBuffers would let every
  // dispatch see the last chunk — the writes all land before any
  // dispatch executes).
  const segBufSize = GPU_MAX_DISPATCH * GPU_SEGMENT_BYTES;
  const segBuf = dev.createBuffer({
    size: segBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = dev.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: heightsBuf } },
      { binding: 1, resource: { buffer: segBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  });
  let dispatches = 0;
  let done = 0;
  while (done < packed.count) {
    const n = Math.min(GPU_MAX_DISPATCH, packed.count - done);
    dev.queue.writeBuffer(
      segBuf, 0,
      packed.bytes.subarray(done * GPU_SEGMENT_BYTES, (done + n) * GPU_SEGMENT_BYTES),
    );
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(n);
    pass.end();
    dev.queue.submit([encoder.finish()]);
    dispatches++;
    done += n;
    if (onProgress) {
      onProgress(done, packed.count);
      // Yield to the page between dispatches so the UI stays
      // responsive on big jobs (Kookabus is several dispatches).
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const copyEncoder = dev.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(heightsBuf, 0, readBuf, 0, heightsBytes);
  dev.queue.submit([copyEncoder.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const heights = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  heightsBuf.destroy();
  readBuf.destroy();
  paramsBuf.destroy();
  segBuf.destroy();
  const ms = performance.now() - t0;
  return {
    heights,
    ms,
    ratioVsPlan: ms > 0 ? flat.totalSeconds / (ms / 1000) : 0,
    segments: packed.count,
    dispatches,
    adapter: adapterLabel(dev),
  };
}

/** Convenience: prepare a job and simulate it on the GPU. The
 * caller owns the job object; geomBounds places the stock (the
 * DXF geometry bounds, when the caller has them). */
export async function simulateJobGpu(
  job: Record<string, unknown>,
  geomBounds?: { x_min: number; x_max: number; y_min: number; y_max: number } | null,
  device?: GPUDevice,
  onProgress?: (done: number, total: number) => void,
): Promise<GpuSimResult> {
  const prep = prepareSim(job, geomBounds);
  return simulateGpu(prep, device, onProgress);
}
