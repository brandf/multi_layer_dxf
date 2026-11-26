#!/usr/bin/env bun
/**
 * validate_job.ts — the executable form of docs-v3/job_model_v3.md.
 *
 * Validates a job dir's job.json against the v3 schema: version
 * invariants (toolpaths present <=> job_version 3), the toolpaths
 * section shape (operations, moves with first-class arcs, tabs,
 * skipped-loop aggregate, recomputed stats, recomputed motion
 * time when recorded (V3.14)), the Z model, the
 * `sim` section shape (V3.4 — stock, pitch, coarse flag, checkpoint
 * index), and the `gcode` section shape (V3.6 — one entry per post
 * run: post_id, file, sha256, verified, generated_at).
 *
 * Structural + cross-field checks only — it is NOT a geometry
 * checker. Geometry (offsets vs outlines, rapid clearance in
 * practice, no-straight-plunge) belongs to the independent checker
 * (~/workspace/v31-spike/check_toolpaths.py) and the sim (V3.4).
 *
 * Usage:
 *   bun ts/validate_job.ts <job-dir> [--json]
 *   bun ts/validate_job.ts --file <job.json> [--json]
 *   mldxf validate-job <job-dir> [--json]   (CLI shell over this)
 *
 * Output contract (mirrors the CLI's): exactly one JSON object on
 * stdout, progress on stderr, exit 0/1/2 with named errors.
 *   ok:   {"ok": true, "job_version": 3, "checks": [...]}
 *   fail: {"ok": false, "error": "<named>", "message": "...",
 *          "checks": [...]} — checks lists every check run, each
 *          {name, ok, detail?}, so a failure names all failures,
 *          not just the first.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { flattenToolpaths, summarizeMotion } from "./view3d/model.ts";
import type { ToolpathsIn } from "./view3d/model.ts";

const OPERATIONS = ["drill", "bore", "pocket", "profile"] as const;
const SKIP_REASONS = ["tool_too_large", "offset_failed", "open_loop"] as const;
const MOVE_TYPES = ["rapid", "feed", "arc"] as const;
const EXPECTED_GENERATOR = "ts/toolpaths.ts";
const EXPECTED_TOOLPATHS_VERSION = 1;

type Check = { name: string; ok: boolean; detail?: string };

class NamedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Canonical JSON: sorted keys, so two objects compare equal
 * regardless of key order (job.json itself is written sorted). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function approx(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) <= eps;
}

/** The job's parts with their z_top: multi-part jobs carry
 * parts[].z_top; single-part jobs carry parts: null + top-level
 * z_top (the generator normalises that to one implicit part). */
function partZTops(job: Record<string, unknown>): Map<string, number> | number {
  const parts = job.parts;
  if (Array.isArray(parts)) {
    const m = new Map<string, number>();
    for (const p of parts) {
      if (isObj(p) && typeof p.name === "string" && isFiniteNumber(p.z_top))
        m.set(p.name, p.z_top);
    }
    return m;
  }
  if (isFiniteNumber(job.z_top)) return job.z_top;
  return new Map<string, number>();
}

/** Owning part's z_top for a layer name: "P01_P01__POCKET_D1.50"
 * belongs to part "P01_P01"; a layer with no "__" belongs to the
 * single implicit part (top-level z_top). Returns null when it
 * cannot be determined (the caller records a check failure). */
function zTopForLayer(
  layer: string,
  zTops: Map<string, number> | number,
): number | null {
  if (typeof zTops === "number") return zTops;
  const idx = layer.indexOf("__");
  if (idx < 0) return null;
  return zTops.get(layer.slice(0, idx)) ?? null;
}

function validateToolpaths(
  job: Record<string, unknown>,
  checks: Check[],
): void {
  const tp = job.toolpaths;
  const fail = (name: string, detail: string) => {
    checks.push({ name, ok: false, detail });
  };
  const pass = (name: string) => checks.push({ name, ok: true });

  if (!isObj(tp)) {
    fail("toolpaths.shape", "toolpaths is present but is not an object");
    return;
  }
  if (tp.version !== EXPECTED_TOOLPATHS_VERSION)
    fail("toolpaths.version", `version is ${JSON.stringify(tp.version)}, expected 1`);
  else pass("toolpaths.version");
  if (tp.generator !== EXPECTED_GENERATOR)
    fail("toolpaths.generator", `generator is ${JSON.stringify(tp.generator)}, expected ${JSON.stringify(EXPECTED_GENERATOR)}`);
  else pass("toolpaths.generator");

  const toolPlan = isObj(job.tool_plan) ? job.tool_plan : {};
  const chosen = toolPlan.chosen;
  if (typeof chosen === "string") {
    if (tp.plan !== chosen)
      fail("toolpaths.plan", `plan is ${JSON.stringify(tp.plan)} but tool_plan.chosen is ${JSON.stringify(chosen)}`);
    else pass("toolpaths.plan");
  } else {
    checks.push({ name: "toolpaths.plan", ok: true, detail: "job names no chosen plan; plan not cross-checked" });
  }

  // clearance = max part z_top + 5.0
  const zTops = partZTops(job);
  let maxZ: number | null = null;
  if (typeof zTops === "number") maxZ = zTops;
  else for (const z of zTops.values()) maxZ = maxZ === null ? z : Math.max(maxZ, z);
  if (!isFiniteNumber(tp.clearance_z_mm) || maxZ === null) {
    fail("toolpaths.clearance", `clearance_z_mm is ${JSON.stringify(tp.clearance_z_mm)} and max part z_top is ${maxZ === null ? "unknown" : maxZ}`);
  } else if (!approx(tp.clearance_z_mm, maxZ + 5.0)) {
    fail("toolpaths.clearance", `clearance_z_mm is ${tp.clearance_z_mm} but max part z_top + 5.0 is ${maxZ + 5.0}`);
  } else pass("toolpaths.clearance");
  const clearance = isFiniteNumber(tp.clearance_z_mm) ? tp.clearance_z_mm : Infinity;

  if (!Array.isArray(tp.cut_order) || !Array.isArray(job.cut_order) ||
      JSON.stringify(tp.cut_order) !== JSON.stringify(job.cut_order))
    fail("toolpaths.cut_order", `toolpaths cut_order ${JSON.stringify(tp.cut_order)} does not equal the job's cut_order ${JSON.stringify(job.cut_order)}`);
  else pass("toolpaths.cut_order");

  if (typeof tp.z_model !== "string" || !tp.z_model.includes("Z=0 at bottom of stock"))
    fail("toolpaths.z_model", `z_model is ${JSON.stringify(tp.z_model)}, expected the recorded Z convention`);
  else pass("toolpaths.z_model");

  const layerNames = new Set<string>();
  const layerDepths = new Map<string, number>();
  if (Array.isArray(job.layers)) {
    for (const l of job.layers) {
      if (isObj(l) && typeof l.layer === "string") {
        layerNames.add(l.layer);
        if (isObj(l.est) && isFiniteNumber(l.est.depth_mm))
          layerDepths.set(l.layer, l.est.depth_mm);
      }
      else if (typeof l === "string") layerNames.add(l);
    }
  }
  const layerDepth = (layer: string): number | null =>
    layerDepths.get(layer) ?? null;
  const planTools = new Set<string>();
  if (Array.isArray(toolPlan.plans)) {
    for (const p of toolPlan.plans) {
      if (isObj(p) && p.id === chosen && Array.isArray(p.tools)) {
        for (const t of p.tools)
          if (isObj(t) && typeof t.id === "string") planTools.add(t.id);
      }
    }
  }

  if (!Array.isArray(tp.operations)) {
    fail("toolpaths.operations", "operations is not an array");
    return;
  }
  // Cut order: entries grouped by operation in cut_order, stable
  // within an operation by plan order (checked as: the sequence of
  // operations, with consecutive duplicates collapsed, is a
  // subsequence of cut_order). A bore sits in the drill group:
  // cut_order names drill/pocket/profile and bore is drill-family
  // (helical entry where the drill does not fit).
  const cutOrder = Array.isArray(tp.cut_order) ? tp.cut_order : [];
  const groupOf = (o: string) => (o === "bore" ? "drill" : o);
  const seen: string[] = [];
  for (const op of tp.operations) {
    const o = isObj(op) ? op.operation : undefined;
    if (typeof o === "string" && seen[seen.length - 1] !== groupOf(o)) seen.push(groupOf(o));
  }
  const orderOk = seen.every((o, i) => cutOrder.indexOf(o) >= (i === 0 ? 0 : cutOrder.indexOf(seen[i - 1])));
  if (!orderOk)
    fail("toolpaths.order", `operations are not grouped in cut_order ${JSON.stringify(cutOrder)} (saw ${JSON.stringify(seen)})`);
  else pass("toolpaths.order");

  let nMoves = 0, nRapid = 0, nFeed = 0, nArc = 0;
  const aggSkipped: unknown[] = [];
  let opBad = false;
  tp.operations.forEach((entry: unknown, ei: number) => {
    const where = `operations[${ei}]`;
    if (!isObj(entry)) { fail(`${where}.shape`, "operation entry is not an object"); opBad = true; return; }
    if (typeof entry.operation !== "string" || !(OPERATIONS as readonly string[]).includes(entry.operation)) {
      fail(`${where}.operation`, `operation is ${JSON.stringify(entry.operation)}, expected one of ${OPERATIONS.join("|")}`); opBad = true;
    }
    if (typeof entry.layer !== "string" || (layerNames.size > 0 && !layerNames.has(entry.layer))) {
      fail(`${where}.layer`, `layer is ${JSON.stringify(entry.layer)} — not a layer in this job`); opBad = true;
    }
    if (typeof entry.tool_id !== "string" || (planTools.size > 0 && !planTools.has(entry.tool_id))) {
      fail(`${where}.tool_id`, `tool_id is ${JSON.stringify(entry.tool_id)} — not a tool in the chosen plan`); opBad = true;
    }
    for (const f of ["feed_mm_s", "plunge_mm_s", "spindle_rpm"]) {
      if (!isFiniteNumber(entry[f])) { fail(`${where}.${f}`, `${f} is ${JSON.stringify(entry[f])}, expected a finite number`); opBad = true; }
    }
    const passObj = entry.pass;
    if (!isObj(passObj) || (passObj.kind !== "rough" && passObj.kind !== "finish")) {
      fail(`${where}.pass`, `pass is ${JSON.stringify(passObj)}, expected {kind: "rough"|"finish", stepdown_index: int|null}`); opBad = true;
    } else {
      const isDrillBore = entry.operation === "drill" || entry.operation === "bore";
      const stepNull = passObj.stepdown_index === null;
      if (passObj.kind === "finish" && !stepNull) { fail(`${where}.pass`, `finish pass has stepdown_index ${JSON.stringify(passObj.stepdown_index)}, expected null`); opBad = true; }
      if (isDrillBore && !stepNull) { fail(`${where}.pass`, `drill/bore entry has stepdown_index ${JSON.stringify(passObj.stepdown_index)}, expected null`); opBad = true; }
      if (passObj.kind === "rough" && !isDrillBore && !Number.isInteger(passObj.stepdown_index)) {
        fail(`${where}.pass`, `rough pocket/profile entry has stepdown_index ${JSON.stringify(passObj.stepdown_index)}, expected an integer`); opBad = true;
      }
    }
    if (isObj(passObj) && passObj.kind === "finish" && entry.z_mm !== null) {
      fail(`${where}.z_mm`, `finish span has z_mm ${JSON.stringify(entry.z_mm)}, expected null`); opBad = true;
    }
    if (!isFiniteNumber(entry.z_top_mm) || !isFiniteNumber(entry.z_bottom_mm)) {
      fail(`${where}.z`, `z_top_mm/z_bottom_mm are ${JSON.stringify(entry.z_top_mm)}/${JSON.stringify(entry.z_bottom_mm)}, expected finite numbers`); opBad = true;
    } else {
      if (entry.z_bottom_mm > entry.z_top_mm + 0.001) { fail(`${where}.z`, `z_bottom_mm ${entry.z_bottom_mm} is above z_top_mm ${entry.z_top_mm}`); opBad = true; }
      // Z model (docs-v3/job_model_v3.md §3): pocket/profile cut
      // from z_top_mm = part z_top − start_depth down to
      // z_bottom_mm = z_top_mm − cut_depth (est.depth_mm);
      // drill/bore peck/helix from the stock top, so z_top_mm is
      // the part z_top and z_bottom_mm = part z_top − start_depth
      // − cut_depth, with z_mm the hole bottom. start_depth is
      // parsed from the layer name's _START<n> suffix (0 when
      // absent); cut_depth is the layer's est.depth_mm.
      if (typeof entry.layer === "string") {
        const partZ = zTopForLayer(entry.layer, zTops);
        const estDepth = layerDepth(entry.layer);
        const startM = entry.layer.match(/_START([0-9]+(?:\.[0-9]+)?)/);
        const start = startM ? Number(startM[1]) : 0;
        const isDrillBore = entry.operation === "drill" || entry.operation === "bore";
        if (partZ !== null) {
          const expTop = isDrillBore ? partZ : partZ - start;
          if (!approx(entry.z_top_mm, expTop))
            { fail(`${where}.z_top`, `z_top_mm is ${entry.z_top_mm} but the model gives ${expTop} (part z_top ${partZ}${isDrillBore ? "" : ` − start_depth ${start}`})`); opBad = true; }
          if (estDepth !== null) {
            // Drill/bore start at the stock top: the bottom is
            // part z_top − start_depth − cut_depth. Pocket/profile
            // already carry the start in z_top_mm, so the bottom
            // is z_top_mm − cut_depth.
            const expBot = (isDrillBore ? partZ - start : expTop) - estDepth;
            if (!approx(entry.z_bottom_mm, expBot))
              { fail(`${where}.z_bottom`, `z_bottom_mm is ${entry.z_bottom_mm} but the model gives ${expBot} (${isDrillBore ? `part z_top ${partZ} − start_depth ${start} − cut_depth ${estDepth}` : `z_top_mm ${expTop} − cut_depth ${estDepth}`})`); opBad = true; }
          }
        }
        if (isDrillBore && isFiniteNumber(entry.z_mm) && !approx(entry.z_mm, entry.z_bottom_mm)) {
          fail(`${where}.z_mm`, `drill/bore z_mm is ${entry.z_mm} but the hole bottom (z_bottom_mm) is ${entry.z_bottom_mm}`); opBad = true;
        }
      }
      if (isFiniteNumber(entry.z_mm) && (entry.z_mm < entry.z_bottom_mm - 0.001 || entry.z_mm > entry.z_top_mm + 0.001)) {
        fail(`${where}.z_mm`, `z_mm ${entry.z_mm} lies outside [z_bottom_mm, z_top_mm] = [${entry.z_bottom_mm}, ${entry.z_top_mm}]`); opBad = true;
      }
    }
    if (entry.tabs !== null) {
      if (entry.operation !== "profile") {
        fail(`${where}.tabs`, `tabs set on a ${JSON.stringify(entry.operation)} entry — tabs belong only on profile entries`); opBad = true;
      } else if (!isObj(entry.tabs) || !Number.isInteger(entry.tabs.count) ||
          !isFiniteNumber(entry.tabs.length_mm) || !isFiniteNumber(entry.tabs.thickness_mm) ||
          !Array.isArray(entry.tabs.positions)) {
        fail(`${where}.tabs`, `tabs is ${JSON.stringify(entry.tabs)}, expected {count, length_mm, thickness_mm, positions: [{loop, s_mm}]}`); opBad = true;
      } else if (entry.tabs.count !== entry.tabs.positions.length) {
        fail(`${where}.tabs`, `tabs count is ${entry.tabs.count} but positions has ${entry.tabs.positions.length} entries`); opBad = true;
      } else {
        for (const pos of entry.tabs.positions) {
          if (!isObj(pos) || !Number.isInteger(pos.loop) || !isFiniteNumber(pos.s_mm)) {
            fail(`${where}.tabs`, `tab position is ${JSON.stringify(pos)}, expected {loop: int, s_mm: number}`); opBad = true; break;
          }
        }
      }
    }
    if (!Array.isArray(entry.moves) || entry.moves.length === 0) {
      fail(`${where}.moves`, "moves is not a non-empty array"); opBad = true;
    } else {
      for (const m of entry.moves) {
        if (!isObj(m) || typeof m.t !== "string" || !(MOVE_TYPES as readonly string[]).includes(m.t)) {
          fail(`${where}.moves`, `move is ${JSON.stringify(m)}, expected {t: "rapid"|"feed"|"arc", x, y, z}`); opBad = true; break;
        }
        if (!isFiniteNumber(m.x) || !isFiniteNumber(m.y) || !isFiniteNumber(m.z)) {
          fail(`${where}.moves`, `move has non-finite coords: ${JSON.stringify(m)}`); opBad = true; break;
        }
        if (m.t === "arc" && (!isFiniteNumber(m.i) || !isFiniteNumber(m.j) || typeof m.cw !== "boolean")) {
          fail(`${where}.moves`, `arc move lacks finite i/j and boolean cw: ${JSON.stringify(m)}`); opBad = true; break;
        }
        if (m.t === "rapid" && m.z < clearance - 0.001) {
          fail(`${where}.moves`, `rapid at z=${m.z} is below clearance_z_mm ${clearance}`); opBad = true; break;
        }
        nMoves++;
        if (m.t === "rapid") nRapid++;
        else if (m.t === "feed") nFeed++;
        else nArc++;
      }
    }
    if (!Array.isArray(entry.skipped)) {
      fail(`${where}.skipped`, "skipped is not an array"); opBad = true;
    } else {
      // Entry-level skips carry no layer (the entry's layer is
      // implied); the section-level aggregate carries it. The
      // aggregate comparison below attaches entry.layer.
      for (const s of entry.skipped) {
        if (!isObj(s) || !Number.isInteger(s.loop) ||
            typeof s.reason !== "string" || !(SKIP_REASONS as readonly string[]).includes(s.reason) ||
            typeof s.detail !== "string") {
          fail(`${where}.skipped`, `skip entry is ${JSON.stringify(s)}, expected {loop: int, reason: ${SKIP_REASONS.join("|")}, detail: string}`); opBad = true; break;
        }
        aggSkipped.push({ layer: entry.layer, loop: s.loop, reason: s.reason, detail: s.detail });
      }
    }
    if (!Array.isArray(entry.notes)) { fail(`${where}.notes`, "notes is not an array"); opBad = true; }
  });
  if (!opBad) pass("toolpaths.operations");

  if (!isObj(tp.stats)) {
    fail("toolpaths.stats", "stats is not an object");
  } else {
    const s = tp.stats;
    const expect = { operations: tp.operations.length, moves: nMoves, rapid: nRapid, feed: nFeed, arc: nArc };
    const bad = (Object.keys(expect) as (keyof typeof expect)[]).filter(
      (k) => s[k] !== expect[k]);
    if (bad.length)
      fail("toolpaths.stats", `stats mismatch: ${bad.map((k) => `${k} is ${JSON.stringify(s[k])}, recomputed ${expect[k]}`).join("; ")}`);
    else pass("toolpaths.stats");
  }

  if (!Array.isArray(tp.skipped)) {
    fail("toolpaths.skipped", "skipped is not an array");
  } else if (canonical(tp.skipped) !== canonical(aggSkipped)) {
    fail("toolpaths.skipped", `section-level skipped (${tp.skipped.length} entries) does not equal the concatenation of entry skipped (${aggSkipped.length} entries)`);
  } else pass("toolpaths.skipped");

  // V3.14 motion: optional (a pre-V3.14 job has none — still valid)
  // but when present it must be the duration model's own numbers,
  // recomputed here from the moves. Tolerance 0.15 s covers the
  // section's 0.1 s rounding on the total and on each breakdown
  // part; the parts' SUM gets a bound that scales with the part
  // count, because independently rounded parts drift by up to
  // 0.05 s each (Kookabus: 7 tools, 0.2 s).
  if (tp.motion_time_s === undefined && tp.motion_by_tool === undefined &&
      tp.motion_by_operation === undefined) {
    checks.push({ name: "toolpaths.motion", ok: true, detail: "no motion recorded (pre-V3.14 job)" });
  } else {
    try {
      const motion = summarizeMotion(flattenToolpaths(tp as unknown as ToolpathsIn));
      const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
      const close = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) <= 0.15;
      const bad: string[] = [];
      if (!close(tp.motion_time_s, motion.totalSeconds))
        bad.push(`motion_time_s is ${JSON.stringify(tp.motion_time_s)}, recomputed ${motion.totalSeconds.toFixed(1)}`);
      for (const [key, recomputed] of [["motion_by_tool", motion.byTool], ["motion_by_operation", motion.byOperation]] as const) {
        const recorded = tp[key];
        if (!isObj(recorded)) bad.push(`${key} is not an object`);
        else if (Math.abs(sum(recorded as Record<string, number>) - motion.totalSeconds) > 0.05 * Object.keys(recorded).length + 0.01)
          bad.push(`${key} sums to ${sum(recorded as Record<string, number>).toFixed(1)}, expected ${motion.totalSeconds.toFixed(1)}`);
        else {
          const rk = Object.keys(recomputed).sort().join(",");
          const ck = Object.keys(recorded).sort().join(",");
          if (rk !== ck) bad.push(`${key} keys ${ck}, expected ${rk}`);
          else for (const k of Object.keys(recomputed))
            if (!close((recorded as Record<string, number>)[k], recomputed[k]))
              bad.push(`${key}.${k} is ${(recorded as Record<string, number>)[k]}, recomputed ${recomputed[k].toFixed(1)}`);
        }
      }
      if (bad.length) fail("toolpaths.motion", bad.join("; "));
      else pass("toolpaths.motion");
    } catch (e) {
      fail("toolpaths.motion", `cannot recompute motion: ${(e as Error).message}`);
    }
  }
}

/** The `sim` section (V3.4, docs-v3/job_model_v3.md §6.2): the stock
 * the sim ran against, the pitch actually used, the coarse flag +
 * reason, and the checkpoint index (null until V3.5 lands the delta
 * log). A sim section is only meaningful on a v3 job (it simulates
 * the toolpaths), and it carries no timestamps — a re-run of
 * `mldxf sim --verify` must produce a byte-identical section. */
function validateSim(job: Record<string, unknown>, hasTp: boolean, checks: Check[]): void {
  const fail = (detail: string) => checks.push({ name: "job.sim", ok: false, detail });
  const sim = job.sim;
  if (sim === undefined || sim === null) {
    checks.push({ name: "job.sim", ok: true, detail: "no sim recorded" });
    return;
  }
  if (!isObj(sim)) { fail(`sim is ${JSON.stringify(sim)}, expected an object`); return; }
  if (!hasTp) { fail("sim is present but the job has no toolpaths — a sim simulates the toolpaths"); return; }
  const stock = sim.stock;
  if (!isObj(stock)) { fail(`sim.stock is ${JSON.stringify(stock)}, expected an object`); return; }
  for (const k of ["x_min", "y_min"] as const) {
    if (!isFiniteNumber(stock[k])) { fail(`sim.stock.${k} is ${JSON.stringify(stock[k])}, expected a finite number`); return; }
  }
  for (const k of ["x_mm", "y_mm", "top_mm"] as const) {
    if (!isFiniteNumber(stock[k]) || stock[k] <= 0) { fail(`sim.stock.${k} is ${JSON.stringify(stock[k])}, expected a positive finite number`); return; }
  }
  if (!(stock.suggested_thickness_mm === null || isFiniteNumber(stock.suggested_thickness_mm))) {
    fail(`sim.stock.suggested_thickness_mm is ${JSON.stringify(stock.suggested_thickness_mm)}, expected a finite number or null`); return;
  }
  if (!isFiniteNumber(sim.pitch_mm) || sim.pitch_mm <= 0) {
    fail(`sim.pitch_mm is ${JSON.stringify(sim.pitch_mm)}, expected a positive finite number`); return;
  }
  if (typeof sim.pitch_coarse !== "boolean") {
    fail(`sim.pitch_coarse is ${JSON.stringify(sim.pitch_coarse)}, expected a boolean`); return;
  }
  if (sim.pitch_coarse) {
    if (typeof sim.coarse_reason !== "string" || !sim.coarse_reason) {
      fail("sim.pitch_coarse is true but sim.coarse_reason is not a non-empty string"); return;
    }
  } else if (sim.coarse_reason !== null) {
    fail("sim.pitch_coarse is false but sim.coarse_reason is not null"); return;
  }
  // V3.5: checkpoints is null (a pre-V3.5 sim section — still
  // valid, the job just has no seek state) or the checkpoint index
  // into the delta log (docs-v3/job_model_v3.md §6.2,
  // docs-v3/sim_seek.md). The index is shape-checked AND
  // cross-checked: its move count must equal the toolpaths'
  // stats.moves (a log built for different toolpaths is stale),
  // its checkpoints must start at move 0 (chunk -1, the initial
  // stock) and end at the last move, in increasing move order.
  const cp = sim.checkpoints;
  if (cp === null) {
    checks.push({ name: "job.sim", ok: true, detail: "no seek state (pre-V3.5 sim section)" });
    return;
  }
  if (!isObj(cp)) { fail(`sim.checkpoints is ${JSON.stringify(cp)}, expected null or an object`); return; }
  if (cp.file !== "sim/delta.bin") { fail(`sim.checkpoints.file is ${JSON.stringify(cp.file)}, expected "sim/delta.bin"`); return; }
  if (cp.format !== 1) { fail(`sim.checkpoints.format is ${JSON.stringify(cp.format)}, expected 1`); return; }
  for (const k of ["chunk_cut_seconds", "checkpoint_cut_seconds"] as const) {
    if (!isFiniteNumber(cp[k]) || cp[k] <= 0) { fail(`sim.checkpoints.${k} is ${JSON.stringify(cp[k])}, expected a positive finite number`); return; }
  }
  if (!Number.isInteger(cp.chunks) || (cp.chunks as number) < 0) { fail(`sim.checkpoints.chunks is ${JSON.stringify(cp.chunks)}, expected a non-negative integer`); return; }
  if (!Number.isInteger(cp.bytes) || (cp.bytes as number) <= 0) { fail(`sim.checkpoints.bytes is ${JSON.stringify(cp.bytes)}, expected a positive integer`); return; }
  if (!Number.isInteger(cp.moves) || (cp.moves as number) < 0) { fail(`sim.checkpoints.moves is ${JSON.stringify(cp.moves)}, expected a non-negative integer`); return; }
  const cpChunks = cp.chunks as number;
  const cpMoves = cp.moves as number;
  const tp = job.toolpaths as { stats?: { moves?: unknown } } | undefined;
  if (tp?.stats?.moves !== undefined && cpMoves !== tp.stats.moves) {
    fail(`sim.checkpoints.moves is ${cpMoves} but the toolpaths have ${tp.stats.moves} moves — the delta log is stale (built for different toolpaths)`); return;
  }
  if (!Array.isArray(cp.checkpoints) || !cp.checkpoints.length) { fail("sim.checkpoints.checkpoints is not a non-empty array"); return; }
  let prevMove = -1;
  let prevChunk = -1;
  for (let i = 0; i < cp.checkpoints.length; i++) {
    const c = cp.checkpoints[i] as Record<string, unknown>;
    if (!isObj(c)) { fail(`sim.checkpoints.checkpoints[${i}] is not an object`); return; }
    if (!Number.isInteger(c.move) || (c.move as number) < 0 || (c.move as number) > cpMoves) { fail(`sim.checkpoints.checkpoints[${i}].move is ${JSON.stringify(c.move)}, expected an integer in [0, ${cpMoves}]`); return; }
    if (!isFiniteNumber(c.time_s) || (c.time_s as number) < 0) { fail(`sim.checkpoints.checkpoints[${i}].time_s is ${JSON.stringify(c.time_s)}, expected a non-negative finite number`); return; }
    if (!Number.isInteger(c.chunk) || (c.chunk as number) < -1 || (c.chunk as number) >= cpChunks) { fail(`sim.checkpoints.checkpoints[${i}].chunk is ${JSON.stringify(c.chunk)}, expected an integer in [-1, ${cpChunks - 1}]`); return; }
    if ((c.move as number) <= prevMove) { fail(`sim.checkpoints.checkpoints[${i}].move (${c.move}) does not increase over the previous checkpoint (${prevMove})`); return; }
    if ((c.chunk as number) < prevChunk) { fail(`sim.checkpoints.checkpoints[${i}].chunk (${c.chunk}) decreases over the previous checkpoint (${prevChunk})`); return; }
    prevMove = c.move as number;
    prevChunk = c.chunk as number;
  }
  const first = cp.checkpoints[0] as Record<string, unknown>;
  if (first.move !== 0 || first.chunk !== -1) { fail(`the first checkpoint must be {move: 0, chunk: -1} (the initial stock), got ${JSON.stringify(first)}`); return; }
  const last = cp.checkpoints[cp.checkpoints.length - 1] as Record<string, unknown>;
  if (last.move !== cpMoves) { fail(`the last checkpoint must sit at the last move (${cpMoves}), got ${JSON.stringify(last)}`); return; }
  checks.push({ name: "job.sim", ok: true });
}

function validateGcode(job: Record<string, unknown>, hasTp: boolean, checks: Check[]): void {
  const fail = (detail: string) => checks.push({ name: "job.gcode", ok: false, detail });
  const gcode = job.gcode;
  if (gcode === undefined || gcode === null) {
    checks.push({ name: "job.gcode", ok: true, detail: "no gcode recorded" });
    return;
  }
  if (!Array.isArray(gcode)) { fail(`gcode is ${JSON.stringify(gcode)}, expected an array of post runs`); return; }
  if (!hasTp) { fail("gcode is present but the job has no toolpaths — G-code is posted from the toolpaths"); return; }
  const seen = new Set<string>();
  for (const [i, e] of gcode.entries()) {
    if (!isObj(e)) { fail(`gcode[${i}] is ${JSON.stringify(e)}, expected an object`); return; }
    if (typeof e.post_id !== "string" || !e.post_id) {
      fail(`gcode[${i}].post_id is ${JSON.stringify(e.post_id)}, expected a non-empty string`); return;
    }
    if (seen.has(e.post_id)) {
      fail(`gcode has two entries for post ${e.post_id} — one entry per post run, latest replaces`); return;
    }
    seen.add(e.post_id);
    if (typeof e.file !== "string" || !e.file) {
      fail(`gcode[${i}].file is ${JSON.stringify(e.file)}, expected a non-empty job-relative path`); return;
    }
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      fail(`gcode[${i}].sha256 is ${JSON.stringify(e.sha256)}, expected 64 lowercase hex chars`); return;
    }
    if (typeof e.verified !== "boolean") {
      fail(`gcode[${i}].verified is ${JSON.stringify(e.verified)}, expected a boolean`); return;
    }
    if (typeof e.generated_at !== "string" || !e.generated_at || !Number.isFinite(Date.parse(e.generated_at))) {
      fail(`gcode[${i}].generated_at is ${JSON.stringify(e.generated_at)}, expected an ISO-8601 timestamp`); return;
    }
  }
  // File existence is NOT checked: the CLI validates the merged
  // job from a temp file (the .nc lives in the job dir, not in
  // /tmp), and a job.json copied without its files is still a
  // well-formed job.
  checks.push({ name: "job.gcode", ok: true });
}

function validateJob(job: unknown): { job: Record<string, unknown>; checks: Check[] } {
  const checks: Check[] = [];
  if (!isObj(job)) {
    checks.push({ name: "job.shape", ok: false, detail: "job.json is not a JSON object" });
    return { job: {}, checks };
  }
  // v2 keys present with their v2 types (spot-check; the V2
  // battery owns the full v2 model).
  for (const [key, want] of [["layers", "array"], ["tool_plan", "object"], ["config_snapshot", "object"]] as const) {
    const v = job[key];
    const ok = want === "array" ? Array.isArray(v) : isObj(v);
    checks.push({ name: `job.${key}`, ok, ...(ok ? {} : { detail: `${key} is ${JSON.stringify(v)}, expected ${want}` }) });
  }

  const version = job.job_version;
  if (version !== 2 && version !== 3) {
    checks.push({ name: "job.job_version", ok: false, detail: `job_version is ${JSON.stringify(version)}, expected 2 or 3` });
    return { job, checks };
  }
  checks.push({ name: "job.job_version", ok: true });
  // Z-zero (docs-v3/z_zero.md): absent reads as "top" everywhere
  // (the historical post behaviour), so only a present-but-wrong
  // value fails — a job carrying any other frame must never be
  // published as if it were either.
  const zz = (job as { z_zero?: unknown }).z_zero;
  if (zz === undefined || zz === null || zz === "top" || zz === "bottom") {
    checks.push({ name: "job.z_zero", ok: true });
  } else {
    checks.push({ name: "job.z_zero", ok: false, detail: `z_zero is ${JSON.stringify(zz)}, expected "top" or "bottom"` });
  }
  const hasTp = job.toolpaths !== undefined && job.toolpaths !== null;
  if (version === 3 && !hasTp) {
    checks.push({ name: "job.toolpaths_present", ok: false, detail: "job_version is 3 but toolpaths is absent" });
  } else if (version === 2 && hasTp) {
    checks.push({ name: "job.toolpaths_present", ok: false, detail: "job_version is 2 but toolpaths is present — presence of toolpaths IS the v3 marker" });
  } else {
    checks.push({ name: "job.toolpaths_present", ok: true });
  }
  if (hasTp) validateToolpaths(job, checks);

  // gcode: filled by V3.6 (see validateGcode above). Until V3.6
  // the section was rejected outright; now it is shape-checked,
  // exactly as V3.4 did for `sim`.
  validateGcode(job, hasTp, checks);
  validateSim(job, hasTp, checks);

  const mp = job.machine_profile;
  if (mp === undefined || mp === null) {
    checks.push({ name: "job.machine_profile.post_processor", ok: true, detail: "no machine_profile recorded" });
  } else if (isObj(mp)) {
    const pp = mp.post_processor;
    if (pp === undefined || pp === null || typeof pp === "string")
      checks.push({ name: "job.machine_profile.post_processor", ok: true });
    else
      checks.push({ name: "job.machine_profile.post_processor", ok: false, detail: `post_processor is ${JSON.stringify(pp)}, expected a string or null` });
  } else {
    checks.push({ name: "job.machine_profile.post_processor", ok: false, detail: `machine_profile is ${JSON.stringify(mp)}, expected an object or null` });
  }
  return { job, checks };
}

function main(): void {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  let jobPath: string | null = null;
  if (rest[0] === "--file" && rest[1]) {
    jobPath = rest[1];
  } else if (rest[0]) {
    jobPath = join(rest[0], "job.json");
  } else {
    console.log(JSON.stringify({ ok: false, error: "usage_error", message: "usage: bun ts/validate_job.ts <job-dir> [--json] | --file <job.json> [--json]" }));
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(jobPath, "utf-8");
  } catch {
    console.log(JSON.stringify({
      ok: false, error: "job_not_found",
      message: `${jobPath} does not exist — not a v2/v3 job dir (a v1 job has manifest.json only; re-run mldxf plan on the source STEP)`,
      checks: [],
    }));
    process.exit(1);
  }
  let job: unknown;
  try {
    job = JSON.parse(raw);
  } catch (e: any) {
    console.log(JSON.stringify({
      ok: false, error: "job_invalid",
      message: `${jobPath} is not valid JSON: ${e?.message ?? e}`,
      checks: [{ name: "job.parse", ok: false, detail: String(e?.message ?? e) }],
    }));
    process.exit(1);
  }
  const { job: jobObj, checks } = validateJob(job);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      job_version: jobObj.job_version ?? null,
      has_toolpaths: jobObj.toolpaths !== undefined && jobObj.toolpaths !== null,
      checks,
    }));
    process.exit(0);
  }
  // The error name is the first failing check's family: a version
  // mismatch names itself; a toolpaths failure is toolpaths_invalid;
  // a premature gcode/sim section names itself.
  let code = "job_invalid";
  const first = failed[0].name;
  if (first === "job.toolpaths_present") code = "job_version_mismatch";
  else if (first.startsWith("toolpaths.")) code = "toolpaths_invalid";
  else if (first === "job.gcode") code = "gcode_invalid";
  else if (first === "job.sim") code = "sim_invalid";
  console.log(JSON.stringify({
    ok: false, error: code,
    message: failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; "),
    checks,
  }));
  process.exit(1);
}

main();
