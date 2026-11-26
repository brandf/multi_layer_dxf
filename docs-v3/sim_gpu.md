# V3.5 — WebGPU cut-sim backend (docs-v3/sim_gpu.md)

A second backend for the dexel sim (`ts/sim.ts` is the CPU
backend): the same dexel grid as a WebGPU storage buffer, one
compute workgroup per swept segment. The point is speed — an
hour-long carve playable in seconds (V3_SCOPE.md §5.4) — and the
contract is that the two backends produce the same stock.

## Design (`ts/sim_gpu.ts`)

- **Same buffer layout as the CPU backend**: the dexel grid is
  one Float32Array, row-major (`idx = j * nx + i`), same nx/ny/
  pitch/origin. The GPU heights buffer is initialised to the stock
  top, exactly like `createGrid`.
- **One workgroup per segment** (`@workgroup_size(256)`,
  invocations stride over the segment's footprint bbox).
  Segments are chunked into dispatches of at most 65,535
  (`maxComputeWorkgroupsPerDimension`); one reusable segment
  buffer, rewritten per chunk, each chunk its OWN submit — queue
  order guarantees dispatch k sees chunk k's data (a single
  submit after all the `writeBuffer`s would let every dispatch
  see the last chunk's segments).
- **Packing** (`packSegments`, pure, testable in Bun): walks
  exactly the segments `simulateRange` sweeps — same `sampleMove`
  (same `arcStepDeg`), same skip rules (lowest tip Z at/above
  the stock top; empty bbox), same `colOf` bbox rule, clamped to
  the grid. A segment is 16 scalars × 4 B = 64 B (p0/p1 xyz,
  radius, profile kind u32, profile param f32, bbox i0/i1/j0/j1,
  3 pad u32). Profile kinds: 0 flat, 1 ball-nose, 2 V-bit
  (param tan(θ/2)), 3 bull-nose (param corner radius).
  `unpackSegment` decodes one for tests/diagnostics.
- **Shader** (`GPU_SHADER_WGSL`): `segmentCut` mirrors
  `sweepSegment` branch-for-branch — vertical disc, flat level
  fast path, general tool-interval + envelope-min (flat: exact
  endpoint minimum; profiled: 16-iteration ternary search);
  `heightAt` mirrors `ts/tools.ts` exactly (including the
  clamps: ball-nose `r >= R → R`, bull-nose fillet).
- **Column writes are `atomicMin` on `bitcast<u32>`** of the cut
  height. IEEE754 bit patterns of non-negative floats sort the
  same as the floats, so the atomic min is a float min — and min
  is commutative, so workgroup execution order cannot change the
  result. Heights are job Z ≥ 0 by construction; the shader
  clamps the operand at `max(cut, 0.0)` so a hypothetical
  negative cut reads as 0.0 and never corrupts the ordering.
  (Tested: the bitcast-order property is asserted in
  `ts/sim_gpu.test.ts`.)
- **Availability**: `isWebGpuAvailable()` checks `navigator.gpu`;
  `requestGpuDevice()` throws a named error when there is none —
  never a fake device. If WebGPU is absent the CPU backend is the
  fallback and the UI says so (the view's sim status names the
  backend; the GPU path there still builds the CPU seek data in
  the background, because the GPU backend has no delta log — its
  writes are fire-and-forget `atomicMin`, not a recorded log).
  Since 2026-11-24 the view also falls back when `navigator.gpu`
  exists but the GPU path THROWS (e.g. `requestAdapter()` returns
  null): `runSim()` catches the GPU-path failure and runs the CPU
  backend, with the status "Simulated on CPU — WebGPU
  unavailable: \<reason\> · seek ready (...)" — the sim is dead
  only when the CPU path itself fails (docs-v3/sim.md, V3.5).
- **TS note**: this repo's TS DOM lib declares the WebGPU
  interfaces but NOT the `GPUBufferUsage` / `GPUMapMode` value
  namespaces — the module declares minimal `declare const`
  versions (type-only, erased; the real browser globals exist at
  runtime).

## WebGPU availability — CORRECTED finding

The wave's first probe concluded WebGPU cannot run on this VM
(`navigator.gpu` absent under 8 flag sets). That conclusion was
wrong: the probe driver launches headless Chromium with
`--enable-unsafe-webgpu --use-angle=swiftshader` and under those
flags `navigator.gpu` IS present (adapter "google",
Dawn/SwiftShader) and compute dispatches RUN — the probe has run
the full container sim in-browser three times. The earlier probe
checked `navigator.gpu` under different launch conditions; the
driver's exact flags are what works. (The first two probe-driver
failures were harness bugs, not WebGPU absence: the test proxy
had no route for the probe page, and the probe page loaded its
bundle from `<head>` before `#probe-output` existed.)

## Measured numbers (container job, 220 moves, 3182 segments)

| run | CPU | GPU (SwiftShader) |
|---|---|---|
| 2026-11-24 #1 | 2186 ms, 101× | 32596 ms, 7× |
| 2026-11-24 #2 | 1712 ms, 129× | 17269 ms, 13× |
| 2026-11-24 #3 | 1378 ms, 161× | 23390 ms, 9× |

SwiftShader is a SOFTWARE renderer, so 7–13× is a
software-renderer number, not a GPU result — the ≥500× target
cannot be assessed here and still needs a real GPU (Brandon's
Windows laptop; the probe is ready to run there — see below).
The CPU numbers (101–161×) are the same engine the V3.4 spike
measured (221× on this job in Bun; the in-browser number runs
under the probe harness's load).

## CPU/GPU equality — what the probe found

Raw exact comparison on the container job (5,400,000 columns):

- **120,496 columns differ at all** (2.2%), max abs diff
  8.4704 mm, mean abs diff 0.000084 mm, tolerance 0.100 mm
  (pitch + 0.05).
- **120,493 of them differ by < 0.01 mm** — f32-vs-f64 ulp
  noise on ramp/helix surfaces. The level fast path writes the
  exact endpoint Z in both backends, so level cuts agree
  bit-for-bit; the general path computes heights (endpoint
  interpolation, ternary search) and f32 vs f64 arithmetic lands
  a few ulps apart. Expected, far below tolerance, not a defect.
- **3 columns differ by more than 0.01 mm** — isolated
  boundary-graze flips, all in the same direction (GPU leaves
  the column at the stock top 9.5, CPU cuts it):

  | column | cpu | gpu | diff |
  |---|---|---|---|
  | i=2591 j=905 (129.575, 45.275) | 1.029615 | 9.5 | 8.470385 |
  | i=1156 j=815 (57.825, 40.775) | 8.036112 | 9.5 | 1.463888 |
  | i=1156 j=904 (57.825, 45.225) | 9.463864 | 9.5 | 0.036136 |

  Diagnosis (spike `v35-spike/gpu_outlier.ts`, which replays the
  segment walk and computes each covering segment's cut three
  ways — f64 math + f64 endpoints, f64 math + f32-packed
  endpoints, f32 emulation of the shader): the shader math
  agrees with f64 math on the packed endpoints in every case —
  **the flip is the f32 rounding of the segment endpoints at
  pack time**. Measured on the worst column (helical arc move
  202, sub-segment 99): the column centre sits **2.1 nm inside**
  the tool envelope in f64 (disc +3.5e-5) and **3.5 nm outside**
  it in f32 (disc −5.7e-5). The endpoints are f32-rounded to
  ~1.5e-5 mm per coordinate, which moves the envelope across a
  column that sits essentially exactly on it. **No f32
  implementation can decide that column the same way as f64** —
  the information is not in the packed segment. It is inherent
  to the f32 backend, not a shader bug: the shader, the packer,
  the interval math, and the profile mapping were all checked
  against the CPU and agree; only the endpoint precision differs.

## Verdict criterion — band + cluster (not raw max diff)

Because a raw max-abs-diff verdict fails on nanometre grazes,
the probe's verdict uses the SAME two-stage criterion as the
G-code round-trip (`ts/gcode_verify.ts` `compareGrids`,
docs-v3/gcode.md §7) — `compareGridsBanded` in `ts/sim_gpu.ts`,
kept in sync by hand (same stage order, same 4-connectivity,
same bar of 3):

- **Stage 1 (band)**: a column differing by more than the
  tolerance is a genuine mismatch only when its height lies
  outside the OTHER grid's 3×3 neighbourhood height range
  (± tol), in both directions. A graze flip's height is carried
  by the neighbours, so it is absorbed; a real missed feature
  (a pocket the GPU never cut) has no neighbour carrying its
  height and survives.
- **Stage 2 (clusters)**: 4-connected runs among the survivors;
  the bar is a largest cluster of 3. Isolated singles are
  rounding fuzz (observed largest fuzz cluster 1); a 0.06 mm
  path shift already clusters 22 (the G-code calibration).

On the container job the banded result is: raw mismatched 2
(the 8.47 mm and 1.46 mm outliers — the 0.036 mm one is within
the 0.100 mm tolerance and never reaches the band test),
after-band 0, clusters 0, maxCluster 0 → **PASS**. The raw exact
stats stay visible in the probe output as diagnostics alongside.

## Running the probe

```sh
bun server/run-webgpu-sim-probe.ts   # exit 0 PASS or UNAVAILABLE, 1 FAIL
```

It builds `server/webgpu-sim-probe-entry.ts` into
`server/public/vendor/webgpu-sim-probe.js`, plans + generates
toolpaths for the real container in a scratch home, serves the
probe page through `server/test-e2e-proxy.ts` (which has a route
for `/webgpu-sim-probe.html`), and drives headless Chromium
(Playwright binary, `--enable-unsafe-webgpu
--use-angle=swiftshader`, remote-debugging CDP) with a 120 s
bound. Verdicts: UNAVAILABLE (no `navigator.gpu` — CPU
fallback, not a failure), PASS (banded criterion met), FAIL
(genuine cluster > 3, or a step threw). On Brandon's Windows
laptop the same driver measures the real GPU ratio against the
≥500× target — SwiftShader's 7–13× here says nothing about
that. **Do not present a SwiftShader number as a GPU result.**

## Where it lives

- `ts/sim_gpu.ts` — shader, packing, dispatch, comparison
  (`compareGrids` exact diagnostics, `compareGridsBanded`
  verdict, `GPU_MAX_CLUSTER`).
- `ts/sim_gpu.test.ts` — 16 tests: profile mapping, pack/unpack
  round-trip, skip rules, arc packing, sub-range packing, shader
  source + bitcast-order properties, `compareGrids`, banded
  verdict cases (absorbed graze flip, surviving single, 2×2
  block, separated singles, size mismatch), Bun has no WebGPU,
  real-container packing.
- `server/webgpu-sim-probe-entry.ts` / `webgpu-sim-probe.html` /
  `run-webgpu-sim-probe.ts` — the probe (test-only; the proxy
  route is in `server/test-e2e-proxy.ts`).
- `~/workspace/v35-spike/gpu_outlier.ts` — outlier diagnosis
  (segment-walk replay + three-way cut comparison);
  `gpu_margin.ts` — the nanometre-margin measurement for move
  202 sub-segment 99.
