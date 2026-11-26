#!/usr/bin/env bun
/**
 * Screenshot walkthrough of the website — the release-gate run.
 *
 * Drives the REAL app in a real browser end to end (fresh form ->
 * libraries -> a real container job through the file input -> Jobs
 * tab -> job detail -> workholding guides -> the V3 3D view ->
 * Simulate -> seek) and captures one screenshot per step, then
 * generates a single self-contained HTML document (screenshots
 * embedded as base64) for review. The HTML opens by
 * double-clicking with no server.
 *
 * This is the deliverable; the HTML is its output. Run it before
 * each new release so the walkthrough matches the build being
 * shipped: `bun server/run-screenshots.ts` from the repo root.
 * The HTML header names the VERSION it was run against and the
 * date, so a stale walkthrough is obvious. Default output:
 *   ~/workspace/goals/onshape-to-vcarve-2-5d-automation/files/V2_WEBSITE_WALKTHROUGH.html
 * (the V2 steps). For the V3 walkthrough — the same V2 steps plus
 * the 3D view / sim / seek steps:
 *   bun server/run-screenshots.ts --label V3 --out ~/workspace/goals/onshape-to-vcarve-2-5d-automation/files/V3_WEBSITE_WALKTHROUGH.html
 *
 * Headless Chromium runs with SwiftShader WebGL + WebGPU
 * (--use-angle=swiftshader --enable-unsafe-webgpu, never
 * --disable-gpu — that flag leaves this VM's Chromium with no
 * WebGL at all, and the 3D view would fall back to the toolpath
 * list). The --enable-unsafe-webgpu flag is load-bearing for the
 * sim: without it navigator.gpu exists but requestAdapter()
 * returns no adapter, simulateGpu throws, and runSim has no CPU
 * fallback — the sim fails instead of simming (diagnosed
 * Nov 24, 2026; the flag set is the one ts/sim_gpu.ts documents
 * as the probe driver's flags). With the flag, the sim runs on
 * the GPU backend in software (SwiftShader, ~27 s for the
 * container headline sim) and the seek data is built by a
 * background CPU build, so "seek ready" lands after the headline
 * sim — the step-11 wait allows for that.
 *
 * The run uses a scratch MLDXF_HOME (a fresh `mldxf init`), never
 * Brandon's real home. The machine.json in that home carries a
 * clearly-marked TEST T-track fixture (copied from the V2.9/V2.10
 * verification fixture — slots x@6, x@84, y@144 and a small test
 * clamp, invented so the guides have slots to use) — Brandon's real
 * T-track measurements are still unknown, and the HTML says so
 * wherever the fixture shows. The shipped server, the shipped UI
 * files and the pipeline are not modified by this script.
 *
 * HOW TO ADD A STEP (cover a new feature):
 *   1. Add ONE entry to STEPS below, in the order it should appear:
 *        {
 *          id: 'short-slug',            // also the PNG filename
 *          title: 'Heading in the HTML',
 *          caption: 'What this shows and what to look at.',
 *          action: async (ctx) => { ... },
 *        }
 *      - `caption` may be a function `(ctx) => string` when it needs
 *        values from the run (e.g. the real plan time). Keep it
 *        honest: say when something is a test fixture, a scratch
 *        home, or a placeholder — never caption a broken state as
 *        working.
 *      - `action` drives the UI to the state to capture, then WAITS
 *        until that state is visible (poll the page with
 *        ctx.waitFor). Throw if it never appears: a step that times
 *        out fails the run instead of screenshotting the wrong thing.
 *      - `setup` (optional) runs once before the action, for test-bed
 *        preparation only — e.g. editing the scratch home's
 *        machine.json. Never use it to drive the UI.
 *   2. Use the helpers on `ctx`: `showTab(id)` (App.showTab),
 *      `evalJs(expr)` (a value back from the page), `waitFor(expr,
 *      label, timeoutMs)` (polls until truthy), `shot(id)`
 *      (captures the full page; the PNG is embedded in the HTML).
 *      `ctx.jobId` is set by the step that completes a job; later
 *      steps read it.
 *   3. Re-run. The new shot lands in order in the HTML. No other
 *      file needs to change.
 *
 * Usage: bun server/run-screenshots.ts [--out PATH] [--label V2|V3]
 *        [--app-port N] [--debug-port N] [--keep-home] [--keep-pngs]
 * Exit code 0 when every step captured what it claims; non-zero
 * otherwise (no HTML is written on failure).
 */
import { join } from "node:path";
import { $ } from "bun";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";

const REPO = join(import.meta.dir, "..");
const CHROME =
  process.env.CHROME ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;
const STEP_PATH = join(REPO, "test", "real_container.step");
const DEFAULT_OUT = join(
  process.env.HOME!,
  "workspace",
  "goals",
  "onshape-to-vcarve-2-5d-automation",
  "files",
  "V2_WEBSITE_WALKTHROUGH.html",
);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = arg("--out", DEFAULT_OUT);
const LABEL = arg("--label", "V2");
const APP_PORT = arg("--app-port", "3901");
const DEBUG_PORT = Number(arg("--debug-port", "9225"));
const KEEP_HOME = process.argv.includes("--keep-home");
const KEEP_PNGS = process.argv.includes("--keep-pngs");
// Unique per run (Nov 26, 2026): the server's retained-inputs index
// lives in the OS temp dir and keys entries by home path, and the
// app restores the last job id from the Chrome profile — a fixed
// home/profile path let a previous (deleted) run's interrupted job
// leak into the next run's Jobs list (step 07 showed the dead run's
// "Interrupted" row) and a stale "Run interrupted" banner onto its
// fresh form (step 01). A fresh home + profile per run keeps each
// render self-contained; both are removed in the finally block.
const RUN_STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const HOME = join(process.env.HOME!, "workspace", `.mldxf-screenshots-home-${RUN_STAMP}`);
const PNG_DIR = join(process.env.HOME!, "workspace", ".mldxf-screenshots-pngs");
const PROFILE = join(process.env.HOME!, "workspace", `.mldxf-screenshots-chrome-profile-${RUN_STAMP}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log("[screenshots]", ...a);

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- context

type Ctx = {
  home: string;
  jobId: string | null;
  plan: any | null;
  guides: any | null;
  moves: number | null;
  simStatus: string | null;
  simInfo: any | null;
  seekMinHeight: number | null;
  evalJs: (expr: string) => Promise<any>;
  waitFor: (expr: string, label: string, timeoutMs?: number) => Promise<any>;
  showTab: (id: string) => Promise<void>;
  shot: (id: string) => Promise<string>;
  setFile: (path: string) => Promise<void>;
};

// ---------------------------------------------------------------- test T-track fixture
//
// Copied from the V2.9/V2.10 verification fixture (the parity home
// at goals/.../hidden_files/parity_2026-11-23/home/): three slots
// (x-axis at y=6 and y=84, y-axis at x=144) and a small test clamp
// (test-tt-clamp, 20x12 mm footprint, 5 mm keep-out, count 4). The
// container job (sheet 160x90) then guides two clamps from those
// slots — where exactly is the current guides logic's answer, not
// a number written here: the step-9 caption derives the positions
// from the run's own guides result (round 13 — the old comment
// asserted (43, 84) and (106.7, 84), which the current logic no
// longer returns). The fixture's slots and clamp are the test bed;
// the placement is whatever compute_guides returns for this job.
//
// NOTE on the y coordinate: the wave-4/V2.10 handoffs record the
// slot at y=88, but that does not reproduce under the current code:
// _slot_candidates requires the clamp footprint to sit fully inside
// the sheet, and a slot at y=88 on a 90 mm sheet leaves no room for
// any clamp (the 20x12 test clamp would span y 82..94). The y=84
// slot is the only one that works for this job (footprint y 78..90,
// 12 mm clear of the profile top at y=66 vs 11.35 mm required).
// These numbers are INVENTED for the test bed — Brandon's real
// T-track measurements are still unknown. The comment fields say so
// in the file itself, and the HTML captions say so wherever the
// fixture shows.

async function applyTestFixture(home: string): Promise<void> {
  const machinePath = join(home, "machine.json");
  const machine = JSON.parse(await readFile(machinePath, "utf8"));
  machine.t_track = {
    slot_width_mm: 8.0,
    placeholder: false,
    comment:
      "TEST FIXTURE — NOT A MEASUREMENT. Slots copied from the V2.9/V2.10 verification fixture (parity home). Brandon's real T-track measurements are still unknown; do not use these numbers on the real machine.",
    slots: [
      { axis: "x", at_y_mm: 6.0, from_x_mm: 0.0, to_x_mm: 1222.4 },
      { axis: "x", at_y_mm: 84.0, from_x_mm: 0.0, to_x_mm: 1222.4 },
      { axis: "y", at_x_mm: 144.0, from_y_mm: 0.0, to_y_mm: 1222.4 },
    ],
  };
  await writeFile(machinePath, JSON.stringify(machine, null, 1) + "\n");

  // The verification fixture's clamp list: the small test clamp
  // (the template t-track-clamp's 50x30 footprint cannot clear the
  // cuts from any slot on this sheet) and one tape strip, which the
  // guides list as the alternative.
  const clampsPath = join(home, "clamps.json");
  const clampsDoc = {
    version: 1,
    clamps: [
      {
        count: 4,
        footprint_mm: [20, 12],
        id: "test-tt-clamp",
        keep_out_mm: 5,
        method: "t_track_clamp",
        notes: "SCRATCH TEST FIXTURE ONLY — not a real clamp measurement.",
        t_track: true,
      },
      {
        count: 1,
        footprint_mm: [100, 25],
        id: "tape",
        keep_out_mm: 5,
        method: "tape",
        notes: "TEMPLATE — double-sided tape strips.",
        t_track: false,
      },
    ],
  };
  await writeFile(clampsPath, JSON.stringify(clampsDoc, null, 1) + "\n");
  log("test T-track fixture applied (slots x@6, x@84, y@144; test-tt-clamp + tape)");
}

// ---------------------------------------------------------------- steps
//
// One entry per screenshot, in display order. See the header comment
// for how to add one.

type Step = {
  id: string;
  title: string;
  caption: string | ((ctx: Ctx) => string);
  action: (ctx: Ctx) => Promise<void>;
  setup?: (ctx: Ctx) => Promise<void>;
};

const STEPS: Step[] = [
  {
    id: "01-job-prep-fresh",
    title: "1 — Job prep, fresh form",
    caption:
      "The app as it opens: the Job prep tab, blank form. Auto-orient is checked by default (settled Nov 23, 2026) — a default container run shows the 7.7 min plan (V3.14 calibrated estimate). Scratch test home, not Brandon's real setup.",
    action: async (ctx) => {
      await ctx.showTab("job-prep");
      // Minor 9 (confirmation judge): the profile is fresh per run
      // now, so the app opens on the default Setup stage — but the
      // click stays as a guard, so step 01 always shows the form
      // while the caption says "blank form".
      await ctx.evalJs(`document.querySelector('[data-role="jp-subtab-setup"]').click(); 'setup'`);
      await ctx.waitFor(
        `document.querySelector('[name="auto"]') && document.querySelector('[name="auto"]').checked === true && !!document.querySelector('[data-role="file-input"]')`,
        "fresh form with auto-orient checked",
      );
    },
  },
  {
    id: "02-tools",
    title: "2 — Tools tab (inventory)",
    caption:
      "The tool inventory from the scratch home: the standard sizes the planner recommends, marked owned or not in your inventory, plus the inventory table. The inventory is advisory in V2 — it changes the display, never the plan.",
    action: async (ctx) => {
      await ctx.showTab("tools");
      await ctx.waitFor(
        `document.querySelector('#tab-main').innerText.includes('Standard sizes owned') && document.querySelector('#tab-main').innerText.includes('EM6.35')`,
        "Tools tab inventory loaded",
      );
    },
  },
  {
    id: "03-clamps-machine",
    title: "3 — Clamps & machine tab (placeholder T-track)",
    caption:
      "A fresh home's machine profile: the T-track slots are PLACEHOLDERS, not measurements — the page says so, and until real slots are entered the workholding guides refuse to run. This is the honest state of a home that has never been measured.",
    action: async (ctx) => {
      await ctx.showTab("clamps-machine");
      await ctx.waitFor(
        `!!document.querySelector('.placeholder-note') && document.querySelector('.placeholder-note').innerText.includes('PLACEHOLDER')`,
        "placeholder T-track warning visible",
      );
    },
  },
  {
    id: "04-step-selected",
    title: "4 — Container STEP selected, before Run",
    caption:
      "The real container STEP (test/real_container.step, the Ø46 two-part container) picked through the file input — the genuine user flow, not a test harness. The test T-track fixture (copied from the V2.9/V2.10 verification fixture: slots x@6, x@84, y@144, small test clamp) is now in the scratch home's machine.json, so the job's config snapshot carries it; the fixture is a test bed, not Brandon's real measurements.",
    setup: async (ctx) => {
      await applyTestFixture(ctx.home);
    },
    action: async (ctx) => {
      await ctx.showTab("job-prep");
      await ctx.waitFor(
        `!!document.querySelector('[data-role="file-input"]')`,
        "file input present",
      );
      // Genuine file selection through the real input (CDP file
      // chooser path — the file is on the same machine as Chrome).
      await ctx.setFile(STEP_PATH);
      await ctx.waitFor(
        `document.querySelector('[data-role="file-name"]') && document.querySelector('[data-role="file-name"]').innerText.includes('real_container.step')`,
        "selected file name shown",
      );
    },
  },
  {
    id: "05-running",
    title: "5 — Job running",
    caption:
      "The run in flight: the four pipeline stages (solids → orientation → layout → plans) with the current one highlighted, Cancel button present, and the raw run log collapsed under “Run log”. The plan runs on the server through the mldxf CLI; the tab only displays its output.",
    action: async (ctx) => {
      await ctx.evalJs(`document.querySelector('.jp-run').click(); 'clicked'`);
      await ctx.waitFor(
        `window.MldxfJobPrep._state.status === 'running' && window.MldxfJobPrep._state.progress.length >= 2 && !!document.querySelector('.jp-cancel')`,
        "run started with progress lines and Cancel button",
        120_000,
      );
    },
  },
  {
    id: "06-complete",
    title: "6 — Job complete",
    caption: (ctx) => {
      const p = ctx.plan;
      const chosen = p?.chosen ?? "?";
      const plan = (p?.plans ?? []).find((x: any) => x.id === chosen) ?? {};
      const tools = (plan.tools ?? []).map((t: any) => t.name ?? t.id).join(" + ") || "?";
      const mins = typeof plan.total_seconds === "number" ? (plan.total_seconds / 60).toFixed(1) : "?";
      return (
        `Plan ${chosen} — ${tools}, ${plan.tool_changes ?? "?"} tool changes, ${mins} min total. ` +
        `Owned badges on the plan's tools and the flags list are on this Plan stage; the post-processing step (roundover on the router table) and the download links live under the Downloads stage. ` +
        `This is the real CLI output for the real container, not a mock.`
      );
    },
    action: async (ctx) => {
      await ctx.waitFor(
        `window.MldxfJobPrep._state.status === 'complete' && !!window.MldxfJobPrep._state.job`,
        "job complete",
        600_000,
      );
      const job = await ctx.evalJs(`window.MldxfJobPrep._state.job`);
      ctx.jobId = job.job_id;
      ctx.plan = job.tool_plan ?? null;
      // Sanity: the shot must show the Plan stage of the result,
      // not just the form — the plan cards live there now.
      await ctx.evalJs(`document.querySelector('[data-role="jp-subtab-plan"]').click(); 'plan'`);
      await ctx.waitFor(
        `!!document.querySelector('[data-role="jp-panel-plan"]') && document.querySelector('[data-role="jp-panel-plan"]').innerText.includes('Plan A')`,
        "Plan stage with Plan A visible",
      );
    },
  },
  {
    id: "07-jobs-list",
    title: "7 — Jobs tab (list)",
    caption:
      "Past jobs, newest first — the completed container job on top with its plan summary (Plan A, tools, changes, minutes) and a Rerun button — v1 jobs are read-only, no rerun. " +
      "The list is scoped to this home: the server records each run's home in its retained-inputs index, so interrupted rows from other (deleted) scratch homes no longer appear here.",
    action: async (ctx) => {
      await ctx.showTab("jobs");
      await ctx.waitFor(
        `window.MldxfJobs._state.jobs && window.MldxfJobs._state.jobs.some(function (j) { return j.id === ${JSON.stringify(ctx.jobId)}; })`,
        "jobs list contains the completed job",
      );
    },
  },
  {
    id: "08-job-detail",
    title: "8 — Job detail (2D layout preview)",
    caption:
      "The job's 2D top view, redrawn as a blueprint (Nov 25, 2026): a dark field with a 10 mm minor / 50 mm major grid and a hatched clamp-margin band, dimension lines for the 160 mm sheet width and 90 mm depth, and the margin dimension in the top band (sheet edge → usable-area boundary, 15 mm). Each part carries its dashed kerf outline — one profile-tool diameter outside the part, labelled 'Kerf (cut)' — and the usable-area box goes around the kerfs, not the parts: each part sits one kerf inside the usable-area boundary, and the hatched band outside it is the clamp margin, which also serves as the web on the outside (15 mm margin > 5 mm web). 'CLAMP MARGIN 15 mm' names the band and 'USABLE AREA' tags the dashed boundary. Round parts render as circles (46 × 46) by design: this is a schematic of the layout, and the dashed kerf is the cut outline. No clamps are drawn here yet — guides have not run at this point in the walkthrough (they run at step 9), after which the guided clamps show as gold rects on this same preview.",
    action: async (ctx) => {
      await ctx.evalJs(`window.MldxfJobs.openJob(${JSON.stringify(ctx.jobId)}); 'opened'`);
      await ctx.waitFor(
        `!!document.querySelector('[data-role="layout-preview"]')`,
        "2D layout preview rendered",
      );
    },
  },
  {
    id: "09-guides",
    title: "9 — Workholding guides (TEST fixture)",
    caption: (ctx) => {
      const clamps = ctx.guides?.clamps ?? [];
      const pos = clamps
        .map((c: any) => `${c.clamp_id ?? c.method ?? "clamp"} at (${c.x_mm}, ${c.y_mm})`)
        .join(", ");
      const bal = ctx.guides?.balance ?? null;
      // The balance note already carries the verdict, the worst
      // cut and the required hold-down — quote it whole instead
      // of prefixing it (an earlier draft printed "Contact
      // balance: unproven — Contact balance: UNPROVEN — ..." and
      // stated the 30.47 N demand twice). Per-clamp demands come
      // from balance.per_clamp, keyed by clamp index in the same
      // order as the clamps list.
      const balTxt = bal && bal.note ? `${bal.note} ` : "";
      let perClampTxt = "";
      if (bal && bal.per_clamp && clamps.length) {
        const parts: string[] = [];
        clamps.forEach((c: any, i: number) => {
          const req = bal.per_clamp[String(i)] ?? bal.per_clamp[i];
          if (req && typeof req.required_hold_down_n === "number") {
            parts.push(`(${c.x_mm}, ${c.y_mm}) ${req.required_hold_down_n.toFixed(2)} N`);
          }
        });
        if (parts.length === clamps.length) {
          perClampTxt = `Required hold-down per clamp at the worst cut: ${parts.join("; ")}. `;
        }
      }
      return (
        `Guides run from the Job prep tab's "Run guides" button. ${pos ? "Recommendation: " + pos + ". " : ""}` +
        balTxt +
        perClampTxt +
        // Round 13 — no hardcoded slot or position here: the old
        // text asserted the clamps sat "on the invented x-axis
        // slot at y=84 mm" (the (43, 84) / (106.7, 84)
        // placement), but the current guides logic places them at
        // (125, 84) / (70, 6) (contact balance, Nov 25, 2026) —
        // the caption went stale while the Recommendation above
        // stayed right, because it derives from the run's own
        // guides result. Positions live only in that derived
        // Recommendation; this sentence names only the fixture
        // they came from.
        `TEST BED ONLY — these clamps sit on the invented test slots from the scratch home's test fixture (copied from the V2.9/V2.10 verification fixture). ` +
        `Brandon's real T-track measurements are still unknown; these positions must NOT be used on his real machine. ` +
        `The force model is first-order and unvalidated (see the disclosure under the workholding table).`
      );
    },
    action: async (ctx) => {
      await ctx.showTab("job-prep");
      // Workholding lives on the Preview stage now — the shot
      // must show it, not the stage the last step left active.
      await ctx.evalJs(`document.querySelector('[data-role="jp-subtab-preview"]').click(); 'preview'`);
      await ctx.waitFor(
        `!!document.querySelector('.jp-guides')`,
        "Run guides button present",
      );
      await ctx.evalJs(`document.querySelector('.jp-guides').click(); 'clicked'`);
      await ctx.waitFor(
        `window.MldxfJobPrep._state.job && window.MldxfJobPrep._state.job.workholding && Array.isArray(window.MldxfJobPrep._state.job.workholding.clamps) && window.MldxfJobPrep._state.job.workholding.clamps.length >= 1`,
        "guides recommendation with at least one clamp",
        120_000,
      );
      const wh = await ctx.evalJs(`window.MldxfJobPrep._state.job.workholding`);
      ctx.guides = wh;
      if (!wh.clamps || wh.clamps.length < 2) {
        throw new Error(
          `expected 2 guided clamps on the test fixture, got ${wh.clamps ? wh.clamps.length : 0}`,
        );
      }
    },
  },
  {
    id: "10-view3d",
    title: "10 — 3D view (toolpaths + layer planes)",
    caption: (ctx) => {
      const moves = ctx.moves ?? "?";
      return (
        `The one 3D view (V3.3) for the real container job, mounted by the real Job prep tab above the operations table — not the standalone probe page: ${moves} moves as 3D paths (rapids faint, feed solid, arcs as true arcs, coloured by operation), the tool cylinder on the path, playback controls (play, scrub, speed, jump-to-operation, timeline), and one toggleable plane per DXF layer at its Z depth (8 planes). ` +
        `The guided clamps also show as red boxes from the bed to the stock top (toggle 'Clamps' in the Layer planes panel). The job origin is the red / green / blue crosshair at the top corner of the stock: Z-zero is on the stock top by default (XY zeroed on the corner, Z probed on top of the workpiece), so the stock extends downward from zero and the bed sits 10 mm below it. ` +
        `The sim has not run yet, so the wireframe stock box is still showing. Same scratch home as the rest of this walkthrough.`
      );
    },
    // NOTE on selectors: the mount container is the `.view3d-mount`
    // div inside the `[data-role="view3d"]` wrap — it carries the
    // `data-view3d-state` attribute (loading → ready/fallback) and
    // the `_view3d` api handle. `[data-role="view3d-host"]` is the
    // view's INNER canvas host and carries neither; selecting it
    // for the state/api silently never matches (bit this runner
    // once — the step-10 wait timed out on a mounted view).
    action: async (ctx) => {
      await ctx.showTab("job-prep");
      // Toolpaths + the 3D view live on the Preview stage now.
      await ctx.evalJs(`document.querySelector('[data-role="jp-subtab-preview"]').click(); 'preview'`);
      await ctx.waitFor(
        `!!document.querySelector('[data-role="run-toolpaths"]')`,
        "Generate toolpaths button present",
      );
      await ctx.evalJs(`document.querySelector('[data-role="run-toolpaths"]').click(); 'clicked'`);
      await ctx.waitFor(
        `window.MldxfJobPrep._state.job && window.MldxfJobPrep._state.job.toolpaths && !!document.querySelector('[data-role="view3d"]')`,
        "toolpaths generated and 3D view mounting",
        180_000,
      );
      await ctx.waitFor(
        `(function(){var h=document.querySelector('[data-role="view3d"] .view3d-mount'); return h && h.getAttribute('data-view3d-state') === 'ready';})()`,
        "3D view ready (WebGL, not fallback)",
        60_000,
      );
      await ctx.waitFor(
        `document.querySelectorAll('[data-role="view3d-layer-toggle"]').length === 8`,
        "8 layer planes loaded",
        60_000,
      );
      const fallback = await ctx.evalJs(`!!document.querySelector('[data-role="view3d-fallback"]')`);
      if (fallback) throw new Error("3D view fell back to the toolpath list (no WebGL?)");
      const info = await ctx.evalJs(
        `(function(){var h=document.querySelector('[data-role="view3d"] .view3d-mount'); return h && h._view3d ? h._view3d.sceneInfo() : null;})()`,
      );
      if (!info || info.webgl !== true || info.layerObjects !== 8 || info.layers !== 8) {
        throw new Error(`3D view scene not as expected: ${JSON.stringify(info)}`);
      }
      ctx.moves = info.moves;
      // Let a frame present before the shot.
      await ctx.evalJs(`new Promise(function(r){setTimeout(r,1500)})`);
    },
  },
  {
    id: "11-simulate",
    title: "11 — Simulate: the simmed stock",
    caption: (ctx) => {
      const s = ctx.simStatus ?? "sim status unknown";
      return (
        `The Simulate button run (V3.4): the dexel cut-sim ran in the browser and the wireframe stock box is replaced by the simmed stock mesh — pockets and profiles cut, the two Ø46 parts standing in the sheet. ${s} ` +
        `The GPU backend here runs in software (SwiftShader WebGL/WebGPU in headless Chromium); the seek data behind the "seek ready" line (in Sim details) was built by a background CPU build. Same scratch home and test fixture as the rest of this walkthrough.`
      );
    },
    action: async (ctx) => {
      await ctx.evalJs(`document.querySelector('[data-role="view3d-simulate"]').click(); 'clicked'`);
      // Round 16 (m4): the "seek ready" facts moved out of the
      // toolbar status line into the Sim details disclosure
      // ([data-role="view3d-sim-facts"]); the status line now
      // leads with plain words. Same wait, new home of the
      // string — the sceneInfo seekReady assertion below stays
      // the real proof.
      await ctx.waitFor(
        `(function(){var s=document.querySelector('[data-role="view3d-sim-facts"]'); return s && s.textContent.indexOf('seek ready') !== -1;})()`,
        "sim complete (seek ready)",
        180_000,
      );
      const failed = await ctx.evalJs(
        `(function(){var s=document.querySelector('[data-role="view3d-sim-status"]'); return s ? s.textContent.indexOf('Sim failed') !== -1 : true;})()`,
      );
      if (failed) throw new Error("sim reported failure in the sim status");
      const info = await ctx.evalJs(
        `(function(){var h=document.querySelector('[data-role="view3d"] .view3d-mount'); return h && h._view3d ? h._view3d.sceneInfo() : null;})()`,
      );
      if (!info || info.stockMesh !== true || !info.sim || info.sim.vertices <= 1000 || info.seekReady !== true) {
        throw new Error(`sim did not produce a stock mesh: ${JSON.stringify(info && info.sim)}`);
      }
      // Round 16 (m4): the status line is now the plain lead
      // only; the numbers live in the Sim details facts. The
      // caption quotes both, as the old single line did.
      const st = await ctx.evalJs(
        `(function(){var s=document.querySelector('[data-role="view3d-sim-status"]'); var f=document.querySelector('[data-role="view3d-sim-facts"]'); return (s ? s.textContent : '') + (f ? ' — ' + f.textContent : '');})()`,
      );
      ctx.simStatus = st;
      ctx.simInfo = info.sim;
      await ctx.evalJs(`new Promise(function(r){setTimeout(r,1500)})`);
    },
  },
  {
    id: "12-seek",
    title: "12 — Seek: stock at mid-cut",
    caption: (ctx) => {
      const moves = typeof ctx.moves === "number" ? ctx.moves : 220;
      const mid = Math.floor(moves / 2);
      const minH = ctx.seekMinHeight;
      return (
        `Scrubbed to move ${mid} of ${moves} (V3.5 seek; the timeline reads Move ${mid + 1}/${moves} — it counts from 1): the stock seeks to the playback position — the cut is part-way through, the pockets part-cut and the stock not yet cut through to the bed` +
        (typeof minH === "number" ? ` (lowest stock height ${minH.toFixed(2)} mm, between the uncut 9.5 mm and the final 0 mm)` : "") +
        `, and the tool cylinder sits at that move. Seeking replays nothing: the delta log + checkpoints rebuild the stock at the scrubbed move. Same scratch home; GPU sim in software (SwiftShader), seek data from the background CPU build.`
      );
    },
    action: async (ctx) => {
      const moves = ctx.moves;
      if (typeof moves !== "number" || moves < 2) throw new Error(`cannot seek: moves=${moves}`);
      const mid = Math.floor(moves / 2);
      await ctx.evalJs(
        `(function(){var s=document.querySelector('[data-role="view3d-scrub"]'); s.value='${mid}'; s.dispatchEvent(new Event('input',{bubbles:true})); return s.value;})()`,
      );
      await ctx.waitFor(
        `(function(){var t=document.querySelector('[data-role="view3d-timeline"]'); return t && t.textContent.indexOf('Move ${mid + 1}/${moves}') !== -1;})()`,
        `timeline at move ${mid + 1}`,
        30_000,
      );
      // The stock follows the scrubber: wait until the shown stock
      // is the mid-cut one, not the final one.
      await ctx.waitFor(
        `(function(){var h=document.querySelector('[data-role="view3d"] .view3d-mount'); if(!h || !h._view3d) return false; var i=h._view3d.sceneInfo(); return i.stockMove === ${mid} && i.stockMinHeight > 0 && i.stockMinHeight < 9.5;})()`,
        "stock seeked to mid-cut",
        60_000,
      );
      const info = await ctx.evalJs(
        `(function(){var h=document.querySelector('[data-role="view3d"] .view3d-mount'); return h && h._view3d ? h._view3d.sceneInfo() : null;})()`,
      );
      ctx.seekMinHeight = info ? info.stockMinHeight : null;
      await ctx.evalJs(`new Promise(function(r){setTimeout(r,1500)})`);
    },
  },
];

// ---------------------------------------------------------------- HTML output

function buildHtml(opts: {
  version: string;
  label: string;
  date: string;
  shots: { id: string; title: string; caption: string; b64: string }[];
}): string {
  const figures = opts.shots
    .map(
      (s) => `<figure>
<h2>${esc(s.title)}</h2>
<img src="data:image/png;base64,${s.b64}" alt="${esc(s.title)}">
<figcaption>${esc(s.caption)}</figcaption>
</figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mldxf ${esc(opts.label)} — website walkthrough (v${esc(opts.version)}, ${esc(opts.date)})</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; color: #222; }
h1 { font-size: 1.6em; }
.meta { background: #f4f4f4; border: 1px solid #ddd; padding: 1em; }
.meta p { margin: 0.3em 0; }
figure { margin: 2.5em 0; }
figure img { width: 100%; border: 1px solid #ccc; }
figcaption { margin-top: 0.5em; color: #444; }
.warn { color: #7a4a00; }
</style>
</head>
<body>
<h1>mldxf ${esc(opts.label)} — website walkthrough</h1>
<div class="meta">
<p><strong>Build:</strong> mldxf VERSION ${esc(opts.version)} (local — generated by <code>bun server/run-screenshots.ts</code>)</p>
<p><strong>Date:</strong> ${esc(opts.date)}</p>
<p><strong>What this is:</strong> the ${esc(opts.label)} website driven end to end in a real browser — a real container job, planned through the real UI. Re-run <code>bun server/run-screenshots.ts</code> before a release; if the date or version above does not match the release, this walkthrough is stale.</p>
<p class="warn"><strong>Honest labels:</strong> this run used a scratch test home, not Brandon's real setup. The workholding screenshot (step 9) uses an invented TEST T-track fixture (slots x@6, x@84, y@144 mm, copied from the V2.9/V2.10 verification fixture) — Brandon's real T-track measurements are still unknown, and those clamp positions must not be used on his real machine. Steps 10–12 show the V3 3D view and sim for the same job: the browser is headless Chromium under software WebGL + WebGPU (SwiftShader), so the sim runs on the GPU backend in software and the seek data is built by a background CPU build — that is the test browser's configuration, not the sim's speed on a real GPU. The scratch home and test fixture apply there too.</p>
</div>
${figures}
<footer><p>Generated by <code>bun server/run-screenshots.ts</code>. To cover a new feature, add one entry to STEPS in that file — see the comment at its top.</p></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- driver

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
  const version = (await readFile(join(REPO, "VERSION"), "utf8")).trim();
  const shots: { id: string; title: string; caption: string; b64: string }[] = [];

  // ---- scratch home ------------------------------------------------
  await $`rm -rf ${HOME} ${PNG_DIR} ${PROFILE}`.quiet();
  await mkdir(PNG_DIR, { recursive: true });
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

  let chrome: any = null;
  let ws: WebSocket | null = null;
  try {
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`, 30000, "app server health");
    log("app server healthy");

    // ---- headless Chromium via CDP (same pattern as v28-e2e.ts) ------
    chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--no-sandbox",
        // SwiftShader WebGL + WebGPU (never --disable-gpu — that
        // leaves this VM's Chromium with no WebGL and the 3D view
        // falls back). --enable-unsafe-webgpu is load-bearing for
        // the sim: without it requestAdapter() returns no adapter
        // and the sim fails (see the header comment). Same flags
        // as the view3d render probe (server/run-view3d-probe.ts).
        "--enable-unsafe-webgpu",
        "--use-angle=swiftshader",
        `--user-data-dir=${PROFILE}`,
        `http://127.0.0.1:${APP_PORT}/`,
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
    const waitFor = async (expr: string, label: string, timeoutMs = 60000): Promise<any> => {
      const deadline = Date.now() + timeoutMs;
      let last: any;
      while (Date.now() < deadline) {
        try {
          last = await evalJs(expr);
          if (last) return last;
        } catch (e: any) {
          last = e;
        }
        await sleep(1000);
      }
      throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("DOM.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The app shell must be up before the steps run.
    await waitFor(
      `window.App && window.MldxfJobPrep && document.querySelector('#tab-nav')`,
      "app shell loaded",
      30000,
    );

    const setFile = async (path: string): Promise<void> => {
      const doc = await send("DOM.getDocument", { depth: -1 });
      const q = await send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: '[data-role="file-input"]',
      });
      if (!q.nodeId) throw new Error("file input not found in DOM");
      await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [path] });
      // CDP fires change itself; dispatch once more so the app's
      // listener definitely runs (idempotent — it reads files[0]).
      await evalJs(
        `(function(){var i=document.querySelector('[data-role="file-input"]'); if(i) i.dispatchEvent(new Event('change',{bubbles:true})); return i && i.files ? i.files.length : 0;})()`,
      );
    };

    const shot = async (id: string): Promise<string> => {
      const r = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      const b64 = r.data as string;
      await writeFile(join(PNG_DIR, `${id}.png`), Buffer.from(b64, "base64"));
      return b64;
    };

    const ctx: Ctx = {
      home: HOME,
      jobId: null,
      plan: null,
      guides: null,
      moves: null,
      simStatus: null,
      simInfo: null,
      seekMinHeight: null,
      evalJs,
      waitFor,
      showTab: async (id: string) => {
        await evalJs(`window.App.showTab(${JSON.stringify(id)}); 'shown'`);
        await sleep(500);
      },
      shot,
      setFile,
    };

    // ---- run the steps in registry order ----------------------------
    for (const step of STEPS) {
      log(`step ${step.id}: ${step.title}`);
      if (step.setup) await step.setup(ctx);
      await step.action(ctx);
      const b64 = await ctx.shot(step.id);
      const caption = typeof step.caption === "function" ? step.caption(ctx) : step.caption;
      shots.push({ id: step.id, title: step.title, caption, b64 });
      log(`  captured ${step.id} (${Math.round(b64.length / 1024)} KB base64)`);
    }

    // ---- sim screenshots must show the sim ------------------------
    // The 3D steps' PNGs must differ from each other: the simmed
    // stock replaces the wireframe box (10 -> 11) and the seek
    // re-cuts the stock to mid-cut (11 -> 12). Near-identical PNGs
    // would mean the canvas drew nothing (fallback/blank) and the
    // captions would be lies, so fail the run instead of writing
    // the HTML.
    const byId = new Map(shots.map((s) => [s.id, s.b64]));
    const diffFrac = (aB64: string, bB64: string): number => {
      const a = Buffer.from(aB64, "base64");
      const b = Buffer.from(bB64, "base64");
      const n = Math.min(a.length, b.length);
      let diff = Math.abs(a.length - b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;
      return diff / Math.max(a.length, b.length);
    };
    const dSim = diffFrac(byId.get("10-view3d")!, byId.get("11-simulate")!);
    const dSeek = diffFrac(byId.get("11-simulate")!, byId.get("12-seek")!);
    log(`PNG diff 10->11 (sim): ${(100 * dSim).toFixed(1)}%, 11->12 (seek): ${(100 * dSeek).toFixed(1)}%`);
    if (dSim < 0.01)
      throw new Error(
        `sim screenshot looks unchanged vs the 3D view (PNG diff ${(100 * dSim).toFixed(2)}% < 1%) — the simmed stock did not draw`,
      );
    if (dSeek < 0.005)
      throw new Error(
        `seek screenshot looks unchanged vs the simmed stock (PNG diff ${(100 * dSeek).toFixed(2)}% < 0.5%) — the stock did not seek`,
      );

    if (pageExceptions.length) {
      throw new Error(`page JS exceptions during the run: ${pageExceptions.slice(0, 3).join(" | ")}`);
    }

    // ---- write the HTML ----------------------------------------------
    const now = new Date();
    const dateStr = `${now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT (${now.toISOString()})`;
    const html = buildHtml({ version, label: LABEL, date: dateStr, shots });
    await writeFile(OUT, html);
    log(`wrote ${OUT} (${Math.round(html.length / 1024)} KB, ${shots.length} screenshots)`);

    // ---- console report ----------------------------------------------
    const plan = ctx.plan;
    const chosen = plan?.chosen ?? "?";
    const chosenPlan = (plan?.plans ?? []).find((x: any) => x.id === chosen) ?? {};
    console.log("\n--- walkthrough run ---");
    console.log(`version: ${version}`);
    console.log(`job: ${ctx.jobId}`);
    console.log(
      `plan: ${chosen} — ${(chosenPlan.tools ?? []).map((t: any) => t.name ?? t.id).join(" + ")} — ${chosenPlan.tool_changes ?? "?"} changes — ${typeof chosenPlan.total_seconds === "number" ? (chosenPlan.total_seconds / 60).toFixed(1) : "?"} min`,
    );
    console.log(
      `guides: ${(ctx.guides?.clamps ?? []).map((c: any) => `${c.clamp_id ?? c.method} at (${c.x_mm}, ${c.y_mm})`).join(", ") || "none"}`,
    );
    console.log(`3d view: ${ctx.moves ?? "?"} moves`);
    console.log(`sim: ${ctx.simStatus ?? "not run"}`);
    if (ctx.seekMinHeight != null) console.log(`seek mid-cut min height: ${ctx.seekMinHeight} mm`);
    console.log(`output: ${OUT}`);
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
    serverProc.kill();
    try {
      await serverProc.exited;
    } catch {}
    if (!KEEP_HOME) {
      await $`rm -rf ${HOME}`.quiet().nothrow();
      log("scratch home removed");
    } else {
      log("scratch home kept at", HOME);
    }
    await $`rm -rf ${PROFILE}`.quiet().nothrow();
    if (!KEEP_PNGS) {
      await rm(PNG_DIR, { recursive: true, force: true }).catch(() => {});
    } else {
      log("PNGs kept at", PNG_DIR);
    }
  }
}

main().catch((e) => {
  console.log("screenshots driver error: " + (e?.stack ?? e));
  process.exit(1);
});
