#!/usr/bin/env bun
// V3.14 headless cut-time tool — the duration model, usable without
// a browser.
//
// Reads a v3 job's toolpaths section and prints its motion time:
// the sum of every move's duration under the model in
// ts/view3d/model.ts (feed at the operation's feed_mm_s, Z-only
// feed at plunge_mm_s, arcs by true length, rapids at 50 mm/s).
// This is the same model the 3D view's playback timeline uses, so
// the number here, the number the generator records in the section,
// and the number the view shows are one number, not three.
//
//   bun ts/cuttime.ts <job-dir> [--json] [--per-layer]
//   -> {"ok": true, "motion_time_s": 222.3,
//       "motion_by_tool": {"EM3.17": 98.4, ...},
//       "motion_by_operation": {"pocket": 150.2, ...},
//       "moves": 220, "operations": 14}            (exit 0)
//   -> {"ok": false, "error": "<named>", "message": "..."} (exit 1)
//
// With --per-layer the output also carries `per_layer`: one entry
// per layer with the motion seconds and the move counts — the data
// the calibration in docs-v3/cuttime_feedback.md fits against.
// Prints exactly one JSON object on stdout (progress on stderr);
// it never writes the job. `mldxf toolpaths` (V3.14) records the
// same numbers in the section it generates, so a fresh v3 job
// already carries them and this tool is the check, not the source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flattenToolpaths, summarizeMotion } from "./view3d/model.ts";
import type { ToolpathsIn } from "./view3d/model.ts";

// Round to 0.1 s — the same precision the plan's per-layer seconds
// carry, and the precision the acceptance §6.1 table is quoted at.
const r1 = (n: number) => Math.round(n * 10) / 10;
const r1map = (r: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of Object.keys(r).sort()) out[k] = r1(r[k]);
  return out;
};

function fail(code: string, message: string): never {
  console.log(JSON.stringify({ ok: false, error: code, message }));
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const jobDir = argv.find((a) => !a.startsWith("-"));
  if (!jobDir) fail("usage_error", "usage: bun ts/cuttime.ts <job-dir> [--json] [--per-layer]");
  const perLayer = argv.includes("--per-layer");
  let job: Record<string, unknown>;
  try {
    job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    fail("job_invalid", `no job.json in ${jobDir} — not a v2/v3 job dir`);
  }
  const tp = job.toolpaths as ToolpathsIn | undefined;
  if (!tp) fail("toolpaths_unavailable", `${jobDir} has no toolpaths — run \`mldxf toolpaths\` first`);
  let flat;
  try {
    flat = flattenToolpaths(tp);
  } catch (e) {
    fail("toolpaths_invalid", `cannot flatten ${jobDir} toolpaths: ${(e as Error).message}`);
  }
  const s = summarizeMotion(flat);
  const out: Record<string, unknown> = {
    ok: true,
    motion_time_s: r1(s.totalSeconds),
    motion_by_tool: r1map(s.byTool),
    motion_by_operation: r1map(s.byOperation),
    moves: flat.moves.length,
    operations: flat.operations.length,
  };
  if (perLayer) {
    out.per_layer = Object.keys(s.byLayer).sort().map((layer) => {
      const l = s.byLayer[layer];
      const op = flat.operations.find((o) => o.layer === layer);
      return {
        layer,
        operation: op?.operation ?? "?",
        tool_id: op?.toolId ?? "?",
        motion_s: r1(l.seconds),
        moves: l.moves,
        rapid: l.rapid,
        feed: l.feed,
        arc: l.arc,
        rapid_s: r1(l.rapidS),
        feed_s: r1(l.feedS),
        arc_s: r1(l.arcS),
      };
    });
  }
  console.log(JSON.stringify(out));
}

main();
