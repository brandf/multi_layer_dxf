#!/usr/bin/env bun
/**
 * Test-only reverse proxy for the job-prep E2E harness.
 *
 * The shipped server (server.ts) serves only `/` and `/public/*`, so
 * the harness page (`test-job-prep.html`) and its fixture
 * (`/real_container.step`) are not reachable through it — and adding
 * a test route to the shipped server is out of the question. This
 * proxy puts everything on one origin without touching the server:
 *
 *   GET /test-job-prep.html  -> served from server/test-job-prep.html
 *   GET /view3d-probe.html   -> served from server/view3d-probe.html
 *                               (V3.3 render probe, SwiftShader WebGL)
 *   GET /webgpu-sim-probe.html -> served from server/webgpu-sim-probe.html
 *                               (V3.5 GPU sim probe, WebGPU compute)
 *   GET /real_container.step -> served from test/real_container.step
 *   everything else          -> proxied to the real app server
 *                               (static files, /api/*, SSE included)
 *
 * The harness's own code and assertions are unchanged: it still
 * fetches `/real_container.step` and loads `/public/job-prep.js` as
 * written. Only this test process and the runner know the proxy
 * exists. Nothing here ships: it is started and stopped by
 * run-job-prep-e2e.ts and never runs in production.
 *
 * Usage: bun server/test-e2e-proxy.ts --app <app-port> --port <proxy-port>
 */
import { join } from "node:path";

const SERVER_DIR = import.meta.dir;
const REPO_ROOT = join(SERVER_DIR, "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP_PORT = arg("--app", "3897");
const PROXY_PORT = Number(arg("--port", "3898"));
const UPSTREAM = `http://127.0.0.1:${APP_PORT}`;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PROXY_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const stamp = new Date().toISOString();

    // Harness page (test-only file, not served by the shipped server).
    if (req.method === "GET" && url.pathname === "/test-job-prep.html") {
      console.log(`[proxy ${stamp}] serve test-job-prep.html from disk`);
      return new Response(Bun.file(join(SERVER_DIR, "test-job-prep.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // 3D view render probe (V3.3, test-only — same treatment).
    if (req.method === "GET" && url.pathname === "/view3d-probe.html") {
      console.log(`[proxy ${stamp}] serve view3d-probe.html from disk`);
      return new Response(Bun.file(join(SERVER_DIR, "view3d-probe.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // WebGPU sim probe (V3.5, test-only — same treatment).
    if (req.method === "GET" && url.pathname === "/webgpu-sim-probe.html") {
      console.log(`[proxy ${stamp}] serve webgpu-sim-probe.html from disk`);
      return new Response(Bun.file(join(SERVER_DIR, "webgpu-sim-probe.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // STEP fixture (test-only; the shipped server has no route for it).
    if (req.method === "GET" && url.pathname === "/real_container.step") {
      console.log(`[proxy ${stamp}] serve test/real_container.step from disk`);
      return new Response(Bun.file(join(REPO_ROOT, "test", "real_container.step")), {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    // Everything else: proxy to the real app server, streaming the
    // response body through (SSE must not be buffered).
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "host" && !HOP_BY_HOP.has(k.toLowerCase())) {
        headers.set(k, v);
      }
    });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
    });
    const outHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-length") {
        outHeaders.set(k, v);
      }
    });
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
});

console.log(`test-e2e-proxy listening on http://127.0.0.1:${server.port} -> ${UPSTREAM}`);
