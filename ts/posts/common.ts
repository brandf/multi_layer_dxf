#!/usr/bin/env bun
// V3.6 post-processor core — the post model (V3_SCOPE.md §6.1).
//
// A post-processor is a TypeScript module with hooks, not a template
// file with magic strings: header, tool_change, rapid, linear, arc,
// plunge, spindle, coolant, footer, plus the machine's limits (max
// feed, max spindle, Z travel, units). The generator's moves
// (docs-v3/job_model_v3.md §3.1) go in; G-code comes out.
//
// This module is the core every post shares: it walks the job's
// toolpaths in cut order, converts coordinates (see the Z model
// below), enforces the post's limits, and calls the post's hooks
// for each line. A post module (ts/posts/masso.ts, grbl.ts,
// template.ts) defines only its hooks + limits + units; it never
// walks moves itself, so a third machine is a new post module, not
// a generator change.
//
// Z MODEL — the most dangerous conversion in the wave (scope §6.4):
//   toolpaths use Z=0 at the bottom of stock; the post converts to
//   the machine's Z-zero, which is the job's setting (ts/z_zero.ts):
//   TOP of material by default (the V1 assumption, unchanged) or
//   BOTTOM (the bed) when the job says so. machineZ = jobZ -
//   stockTop under top, machineZ = jobZ under bottom, where
//   stockTop is the max part z_top. So under top the clearance
//   plane (jobZ = stockTop + 5) becomes machine Z +5.000, a cut at
//   the stock bottom (jobZ = 0) becomes machine Z -stockTop, and a
//   pocket floor at jobZ = 8.0 on a 9.5 mm part becomes -1.500;
//   under bottom the same cut stays machine Z 0 and the clearance
//   plane is machine Z stockTop + 5. X/Y are unchanged: the
//   operator zeroes X/Y at the sheet corner (the job origin) and Z
//   on the stock top (top) or the bed (bottom) — stated in every
//   emitted header and in docs-v3/dry_run_foreman.md.
//   A machine Z below the stock bottom would cut below the stock:
//   the core refuses it (post_limit_exceeded), it never clamps.
//
// LIMITS — the post enforces the machine profile's limits and
// REFUSES (named error `post_limit_exceeded`, exit 1) moves
// exceeding them — never silently clamps (scope §6.4). Checked
// here, in the post itself, not in the UI or the CLI: every feed
// (XY feed and plunge feed, in the post's units), every spindle
// speed, every machine Z (never below the stock bottom, never
// above the clearance plane), the job's total Z span against the
// Z travel, and X/Y against the bed when the post names one.
//
// FEEDS — the move model carries no per-move feed (ts/README.md):
// a Z-only feed move runs at the operation's plunge_mm_s, an XY
// feed move or an arc at feed_mm_s. The core derives which applies
// from the move's geometry, exactly as the view's timeline does.
// Rapids carry no feed; the post emits no F word on a rapid.
//
// DRILLS — explicit peck moves, never canned cycles. The
// generator already emits the peck cycle as feed/rapid moves, so
// the post translates them move-for-move; the round-trip parser
// then covers exactly what the post emits. Masso's canned-cycle
// support IS proven (docs.masso.com.au lists G73/G81/G82/G83, and
// the G83 page gives "G83 X Y Z R Q K F", modal, cancel G80) —
// explicit pecks are a deliberate choice on top of that proof, not
// a fallback for unproven support: G83's R/Q/G98 modal semantics
// add a translation risk with no benefit on 1.55 mm-deep holes,
// and a canned cycle would hide the exact peck depths the
// generator chose. G83 stays a documented future option
// (docs-v3/gcode.md).
//
// No I/O, no DOM, no Node/Bun APIs: this module runs in Bun (the
// CLI driver ts/gcode.ts), in tests, and anywhere else a post is
// needed.

import type { ZZero } from "../z_zero.ts";
import { displayZ } from "../z_zero.ts";

export type PostUnits = "mm" | "inch";


/** The machine's limits, from the post definition (published
 * machine numbers — see each post module for its sources). A post
 * that does not know a limit leaves it null and the core skips
 * that check, rather than inventing a number. */
export type MachineLimits = {
  /** Fastest cutting feed the machine allows, mm/min. */
  maxFeedMmMin: number;
  /** Fastest spindle speed the machine allows, rpm. */
  maxSpindleRpm: number;
  /** Z-slider travel, mm — the job's total Z span (clearance
   * plane down to the deepest cut) must fit inside it. */
  zTravelMm: number;
  /** Bed size in mm, when the post names the machine's bed
   * (null = unknown, no XY check). The check is on the job's XY
   * TRAVEL SPAN (max-min over move endpoints plus arc bounding
   * boxes), not on absolute coordinates: job X/Y are work
   * coordinates from the sheet corner and the sheet can sit
   * anywhere on the bed, so an absolute check would refuse valid
   * off-origin jobs. Sheet placement is the operator's job. */
  bedWidthMm: number | null;
  bedDepthMm: number | null;
};

export type ToolEntry = {
  id: string;
  name: string;
  /** Masso/GRBL tool number (T word). The plan records it; a tool
   * without one is refused, never guessed. */
  toolNumber: number;
  diaMm: number;
  kind: string;
};

export type OperationIn = {
  operation: string;
  layer: string;
  tool_id: string;
  feed_mm_s: number;
  plunge_mm_s: number;
  spindle_rpm: number;
  moves: (
    | { t: "rapid"; x: number; y: number; z: number }
    | { t: "feed"; x: number; y: number; z: number }
    | { t: "arc"; x: number; y: number; z: number; i: number; j: number; cw: boolean }
  )[];
};

export type JobIn = {
  job_id?: string;
  toolpaths: {
    version: number;
    plan: string;
    clearance_z_mm: number;
    operations: OperationIn[];
    stats?: { operations: number; moves: number; rapid: number; feed: number; arc: number };
  };
  /** Chosen plan's tools, in plan order — the post reads tool
   * numbers, names, and diameters from here. */
  planTools: ToolEntry[];
  /** Max part z_top — the stock top, i.e. the machine's Z-zero
   * under top (under bottom the machine's Z-zero is the bed).
   * The caller (ts/gcode.ts) derives it from the job's parts. */
  stockTopMm: number;
  /** The job's Z-zero setting ("top" | "bottom", ts/z_zero.ts) —
   * where machine Z=0 sits. The caller resolves it from the job
   * (missing reads as "top", the historical behaviour). */
  zZero: ZZero;
};

export type PostContext = {
  job: JobIn;
  post: PostDef;
  /** The job's Z-zero setting — what the header states. */
  zZero: ZZero;
  /** Stock top in job coords (= machine Z-zero under top;
   * under bottom the machine Z-zero is the bed and the stock
   * top is machine Z +stockTop). */
  stockTopMm: number;
  /** Clearance plane in machine coords (job clearance - stockTop
   * under top, job clearance under bottom). */
  clearanceMachine: number;
  /** Format a job-coordinate length (mm) in the post's units. */
  fmt: (mm: number) => string;
  /** Format a feed rate (mm/min) in the post's units/min. */
  fmtFeed: (mmMin: number) => string;
  /** Convert a job Z (mm, Z=0 at stock bottom) to machine Z
   * (post units, Z=0 at the job's Z-zero: top of material under
   * top, bed under bottom). */
  machineZ: (jobZMm: number) => number;
  /** Convert a job XY length (mm) to the post's units. */
  toUnits: (mm: number) => number;
};

export type PostHooks = {
  /** Header lines (comments + setup words). Called once. */
  header: (ctx: PostContext) => string[];
  /** Tool-change lines, emitted at the clearance plane after the
   * core rapids Z up. `tool` is the tool being loaded. */
  toolChange: (ctx: PostContext, tool: ToolEntry, spindleRpm: number) => string[];
  /** Spindle-on line for a tool already loaded (M3 S...). The
   * core calls this from toolChange by default — a post overrides
   * it only when its spindle word differs. */
  spindleOn: (ctx: PostContext, spindleRpm: number) => string[];
  /** Coolant lines. The shipped posts fit no coolant, so they
   * return [] — the hook exists so a post WITH coolant has one
   * place to emit it, and the footer turns it off. */
  coolantOn: (ctx: PostContext) => string[];
  coolantOff: (ctx: PostContext) => string[];
  /** Footer lines (spindle off, park, end of program). */
  footer: (ctx: PostContext) => string[];
};

export type PostDef = {
  id: string;
  label: string;
  units: PostUnits;
  description: string;
  limits: MachineLimits;
  hooks: PostHooks;
};

export class PostError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MM_PER_INCH = 25.4;

function fmtMm(v: number): string {
  return v.toFixed(3);
}
/** Inch formatting: the value is ALREADY in inches (toUnits /
 * machineZ converted it) — this only fixes the decimals, it
 * must NOT divide again (a double conversion shipped Z0.0078
 * for a 0.1969 in clearance on the first inch run, caught by the
 * round-trip before anything shipped). */
function fmtInch(v: number): string {
  return v.toFixed(4);
}

export type PostedResult = {
  postId: string;
  /** Full G-code text (LF lines, trailing newline). */
  text: string;
  lines: number;
  /** Moves emitted, by kind (rapids/feeds/arcs as posted). */
  moves: { rapid: number; feed: number; arc: number; total: number };
  tools: { id: string; name: string; toolNumber: number }[];
  stockTopMm: number;
  clearanceMachine: number;
  /** Machine Z of the deepest cut (post units), for the header. */
  deepestMachineZ: number;
};

/** Post a job through a post definition. Throws PostError with a
 * named code — `post_limit_exceeded` (a move/feed/spindle/Z
 * outside the machine's limits — refused, never clamped),
 * `post_tool_missing` (a toolpath tool with no plan entry or no
 * tool number), `post_no_toolpaths` (no v1 toolpaths section).
 * Deterministic: same job + same post -> identical text (no
 * timestamps, no randomness — the file's sha256 is stable across
 * re-posts, so a rerun can re-post and match). */
export function postJob(job: JobIn, post: PostDef): PostedResult {
  const tp = job.toolpaths;
  if (!tp || tp.version !== 1 || !Array.isArray(tp.operations)) {
    throw new PostError(
      "post_no_toolpaths",
      "job has no version-1 toolpaths section — run `mldxf toolpaths` first",
    );
  }
  const stockTop = job.stockTopMm;
  if (!(Number.isFinite(stockTop) && stockTop > 0)) {
    throw new PostError(
      "post_no_stock_top",
      `job has no usable stock top (max part z_top = ${JSON.stringify(stockTop)}) — cannot convert Z to the machine's ` +
        (job.zZero === "bottom" ? "bed zero" : "top-of-material zero"),
    );
  }
  if (tp.operations.length === 0) {
    throw new PostError(
      "post_no_toolpaths",
      "job has a toolpaths section with no operations — nothing to post",
    );
  }
  const toUnits = post.units === "inch" ? (mm: number) => mm / MM_PER_INCH : (mm: number) => mm;
  const fmt = post.units === "inch" ? fmtInch : fmtMm;
  const fmtFeed =
    post.units === "inch"
      ? (mmMin: number) => (mmMin / MM_PER_INCH).toFixed(2)
      : (mmMin: number) => mmMin.toFixed(1);
  const machineZ = (jobZMm: number) => toUnits(displayZ(jobZMm, stockTop, job.zZero));
  const clearanceMachine = machineZ(tp.clearance_z_mm);

  const ctx: PostContext = {
    job, post, zZero: job.zZero, stockTopMm: stockTop, clearanceMachine,
    fmt, fmtFeed, machineZ, toUnits,
  };

  // --- limit checks on the job as a whole (before emitting) ---
  const lim = post.limits;
  // Z span: clearance plane down to the deepest cut (stock bottom,
  // jobZ = 0) must fit the Z-slider travel.
  const zSpanMm = tp.clearance_z_mm - 0;
  if (zSpanMm > lim.zTravelMm + 0.001) {
    throw new PostError(
      "post_limit_exceeded",
      `job Z span ${zSpanMm.toFixed(3)} mm (clearance ${tp.clearance_z_mm} mm to stock bottom) exceeds ${post.id} Z travel ${lim.zTravelMm} mm — refused, not clamped`,
    );
  }

  // XY travel span: the tool centre's travel in X and Y over the
  // whole job must fit the bed. This is a SPAN check, not an
  // absolute-position check, and the distinction matters: the
  // file's X/Y are job coordinates relative to the sheet corner
  // (the operator zeroes X/Y there), and the sheet can sit
  // anywhere on the bed — the post cannot know where. A job whose
  // sheet is at (-60,-40) (the machined job: a part centred on
  // the origin) is valid on a 1222 mm bed even though its X runs
  // to -63; what the post CAN enforce is that the travel span
  // fits. The tool centre legitimately travels up to one tool
  // radius outside the sheet (profile cuts around the outline),
  // so the span is measured over move endpoints plus arc
  // bounding boxes (centre +/- radius — a safe over-approximation
  // of an arc's path), never over the sheet. Placement of the
  // sheet on the bed is the operator's job; the header tells
  // them to zero at the sheet corner.
  if (lim.bedWidthMm !== null || lim.bedDepthMm !== null) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let prev: { x: number; y: number } | null = null;
    for (const op of tp.operations) {
      for (const m of op.moves) {
        if (m.x < minX) minX = m.x;
        if (m.x > maxX) maxX = m.x;
        if (m.y < minY) minY = m.y;
        if (m.y > maxY) maxY = m.y;
        if (m.t === "arc" && prev !== null) {
          const cx = prev.x + m.i;
          const cy = prev.y + m.j;
          const r = Math.hypot(m.i, m.j);
          if (cx - r < minX) minX = cx - r;
          if (cx + r > maxX) maxX = cx + r;
          if (cy - r < minY) minY = cy - r;
          if (cy + r > maxY) maxY = cy + r;
        }
        prev = { x: m.x, y: m.y };
      }
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (lim.bedWidthMm !== null && spanX > lim.bedWidthMm + 0.001) {
      throw new PostError(
        "post_limit_exceeded",
        `job X travel span ${spanX.toFixed(3)} mm (X ${minX.toFixed(3)} to ${maxX.toFixed(3)} mm) exceeds ${post.id} bed width ${lim.bedWidthMm} mm — refused, not clamped`,
      );
    }
    if (lim.bedDepthMm !== null && spanY > lim.bedDepthMm + 0.001) {
      throw new PostError(
        "post_limit_exceeded",
        `job Y travel span ${spanY.toFixed(3)} mm (Y ${minY.toFixed(3)} to ${maxY.toFixed(3)} mm) exceeds ${post.id} bed depth ${lim.bedDepthMm} mm — refused, not clamped`,
      );
    }
  }

  const toolById = new Map<string, ToolEntry>();
  for (const t of job.planTools ?? []) {
    if (t && typeof t.id === "string") toolById.set(t.id, t);
  }
  const lines: string[] = [];
  const counts = { rapid: 0, feed: 0, arc: 0, total: 0 };
  const toolsUsed: { id: string; name: string; toolNumber: number }[] = [];
  const seenTools = new Set<string>();
  let currentTool: string | null = null;
  let deepestMachineZ = clearanceMachine;
  // Current machine position (post units). X/Y start unknown
  // (null) — the tool-change rapid moves Z only and must not
  // invent an XY; the first rapid of an operation sets them. A
  // feed with unknown XY is refused (no position to derive the
  // feed from), never guessed.
  let cur: { x: number | null; y: number | null; z: number | null } = { x: null, y: null, z: null };

  const checkFeed = (mmMin: number, what: string) => {
    if (!(Number.isFinite(mmMin) && mmMin > 0)) {
      throw new PostError("post_limit_exceeded", `${what} feed ${mmMin} mm/min is not a positive finite feed — refused`);
    }
    if (mmMin > lim.maxFeedMmMin + 1e-9) {
      throw new PostError(
        "post_limit_exceeded",
        `${what} feed ${mmMin.toFixed(1)} mm/min exceeds ${post.id} max feed ${lim.maxFeedMmMin} mm/min — refused, not clamped`,
      );
    }
  };
  const checkSpindle = (rpm: number, toolId: string) => {
    if (!(Number.isFinite(rpm) && rpm > 0)) {
      throw new PostError("post_limit_exceeded", `spindle ${rpm} rpm for tool ${toolId} is not a positive finite speed — refused`);
    }
    if (rpm > lim.maxSpindleRpm) {
      throw new PostError(
        "post_limit_exceeded",
        `spindle ${rpm} rpm for tool ${toolId} exceeds ${post.id} max spindle ${lim.maxSpindleRpm} rpm — refused, not clamped`,
      );
    }
  };
  const checkMachineZ = (jobZMm: number, what: string) => {
    const mz = machineZ(jobZMm);
    if (mz < -toUnits(stockTop) - 0.001) {
      throw new PostError(
        "post_limit_exceeded",
        `${what} machine Z ${mz.toFixed(3)} ${post.units} is below the stock bottom (job Z ${jobZMm} mm < 0) — refused, not clamped`,
      );
    }
    if (mz > clearanceMachine + 0.001) {
      throw new PostError(
        "post_limit_exceeded",
        `${what} machine Z ${mz.toFixed(3)} ${post.units} is above the clearance plane (${clearanceMachine.toFixed(3)} ${post.units}) — refused, not clamped`,
      );
    }
    if (mz < deepestMachineZ) deepestMachineZ = mz;
  };
  lines.push(...post.hooks.header(ctx));
  lines.push(...post.hooks.coolantOn(ctx));

  for (const op of tp.operations) {
    const tool = toolById.get(op.tool_id);
    if (!tool) {
      throw new PostError(
        "post_tool_missing",
        `toolpaths use tool ${op.tool_id} but the chosen plan names no such tool — refused rather than posting with a guessed tool`,
      );
    }
    if (!Number.isInteger(tool.toolNumber) || tool.toolNumber <= 0) {
      throw new PostError(
        "post_tool_missing",
        `tool ${op.tool_id} has no tool number in the plan (T word) — refused rather than posting with a guessed number`,
      );
    }
    checkSpindle(op.spindle_rpm, op.tool_id);
    checkFeed(op.feed_mm_s * 60, `${op.operation} ${op.layer} feed`);
    checkFeed(op.plunge_mm_s * 60, `${op.operation} ${op.layer} plunge`);

    if (currentTool !== op.tool_id) {
      // Tool change at the clearance plane: rapid Z up first so
      // the change never happens at cut depth. At the very start
      // of the job (no position yet) there is nothing to lift —
      // the M6 itself moves to the change position — so no Z-up
      // is emitted there; the first rapid positions fully.
      if (cur.z !== null && Math.abs(cur.z - clearanceMachine) > 1e-9) {
        lines.push(`G0 Z${fmt(clearanceMachine)}`);
        counts.rapid++;
        counts.total++;
        cur = { ...cur, z: clearanceMachine };
      }
      lines.push(...post.hooks.toolChange(ctx, tool, op.spindle_rpm));
      currentTool = op.tool_id;
      if (!seenTools.has(op.tool_id)) {
        seenTools.add(op.tool_id);
        toolsUsed.push({ id: tool.id, name: tool.name, toolNumber: tool.toolNumber });
      }
    }

    for (const m of op.moves) {
      checkMachineZ(m.z, `${op.operation} ${op.layer} move`);
      const X = fmt(toUnits(m.x));
      const Y = fmt(toUnits(m.y));
      const Z = fmt(machineZ(m.z));
      if (m.t === "rapid") {
        lines.push(`G0 X${X} Y${Y} Z${Z}`);
        counts.rapid++;
      } else if (m.t === "feed") {
        // Z-only feed -> plunge feed; XY feed -> cutting feed
        // (ts/README.md: the move model carries no per-move feed).
        // `cur` is the machine position (post units) after the
        // previous move; a Z-only move keeps its XY. A feed with
        // unknown XY (no rapid yet — a generator bug) is refused,
        // never guessed.
        if (cur.x === null || cur.y === null) {
          throw new PostError(
            "post_limit_exceeded",
            `${op.operation} ${op.layer} starts with a feed move before any rapid — no position to derive the feed from; refused (generator bug, not a post decision)`,
          );
        }
        const zOnlyMm = Math.abs(toUnits(m.x) - cur.x) < 1e-9 && Math.abs(toUnits(m.y) - cur.y) < 1e-9;
        const feedMmMin = (zOnlyMm ? op.plunge_mm_s : op.feed_mm_s) * 60;
        lines.push(`G1 X${X} Y${Y} Z${Z} F${fmtFeed(feedMmMin)}`);
        counts.feed++;
      } else if (m.t === "arc") {
        const I = fmt(toUnits(m.i));
        const J = fmt(toUnits(m.j));
        const code = m.cw ? "G2" : "G3";
        const feedMmMin = op.feed_mm_s * 60;
        lines.push(`${code} X${X} Y${Y} Z${Z} I${I} J${J} F${fmtFeed(feedMmMin)}`);
        counts.arc++;
      } else {
        throw new PostError(
          "post_limit_exceeded",
          `${op.operation} ${op.layer} has an unknown move type ${JSON.stringify((m as { t: unknown }).t)} — refused`,
        );
      }
      counts.total++;
      cur = { x: toUnits(m.x), y: toUnits(m.y), z: machineZ(m.z) };
    }
  }

  // Footer: Z up to clearance, spindle off, park at the origin,
  // end of program. The core emits the Z-up as a rapid so the
  // footer never relies on the last move's position.
  if (cur.z === null || Math.abs(cur.z - clearanceMachine) > 1e-9) {
    lines.push(`G0 Z${fmt(clearanceMachine)}`);
    counts.rapid++;
    counts.total++;
  }
  lines.push(...post.hooks.coolantOff(ctx));
  lines.push(...post.hooks.footer(ctx));

  return {
    postId: post.id,
    text: lines.join("\n") + "\n",
    lines: lines.length,
    moves: counts,
    tools: toolsUsed,
    stockTopMm: stockTop,
    clearanceMachine,
    deepestMachineZ,
  };
}

/** Shared header comment block: job identity, the Z-zero
 * convention, and the dry-run warning — every shipped post opens
 * with it (the scope §6.4 safety bar is structural, and the
 * header is where the operator meets it). */
export function headerComments(ctx: PostContext): string[] {
  const tp = ctx.job.toolpaths;
  const stats = tp.stats;
  const moves = stats ? stats.moves : tp.operations.reduce((n, o) => n + o.moves.length, 0);
  const zeroLine =
    ctx.zZero === "bottom"
      ? `(Z-zero: BOTTOM of material (bed). Zero X/Y at the sheet corner, Z on the bed.)`
      : `(Z-zero: TOP of material. Zero X/Y at the sheet corner, Z on the stock top.)`;
  return [
    `(Generated by mldxf V3.6 — post ${ctx.post.id})`,
    `(Job: ${ctx.job.job_id ?? "?"} — plan ${tp.plan}, ${tp.operations.length} operations, ${moves} moves)`,
    zeroLine,
    `(Stock top ${ctx.stockTopMm} mm (job Z); clearance ${ctx.clearanceMachine.toFixed(3)} ${ctx.post.units} above Z-zero.)`,
    `(DRY RUN BEFORE CUTTING — see docs-v3/dry_run_foreman.md. Unverified G-code is never ready to run.)`,
  ];
}
