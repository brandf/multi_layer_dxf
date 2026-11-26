/**
 * mldxf-server — Bun local server + JSON API (V2.5).
 *
 * A thin shell over the `mldxf` CLI (V2_SCOPE.md §5). Every endpoint
 * maps 1:1 to a CLI command: the server spawns `mldxf` with argv
 * arrays (never a shell string — paths with spaces work), reads its
 * stdout JSON, and returns it. The server holds no pipeline state
 * and computes nothing about a job: job summaries are fields read
 * off the CLI's own `mldxf job --json` output, and the 2D preview /
 * UI tabs are V2.6–V2.8 work, not this server.
 *
 * Localhost only, single user, no auth in V2 (scope §5.1: it binds
 * localhost on the operator's own machine; any decision to expose
 * it beyond localhost re-opens auth).
 *
 * Runs are async: POST /api/jobs returns a job id immediately, the
 * CLI's stderr progress lines stream over SSE
 * (GET /api/jobs/:id/events) and are also available polled
 * (GET /api/jobs/:id/status). No timeout shorter than the run
 * (idleTimeout 0 + SSE heartbeats). Cancel kills the CLI
 * subprocess (whole process group on POSIX) and marks the job
 * interrupted (scope §8 Q6).
 *
 * Jobs live under <MLDXF_HOME>/jobs/, one dir per job id. On
 * startup the server re-scans: a dir with job.json or manifest.json
 * is complete (read-only display); a dir with NEITHER is
 * interrupted and re-runnable from its inputs (scope §8 Q2). The
 * server never writes into a job dir except by invoking the CLI,
 * and never edits job.json (§8 Q5). Run state lives in memory plus
 * a state file under the OS temp dir (retained uploads, so an
 * interrupted job can be re-run after a restart); it is not job
 * state and never lives in a job dir.
 *
 * Library edits are validate-then-save: the candidate is written
 * to a temp home, validated by the real CLI
 * (`mldxf <lib> validate --json` with MLDXF_HOME pointed at the
 * temp home), and only then moved into place, bumping the file's
 * `version` integer. An invalid save is refused with the CLI's
 * named error and the file on disk is unchanged. Exception:
 * preferences has no `mldxf preferences` subcommand in the V2.1
 * CLI and no `version` key in its model (adding one would fail
 * validation as an unknown key), so preferences is validated by
 * running the CLI's own validator module (mldxf_config.
 * load_preferences) against the temp home, and saved without a
 * version bump. That missing subcommand is a CLI gap to file,
 * not something this server works around by re-implementing
 * validation.
 *
 * Usage: `mldxf serve [--port N]` (spawns `bun run server.ts`),
 * or directly: `bun run server.ts [--port N]` (PORT env also works).
 * Dependency-free — Bun's built-in server, no npm packages.
 *
 * V3.3: GET /api/jobs/:id/geometry serves the job's layer geometry
 * (1:1 with `mldxf geometry --json`) for the three.js 3D view, and
 * the server ensures the view bundle (server/public/vendor/
 * view3d.js, built by ts/view3d/build.ts) exists and is fresh at
 * startup — a failed build never blocks the server; the view falls
 * back to the toolpath list. The server still computes nothing
 * about a job itself.
 */

import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
// V3.8: the native post registry is the authority for the known
// post ids (the Preferences -> machine.json mirror only ever
// writes one of these). The posts modules are pure TS (no I/O,
// no DOM, no Node/Bun APIs), so the server can import them.
import { listPosts } from "../ts/posts/index.ts";

// ---------------------------------------------------------------- paths

const SERVER_DIR = import.meta.dir;
const REPO_ROOT = resolve(SERVER_DIR, "..");
const PUBLIC_DIR = join(SERVER_DIR, "public");
const MLDXF_PY =
  process.env.MLDXF_PY ?? join(REPO_ROOT, "mldxf.py");
const VERSION_FILE = join(REPO_ROOT, "VERSION");

function defaultPython(): string {
  const venv =
    process.platform === "win32"
      ? join(REPO_ROOT, ".venv", "Scripts", "python.exe")
      : join(REPO_ROOT, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}
const PYTHON = process.env.MLDXF_PYTHON ?? defaultPython();

function resolveHome(): string {
  // Mirrors mldxf_config.resolve_home (V2_SCOPE.md §4.1): MLDXF_HOME
  // wins, else %APPDATA%\multi_layer_dxf on Windows, else
  // ~/.config/multi_layer_dxf. Never the current working directory.
  const override = process.env.MLDXF_HOME;
  if (override && override.trim()) return override;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata && appdata.trim())
      return join(appdata, "multi_layer_dxf");
  }
  return join(homedir(), ".config", "multi_layer_dxf");
}
const HOME = resolveHome();
const JOBS_ROOT = join(HOME, "jobs");

// Server-owned scratch (NOT a job dir, NOT the library home):
// retained STEP uploads + the run-state index.
const STATE_DIR = join(tmpdir(), "mldxf-server");
const UPLOADS_DIR = join(STATE_DIR, "uploads");
const STATE_FILE = join(STATE_DIR, "server-state.json");

const CLI_VERSION = await Bun.file(VERSION_FILE)
  .text()
  .then((t) => t.trim())
  .catch(() => "unknown");

// ---------------------------------------------------------------- errors

function cliErrorName(message: string): string {
  return message.includes("mldxf init")
    ? "home_not_initialized"
    : "config_error";
}

function httpStatusForCliError(name: string): number {
  return name === "internal_error" ? 500 : 400;
}

// ---------------------------------------------------------------- CLI spawn

/** argv for the CLI. The pipeline runs under the repo venv python
 * when present (the V1 scripts need build123d + ezdxf); mldxf.py
 * itself is stdlib-only. Always an argv array — never a shell
 * string — so paths with spaces work (scope §8 Q8). */
function cliArgv(args: string[]): string[] {
  return [PYTHON, MLDXF_PY, ...args];
}

/** Extra env for a CLI child: the server's env, with MLDXF_HOME
 * pinned to the home the server resolved, so the CLI and the
 * server can never disagree about where libraries and jobs live. */
function cliEnv(extra?: Record<string, string>): Record<string, string> {
  return { ...process.env, MLDXF_HOME: HOME, ...extra } as Record<
    string,
    string
  >;
}

/** Run a CLI command to completion and parse its stdout JSON.
 * Returns the parsed object, or { ok:false, error, message } when
 * the CLI failed or its stdout was not JSON. */
async function runCli(
  args: string[],
  envExtra?: Record<string, string>,
): Promise<{ code: number; body: any }> {
  const proc = Bun.spawn(cliArgv(args), {
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(envExtra),
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const text = out.trim();
  try {
    return { code, body: JSON.parse(text) };
  } catch {
    // The CLI contract says stdout is exactly one JSON object; if
    // it is not, that is an internal error, reported with the tail
    // of stderr so the cause is visible.
    return {
      code,
      body: {
        ok: false,
        error: "internal_error",
        message:
          `mldxf ${args[0]} produced no JSON on stdout ` +
          `(exit ${code}): ${(err.trim().split("\n").slice(-2).join(" | ") || "(no stderr)")}`,
      },
    };
  }
}

/** Validate preferences through the CLI's own validator module
 * (mldxf_config.load_preferences) — there is no
 * `mldxf preferences validate` subcommand in the V2.1 CLI, so
 * this is the closest faithful equivalent: the same code the CLI
 * would run, invoked as a subprocess with argv, against the given
 * home. Prints exactly one JSON object on stdout. */
function preferencesCheckArgv(): string[] {
  const code =
    "import json, sys\n" +
    "sys.path.insert(0, " +
    JSON.stringify(REPO_ROOT) +
    ")\n" +
    "import mldxf_config\n" +
    "try:\n" +
    "    data = mldxf_config.load_preferences()\n" +
    "    print(json.dumps({'ok': True, 'preferences': data}))\n" +
    "except mldxf_config.ConfigError as e:\n" +
    "    name = 'home_not_initialized' if 'mldxf init' in str(e) else 'config_error'\n" +
    "    print(json.dumps({'ok': False, 'error': name, 'message': str(e)}))\n";
  return [PYTHON, "-c", code];
}

async function runPreferencesCheck(
  home: string,
): Promise<{ code: number; body: any }> {
  const proc = Bun.spawn(preferencesCheckArgv(), {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MLDXF_HOME: home } as Record<string, string>,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  try {
    return { code, body: JSON.parse(out.trim()) };
  } catch {
    return {
      code,
      body: {
        ok: false,
        error: "internal_error",
        message: `preferences check produced no JSON (exit ${code}): ${err.trim().slice(-300)}`,
      },
    };
  }
}

// ---------------------------------------------------------------- zip (stored, no compression)

// The download endpoint serves a zip of the job dir. No npm
// dependency and no assumption that `zip` exists on the machine
// (notably Windows), so this is a minimal stored-entries ZIP
// writer (CRC-32 + local headers + central directory). Verified
// against Python's zipfile in server/verify_v25.py.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStored(
  entries: { name: string; data: Uint8Array }[],
): Uint8Array {
  const out: number[] = [];
  const central: { name: string; crc: number; size: number; offset: number }[] = [];
  const pushU16 = (v: number) => {
    out.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushU32 = (v: number) => {
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };
  const pushBytes = (b: Uint8Array) => {
    for (const x of b) out.push(x);
  };
  const enc = new TextEncoder();
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const offset = out.length;
    pushU32(0x04034b50); // local file header
    pushU16(20); // version needed
    pushU16(0x0800); // flags: UTF-8 filenames
    pushU16(0); // method: stored
    pushU16(0); // mod time
    pushU16(0x21); // mod date: 1980-01-01 (deterministic)
    pushU32(crc);
    pushU32(data.length);
    pushU32(data.length);
    pushU16(nameBytes.length);
    pushU16(0);
    pushBytes(nameBytes);
    pushBytes(data);
    central.push({ name, crc, size: data.length, offset });
  }
  const centralStart = out.length;
  for (const { name, crc, size, offset } of central) {
    const nameBytes = enc.encode(name);
    pushU32(0x02014b50); // central file header
    pushU16(20); // version made by
    pushU16(20); // version needed
    pushU16(0x0800);
    pushU16(0);
    pushU16(0);
    pushU16(0x21);
    pushU32(crc);
    pushU32(size);
    pushU32(size);
    pushU16(nameBytes.length);
    pushU16(0);
    pushU16(0);
    pushU16(0);
    pushU16(0);
    pushU32(0);
    pushU32(offset);
    pushBytes(nameBytes);
  }
  const centralSize = out.length - centralStart;
  pushU32(0x06054b50); // end of central directory
  pushU16(0);
  pushU16(0);
  pushU16(central.length);
  pushU16(central.length);
  pushU32(centralSize);
  pushU32(centralStart);
  pushU16(0);
  return new Uint8Array(out);
}

async function zipJobDir(dir: string): Promise<Uint8Array> {
  const entries: { name: string; data: Uint8Array }[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    const names = [...(await readdirSafe(d))].sort();
    for (const name of names) {
      const path = join(d, name);
      const isDir = await isDirectory(path);
      if (isDir) {
        await walk(path, prefix + name + "/");
      } else {
        entries.push({
          name: prefix + name,
          data: new Uint8Array(await Bun.file(path).arrayBuffer()),
        });
      }
    }
  }
  await walk(dir, "");
  return zipStored(entries);
}

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- runs

type RunStatus = "running" | "complete" | "failed" | "interrupted";

interface RetainedInputs {
  /** Absolute path of the retained STEP upload (under STATE_DIR). */
  stepPath: string;
  /** The plan options the run was started with. */
  options: PlanOptions;
  /** ISO timestamp the run was accepted (listed as `created`). */
  startedAt?: string;
  /** The library home the run belonged to (the HOME this server
   * was started with). The retained-inputs index lives in a
   * shared OS temp dir, so without this the jobs list would show
   * interrupted runs retained by other homes' servers. Entries
   * written before this field existed carry no home and are
   * treated as foreign — the list only shows this home's jobs. */
  home?: string;
}

interface PlanOptions {
  material?: string;
  plan?: string;
  auto?: boolean;
  mode?: string;
  minTool?: number;
  only?: string;
}

interface JobRun {
  id: string;
  dir: string;
  status: RunStatus;
  /** True when the run ended because the user cancelled it. */
  cancelled: boolean;
  startedAt: string;
  finishedAt?: string;
  /** CLI subprocess pid while running (for verification that a
   * cancel really killed it). */
  pid?: number;
  error?: { error: string; message: string };
  /** The CLI's stdout JSON object once the run finishes. */
  job?: any;
  /** stderr progress lines, in order (replayed to new SSE clients). */
  progress: string[];
  /** Inputs retained under STATE_DIR, so an interrupted job can be
   * re-run after a restart. Null for jobs the server did not start
   * (e.g. CLI-created jobs found by the startup scan). */
  retained: RetainedInputs | null;
  proc?: any; // Bun Subprocess while running
  sse: Set<(line: string) => void>;
}

const runs = new Map<string, JobRun>();

// Retained-inputs index, persisted under STATE_DIR (never in a job
// dir): job id -> { stepPath, options }. Loaded at startup so an
// interrupted job stays re-runnable across a server restart.
let retainedIndex: Record<string, RetainedInputs> = {};
try {
  const raw = await Bun.file(STATE_FILE).text();
  retainedIndex = JSON.parse(raw) as Record<string, RetainedInputs>;
} catch {
  retainedIndex = {};
}

async function saveRetainedIndex(): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(retainedIndex, null, 2));
}

function jobIdFor(stepStem: string): string {
  const slug = stepStem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // Local time, not UTC: match the CLI's job-id format
  // (YYYYMMDD-HHMMSS-<slug>, local time).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const local =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return slug ? `${local}-${slug}` : local;
}

async function uniqueJobDir(id: string): Promise<{ id: string; dir: string }> {
  let candidate = id;
  let n = 2;
  while (existsSync(join(JOBS_ROOT, candidate))) {
    candidate = `${id}-${n}`;
    n++;
  }
  return { id: candidate, dir: join(JOBS_ROOT, candidate) };
}

function planArgv(
  stepPath: string,
  dir: string,
  options: PlanOptions,
): string[] {
  const argv = ["plan", stepPath, "-o", dir, "--json"];
  if (options.mode) argv.push("--mode", options.mode);
  if (options.minTool) argv.push("--min-tool", String(options.minTool));
  if (options.material) argv.push("--material", options.material);
  if (options.plan) argv.push("--plan", options.plan);
  if (options.only) argv.push("--only", options.only);
  if (options.auto) argv.push("--auto");
  return argv;
}

/** Start a `mldxf plan` run in the background and register it.
 * Returns the JobRun immediately — the caller must NOT await the
 * run itself. Completion is delivered via the run's progress/SSE
 * and the status endpoint. */
function startPlanRun(
  id: string,
  dir: string,
  stepPath: string,
  options: PlanOptions,
  retained: RetainedInputs | null,
): JobRun {
  const run: JobRun = {
    id,
    dir,
    status: "running",
    cancelled: false,
    startedAt: new Date().toISOString(),
    progress: [],
    retained,
    sse: new Set(),
  };
  runs.set(id, run);
  if (retained) {
    retainedIndex[id] = { ...retained, startedAt: run.startedAt, home: HOME };
    void saveRetainedIndex();
  }
  log(`run ${id} started: mldxf ${planArgv(stepPath, dir, options).join(" ")}`);
  void runCliJob(
    run,
    planArgv(stepPath, dir, options),
    "plan",
    "plan_failed",
  );
  return run;
}

/** Start a `mldxf toolpaths` run in the background and register it
 * (V3.2): same machinery as a plan run — the caller gets the JobRun
 * immediately (202), progress streams over the same SSE endpoint
 * (`GET /api/jobs/:id/events`), completion lands in the same status
 * endpoint. No retained inputs: the job dir itself is the input.
 * Toolpaths run in seconds on small jobs but the Kookabus job is
 * 57k moves, so it is async like plan, never synchronous like
 * guides. */
function startToolpathsRun(id: string, dir: string): JobRun {
  const run: JobRun = {
    id,
    dir,
    status: "running",
    cancelled: false,
    startedAt: new Date().toISOString(),
    progress: [],
    retained: null,
    sse: new Set(),
  };
  runs.set(id, run);
  log(`run ${id} started: mldxf toolpaths ${dir} --json`);
  void runCliJob(run, ["toolpaths", dir, "--json"], "toolpaths", "toolpaths_failed");
  return run;
}

/** The background half of startPlanRun / startToolpathsRun: spawn
 * the CLI (argv is the `mldxf ...` argv without the python prefix),
 * stream its stderr into the run's progress buffer + SSE
 * subscribers, and record the outcome when it exits. `label` is
 * the command name for logs/messages; `defaultError` is the error
 * name when the CLI fails with no JSON on stdout. */
async function runCliJob(
  run: JobRun,
  cliArgs: string[],
  label: string,
  defaultError: string,
): Promise<void> {
  const { id } = run;

  // On POSIX the CLI is spawned under `setsid` so it leads its own
  // process group: cancel can then kill the whole group (the CLI
  // plus the v1 pipeline child it spawned), not just the shell.
  const useSetsid =
    process.platform !== "win32" && Bun.which("setsid") !== null;
  const argv = useSetsid
    ? ["setsid", ...cliArgv(cliArgs)]
    : cliArgv(cliArgs);
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(),
  });
  run.proc = proc;
  run.pid = proc.pid;

  const decoder = new TextDecoder();
  const pushLine = (line: string) => {
    if (!line.trim()) return;
    run.progress.push(line);
    for (const fn of run.sse) fn(line);
  };
  const drainStderr = (async () => {
    const reader = proc.stderr.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) pushLine(line);
      }
      buf += decoder.decode();
      if (buf) pushLine(buf);
    } catch {
      /* stderr closed with the process — nothing to do */
    }
  })();
  const stdoutText = new Response(proc.stdout).text();
  const code = await proc.exited;
  await drainStderr;
  await stdoutText.then((text) => {
    run.finishedAt = new Date().toISOString();
    run.proc = undefined;
    run.pid = undefined;
    let body: any = null;
    try {
      body = JSON.parse(text.trim());
    } catch {
      body = null;
    }
    if (code === 0 && body && body.ok) {
      run.status = "complete";
      run.job = body.job ?? null;
      log(`run ${id} complete (exit 0)`);
    } else if (run.cancelled) {
      run.status = "interrupted";
      run.error = {
        error: "cancelled",
        message: "run cancelled by the user",
      };
      log(`run ${id} cancelled (exit ${code})`);
    } else {
      run.status = "failed";
      run.error = {
        error: body?.error ?? defaultError,
        message:
          body?.message ??
          `mldxf ${label} failed (exit ${code}) with no JSON on stdout`,
      };
      run.job = body?.job ?? null;
      log(`run ${id} failed: ${run.error.error}: ${run.error.message}`);
    }
    for (const fn of run.sse) fn("\u0000DONE");
  });
}

/** Kill a running job's CLI subprocess (whole process group on
 * POSIX) and mark the job interrupted (scope §8 Q6). */
async function cancelRun(run: JobRun): Promise<void> {
  if (run.status !== "running" || !run.proc) return;
  run.cancelled = true;
  const pid = run.proc.pid;
  try {
    if (process.platform === "win32") {
      // taskkill /T kills the whole process tree.
      const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await killer.exited;
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        run.proc.kill("SIGTERM");
      }
      // If the group is still alive after 3 s, SIGKILL it.
      await new Promise((r) => setTimeout(r, 3000));
      try {
        process.kill(-pid, 0);
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  } catch {
    try {
      run.proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  // The exit handler in startPlanRun sees run.cancelled and marks
  // the job interrupted; wait briefly for it to land.
  for (let i = 0; i < 20 && run.status === "running"; i++)
    await new Promise((r) => setTimeout(r, 100));
  if (run.status === "running") {
    run.status = "interrupted";
    run.finishedAt = new Date().toISOString();
    run.proc = undefined;
  }
}

// ---------------------------------------------------------------- job scan

function planSummaryFromJob(job: any): any {
  // Fields read off the CLI's own job object — counts and the first
  // plan's tools/time, formatted the same way mldxf.py's
  // plan_summary does. No pipeline computation here.
  const toolPlan = job?.tool_plan ?? {};
  const plans = toolPlan?.plans ?? [];
  const first = plans[0];
  return {
    parts: Array.isArray(job?.parts) ? job.parts.length : 0,
    layers: Array.isArray(job?.layers) ? job.layers.length : 0,
    flags: Array.isArray(job?.flags) ? job.flags.length : 0,
    plan: first
      ? {
          id: first.id ?? "A",
          tools: (first.tools ?? []).map(
            (t: any) => t.name ?? t.id ?? "?",
          ),
          tool_changes: first.tool_changes ?? 0,
          total_seconds: first.total_seconds ?? 0,
          minutes: Math.round(((first.total_seconds ?? 0) / 60) * 10) / 10,
        }
      : null,
    toolpaths: toolpathsSummaryFromJob(job),
    gcode: gcodeSummaryFromJob(job),
  };
}

/** The G-code summary for a job (V3.6, docs-v3/job_model_v3.md
 * §6.1): null for a job never posted, one line per post run for a
 * posted job — the post, the file, the verified stamp, and the
 * run time. Read off the job object only; no computation. */
function gcodeSummaryFromJob(job: any): any {
  const gc = job?.gcode;
  if (!Array.isArray(gc) || gc.length === 0) return null;
  return gc.map((e: any) => ({
    post_id: e?.post_id ?? null,
    file: e?.file ?? null,
    sha256: e?.sha256 ?? null,
    verified: e?.verified ?? false,
    generated_at: e?.generated_at ?? null,
  }));
}

/** The toolpaths summary for a job (V3.2, docs-v3/job_model_v3.md
 * §11): null for a v2 job (no toolpaths yet), the section's stats
 * + skipped loops for a v3 job. Skipped loops are listed, never
 * hidden — a job that skips material says so in the list. Read off
 * the job object only; no computation. */
function toolpathsSummaryFromJob(job: any): any {
  const tp = job?.toolpaths;
  if (!tp) return null;
  const stats = tp.stats ?? {};
  const ops = tp.operations ?? [];
  return {
    version: tp.version ?? null,
    plan: tp.plan ?? null,
    operations: stats.operations ?? ops.length,
    moves: stats.moves ?? 0,
    rapid: stats.rapid ?? 0,
    feed: stats.feed ?? 0,
    arc: stats.arc ?? 0,
    skipped: (tp.skipped ?? []).map((s: any) => ({
      layer: s.layer ?? null,
      loop: s.loop ?? null,
      reason: s.reason ?? null,
    })),
  };
}

async function readJobFile(dir: string): Promise<{
  data: any;
  filename: string;
} | null> {
  for (const filename of ["job.json", "manifest.json"]) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;
    try {
      return { data: await Bun.file(path).json(), filename };
    } catch {
      return { data: null, filename };
    }
  }
  return null;
}

/** Disk scan of the jobs root (scope §5.1 / §8 Q2). A dir with
 * job.json or manifest.json is complete; a dir with NEITHER is
 * interrupted. In-memory runs (started by this server process)
 * override the disk rule while they are live. A run the server
 * accepted but whose dir does not exist yet — killed during the
 * CLI's solid-count probe, before the pipeline creates the outdir
 * — is merged in from the retained-inputs index as interrupted:
 * the server never writes into a job dir, so it cannot conjure
 * the dir itself, but the retained inputs are the record that
 * the run existed and can be re-run.
 *
 * The list is scoped to THIS home: the retained-inputs index is
 * shared (OS temp dir) across homes, so a retained entry counts
 * only when its recorded home is this server's HOME. Job dirs
 * are under this home's jobs root by construction, so they need
 * no extra check. */
function retainedIsOurs(retained: RetainedInputs | undefined): boolean {
  return !!retained && retained.home === HOME;
}

async function scanJobs(): Promise<any[]> {
  const names = (await readdirSafe(JOBS_ROOT)).sort().reverse();
  const out: any[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const dir = join(JOBS_ROOT, name);
    if (!(await isDirectory(dir))) continue;
    seen.add(name);
    const inMemory = runs.get(name);
    if (inMemory && inMemory.status === "running") {
      out.push({
        id: name,
        created: inMemory.startedAt,
        status: "running",
        summary: inMemory.job ? planSummaryFromJob(inMemory.job) : null,
      });
      continue;
    }
    const found = await readJobFile(dir);
    if (found && found.data) {
      const job = found.data;
      out.push({
        id: name,
        created:
          job.created_at ??
          (await dirMtime(dir)),
        status: inMemory?.status ?? "complete",
        job_version: job.job_version ?? 1,
        summary: planSummaryFromJob(job),
      });
    } else if (found && found.data === null) {
      out.push({
        id: name,
        created: await dirMtime(dir),
        status: "invalid",
        error: "job_invalid",
        summary: null,
      });
    } else {
      out.push({
        id: name,
        created: await dirMtime(dir),
        status: inMemory?.status ?? "interrupted",
        cancelled: inMemory?.cancelled ?? false,
        can_rerun_from_inputs: retainedIsOurs(retainedIndex[name]),
        summary: null,
      });
    }
  }
  // Retained runs with no dir on disk (killed before the CLI
  // created the outdir): interrupted, re-runnable from inputs —
  // but only this home's own; another home's retained runs never
  // appear in this list.
  for (const [id, retained] of Object.entries(retainedIndex)) {
    if (seen.has(id) || runs.has(id)) continue;
    if (!retainedIsOurs(retained)) continue;
    if (!existsSync(retained.stepPath)) continue;
    out.push({
      id,
      created: retained.startedAt ?? new Date(0).toISOString(),
      status: "interrupted",
      cancelled: false,
      can_rerun_from_inputs: true,
      summary: null,
    });
  }
  // In-memory runs with no dir on disk yet: with V2.2's atomic
  // job-dir write (temp sibling + rename), the final dir appears
  // only when the run finishes, so a running job has no dir for
  // its whole lifetime — the disk scan alone would hide every
  // in-flight run from the list. (Also covers runs whose dir the
  // CLI removed, e.g. --mode check or a failed run.)
  for (const run of runs.values()) {
    if (seen.has(run.id)) continue;
    out.push({
      id: run.id,
      created: run.startedAt,
      status: run.status,
      cancelled: run.cancelled,
      can_rerun_from_inputs: retainedIsOurs(retainedIndex[run.id]),
      summary: run.job ? planSummaryFromJob(run.job) : null,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

async function dirMtime(dir: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(dir)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ---------------------------------------------------------------- HTTP helpers

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  name: string,
  message: string,
  status = 400,
): Response {
  return jsonResponse({ ok: false, error: name, message }, status);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;

function jobDirFor(id: string): string | null {
  if (!SAFE_ID.test(id) || id === "." || id === "..") return null;
  const dir = resolve(JOBS_ROOT, id);
  if (dir !== JOBS_ROOT && !dir.startsWith(JOBS_ROOT + sep)) return null;
  return dir;
}

// ---------------------------------------------------------------- libraries

const LIBRARIES: Record<
  string,
  { filename: string; key: string; cli: string[] | null }
> = {
  // key = the envelope key the CLI returns ({"ok": true, "tools": {...}}).
  // cli = the CLI validate command; null for preferences (no CLI
  // subcommand — validated via the CLI's validator module instead).
  tools: { filename: "tools.json", key: "tools", cli: ["tools", "validate"] },
  clamps: { filename: "clamps.json", key: "clamps", cli: ["clamps", "validate"] },
  machine: { filename: "machine.json", key: "machine", cli: ["machine", "validate"] },
  preferences: { filename: "preferences.json", key: "preferences", cli: null },
};

async function libraryGet(kind: string): Promise<Response> {
  const lib = LIBRARIES[kind];
  if (kind === "preferences") {
    const { body } = await runPreferencesCheck(HOME);
    if (!body.ok)
      return errorResponse(
        body.error ?? "config_error",
        body.message ?? "preferences could not be read",
        httpStatusForCliError(body.error ?? "config_error"),
      );
    return jsonResponse(body);
  }
  const listCmd =
    kind === "machine" ? ["machine", "show"] : [kind, "list"];
  const { body } = await runCli([...listCmd, "--json"]);
  if (!body.ok)
    return errorResponse(
      body.error ?? "config_error",
      body.message ?? `${kind} could not be read`,
      httpStatusForCliError(body.error ?? "config_error"),
    );
  return jsonResponse(body);
}

/** Normalize a PUT body into the canonical file shape for the
 * library. Tools/clamps accept a bare list, a {version, tools}
 * object, or the CLI envelope {tools: {...}}; machine and
 * preferences accept the object itself (or the CLI envelope). */
function normalizeLibraryBody(kind: string, body: any): any {
  const lib = LIBRARIES[kind];
  let inner = body;
  if (inner && typeof inner === "object" && lib.key in inner &&
      (kind === "machine" || kind === "preferences" ||
       (inner[lib.key] && typeof inner[lib.key] === "object"))) {
    // CLI envelope, e.g. {"tools": {"version": 1, "tools": [...]}}.
    // A bare list for tools/clamps has no such key, so it is not
    // unwrapped here.
    if (kind === "tools" || kind === "clamps") {
      if (inner[lib.key] && typeof inner[lib.key] === "object" &&
          !Array.isArray(inner[lib.key]))
        inner = inner[lib.key];
    } else {
      inner = inner[lib.key];
    }
  }
  if (kind === "tools" || kind === "clamps") {
    const entries = entryList(kind, inner);
    return { version: 0, [lib.key]: entries }; // version set by caller
  }
  if (!inner || typeof inner !== "object" || Array.isArray(inner))
    throw new Error(`${kind} body must be a JSON object`);
  return inner;
}

function entryList(kind: string, inner: any): any[] {
  const key = LIBRARIES[kind].key;
  if (Array.isArray(inner)) return inner;
  if (inner && typeof inner === "object") {
    const list = inner[key];
    if (Array.isArray(list)) return list;
    if (list && typeof list === "object") {
      // Keyed form: {"EM6.35": {...}} — id defaults to the key.
      return Object.entries(list).map(([id, entry]: [string, any]) => ({
        ...(entry as any),
        id: (entry as any)?.id ?? id,
      }));
    }
  }
  throw new Error(`${kind} body must be a list of entries or an object with a '${key}' list`);
}

async function libraryPut(kind: string, req: Request): Promise<Response> {
  const lib = LIBRARIES[kind];
  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", "PUT body must be valid JSON");
  }
  let candidate: any;
  try {
    candidate = normalizeLibraryBody(kind, body);
  } catch (e: any) {
    return errorResponse("invalid_json", e.message ?? String(e));
  }

  // Current version: the bump is always current + 1, whatever the
  // client submitted (the file's version names the library version
  // a job snapshot records — the server, not the client, owns it).
  // Preferences has no version key in its model, so no bump there.
  const currentPath = join(HOME, lib.filename);
  let currentVersion = 1;
  if (existsSync(currentPath)) {
    try {
      const current = await Bun.file(currentPath).json();
      if (current && typeof current.version === "number")
        currentVersion = current.version;
    } catch {
      return errorResponse(
        "config_error",
        `${lib.filename} on disk is not valid JSON — refusing to overwrite it; fix or remove it by hand`,
      );
    }
  } else {
    return errorResponse(
      "home_not_initialized",
      `${lib.filename} not found in ${HOME} — run 'mldxf init' to create it from the shipped examples`,
    );
  }
  if (kind !== "preferences") candidate.version = currentVersion + 1;

  // Validate-then-save: copy the whole home into a temp home,
  // write the candidate there, and run the CLI's own validation
  // against the temp home (MLDXF_HOME pointed at it). The real
  // file is touched only after the CLI accepts the candidate.
  const { mkdtemp, cp, rm, rename, writeFile } = await import("node:fs/promises");
  const tmp = await mkdtemp(join(tmpdir(), "mldxf-validate-"));
  try {
    for (const name of ["machine.json", "tools.json", "clamps.json", "preferences.json"]) {
      const src = join(HOME, name);
      if (existsSync(src)) await cp(src, join(tmp, name));
    }
    await writeFile(
      join(tmp, lib.filename),
      JSON.stringify(candidate, null, 2) + "\n",
      "utf-8",
    );
    let result: { code: number; body: any };
    if (lib.cli) {
      result = await runCli([...lib.cli, "--json"], { MLDXF_HOME: tmp });
    } else {
      result = await runPreferencesCheck(tmp);
    }
    if (!result.body?.ok) {
      // Refused: the CLI's named error, file on disk unchanged.
      return errorResponse(
        result.body?.error ?? "config_error",
        result.body?.message ?? `${kind} validation failed`,
        httpStatusForCliError(result.body?.error ?? "config_error"),
      );
    }
    // Accepted: move into place atomically (temp sibling + rename).
    const staging = join(HOME, `.${lib.filename}.tmp-${process.pid}`);
    await writeFile(staging, JSON.stringify(candidate, null, 2) + "\n", "utf-8");
    await rename(staging, currentPath);
    log(`${kind} saved: version ${candidate.version ?? "(no version field)"} (was ${currentVersion})`);
    // V3.8: a chosen native post in Preferences also sets the
    // machine profile's post processor — see mirrorPostToMachine.
    if (kind === "preferences") {
      await mirrorPostToMachine(candidate);
    }
    return jsonResponse({ ok: true, [lib.key]: candidate });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** V3.8 — mirror a chosen native post from Preferences into the
 * machine profile (machine.json), where the selection lives: the
 * CLI's post resolution honors machine.json (`mldxf gcode`
 * without --post), and the machine tab edits the same field, so
 * the two UIs agree. Only a value naming a known native post
 * mirrors; anything else (a legacy VCarve post name, the old
 * CHANGE_ME sentinel, blank) leaves machine.json untouched.
 * Best-effort by design: a machine file that cannot be read or
 * validated keeps its old value, and the preferences save still
 * stands — the mirror is a convenience, never a reason to refuse
 * the operator's save. The mirrored file is validated with the
 * CLI's own `mldxf machine validate` in a temp home before it is
 * moved into place (the libraryPut validate-then-save pattern),
 * and its version is bumped like any machine save. */
async function mirrorPostToMachine(prefs: any): Promise<void> {
  const pp = prefs?.vcarve?.post_processor;
  if (typeof pp !== "string") return;
  const known = new Set(listPosts().map((p) => p.id));
  if (!known.has(pp)) return;
  const machinePath = join(HOME, "machine.json");
  let machine: any;
  try {
    machine = await Bun.file(machinePath).json();
  } catch {
    log(`post mirror skipped: machine.json could not be read`);
    return;
  }
  if (!machine || typeof machine !== "object" || Array.isArray(machine)) return;
  if (machine.post_processor === pp) return;
  const next = { ...machine, post_processor: pp };
  if (typeof next.version === "number") next.version = next.version + 1;
  const { mkdtemp, cp, rm, rename, writeFile } = await import("node:fs/promises");
  const tmp = await mkdtemp(join(tmpdir(), "mldxf-post-mirror-"));
  try {
    for (const name of ["machine.json", "tools.json", "clamps.json", "preferences.json"]) {
      const src = join(HOME, name);
      if (existsSync(src)) await cp(src, join(tmp, name));
    }
    await writeFile(
      join(tmp, "machine.json"),
      JSON.stringify(next, null, 2) + "\n",
      "utf-8",
    );
    const result = await runCli(["machine", "validate", "--json"], { MLDXF_HOME: tmp });
    if (!result.body?.ok) {
      log(`post mirror skipped: machine.json with post ${pp} failed validation: ${result.body?.message ?? "unknown"}`);
      return;
    }
    const staging = join(HOME, `.machine.json.tmp-${process.pid}`);
    await writeFile(staging, JSON.stringify(next, null, 2) + "\n", "utf-8");
    await rename(staging, machinePath);
    log(`post mirror: machine.json post_processor set to ${pp} (version ${next.version ?? "?"})`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- jobs

async function handleCreateJob(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  let stepPath: string | null = null;
  let uploaded = false;
  const options: PlanOptions = {};
  let stepStem = "job";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return errorResponse("invalid_upload", "multipart body could not be read");
    }
    const file = form.get("step") ?? form.get("file");
    if (!file || typeof file === "string" || !("arrayBuffer" in file))
      return errorResponse("step_file_not_found", "multipart upload needs a STEP file in the 'step' field");
    // Keep the upload's ORIGINAL filename (and hence its stem):
    // the DXF name, the report title and manifest.txt's "# dxf:"
    // line all come from the STEP's stem, so renaming the upload
    // to <job-id>.step would make the API job's outputs differ
    // from a CLI run on the same file. The upload lives under
    // uploads/<job-id>/, so the id is in the path either way.
    const rawName = basename((file as File).name || "upload.step");
    stepStem = rawName.replace(/\.step$/i, "") || "job";
    const { id, dir } = await uniqueJobDir(jobIdFor(stepStem));
    const safeName = SAFE_FILE.test(rawName) ? rawName : `${id}-upload.step`;
    const { mkdir } = await import("node:fs/promises");
    const uploadDir = join(UPLOADS_DIR, id);
    await mkdir(uploadDir, { recursive: true });
    await Bun.write(join(uploadDir, safeName), file as File);
    stepPath = join(uploadDir, safeName);
    uploaded = true;
    const opt = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v : undefined;
    };
    if (opt("material")) options.material = opt("material");
    if (opt("plan")) options.plan = opt("plan");
    if (opt("mode")) options.mode = opt("mode");
    if (opt("only")) options.only = opt("only");
    if (opt("min_tool")) options.minTool = Number(opt("min_tool"));
    if (opt("auto") === "true" || opt("auto") === "1") options.auto = true;
    const run = startPlanRun(id, dir, stepPath, options, {
      stepPath,
      options,
    });
    return jsonResponse(
      { ok: true, job: { job_id: run.id, job_dir: run.dir, status: "running" } },
      202,
    );
  }

  // JSON body: pick a STEP already on disk (V2.7 also allows this).
  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", "POST /api/jobs needs multipart STEP upload or a JSON body with step_path");
  }
  if (!body || typeof body.step_path !== "string" || !body.step_path)
    return errorResponse("step_file_not_found", "JSON body needs 'step_path' (absolute path to a STEP file)");
  stepPath = body.step_path;
  // stepPath is a non-empty string here by the guard above; this
  // makes the invariant visible to the typechecker (string | null
  // otherwise, and the uses below would not typecheck).
  if (!stepPath)
    return errorResponse("step_file_not_found", "no STEP file for this job");
  if (!existsSync(stepPath))
    return errorResponse("step_file_not_found", `STEP file not found: ${stepPath}`);
  stepStem = basename(stepPath).replace(/\.step$/i, "");
  if (typeof body.material === "string") options.material = body.material;
  if (typeof body.plan === "string") options.plan = body.plan;
  if (typeof body.mode === "string") options.mode = body.mode;
  if (typeof body.only === "string") options.only = body.only;
  if (typeof body.min_tool === "number") options.minTool = body.min_tool;
  if (body.auto === true) options.auto = true;
  const { id, dir } = await uniqueJobDir(jobIdFor(stepStem));
  // The CLI reads the STEP from its path; no upload to retain, but
  // the on-disk path is the input, so an interrupted JSON-started
  // job is re-runnable from that same path.
  const run = startPlanRun(id, dir, stepPath, options, {
    stepPath,
    options,
  });
  void uploaded;
  return jsonResponse(
    { ok: true, job: { job_id: run.id, job_dir: run.dir, status: "running" } },
    202,
  );
}

async function handleGetJob(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  const run = runs.get(id);
  if (!existsSync(dir)) {
    // A run whose dir is gone (e.g. --mode check, or a failed run
    // the CLI cleaned up): answer from the in-memory record. A
    // retained run with no dir at all (killed before the CLI
    // created the outdir): interrupted, re-runnable from inputs.
    if (run)
      return jsonResponse({
        ok: true,
        job: run.job ?? null,
        status: run.status,
        cancelled: run.cancelled,
        error: run.error ?? null,
      });
    if (retainedIndex[id])
      return jsonResponse({
        ok: true,
        job: null,
        status: "interrupted",
        cancelled: false,
        can_rerun_from_inputs: true,
      });
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  }
  const { body } = await runCli(["job", dir, "--json"]);
  if (!body.ok)
    return errorResponse(
      body.error ?? "job_invalid",
      body.message ?? `job ${id} could not be read`,
      body.error === "job_not_found" ? 404 : 400,
    );
  const scanned = (await scanJobs()).find((j) => j.id === id);
  return jsonResponse({
    ok: true,
    job: body.job,
    status: scanned?.status ?? run?.status ?? "complete",
    cancelled: run?.cancelled ?? false,
    can_rerun_from_inputs:
      scanned?.status === "interrupted" && Boolean(retainedIndex[id]),
  });
}

async function handleRerun(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  const retained = retainedIndex[id];
  // No dir on disk but inputs retained (killed before the CLI
  // created the outdir): re-plan from the retained inputs into a
  // NEW job dir — there is nothing to `mldxf rerun` from.
  if (!existsSync(dir)) {
    if (!retained)
      return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
    return await rerunFromInputs(id, retained);
  }
  const { body } = await runCli(["rerun", dir, "--json"]);
  if (body.ok) return jsonResponse(body);
  // Faithful passthrough for the normal case (v1 jobs:
  // rerun_unavailable; v2 jobs: the CLI replays the job in
  // place). The one exception is an interrupted job whose inputs
  // the server retained: there is no job.json to rerun from, so
  // re-running means re-planning from the retained inputs into a
  // NEW job dir (a new job id — the old dir is never written into
  // except by the CLI, and a fresh run gets a fresh id per scope
  // §8 Q9).
  const interrupted =
    (await scanJobs()).find((j) => j.id === id)?.status === "interrupted";
  if (
    interrupted && retained &&
    (body.error === "rerun_unavailable" ||
      body.error === "rerun_not_implemented")
  ) {
    return await rerunFromInputs(id, retained);
  }
  return errorResponse(
    body.error ?? "rerun_failed",
    body.message ?? `rerun of ${id} failed`,
    httpStatusForCliError(body.error ?? "rerun_failed"),
  );
}

/** Workholding guides (V2.9): POST /api/jobs/:id/guides, 1:1 with
 * `mldxf guides` — the server spawns the CLI and returns its
 * stdout JSON, computing nothing about the job itself. A refusal
 * (placeholder T-track, no clamps, v1 job) passes through with
 * the CLI's named error, so the UI shows it honestly instead of
 * an empty result. Synchronous: guides run in seconds, unlike a
 * plan run, so no background run is registered. */
async function handleGuides(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  if (!existsSync(dir))
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  const { body } = await runCli(["guides", dir, "--json"]);
  if (body.ok) return jsonResponse(body);
  return errorResponse(
    body.error ?? "guides_failed",
    body.message ?? `guides for ${id} failed`,
    httpStatusForCliError(body.error ?? "guides_failed"),
  );
}

/** Re-plan an interrupted job from its retained inputs into a NEW
 * job dir (new id). The old dir is never written into except by
 * the CLI, and a fresh run gets a fresh id per scope §8 Q9. *//** Toolpaths (V3.2): POST /api/jobs/:id/toolpaths, 1:1 with
 * `mldxf toolpaths` — async like a plan run (startToolpathsRun
 * registers a JobRun; progress over the same SSE endpoint, outcome
 * over the same status endpoint), because the Kookabus job is
 * 57k moves and must not block the page. A v1 job is refused
 * synchronously with the CLI's toolpaths_unavailable (the job
 * cannot gain toolpaths without the V2.2 job model); a job with a
 * run already in progress is refused with job_already_running
 * (409) rather than starting a second generator on the same dir.
 * On completion GET /api/jobs/:id returns the full job with its
 * `toolpaths` section (docs-v3/job_model_v3.md §11). */
async function handleToolpaths(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  if (!existsSync(dir))
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  const existing = runs.get(id);
  if (existing && existing.status === "running")
    return errorResponse(
      "job_already_running",
      `job ${id} already has a run in progress (status: running)`,
      409,
    );
  const found = await readJobFile(dir);
  if (!found || !found.data)
    return errorResponse(
      "job_invalid",
      `job ${id} could not be read`,
      400,
    );
  if ((found.data.job_version ?? 1) < 2)
    return errorResponse(
      "toolpaths_unavailable",
      `job ${id} is a v1 job (manifest.json only) — toolpaths need ` +
        "the V2.2 job model (job.json with layout + tool plan + " +
        "material). v1 jobs are read-only; re-run `mldxf plan` on " +
        "the source STEP instead",
      400,
    );
  const run = startToolpathsRun(id, dir);
  return jsonResponse(
    { ok: true, job: { job_id: run.id, job_dir: run.dir, status: "running" } },
    202,
  );
}

/** Start a `mldxf gcode` run in the background and register it
 * (V3.6): same machinery as a toolpaths run — the caller gets the
 * JobRun immediately (202), progress over the same SSE endpoint,
 * outcome over the same status endpoint. A Kookabus post
 * re-simulates 76k moves, so it is async like toolpaths, never
 * synchronous like guides. `post` is the requested post id, or
 * null for the CLI's default selection (job profile > machine.json
 * > masso-mm). */
function startGcodeRun(id: string, dir: string, post: string | null): JobRun {
  const run: JobRun = {
    id,
    dir,
    status: "running",
    cancelled: false,
    startedAt: new Date().toISOString(),
    progress: [],
    retained: null,
    sse: new Set(),
  };
  runs.set(id, run);
  const argv = ["gcode", dir, "--json"];
  if (post) argv.push("--post", post);
  log(`run ${id} started: mldxf ${argv.join(" ")}`);
  void runCliJob(run, argv, "gcode", "gcode_failed");
  return run;
}

/** G-code (V3.6): POST /api/jobs/:id/gcode, 1:1 with
 * `mldxf gcode` — async like a toolpaths run (startGcodeRun
 * registers a JobRun; progress over the same SSE endpoint,
 * outcome over the same status endpoint). Optional JSON body
 * `{"post": "<post-id>"}` selects the post; an absent body, an
 * empty body, or a body without a string `post` takes the CLI's
 * default selection. A v1 job is refused synchronously with the
 * CLI's toolpaths_unavailable, as is a v2/v3 job with no
 * toolpaths yet (G-code is posted from the toolpaths); a job
 * with a run already in progress is refused with
 * job_already_running (409). On completion GET /api/jobs/:id
 * returns the full job with its `gcode` section; an unverified
 * round-trip fails the run with `gcode_unverified` (the entry
 * is still recorded, verified: false — GET shows it). */
async function handleGcode(id: string, req: Request): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  if (!existsSync(dir))
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  const existing = runs.get(id);
  if (existing && existing.status === "running")
    return errorResponse(
      "job_already_running",
      `job ${id} already has a run in progress (status: running)`,
      409,
    );
  const found = await readJobFile(dir);
  if (!found || !found.data)
    return errorResponse(
      "job_invalid",
      `job ${id} could not be read`,
      400,
    );
  if ((found.data.job_version ?? 1) < 2)
    return errorResponse(
      "toolpaths_unavailable",
      `job ${id} is a v1 job (manifest.json only) — G-code needs ` +
        "the V2.2 job model (job.json with layout + tool plan + " +
        "material). v1 jobs are read-only; re-run `mldxf plan` on " +
        "the source STEP instead",
      400,
    );
  if (!found.data.toolpaths)
    return errorResponse(
      "toolpaths_unavailable",
      `job ${id} has no toolpaths — G-code is posted from the ` +
        "toolpaths. Run `mldxf toolpaths` first",
      400,
    );
  let post: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.post === "string" && body.post) post = body.post;
  } catch {
    // No body, or an unparseable one: the default post selection.
  }
  const run = startGcodeRun(id, dir, post);
  return jsonResponse(
    { ok: true, job: { job_id: run.id, job_dir: run.dir, status: "running" } },
    202,
  );
}

/** Job-model validation (V3.2): GET /api/jobs/:id/validate, 1:1
 * with `mldxf validate-job --json` — the server spawns the CLI
 * and returns the validator's JSON, computing nothing itself. */
async function handleValidate(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  if (!existsSync(dir))
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  const { body } = await runCli(["validate-job", dir, "--json"]);
  if (body.ok) return jsonResponse(body);
  return errorResponse(
    body.error ?? "job_invalid",
    body.message ?? `job ${id} failed validation`,
    httpStatusForCliError(body.error ?? "job_invalid"),
  );
}

/** Layer geometry (V3.3): GET /api/jobs/:id/geometry, 1:1 with
 * `mldxf geometry --json` — the server spawns the CLI and returns
 * the extractor's JSON (one entry per job layer: DXF loops as
 * sampled points + the layer's Z depths), computing nothing
 * itself. The 3D view fetches this; the toolpaths themselves come
 * from GET /api/jobs/:id. A v1 job is refused with the CLI's
 * geometry_unavailable (400); an unknown id is 404. */
async function handleGeometry(id: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir) return errorResponse("job_not_found", `no such job: ${id}`, 404);
  if (!existsSync(dir))
    return errorResponse("job_not_found", `job dir not found: ${dir}`, 404);
  const { body } = await runCli(["geometry", dir, "--json"]);
  if (body.ok) return jsonResponse(body);
  return errorResponse(
    body.error ?? "geometry_failed",
    body.message ?? `job ${id} has no layer geometry`,
    httpStatusForCliError(body.error ?? "geometry_failed"),
  );
}

async function rerunFromInputs(
  id: string,
  retained: RetainedInputs,
): Promise<Response> {
  const stepStem = basename(retained.stepPath).replace(/\.step$/i, "");
  const { id: newId, dir: newDir } = await uniqueJobDir(jobIdFor(stepStem));
  const run = startPlanRun(newId, newDir, retained.stepPath, retained.options, {
    stepPath: retained.stepPath,
    options: retained.options,
  });
  return jsonResponse(
    {
      ok: true,
      rerun_from_inputs: true,
      rerun_of: id,
      job: { job_id: run.id, job_dir: run.dir, status: "running" },
    },
    202,
  );
}

async function handleCancel(id: string): Promise<Response> {
  const run = runs.get(id);
  if (!run || run.status !== "running")
    return errorResponse(
      "job_not_running",
      `job ${id} is not running (status: ${run?.status ?? "unknown"})`,
      409,
    );
  await cancelRun(run);
  return jsonResponse({
    ok: true,
    id,
    status: run.status,
    cancelled: run.cancelled,
  });
}

async function handleStatus(id: string): Promise<Response> {
  const run = runs.get(id);
  if (!run) {
    const scanned = (await scanJobs()).find((j) => j.id === id);
    if (!scanned)
      return errorResponse("job_not_found", `no such job: ${id}`, 404);
    return jsonResponse({
      ok: true,
      id,
      status: scanned.status,
      cancelled: scanned.cancelled ?? false,
      can_rerun_from_inputs: scanned.can_rerun_from_inputs ?? false,
      progress: [],
      job: null,
      error: scanned.error ? { error: scanned.error, message: "" } : null,
    });
  }
  return jsonResponse({
    ok: true,
    id: run.id,
    status: run.status,
    cancelled: run.cancelled,
    pid: run.pid ?? null,
    progress: run.progress,
    job: run.job ?? null,
    error: run.error ?? null,
  });
}

function handleEvents(id: string): Response {
  const run = runs.get(id);
  if (!run)
    return errorResponse("job_not_found", `no such job: ${id}`, 404);
  let send: (line: string) => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      // The run's current status first, so a client connecting
      // mid-run (or before the CLI's first progress line — the
      // solid-count probe takes ~15 s of silence) knows immediately
      // what it connected to; then the replayed progress lines,
      // then live lines.
      controller.enqueue(
        enc.encode(
          `event: status\ndata: ${JSON.stringify({ id: run.id, status: run.status })}\n\n`,
        ),
      );
      // Replay buffered progress, then stream new lines live.
      for (const line of run.progress)
        controller.enqueue(enc.encode(`data: ${line}\n\n`));
      send = (line: string) => {
        try {
          if (line === "\u0000DONE") {
            controller.enqueue(
              enc.encode(
                `event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`,
              ),
            );
            controller.close();
          } else if (line.startsWith(":")) {
            // SSE comment (heartbeat) — sent raw, not as a data line.
            controller.enqueue(enc.encode(`${line}\n\n`));
          } else {
            controller.enqueue(enc.encode(`data: ${line}\n\n`));
          }
        } catch {
          /* client gone */
        }
      };
      run.sse.add(send);
      if (run.status !== "running") {
        // Connected after the run finished: replay is done, so send
        // the done event now instead of leaving the stream open.
        send("\u0000DONE");
      }
    },
    cancel() {
      run.sse.delete(send);
    },
  });
  // Heartbeat keeps the stream alive past any idle timeout, and
  // lets the UI tell a live stream from a stalled one.
  const heartbeat = setInterval(() => {
    if (run.status !== "running") {
      clearInterval(heartbeat);
      return;
    }
    try {
      send(": ping");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);
  void heartbeat;
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

const DOWNLOAD_TYPES: Record<string, string> = {
  ".dxf": "application/dxf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".step": "application/octet-stream",
};

async function handleDownload(id: string, file: string): Promise<Response> {
  const dir = jobDirFor(id);
  if (!dir || !existsSync(dir))
    return errorResponse("job_not_found", `no such job: ${id}`, 404);
  // Multi-segment paths (e.g. gcode/<job>-<post>.nc): every
  // segment must be a safe file name, and no ".." anywhere — the
  // download endpoint is not a file browser.
  if (!file.split("/").every((seg) => SAFE_FILE.test(seg)) || file.includes(".."))
    return errorResponse("invalid_download", `not a downloadable file: ${file}`);
  if (file === "zip") {
    const data = await zipJobDir(dir);
    return new Response(data as unknown as BodyInit, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${id}.zip"`,
      },
    });
  }
  // Serve exactly the job's outputs: for a v2 job, the names in
  // job.json's `outputs`; for a v1 job, the known v1 output files
  // present in the dir (DXF, manifest.txt, manifest.json,
  // report.md). Anything else is refused — the download endpoint
  // is not a file browser.
  const found = await readJobFile(dir);
  let allowed: Set<string> | null = null;
  if (found?.data && Array.isArray(found.data.outputs)) {
    allowed = new Set(
      found.data.outputs.map((o: any) =>
        typeof o === "string" ? o : o?.file ?? o?.name,
      ).filter(Boolean),
    );
  }
  const path = join(dir, file);
  if (!existsSync(path) || (await isDirectory(path)))
    return errorResponse("invalid_download", `no such output in job ${id}: ${file}`, 404);
  if (allowed) {
    if (!allowed.has(file))
      return errorResponse("invalid_download", `${file} is not in job ${id}'s outputs`, 403);
  } else if (
    !(
      file.endsWith(".dxf") ||
      file === "manifest.txt" ||
      file === "manifest.json" ||
      file === "report.md" ||
      file.startsWith("manifest_plan_")
    )
  ) {
    return errorResponse("invalid_download", `${file} is not a job output`, 403);
  }
  const ext = file.slice(file.lastIndexOf("."));
  const data = await Bun.file(path).arrayBuffer();
  return new Response(data, {
    headers: {
      "content-type": DOWNLOAD_TYPES[ext] ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${file}"`,
    },
  });
}

// ---------------------------------------------------------------- static UI

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve a file from server/public/ (V2.6). GET / serves
 * public/index.html; GET /public/* serves the file under it. The
 * resolved path must stay inside PUBLIC_DIR — no traversal. The
 * UI is plain HTML + vanilla JS + one CSS file, no build step, no
 * external resources (localhost, offline-safe). */
async function serveStatic(pathname: string): Promise<Response | null> {
  const rel =
    pathname === "/" ? "index.html" : pathname.replace(/^\/public\//, "");
  if (rel.includes("..")) return null;
  const path = resolve(PUBLIC_DIR, rel);
  if (path !== PUBLIC_DIR && !path.startsWith(PUBLIC_DIR + sep)) return null;
  if (!existsSync(path)) return null;
  const ext = path.slice(path.lastIndexOf("."));
  const type = STATIC_TYPES[ext] ?? "application/octet-stream";
  return new Response(await Bun.file(path).arrayBuffer(), {
    headers: { "content-type": type },
  });
}

// ---------------------------------------------------------------- routing

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" &&
        (url.pathname === "/" || url.pathname.startsWith("/public/"))) {
      const file = await serveStatic(url.pathname);
      if (file) return file;
      return errorResponse(
        "not_found",
        `no such file: ${req.method} ${url.pathname}`,
        404,
      );
    }
    if (req.method === "GET" && url.pathname === "/api/health")
      return jsonResponse({
        ok: true,
        service: "mldxf-server",
        cli_version: CLI_VERSION,
        home: HOME,
        jobs_root: JOBS_ROOT,
      });
    if (parts[0] === "api" && parts[1] === "jobs") {
      if (parts.length === 2 && req.method === "POST")
        return await handleCreateJob(req);
      if (parts.length === 2 && req.method === "GET")
        return jsonResponse({ ok: true, jobs: await scanJobs() });
      const id = parts[2];
      if (!id) return errorResponse("job_not_found", "job id required", 404);
      if (parts.length === 3 && req.method === "GET")
        return await handleGetJob(id);
      if (parts.length === 4 && parts[3] === "rerun" && req.method === "POST")
        return await handleRerun(id);
      if (parts.length === 4 && parts[3] === "guides" && req.method === "POST")
        return await handleGuides(id);
      if (parts.length === 4 && parts[3] === "toolpaths" && req.method === "POST")
        return await handleToolpaths(id);
      if (parts.length === 4 && parts[3] === "gcode" && req.method === "POST")
        return await handleGcode(id, req);
      if (parts.length === 4 && parts[3] === "validate" && req.method === "GET")
        return await handleValidate(id);
      if (parts.length === 4 && parts[3] === "geometry" && req.method === "GET")
        return await handleGeometry(id);
      if (parts.length === 4 && parts[3] === "cancel" && req.method === "POST")
        return await handleCancel(id);
      if (parts.length === 4 && parts[3] === "status" && req.method === "GET")
        return await handleStatus(id);
      if (parts.length === 4 && parts[3] === "events" && req.method === "GET")
        return handleEvents(id);
      if (parts.length >= 5 && parts[3] === "download" && req.method === "GET")
        return await handleDownload(id, parts.slice(4).join("/"));
      return errorResponse("not_found", `no such endpoint: ${req.method} ${url.pathname}`, 404);
    }
    if (parts[0] === "api" && parts.length === 2 &&
        parts[1] in LIBRARIES) {
      if (req.method === "GET") return await libraryGet(parts[1]);
      if (req.method === "PUT") return await libraryPut(parts[1], req);
      return errorResponse("not_found", `method ${req.method} not allowed here`, 405);
    }
    return errorResponse("not_found", `no such endpoint: ${req.method} ${url.pathname}`, 404);
  } catch (e: any) {
    console.error(e);
    return errorResponse("internal_error", `${e?.name ?? "Error"}: ${e?.message ?? e}`, 500);
  }
}

// ---------------------------------------------------------------- startup

function parsePort(): number {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const env = Number(process.env.PORT);
  if (Number.isInteger(env) && env > 0) return env;
  return 3000;
}

const PORT = parsePort();

await Bun.write(
  join(STATE_DIR, ".keep"),
  "",
).catch(() => {});
await import("node:fs/promises").then((fs) =>
  fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {}),
);

// Prune retained inputs whose upload is gone (tmpdir was wiped).
for (const [id, retained] of Object.entries(retainedIndex)) {
  if (!existsSync(retained.stepPath)) delete retainedIndex[id];
}
await saveRetainedIndex();

const scanned = await scanJobs();
const interrupted = scanned.filter((j) => j.status === "interrupted").length;

// The 3D view bundle (V3.3) is a build artifact, not checked in:
// ensure it exists and is fresh before serving, so every launch
// path — `mldxf serve`, `start.bat`, and a direct `bun run
// server.ts` (the path the test drivers use) — serves a working
// view. Best-effort and synchronous at startup: a failed build
// never blocks the server (the view falls back to the toolpath
// list), and an up-to-date bundle is a no-op.
try {
  const built = Bun.spawnSync(
    [process.execPath, join(REPO_ROOT, "ts", "view3d", "build.ts"), "--json"],
    { cwd: REPO_ROOT, timeout: 120000 },
  );
  const out = built.stdout ? built.stdout.toString().trim() : "";
  const body = out ? JSON.parse(out) : null;
  if (built.exitCode === 0 && body?.ok) {
    log(`3D view bundle: ${body.built ? "built" : "up to date"} (${body.bundle})`);
  } else {
    log(`3D view bundle: build did not run cleanly (${body?.error ?? "exit " + built.exitCode}) — the view will fall back to the toolpath list`);
  }
} catch (e: any) {
  log(`3D view bundle: ensure-build failed (${e?.message ?? e}) — the view will fall back to the toolpath list`);
}

log(
  `mldxf-server starting: home=${HOME} jobs=${JOBS_ROOT} ` +
    `(${scanned.length} job dir(s) scanned, ${interrupted} interrupted)`,
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  // No timeout shorter than a run: SSE streams and long polls must
  // survive a ~6-minute Kookabus orientation search.
  idleTimeout: 0,
  fetch: handleRequest,
});

log(`mldxf-server listening on http://127.0.0.1:${server.port}`);
log(`CLI: ${PYTHON} ${MLDXF_PY} (cli version ${CLI_VERSION})`);
