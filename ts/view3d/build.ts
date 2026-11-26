#!/usr/bin/env bun
// V3.3 build step — the project's first one (V3_SCOPE.md §4.5).
//
// Bundles the 3D view entry (ts/view3d/entry.ts, three.js included)
// into server/public/vendor/view3d.js. The bundle is a BUILD
// ARTIFACT, not checked in (see .gitignore); `mldxf serve` /
// `start.bat` build it when it is missing or stale, and the server
// ensures it at startup too, so the double-click flow still works
// with nothing extra to run. The server stays dependency-free at
// runtime: it serves the bundle as a static file, exactly as it
// serves the rest of server/public/.
//
//   bun ts/view3d/build.ts [--json]
//   -> {ok, built, bundle, reason} — built=false means up to date.
//   bun ts/view3d/build.ts --force   — rebuild even when up to date.
//
// Stale = the bundle is missing, or any input (entry, model,
// three's package.json) is newer than the bundle. The build is
// deterministic for a pinned three version (bun.lock), so a
// rebuild of unchanged inputs is a no-op for the page.
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(import.meta.dir, "entry.ts");
const MODEL = join(import.meta.dir, "model.ts");
// V3.4: the entry imports the sim engine + tool profiles, so they
// are staleness inputs too — a sim change must rebuild the bundle.
// V3.5: the seek engine + GPU backend join them (the entry imports
// both for the seekable sim).
const SIM = join(ROOT, "ts", "sim.ts");
const TOOLS = join(ROOT, "ts", "tools.ts");
const SIM_SEEK = join(ROOT, "ts", "sim_seek.ts");
const SIM_GPU = join(ROOT, "ts", "sim_gpu.ts");
// Clamp check (V3.15 follow-up): the entry imports it for the
// toolpath-vs-clamp summary line, so it joins the inputs too.
const CLAMP_CHECK = join(ROOT, "ts", "clamp_check.ts");
const THREE_PKG = join(ROOT, "node_modules", "three", "package.json");
const OUTDIR = join(ROOT, "server", "public", "vendor");
const BUNDLE = join(OUTDIR, "view3d.js");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const force = args.includes("--force");

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function emit(obj: Record<string, unknown>): void {
  if (asJson) console.log(JSON.stringify(obj));
  else if (obj.ok) {
    console.log(
      obj.built
        ? `view3d bundle built: ${obj.bundle} (${obj.reason})`
        : `view3d bundle up to date: ${obj.bundle}`,
    );
  } else {
    console.error(`view3d build failed: ${obj.error}: ${obj.message}`);
  }
}

async function main(): Promise<void> {
  const bundleMtime = existsSync(BUNDLE) ? mtime(BUNDLE) : 0;
  const newestInput = Math.max(mtime(ENTRY), mtime(MODEL), mtime(SIM), mtime(TOOLS), mtime(SIM_SEEK), mtime(SIM_GPU), mtime(CLAMP_CHECK), mtime(THREE_PKG));
  if (!force && bundleMtime > 0 && newestInput <= bundleMtime) {
    emit({ ok: true, built: false, bundle: BUNDLE, reason: "up to date" });
    return;
  }
  if (!existsSync(THREE_PKG)) {
    emit({
      ok: false, built: false, bundle: BUNDLE,
      error: "three_missing",
      message: "three is not installed — run `bun install three` in the repo root first",
    });
    process.exit(1);
  }
  const reason = !existsSync(BUNDLE)
    ? "bundle missing"
    : force ? "forced rebuild" : "inputs newer than bundle";
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    // Bun names the output after the entry file (entry.js) unless
    // told otherwise — the served name is view3d.js.
    naming: { entry: "view3d.js" },
    target: "browser",
    // Classic script, not ESM: the app loads the bundle with a
    // plain <script> tag, and an `export{...}` footer would be a
    // SyntaxError there. The entry assigns window.MldxfView3d
    // itself, so no module exports are needed.
    format: "iife",
    minify: true,
  });
  if (!result.success) {
    const detail = result.logs.map((l) => l.message).join("; ");
    emit({
      ok: false, built: false, bundle: BUNDLE,
      error: "build_failed", message: detail || "bun build failed",
    });
    process.exit(1);
  }
  emit({ ok: true, built: true, bundle: BUNDLE, reason });
}

main().catch((e: unknown) => {
  const err = e as Error;
  emit({
    ok: false, built: false, bundle: BUNDLE,
    error: "internal_error", message: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`,
  });
  process.exit(2);
});
