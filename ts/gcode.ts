#!/usr/bin/env bun
// V3.6 G-code driver — `mldxf gcode <job-dir> [--post <post-id>]`
// (Bun; the Python CLI shells out to this and merges the entry
// into job.json, the cmd_toolpaths / cmd_sim pattern).
//
// Flow: load job.json -> resolve the post (getPost, `post_unknown`
// on an unknown id) -> postJob (the post's own limit checks —
// `post_limit_exceeded` refuses, never clamps) -> write
// gcode/<job-id>-<post-id>.nc -> parse the file back
// (ts/gcode_parse.ts) -> round-trip re-simulate it
// (ts/gcode_verify.ts) -> print one JSON object on stdout
// (progress on stderr).
//
// V3.8 adds `--verify`: re-verify the RECORDED .nc for a post —
// the file as it sits on disk, against the toolpaths as they sit
// in job.json now. The driver checks the recorded entry exists,
// the file exists, the sha256 matches the entry, then parses the
// file back and round-trip re-simulates it. Nothing is written:
// the CLI syncs the recorded `verified` stamp to the observed
// result. This is what catches a file corrupted (or a toolpath
// changed) after posting — the stamp says verified while the
// bytes on disk are not the verified bytes.
//
// Output contract (mirrors the CLI's): exactly one JSON object
// on stdout, exit 0 when the file posted AND round-trip verified
// (or, in --verify mode, the recorded file verifies), 1 on a
// named failure, 2 on an internal error. On
// `gcode_unverified` the JSON still carries the `gcode` entry
// (verified: false) and the round-trip numbers, and the file IS
// on disk — so the CLI can record the unverified entry (the UI
// shows it as inspect-only, never ready to run) and then exit 1.
// A limit/unknown-post/tool failure writes no file and no entry.
//
// The file itself carries no timestamp (deterministic: re-posting
// an unchanged job through the same post produces byte-identical
// G-code and the same sha256); the `generated_at` timestamp lives
// in the job.json entry, which the CLI adds when it merges.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { getPost } from "./posts/index.ts";
import { postJob, PostError } from "./posts/common.ts";
import type { JobIn, ToolEntry } from "./posts/common.ts";
import { parseGcode, GcodeParseError } from "./gcode_parse.ts";
import { roundTripVerify } from "./gcode_verify.ts";
import { zZeroOf } from "./z_zero.ts";
import type { ZZero } from "./z_zero.ts";

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

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Max part z_top — the stock top, i.e. the machine's Z-zero. */
function stockTopMm(job: Record<string, unknown>): number {
  const parts = job.parts;
  if (Array.isArray(parts) && parts.length) {
    let top: number | null = null;
    for (const p of parts) {
      if (isObj(p) && typeof p.z_top === "number" && Number.isFinite(p.z_top)) {
        top = top === null ? p.z_top : Math.max(top, p.z_top);
      }
    }
    if (top !== null) return top;
  }
  if (typeof job.z_top === "number" && Number.isFinite(job.z_top)) return job.z_top;
  fail("post_no_stock_top", "job has no part z_top (or top-level z_top) — cannot determine the stock top");
}

function main(): void {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");
  void jsonMode;
  const verifyMode = argv.includes("--verify");
  const rest = argv.filter((a) => a !== "--json" && a !== "--verify");
  const postIdx = rest.indexOf("--post");
  let postId: string | null = null;
  if (postIdx >= 0) {
    postId = rest[postIdx + 1] ?? null;
    rest.splice(postIdx, 2);
  }
  const jobDir = rest[0];
  if (!jobDir || !postId) {
    console.log(JSON.stringify({
      ok: false, error: "usage_error",
      message: "usage: bun ts/gcode.ts <job-dir> --post <post-id> [--verify] [--json]",
    }));
    process.exit(1);
  }

  try {
    let raw: string;
    try {
      raw = readFileSync(join(jobDir, "job.json"), "utf-8");
    } catch {
      fail("job_not_found", `${join(jobDir, "job.json")} does not exist — not a v2/v3 job dir`);
    }
    let job: Record<string, unknown>;
    try {
      job = JSON.parse(raw!);
    } catch (e: any) {
      fail("job_invalid", `job.json is not valid JSON: ${e?.message ?? e}`);
    }
    const tp = job!.toolpaths;
    if (!isObj(tp) || tp.version !== 1 || !Array.isArray(tp.operations)) {
      fail("toolpaths_unavailable", `${jobDir} has no toolpaths — G-code posts the toolpaths. Run \`mldxf toolpaths\` first`);
    }
    const plan = job!.tool_plan as { chosen?: unknown; plans?: { id?: unknown; tools?: unknown[] }[] } | undefined;
    const chosen = typeof plan?.chosen === "string" ? plan.chosen : null;
    const planEntry = (plan?.plans ?? []).find((p) => isObj(p) && p.id === chosen);
    if (!planEntry || !Array.isArray((planEntry as { tools?: unknown }).tools)) {
      fail("post_tool_missing", `job names no chosen plan with tools (chosen=${JSON.stringify(chosen)}) — cannot map toolpaths tools to T numbers`);
    }
    const planTools: ToolEntry[] = [];
    const toolByNumber = new Map<number, string>();
    for (const t of (planEntry as { tools: Record<string, unknown>[] }).tools) {
      if (!isObj(t) || typeof t.id !== "string") continue;
      const toolNumber = typeof t.tool_number === "number" ? t.tool_number : null;
      planTools.push({
        id: t.id,
        name: typeof t.name === "string" ? t.name : t.id,
        toolNumber: toolNumber ?? -1,
        diaMm: typeof t.dia_mm === "number" ? t.dia_mm : 0,
        kind: typeof t.kind === "string" ? t.kind : "?",
      });
      if (toolNumber !== null) toolByNumber.set(toolNumber, t.id);
    }

    const jobIn: JobIn = {
      job_id: typeof job!.job_id === "string" ? job!.job_id : undefined,
      toolpaths: tp as JobIn["toolpaths"],
      planTools,
      stockTopMm: stockTopMm(job!),
      // The job's Z-zero (ts/z_zero.ts): missing reads as "top",
      // the historical post behaviour — a corrupt value fails
      // here as job_invalid rather than posting under the wrong
      // zero. The validator (ts/validate_job.ts) refuses it at
      // publish time; this is the defence for hand-built jobs.
      zZero: ((): ZZero => {
        try {
          return zZeroOf(job!);
        } catch (e: any) {
          fail("job_invalid", e?.message ?? "job z_zero is corrupt");
        }
      })(),
    };
    const post = getPost(postId);

    // --- V3.8 --verify: re-verify the recorded file, write nothing.
    if (verifyMode) {
      const entries = Array.isArray(job!.gcode) ? job!.gcode : [];
      const recorded = (entries as Record<string, unknown>[]).find(
        (e) => isObj(e) && e.post_id === post.id,
      ) as Record<string, unknown> | undefined;
      if (!recorded || typeof recorded.file !== "string" || !recorded.file) {
        console.log(JSON.stringify({
          ok: false, error: "gcode_not_posted",
          message: `no G-code entry for post ${post.id} in ${jobDir} — post it first (\`mldxf gcode --post ${post.id}\`)`,
          gcode: null,
        }));
        process.exit(1);
      }
      const absFile = resolve(jobDir, recorded.file as string);
      const absDir = resolve(jobDir);
      if (absFile !== absDir && !absFile.startsWith(absDir + sep)) {
        fail("job_invalid", `recorded G-code file ${JSON.stringify(recorded.file)} escapes the job dir — not a verifiable entry`);
      }
      if (!existsSync(absFile)) {
        console.log(JSON.stringify({
          ok: false, error: "gcode_file_missing",
          message: `recorded G-code file ${recorded.file} (post ${post.id}) is missing from the job dir — the verified stamp cannot stand for a file that is not there`,
          gcode: { ...recorded, verified: false },
        }));
        process.exit(1);
      }
      const text = readFileSync(absFile, "utf-8");
      const actualSha = createHash("sha256").update(text, "utf-8").digest("hex");
      if (typeof recorded.sha256 === "string" && recorded.sha256 !== actualSha) {
        console.log(JSON.stringify({
          ok: false, error: "gcode_sha_mismatch",
          message:
            `recorded G-code file ${recorded.file} (post ${post.id}) no longer matches its entry: ` +
            `on disk sha256 ${actualSha.slice(0, 12)}…, recorded ${String(recorded.sha256).slice(0, 12)}… — ` +
            `the file was changed after it was verified; it is not the verified file`,
          gcode: { ...recorded, verified: false },
          sha256: actualSha,
        }));
        process.exit(1);
      }
      const parsed = parseGcode(text, { stockTopMm: jobIn.stockTopMm, zZero: jobIn.zZero, toolByNumber });
      const roundtrip = roundTripVerify(job!, parsed);
      const entry = {
        post_id: post.id,
        file: recorded.file as string,
        sha256: actualSha,
        verified: roundtrip.verified,
      };
      if (!roundtrip.verified) {
        console.log(JSON.stringify({
          ok: false, error: "gcode_unverified",
          message:
            `recorded G-code through ${post.id} does NOT round-trip against the current toolpaths: ` +
            `${roundtrip.mismatched} of ${roundtrip.columns} dexel columns still differ after the band test ` +
            `(largest mismatch cluster ${roundtrip.maxCluster} columns, max ${roundtrip.maxDiffMm} mm) — ` +
            `the file or the toolpaths changed after posting; it is never ready to run`,
          gcode: entry,
          roundtrip,
          sha256: actualSha,
        }));
        process.exit(1);
      }
      console.log(JSON.stringify({
        ok: true,
        post_id: post.id,
        file: entry.file,
        sha256: actualSha,
        verified: true,
        gcode: entry,
        roundtrip,
      }));
      process.exit(0);
    }

    const posted = postJob(jobIn, post);

    const jobId = typeof job!.job_id === "string" ? job!.job_id : "job";
    const relFile = `gcode/${jobId}-${post.id}.nc`;
    mkdirSync(join(jobDir, "gcode"), { recursive: true });
    writeFileSync(join(jobDir, relFile), posted.text, "utf-8");
    const sha256 = createHash("sha256").update(posted.text, "utf-8").digest("hex");

    // Round-trip: parse the file we just wrote and re-simulate it.
    const parsed = parseGcode(posted.text, { stockTopMm: jobIn.stockTopMm, zZero: jobIn.zZero, toolByNumber });
    const roundtrip = roundTripVerify(job!, parsed);

    const entry = {
      post_id: post.id,
      file: relFile,
      sha256,
      verified: roundtrip.verified,
    };
    if (!roundtrip.verified) {
      console.log(JSON.stringify({
        ok: false, error: "gcode_unverified",
        message:
          `posted G-code through ${post.id} does NOT round-trip: ` +
          `${roundtrip.mismatched} of ${roundtrip.columns} dexel columns still differ after the band test ` +
          `(largest mismatch cluster ${roundtrip.maxCluster} columns, max ${roundtrip.maxDiffMm} mm) — the file is on disk for inspection ` +
          `(${relFile}) and the entry is recorded unverified; it is never ready to run`,
        gcode: entry,
        roundtrip,
        posted: { lines: posted.lines, moves: posted.moves, tools: posted.tools },
      }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      post_id: post.id,
      file: relFile,
      sha256,
      verified: true,
      gcode: entry,
      roundtrip,
      posted: { lines: posted.lines, moves: posted.moves, tools: posted.tools },
    }));
    process.exit(0);
  } catch (e: any) {
    if (e instanceof PostError || e instanceof GcodeParseError || e instanceof NamedError) {
      const code = e.code;
      console.log(JSON.stringify({
        ok: false, error: code, message: e.message,
      }));
      process.exit(code === "internal_error" ? 2 : 1);
    }
    console.log(JSON.stringify({
      ok: false, error: "internal_error",
      message: `gcode failed: ${e?.message ?? e}`,
    }));
    process.exit(2);
  }
}

main();
