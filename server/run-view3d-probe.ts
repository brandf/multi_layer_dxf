#!/usr/bin/env bun
/**
 * Render probe for the V3.3 3D view (test-only).
 *
 * Mounts the real view against the real 8-layer container job in
 * headless Chromium with SwiftShader WebGL + WebGPU
 * (--enable-unsafe-webgpu --use-angle=swiftshader; the E2E
 * driver's --disable-gpu flags have NO WebGL, so the E2E driver
 * can only exercise the fallback — this probe is the check that
 * the real canvas draws). The --enable-unsafe-webgpu flag is
 * load-bearing for the sim: without it navigator.gpu exists but
 * requestAdapter() returns no adapter, simulateGpu throws, and
 * runSim has no CPU fallback — the sim fails (diagnosed
 * Nov 24, 2026; the flag set is the one ts/sim_gpu.ts documents
 * as the probe driver's flags). Asserts the canvas pixels are
 * non-blank, the 8 layer planes mount, and playback scrub works.
 *
 * Flow: scratch MLDXF_HOME -> `mldxf init` -> CLI plan of
 * test/real_container.step --auto -> `mldxf toolpaths` (v3 job) ->
 * `mldxf guides` (clamp boxes need the guides step; the init
 * home's T-track is a placeholder, so guides refuse there — the
 * probe borrows the parity fixture's real machine + clamp
 * inventory, the same fixture the guides verification uses) ->
 * real server -> test proxy (serves view3d-probe.html) -> headless
 * Chromium via CDP -> wait for `VIEW3D DONE:` in the title -> print
 * the probe's PASS/FAIL lines -> exit code = fail count.
 *
 * Usage: bun server/run-view3d-probe.ts [--app-port N]
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
const APP_PORT = arg("--app-port", "3895");
const PROXY_PORT = arg("--proxy-port", "3896");
const DEBUG_PORT = Number(arg("--debug-port", "9223"));
const KEEP_HOME = process.argv.includes("--keep-home");
const HOME = join(process.env.HOME!, "workspace", ".mldxf-view3d-probe-home");
const PROFILE = join(process.env.HOME!, "workspace", "view3d-probe-chrome-profile");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log("[view3d-probe]", ...a);

async function waitForHttp(url: string, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r.status;
      last = `HTTP ${r.status}`;
    } catch (e: any) {
      last = String(e?.message ?? e);
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what} at ${url} (last: ${last})`);
}

async function main() {
  await $`rm -rf ${HOME}`.quiet();
  log("init scratch home", HOME);
  const env = { ...process.env, MLDXF_HOME: HOME };
  const init = await $`./.venv/bin/python mldxf.py init`
    .cwd(REPO).env(env).quiet().nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`mldxf init failed:\n${init.stdout}\n${init.stderr}`);
  }
  // Plan the real container (--auto) via the CLI, then toolpaths.
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

  // Guides: the init home's T-track is a placeholder, so guides
  // refuse there — borrow the parity fixture's real machine +
  // clamp inventory (slots x@6, x@84, y@144; test-tt-clamp
  // 20x12, count 4), the same fixture the guides verification
  // uses. The job then carries the guides' contact-balance
  // placement; the probe page reads the job's own clamps and asserts the
  // boxes match them, so it tests rendering fidelity, not the
  // placement policy (the origin keep-out moved the fixture
  // from (15,6)+(144,75) to (135,6)+(15,84) on Nov 25, 2026; the
  // Nov 25 layout change moved it again to (145,6)+(15,84); the
  // V3.16 contact-balance greedy moved it to (70,6)+(125,84)).
  const parityHome = join(
    REPO, "..", "goals", "onshape-to-vcarve-2-5d-automation",
    "hidden_files", "parity_2026-11-23", "home",
  );
  await $`cp ${join(parityHome, "machine.json")} ${join(HOME, "machine.json")}`.quiet();
  await $`cp ${join(parityHome, "clamps.json")} ${join(HOME, "clamps.json")}`.quiet();
  const guides = await $`./.venv/bin/python mldxf.py guides ${jobDir} --json`
    .cwd(REPO).env(env).quiet().nothrow();
  if (guides.exitCode !== 0) {
    throw new Error(`mldxf guides failed:\n${guides.stdout}\n${guides.stderr}`);
  }
  log("guides run (clamps placed)");

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

  let chrome: any = null;
  let ws: WebSocket | null = null;
  let failures = 0;
  try {
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`, 30000, "app server health");
    log("app server healthy");
    await waitForHttp(
      `http://127.0.0.1:${PROXY_PORT}/view3d-probe.html`,
      30000,
      "proxy probe page",
    );
    log("proxy serves the probe page");

    // SwiftShader WebGL + WebGPU: --enable-unsafe-webgpu and
    // --use-angle=swiftshader, and NOT --disable-gpu (that flag
    // leaves this VM's Chromium with no WebGL at all — the E2E
    // driver's fallback case). --enable-unsafe-webgpu is
    // load-bearing for the sim: without it navigator.gpu exists
    // but requestAdapter() returns no adapter and the sim fails
    // (see the header comment; the flag set is the one
    // ts/sim_gpu.ts documents as the probe driver's flags).
    chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--use-angle=swiftshader",
        `--user-data-dir=${PROFILE}`,
        `http://127.0.0.1:${PROXY_PORT}/view3d-probe.html?job=${jobId}`,
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
        const page = (list as any[]).find((t: any) => t.type === "page");
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch {}
    }
    if (!wsUrl) throw new Error("chrome did not expose a page target");
    ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = (e) => reject(new Error("ws error: " + JSON.stringify(e)));
    });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
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
    const send = (method: string, params: any = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws!.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression: string): Promise<any> => {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          "page JS threw: " +
            (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
        );
      }
      return r.result?.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");

    // 180 s: the page's first sim alone allows 120 s (GPU headline
    // ~27 s + the background CPU seek build), and the V3.5 GPU
    // fallback step re-runs Simulate on the CPU afterwards — 60 s
    // was already marginal and raced finish() by a hair.
    log("waiting for VIEW3D DONE (180 s bound) ...");
    const deadline = Date.now() + 180000;
    let title = "";
    while (Date.now() < deadline) {
      title = (await evalJs(`document.title`)) ?? "";
      if (title.startsWith("VIEW3D DONE:")) break;
      await sleep(1000);
    }
    const output: string = (await evalJs(
      `document.getElementById('probe-output').textContent`,
    )) ?? "";
    console.log("\n--- probe output ---");
    console.log(output);
    console.log("--- end probe output ---\n");
    const passes = output.split("\n").filter((l) => l.startsWith("PASS ")).length;
    failures = output.split("\n").filter((l) => l.startsWith("FAIL ")).length;
    log(`probe: ${passes} pass, ${failures} fail (title: ${title})`);
    if (pageExceptions.length) {
      failures += 1;
      log("FAIL page JS exceptions:", pageExceptions.slice(0, 3).join(" | "));
    }
    if (!title.startsWith("VIEW3D DONE:")) {
      failures += 1;
      log("FAIL probe did not finish within 180 s; title:", JSON.stringify(title));
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
  console.log("Probe driver error: " + (e?.stack ?? e));
  process.exit(1);
});
