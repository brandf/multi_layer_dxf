#!/usr/bin/env bun
// V3.3 layer geometry for the 3D view (Bun-runnable).
//
// Reads ONLY job-dir files: job.json (layers with part /
// start_depth / cut_depth / floor_z, parts with z_top) and the
// job's root DXF (layer outlines). It NEVER touches Python
// internals, the classifier, or the planner. It prints exactly
// one JSON object on stdout (progress on stderr) and writes
// nothing: the Python CLI (`mldxf geometry`) is the shell over
// it, and the API reaches it 1:1 as GET /api/jobs/:id/geometry.
//
//   bun ts/geometry.ts <job-dir> [--json]
//   -> {"ok": true, "job_id": ..., "dxf": ..., "layers": [...], "bounds": {...}}
//   -> {"ok": false, "error": "<named>", "message": "..."} (exit 1/2)
//
// One entry per job.json layer, in job order. Each entry carries
// the DXF loops of that layer as sampled points (arcs sampled at
// 5 deg from the true circle — the plane is a line rendering of
// the DXF outline, so sampling is exact enough; the TOOLPATH arcs
// are the ones that must stay first-class, and they do — they
// never pass through here) plus the plane's Z depths, derived
// from the job (V3_SCOPE.md §4.3: one plane per DXF layer, at
// that layer's Z depth):
//   z_top_mm    = part z_top - start_depth   (the cut's top)
//   z_bottom_mm = floor_z when the job records one, else
//                 z_top_mm - cut_depth
// Single-part jobs (parts: null, top-level z_top, layers with no
// `part` field) normalise to one implicit part, exactly as the
// V3.1 generator does (ts/toolpaths.ts).
//
// The loader is also importable: `loadJobGeometry(jobDir)` returns
// the same layers with their assembled Loop objects (not just
// sampled points), for the V3.4 headless verifier (ts/sim_verify.ts),
// which rasterises the loops against the simmed stock. The CLI
// entry point runs only under `import.meta.main`, so importing
// this module never runs the CLI.
//
// Named errors mirror the generator's: job_not_found (no job dir
// / no job.json), geometry_unavailable (a v1 job — geometry needs
// the V2.2 job model), dxf_not_found / dxf_ambiguous (the root-DXF
// discovery rule is the generator's: prefer <job-dir>.dxf, else
// the single .dxf), layer_missing_in_dxf (a job layer with no
// entities in the DXF — a real defect, never an empty plane).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import {
  parseDxf, entitiesToSegs, parseLwpl, repairArcsInLayer, assemble,
  loopPoints, areaOf,
} from "./offset.ts";
import type { Seg, Loop } from "./offset.ts";

// Round to 0.001 mm for deterministic output; normalise -0 to 0.
const r3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

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
function isNamed(e: unknown): e is NamedError {
  return e instanceof NamedError;
}
function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail("job_invalid", `job.json: ${name} is not a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

export type JobLayerGeometry = {
  layer: string;
  operation: string | null;
  part: string | null;
  z_top_mm: number;
  z_bottom_mm: number;
  /** Assembled DXF loops (arcs as true arcs — sample with
   * loopPoints() from ./offset.ts; the verifier rasterises them). */
  loops: Loop[];
};

export type LoadedJobGeometry = {
  job: Record<string, unknown>;
  job_id: string;
  dxf: string;
  layers: JobLayerGeometry[];
  bounds: {
    x_min: number; x_max: number; y_min: number; y_max: number;
    z_min: number; z_max: number;
  };
};

/** Load a job's layer geometry from its job dir (job.json + root
 * DXF). Throws a NamedError (`.code`) on any failure — the CLI
 * maps it to its one-JSON-object output; library callers (the
 * V3.4 verifier) catch it the same way. */
export function loadJobGeometry(jobDir: string): LoadedJobGeometry {
  if (!existsSync(jobDir)) {
    fail("job_not_found", `job dir not found: ${jobDir}`);
  }
  const jobText = (() => {
    try { return readFileSync(join(jobDir, "job.json"), "utf-8"); }
    catch {
      // A v1 job (manifest.json only) is a named refusal, not a
      // missing job — geometry needs the V2.2 job model, exactly
      // as toolpaths does (toolpaths_unavailable there).
      if (existsSync(join(jobDir, "manifest.json"))) {
        fail("geometry_unavailable", `${jobDir} is a v1 job — layer geometry needs the V2.2 job model (job.json). Re-run \`mldxf plan\` on the source STEP instead`);
      }
      fail("job_not_found", `no job.json in ${jobDir} — not a v2 job dir`);
    }
  })();
  let job: Record<string, unknown>;
  try {
    job = JSON.parse(jobText) as Record<string, unknown>;
  } catch {
    fail("job_invalid", `${jobDir}/job.json is not valid JSON`);
  }
  if (num(job.job_version, "job_version") < 2) {
    fail("geometry_unavailable", `${jobDir} is a v1 job — layer geometry needs the V2.2 job model (job.json). Re-run \`mldxf plan\` on the source STEP instead`);
  }
  const layers = job.layers as Record<string, unknown>[];
  if (!Array.isArray(layers)) fail("job_invalid", "job.json: layers is not an array");
  // Multi-part jobs carry a parts list; single-part jobs have
  // parts: null and a top-level z_top — same normalisation as
  // the V3.1 generator.
  const rawParts = job.parts as Record<string, unknown>[] | null | undefined;
  const parts: { name: string; z_top: number }[] = (Array.isArray(rawParts) && rawParts.length)
    ? rawParts.map((p) => ({ name: String(p.name), z_top: num(p.z_top, `parts[].z_top`) }))
    : [{ name: "__single__", z_top: num(job.z_top, "z_top (single-part job)") }];
  const partByName = new Map(parts.map((p) => [p.name, p]));
  // The job's root DXF: prefer the file named after the job dir.
  const rootFiles = readdirSync(jobDir).filter((f: string) => f.toLowerCase().endsWith(".dxf"));
  const dxfName = rootFiles.find((f: string) => f === `${basename(jobDir)}.dxf`) ?? (rootFiles.length === 1 ? rootFiles[0] : undefined);
  if (!dxfName) {
    if (!rootFiles.length) fail("dxf_not_found", `no .dxf file in ${jobDir}`);
    fail("dxf_ambiguous", `multiple .dxf files in ${jobDir}: ${rootFiles.join(", ")}`);
  }
  const dxfText = readFileSync(join(jobDir, dxfName), "utf-8");
  const ents = parseDxf(dxfText);
  const byLayer = entitiesToSegs(ents);
  for (const l of parseLwpl(dxfText)) {
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < l.pts.length; i++) segs.push({ kind: "line", p1: l.pts[i], p2: l.pts[i + 1] });
    if (l.closed && l.pts.length > 2) segs.push({ kind: "line", p1: l.pts[l.pts.length - 1], p2: l.pts[0] });
    if (!byLayer.has(l.layer)) byLayer.set(l.layer, []);
    byLayer.get(l.layer)!.push(...segs);
  }
  // Assemble loops per layer (with the classifier arc-span
  // repair — the same repair the generator applies, so the
  // planes show the same outlines the toolpaths were cut from).
  const loopsByLayer = new Map<string, Loop[]>();
  for (const [name, segs] of byLayer) {
    repairArcsInLayer(segs);
    loopsByLayer.set(name, assemble(segs));
  }
  const outLayers: JobLayerGeometry[] = [];
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  for (const jl of layers) {
    const name = String(jl.layer);
    const part = (jl.part ? partByName.get(String(jl.part)) : parts[0]) ?? parts[0];
    if (jl.part && !partByName.has(String(jl.part))) {
      fail("part_missing", `layer ${name} names part ${jl.part}, not in job.json parts`);
    }
    const startDepth = num(jl.start_depth, `${name}.start_depth`);
    const cutDepth = num(jl.cut_depth, `${name}.cut_depth`);
    const zTop = r3(part.z_top - startDepth);
    const floorZ = typeof jl.floor_z === "number" && Number.isFinite(jl.floor_z)
      ? r3(jl.floor_z as number)
      : r3(zTop - cutDepth);
    const loops = loopsByLayer.get(name);
    if (!loops) fail("layer_missing_in_dxf", `job layer ${name} has no entities in ${dxfName}`);
    for (const loop of loops) {
      for (const p of loopPoints(loop)) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }
    if (zTop > zMax) zMax = zTop;
    if (floorZ < zMin) zMin = floorZ;
    outLayers.push({
      layer: name,
      operation: typeof jl.operation === "string" ? jl.operation : null,
      part: (jl.part ? String(jl.part) : null),
      z_top_mm: zTop,
      z_bottom_mm: floorZ,
      loops,
    });
  }
  return {
    job,
    job_id: typeof job.job_id === "string" ? job.job_id : basename(jobDir),
    dxf: dxfName,
    layers: outLayers,
    bounds: {
      x_min: r3(xMin), x_max: r3(xMax), y_min: r3(yMin), y_max: r3(yMax),
      z_min: r3(zMin), z_max: r3(zMax),
    },
  };
}

// ---------------------------------------------------------------- main
function main(): void {
  const argv = process.argv.slice(2);
  const jobDirArg = argv.find((a: string) => !a.startsWith("-"));
  if (!jobDirArg) {
    console.log(JSON.stringify({ ok: false, error: "usage_error", message: "usage: bun ts/geometry.ts <job-dir>" }));
    process.exit(1);
  }
  try {
    const loaded = loadJobGeometry(jobDirArg);
    const outLayers = loaded.layers.map((l) => ({
      layer: l.layer,
      operation: l.operation,
      part: l.part,
      z_top_mm: l.z_top_mm,
      z_bottom_mm: l.z_bottom_mm,
      loops: l.loops.map((loop) => {
        const pts = loopPoints(loop);
        const points = pts.map((p) => [r3(p.x), r3(p.y)]);
        return { closed: loop.closed, points, area_mm2: r3(Math.abs(areaOf(pts))) };
      }),
      loop_count: l.loops.length,
    }));
    console.log(JSON.stringify({
      ok: true,
      job_id: loaded.job_id,
      dxf: loaded.dxf,
      layers: outLayers,
      bounds: loaded.bounds,
    }));
  } catch (e) {
    if (isNamed(e)) {
      console.log(JSON.stringify({ ok: false, error: e.code, message: e.message }));
      process.exit(1);
    }
    const err = e as Error;
    console.log(JSON.stringify({ ok: false, error: "internal_error", message: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` }));
    process.exit(2);
  }
}

if (import.meta.main) main();
