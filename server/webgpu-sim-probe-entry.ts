// WebGPU sim probe entry (test-only, V3.5).
//
// Bundled by server/run-webgpu-sim-probe.ts into
// server/public/vendor/webgpu-sim-probe.js (a build artifact, never
// checked in — see .gitignore) and loaded by
// server/webgpu-sim-probe.html. It runs the CPU backend and the GPU
// backend on the same job in the same browser and compares the
// simmed stock, and measures both backends' x-real-time ratios.
//
// Verdicts (written to #probe-output + document.title):
//   UNAVAILABLE — no WebGPU in this browser (navigator.gpu absent
//     or no adapter). NOT a failure: the measurement is deferred to
//     a machine with WebGPU, and the CPU backend is the fallback.
//     The driver exits 0 on this verdict.
//   PASS — GPU ran and the grids agree under the band+cluster
//     criterion (compareGridsBanded in ts/sim_gpu.ts — the same
//     two-stage criterion as the G-code round-trip): no genuine
//     mismatch survives the 3x3 band test, or the largest
//     surviving cluster is <= 3 (isolated graze flips). The raw
//     exact-equality stats are reported alongside as diagnostics.
//   FAIL — a genuine mismatch survives (largest cluster > 3), or
//     a step threw. The driver exits 1.
import { prepareSim, simulateAll } from "../ts/sim.ts";
import type { GeomBounds } from "../ts/sim.ts";
import {
  isWebGpuAvailable, simulateGpu, compareGrids, compareGridsBanded,
  GPU_MAX_CLUSTER,
} from "../ts/sim_gpu.ts";

const out: string[] = [];
const el = document.getElementById("probe-output")!;
function line(s: string): void {
  out.push(s);
  el.textContent = out.join("\n");
}
function finish(verdict: string): void {
  line("VERDICT: " + verdict);
  const fails = out.filter((l) => l.startsWith("FAIL ")).length;
  const passes = out.filter((l) => l.startsWith("PASS ")).length;
  document.title = "WEBGPU DONE: " + verdict + " (" + passes + " pass, " + fails + " fail)";
}

async function main(): Promise<void> {
  const jobId = new URLSearchParams(location.search).get("job");
  if (!jobId) {
    line("FAIL job param present :: no ?job=");
    finish("FAIL");
    return;
  }
  let job: Record<string, unknown>;
  let bounds: GeomBounds | null = null;
  try {
    const r = await fetch("/api/jobs/" + encodeURIComponent(jobId));
    const body = await r.json();
    job = body.job;
    if (!job || !job.toolpaths) throw new Error("job has no toolpaths");
    const g = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/geometry");
    const gb = await g.json();
    if (gb && gb.bounds) bounds = gb.bounds as GeomBounds;
  } catch (e) {
    line("FAIL job fetch :: " + (e instanceof Error ? e.message : String(e)));
    finish("FAIL");
    return;
  }
  const moves = (job.toolpaths as { stats: { moves: number } }).stats.moves;
  line("job: " + jobId + " moves=" + moves);

  // CPU backend (always available).
  const prep = prepareSim(job, bounds);
  const tCpu0 = performance.now();
  simulateAll(prep);
  const cpuMs = performance.now() - tCpu0;
  const cpuHeights = prep.grid.heights.slice();
  const cpuRatio = prep.flat.totalSeconds / (cpuMs / 1000);
  line(
    "CPU: " + cpuMs.toFixed(0) + " ms, " + cpuRatio.toFixed(0) +
    "x real time (" + prep.flat.totalSeconds.toFixed(1) + " s cut time)",
  );

  if (!isWebGpuAvailable()) {
    line("WebGPU: navigator.gpu is absent in this browser — CPU fallback, honestly labelled");
    line("PASS CPU backend ran (GPU measurement deferred to a machine with WebGPU)");
    finish("UNAVAILABLE");
    return;
  }
  line("WebGPU: navigator.gpu present");
  try {
    const gpu = await simulateGpu(prep);
    const cmp = compareGrids(gpu.heights, cpuHeights);
    const tol = prep.pitch.pitch_mm + 0.05;
    line(
      "GPU: " + gpu.ms.toFixed(0) + " ms, " + gpu.ratioVsPlan.toFixed(0) +
      "x real time, " + gpu.segments + " segments, " + gpu.dispatches +
      " dispatches, adapter: " + gpu.adapter,
    );
    line(
      "compare: mismatches=" + cmp.mismatches + " / " + cpuHeights.length +
      " columns, max abs diff=" + cmp.maxAbsDiffMm.toFixed(4) +
      " mm, mean abs diff=" + cmp.meanAbsDiffMm.toFixed(6) +
      " mm, tolerance=" + tol.toFixed(3) + " mm",
    );
    // Mismatch localisation (debug aid — where the backends
    // disagree, and in which direction): bounding box in grid
    // columns and mm, deeper-vs-shallower counts, a diff-size
    // histogram, and the first samples.
    {
      const nx = prep.grid.nx;
      let bi0 = Infinity, bi1 = -Infinity, bj0 = Infinity, bj1 = -Infinity;
      let deeper = 0, shallower = 0;
      const buckets = [0, 0, 0, 0, 0]; // <0.01, <0.1, <1, <5, >=5 mm
      const samples: string[] = [];
      for (let idx = 0; idx < cpuHeights.length; idx++) {
        const c = cpuHeights[idx], g = gpu.heights[idx];
        if (c === g) continue;
        const d = Math.abs(g - c);
        const i = idx % nx, j = (idx / nx) | 0;
        if (i < bi0) bi0 = i;
        if (i > bi1) bi1 = i;
        if (j < bj0) bj0 = j;
        if (j > bj1) bj1 = j;
        if (g < c) deeper++; else shallower++;
        buckets[d < 0.01 ? 0 : d < 0.1 ? 1 : d < 1 ? 2 : d < 5 ? 3 : 4]++;
        if (samples.length < 10) {
          samples.push(
            "i=" + i + " j=" + j +
            " x=" + (prep.grid.x0 + (i + 0.5) * prep.grid.pitchMm).toFixed(2) +
            " y=" + (prep.grid.y0 + (j + 0.5) * prep.grid.pitchMm).toFixed(2) +
            " cpu=" + c.toFixed(3) + " gpu=" + g.toFixed(3),
          );
        }
      }
      line(
        "mismatch bbox: i=[" + bi0 + "," + bi1 + "] j=[" + bj0 + "," + bj1 + "]" +
        " x=[" + (prep.grid.x0 + (bi0 + 0.5) * prep.grid.pitchMm).toFixed(1) +
        "," + (prep.grid.x0 + (bi1 + 0.5) * prep.grid.pitchMm).toFixed(1) + "]" +
        " y=[" + (prep.grid.y0 + (bj0 + 0.5) * prep.grid.pitchMm).toFixed(1) +
        "," + (prep.grid.y0 + (bj1 + 0.5) * prep.grid.pitchMm).toFixed(1) + "] mm",
      );
      line("mismatch direction: gpu-deeper=" + deeper + " gpu-shallower=" + shallower);
      line("mismatch |diff| buckets mm: <0.01=" + buckets[0] + " <0.1=" + buckets[1] + " <1=" + buckets[2] + " <5=" + buckets[3] + " >=5=" + buckets[4]);
      for (const s of samples) line("mismatch sample: " + s);
      // Outliers: the columns that actually matter. The <0.01 mm
      // mass is f32-vs-f64 ulp noise on ramp/helix surfaces (the
      // general path computes heights; the level fast path writes
      // exact endpoint Z in both backends) — far below tolerance
      // and expected. A column differing by millimetres is a
      // membership flip (a boundary column cut by one backend
      // and not the other) and is the real defect to chase.
      // Printed at full precision, largest first.
      const outliers: { i: number; j: number; c: number; g: number; d: number }[] = [];
      for (let idx = 0; idx < cpuHeights.length; idx++) {
        const c = cpuHeights[idx], g = gpu.heights[idx];
        const d = Math.abs(g - c);
        if (d >= 0.01) {
          const nx2 = prep.grid.nx;
          outliers.push({ i: idx % nx2, j: (idx / nx2) | 0, c, g, d });
        }
      }
      outliers.sort((a, b) => b.d - a.d);
      line("outliers (|diff| >= 0.01 mm): " + outliers.length);
      for (const o of outliers) {
        line(
          "outlier: i=" + o.i + " j=" + o.j +
          " x=" + (prep.grid.x0 + (o.i + 0.5) * prep.grid.pitchMm).toFixed(4) +
          " y=" + (prep.grid.y0 + (o.j + 0.5) * prep.grid.pitchMm).toFixed(4) +
          " cpu=" + o.c.toFixed(6) + " gpu=" + o.g.toFixed(6) +
          " diff=" + (o.g - o.c).toFixed(6),
        );
      }
    }
    if (cmp.mismatches === 0) {
      line("PASS CPU and GPU backends produce bit-identical stock");
    } else {
      line("INFO CPU/GPU stock differs on " + cmp.mismatches + " columns — mostly f32-vs-f64 ulp noise on ramp/helix surfaces (see the banded verdict below for the genuine-mismatch count)");
    }
    // Verdict: the band+cluster criterion, not raw max-abs-diff.
    // A raw max diff of millimetres on one column is a boundary
    // graze (the column centre sits nanometres from the tool
    // envelope in f64 and the f32-rounded endpoints put it on the
    // other side) — the band test absorbs it when the neighbours
    // carry the same height, and the cluster bar catches a real
    // missed feature, which would cluster.
    const banded = compareGridsBanded(
      gpu.heights, cpuHeights, prep.grid.nx, prep.grid.ny, tol,
    );
    line(
      "banded: raw mismatched=" + banded.rawMismatched +
      " after-band=" + banded.mismatched +
      " clusters=" + banded.clusters +
      " maxCluster=" + banded.maxCluster +
      " maxDiff=" + banded.maxDiffMm.toFixed(4) + " mm" +
      " (bar: maxCluster <= " + GPU_MAX_CLUSTER + ")",
    );
    if (banded.mismatched === 0) {
      line("PASS CPU/GPU stock agrees under the band+cluster criterion (no genuine mismatches)");
    } else if (banded.maxCluster <= GPU_MAX_CLUSTER) {
      line("PASS CPU/GPU stock agrees under the band+cluster criterion (only isolated graze flips, largest cluster " + banded.maxCluster + " <= " + GPU_MAX_CLUSTER + ")");
    } else {
      line("FAIL CPU/GPU stock has a genuine mismatch cluster of " + banded.maxCluster + " columns (bar " + GPU_MAX_CLUSTER + ")");
    }
    if (gpu.ratioVsPlan >= 500) {
      line("PASS GPU >= 500x real time (" + gpu.ratioVsPlan.toFixed(0) + "x)");
    } else {
      line("INFO GPU " + gpu.ratioVsPlan.toFixed(0) + "x real time — below the 500x target (spike target, to confirm or revise)");
    }
    finish(banded.maxCluster <= GPU_MAX_CLUSTER ? "PASS" : "FAIL");
  } catch (e) {
    line("FAIL GPU sim threw :: " + (e instanceof Error ? e.message : String(e)));
    finish("FAIL");
  }
}

void main();
