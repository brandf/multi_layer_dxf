#!/usr/bin/env bun
/**
 * WebGPU sim probe driver (test-only, V3.5).
 *
 * Builds server/webgpu-sim-probe-entry.ts into
 * server/public/vendor/webgpu-sim-probe.js, then mounts the probe
 * page against the real 8-layer container job in headless Chromium
 * with WebGPU enabled (--enable-unsafe-webgpu, SwiftShader ANGLE)
 * and reads the verdict:
 *   UNAVAILABLE — no WebGPU in this browser (navigator.gpu absent
 *     or no adapter). Exit 0: the GPU measurement is deferred to a
 *     machine with WebGPU (Brandon's Windows laptop), and the CPU
 *     backend is the fallback. This is the honest outcome on this
 *     VM, not a failure — a CPU-only result presented as a GPU
 *     result would be the failure.
 *   PASS — GPU ran and the grids agree within tolerance. Exit 0.
 *   FAIL — GPU ran but the grids disagree, or a step threw. Exit 1.
 *
 * Flow mirrors server/run-view3d-probe.ts: scratch MLDXF_HOME ->
 * `mldxf init` -> CLI plan of test/real_container.step --auto ->
 * `mldxf toolpaths` (v3 job) -> real server -> test proxy (serves
 * webgpu-sim-probe.html) -> headless Chromium via CDP -> wait for
 * `WEBGPU DONE:` in the title -> print the probe's lines.
 *
 * Usage: bun server/run-webgpu-sim-probe.ts [--app-port N]
 *        [--proxy-port N] [--debug-port N] [--keep-home]
 */
import { join } from "node:path";
import { $ } from "bun";

const REPO = join(import.meta.dir, "..");
const CHROME =
  process.env.CHROME ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP_PORT = arg("--app-port", "3897");
const PROXY_PORT = arg("--proxy-port", "3898");
const DEBUG_PORT = Number(arg("--debug-port", "9224"));
const KEEP_HOME = process.argv.includes("--keep-home");
const HOME = join(process.env.HOME!, "workspace", ".mldxf-webgpu-probe-home");
const PROFILE = join(process.env.HOME!, "workspace", "webgpu-probe-chrome-profile");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[webgpu-probe]", ...a);

async function waitForHttp(url: string, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r.status;
      last = `HTTP ${r.status}`;
    } catch (e: unknown) {
      last = String((e as Error)?.message ?? e);
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what} at ${url} (last: ${last})`);
}

async function main() {
  // Build the probe bundle (test artifact, never checked in).
  log("building the probe bundle");
  const built = await Bun.build({
    entrypoints: [join(REPO, "server", "webgpu-sim-probe-entry.ts")],
    outdir: join(REPO, "server", "public", "vendor"),
    naming: "webgpu-sim-probe.js",
    target: "browser",
  });
  if (!built.success) {
    for (const l of built.logs) log("build log:", l.message);
    throw new Error("probe bundle build failed");
  }
  log("probe bundle built");

  await $`rm -rf ${HOME}`.quiet();
  log("init scratch home", HOME);
  const env = { ...process.env, MLDXF_HOME: HOME };
  const init = await $`./.venv/bin/python mldxf.py init`
    .cwd(REPO).env(env).quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`mldxf init failed:\n${init.stdout}\n${init.stderr}`);
  }
  const plan = await $`./.venv/bin/python mldxf.py plan test/real_container.step --auto --json`
    .cwd(REPO).env(env).quiet().nothrow();
  if (plan.exitCode !== 0) {
    throw new Error(`mldxf plan failed:\n${plan.stdout}\n${plan.stderr}`);
  }
  const planned = JSON.parse(plan.stdout as unknown as string);
  const jobDir = (planned.job as { job_dir: string }).job_dir;
  const jobId = jobDir.split("/").pop()!;
  log("planned job", jobId);
  const tp = await $`./.venv/bin/python mldxf.py toolpaths ${jobDir} --json`
    .cwd(REPO).env(env).quiet().nothrow();
  if (tp.exitCode !== 0) {
    throw new Error(`mldxf toolpaths failed:\n${tp.stdout}\n${tp.stderr}`);
  }
  log("toolpaths generated (v3 job)");

  log("start real server on", APP_PORT);
  const serverProc = Bun.spawn(
    ["bun", "run", "server/server.ts", "--port", APP_PORT],
    { cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
  );
  log("start test proxy on", PROXY_PORT, "-> app", APP_PORT);
  const proxyProc = Bun.spawn(
    ["bun", "server/test-e2e-proxy.ts", "--app", APP_PORT, "--port", PROXY_PORT],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );

  let chrome: ReturnType<typeof Bun.spawn> | null = null;
  let ws: WebSocket | null = null;
  let failures = 0;
  let verdict = "";
  try {
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`, 30000, "app server health");
    log("app server healthy");
    await waitForHttp(
      `http://127.0.0.1:${PROXY_PORT}/webgpu-sim-probe.html`,
      30000,
      "proxy probe page",
    );
    log("proxy serves the probe page");

    // WebGPU via Dawn/SwiftShader behind --enable-unsafe-webgpu.
    // (On this VM navigator.gpu is absent under every flag set
    // tried — the probe then reports UNAVAILABLE, exit 0.)
    chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--use-angle=swiftshader",
        `--user-data-dir=${PROFILE}`,
        `http://127.0.0.1:${PROXY_PORT}/webgpu-sim-probe.html?job=${jobId}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let wsUrl = "";
    for (let i = 0; i < 30 && !wsUrl; i++) {
      await sleep(1000);
      try {
        const list = await (
          await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
        ).json();
        const page = (list as unknown[]).find((t) => (t as { type?: string }).type === "page");
        if (page) wsUrl = (page as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      } catch {}
    }
    if (!wsUrl) throw new Error("chrome did not expose a page target");
    ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = (e) => reject(new Error("ws error: " + JSON.stringify(e)));
    });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const pageExceptions: string[] = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        pageExceptions.push(`${d?.exception?.description ?? d?.text ?? "exception"}`);
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws!.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression: string): Promise<unknown> => {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          "page JS threw: " +
            ((r.exceptionDetails as { exception?: { description?: string }; text?: string }).exception?.description ??
              (r.exceptionDetails as { text?: string }).text),
        );
      }
      return (r.result as { value?: unknown })?.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");

    log("waiting for WEBGPU DONE (120 s bound) ...");
    const deadline = Date.now() + 120000;
    let title = "";
    while (Date.now() < deadline) {
      title = ((await evalJs(`document.title`)) as string) ?? "";
      if (title.startsWith("WEBGPU DONE:")) break;
      await sleep(1000);
    }
    const output: string = ((await evalJs(
      `document.getElementById('probe-output').textContent`,
    )) as string) ?? "";
    console.log("\n--- probe output ---");
    console.log(output);
    console.log("--- end probe output ---\n");
    const verdictLine = output.split("\n").find((l) => l.startsWith("VERDICT: "));
    verdict = verdictLine ? verdictLine.slice("VERDICT: ".length).trim() : "";
    const passes = output.split("\n").filter((l) => l.startsWith("PASS ")).length;
    failures = output.split("\n").filter((l) => l.startsWith("FAIL ")).length;
    log(`probe: ${passes} pass, ${failures} fail, verdict=${verdict} (title: ${title})`);
    if (pageExceptions.length) {
      failures += 1;
      log("FAIL page JS exceptions:", pageExceptions.slice(0, 3).join(" | "));
    }
    if (!title.startsWith("WEBGPU DONE:")) {
      failures += 1;
      log("FAIL probe did not finish within 120 s; title:", JSON.stringify(title));
    }
    if (verdict !== "PASS" && verdict !== "UNAVAILABLE") {
      failures += 1;
      log("FAIL unexpected verdict:", JSON.stringify(verdict));
    }
  } finally {
    try {
      ws?.close();
    } catch {}
    if (chrome) {
      chrome.kill();
      try {
        await chrome.exited;
      } catch {}
    }
    proxyProc.kill();
    serverProc.kill();
    try {
      await proxyProc.exited;
    } catch {}
    try {
      await serverProc.exited;
    } catch {}
    if (!KEEP_HOME) {
      await $`rm -rf ${HOME}`.quiet().nothrow();
      log("scratch home removed");
    } else {
      log("scratch home kept at", HOME);
    }
  }
  process.exit(failures);
}

main().catch((e) => {
  console.log("Probe driver error: " + ((e as Error)?.stack ?? e));
  process.exit(1);
});
