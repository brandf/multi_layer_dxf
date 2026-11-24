#!/usr/bin/env bun
/**
 * Run the job-prep E2E harness (`server/test-job-prep.html?mode=e2e`)
 * end to end against the real server.
 *
 * The harness cannot run against the shipped server alone: the server
 * serves only `/` and `/public/*`, so neither the harness page nor
 * its `/real_container.step` fixture is reachable. This driver starts
 * the real server untouched and puts a test-only reverse proxy
 * (test-e2e-proxy.ts) in front of it on a second port, so the harness,
 * the fixture, the static files and the API all share one origin.
 * The shipped server, the harness and the E2E assertions are all
 * unchanged; only this driver and the proxy are test-only.
 *
 * Flow: scratch MLDXF_HOME -> `mldxf init` (default tools inventory:
 * EM3.17/D2.25/EM6.35 owned, EM4.76 not — exactly the mix the E2E
 * asserts) -> real server -> proxy -> headless Chromium via CDP ->
 * load the harness -> wait for `JOBPREP DONE:` in the title -> print
 * the harness's own PASS/FAIL lines -> exit code = fail count.
 *
 * Usage: bun server/run-job-prep-e2e.ts [--app-port N] [--proxy-port N]
 *        [--debug-port N] [--keep-home]   (keeps the scratch home for
 *        debugging; default removes it)
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
const HOME = join(process.env.HOME!, "workspace", ".mldxf-jobprep-e2e-home");
const PROFILE = join(process.env.HOME!, "workspace", "jobprep-e2e-chrome-profile");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log("[e2e-driver]", ...a);

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
  // ---- scratch home ------------------------------------------------
  await $`rm -rf ${HOME}`.quiet();
  log("init scratch home", HOME);
  const init = await $`./.venv/bin/python mldxf.py init`
    .cwd(REPO)
    .env({ ...process.env, MLDXF_HOME: HOME })
    .quiet()
    .nothrow();
  if (init.exitCode !== 0) {
    throw new Error(`mldxf init failed:\n${init.stdout}\n${init.stderr}`);
  }

  // ---- real server (untouched) --------------------------------------
  log("start real server on", APP_PORT);
  const serverProc = Bun.spawn(
    ["bun", "run", "server/server.ts", "--port", APP_PORT],
    {
      cwd: REPO,
      env: { ...process.env, MLDXF_HOME: HOME },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // ---- test-only proxy in front of it -------------------------------
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
      `http://127.0.0.1:${PROXY_PORT}/test-job-prep.html`,
      30000,
      "proxy harness page",
    );
    log("proxy serves the harness page");

    // ---- headless Chromium via CDP (same pattern as v28-e2e.ts) ------
    chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${PROFILE}`,
        `http://127.0.0.1:${PROXY_PORT}/test-job-prep.html?mode=e2e`,
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

    // ---- wait for the harness to finish (its own deadline is 10 min) --
    log("waiting for JOBPREP DONE (harness deadline 10 min) ...");
    const deadline = Date.now() + 660_000;
    let title = "";
    while (Date.now() < deadline) {
      title = (await evalJs(`document.title`)) ?? "";
      if (title.startsWith("JOBPREP DONE:")) break;
      await sleep(2000);
    }
    const output: string = (await evalJs(
      `document.getElementById('test-output').textContent`,
    )) ?? "";
    console.log("\n--- harness output ---");
    console.log(output);
    console.log("--- end harness output ---\n");
    const passes = output.split("\n").filter((l) => l.startsWith("PASS ")).length;
    failures = output.split("\n").filter((l) => l.startsWith("FAIL ")).length;
    log(`harness: ${passes} pass, ${failures} fail (title: ${title})`);
    if (pageExceptions.length) {
      failures += 1;
      log("FAIL page JS exceptions:", pageExceptions.slice(0, 3).join(" | "));
    }
    if (!title.startsWith("JOBPREP DONE:")) {
      failures += 1;
      log("FAIL harness did not finish within 11 min; title:", JSON.stringify(title));
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
  console.log("E2E driver error: " + (e?.stack ?? e));
  process.exit(1);
});
