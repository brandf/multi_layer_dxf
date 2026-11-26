#!/usr/bin/env bun
// V3.1 TypeScript toolpath generator (Bun-runnable).
//
// Reads ONLY job-dir files: job.json (layers, chosen plan, cut_order,
// tabs, config snapshot) and the job's root DXF (layer outlines).
// It NEVER touches Python internals, the classifier, the planner, or
// the layout code. It prints exactly one JSON object on stdout
// (progress on stderr) and does NOT write job.json: the Python CLI
// (`mldxf toolpaths`) merges the printed `toolpaths` section into
// job.json and bumps job_version to 3.
//
//   bun ts/toolpaths.ts <job-dir> [--json]
//   -> {"ok": true, "toolpaths": {...}, "stats": {...}}   (exit 0)
//   -> {"ok": false, "error": "<named>", "message": "..."} (exit 1/2)
//
// The section also carries the motion time (V3.14): `motion_time_s`
// plus `motion_by_tool` / `motion_by_operation` breakdowns, computed
// from the same duration model the 3D view uses
// (ts/view3d/model.ts flattenToolpaths). Motion is derived data —
// a deterministic function of the moves — so the rerun identity
// comparison ignores those three fields (see mldxf.py) and a
// pre-V3.14 v3 job gains them on its next toolpaths run.
//
// Move model (V3_SCOPE.md §3.4): moves are rapid/feed with XYZ (job
// coords, mm, Z=0 at the bottom of stock); arcs are FIRST-CLASS
// (centre offset i,j + direction cw), never polylines. A rapid is
// always at or above the clearance plane. An arc whose end Z differs
// from its start Z is a helical arc (G2/G3 with Z) — that is how
// ramps and bore entries are expressed; a planar arc has equal Zs.
// Z-only feed moves use the entry's plunge_mm_s; XY feed moves and
// arcs use feed_mm_s; the post-processor (V3.2+) owns that mapping.
//
// Z model: Z=0 at the bottom of stock. Per-part z_top from job.json
// parts; layer start_depth/cut_depth are depths below the part top,
// so cut-bottom Z = z_top - start_depth - cut_depth (= floor_z for
// pockets when present). clearance_z = max part z_top + 5.0 mm (no
// clearance plane exists in the config — only pin_clearance_mm —
// so the generator defines and records this value).
//
// Cut order: the plan's layers list is part-major, NOT machining
// order. Entries are emitted in job.json cut_order (drill, pocket,
// profile), stable within an operation by plan order. Pockets keep
// plan order, so a START1.50 pocket follows the pocket above it
// (its top is that pocket's floor, already cleared).
//
// Traversal convention (climb milling, CW spindle viewed from
// above): outer profiles CW (G2), pockets / bores / through-cut
// slots CCW (G3), island contours CW (the island is an external
// feature to the tool going around it). All contours are emitted
// CCW by offsetLoop; outer profiles and island contours are
// reversed before emission. The sim (V3.2+) verifies the cut, not
// the convention.
//
// Tabs: count/length/thickness come from the plan entry (the planner
// already resolved the config toolplan.tabs). Tabs apply ONLY on the
// bottom profile pass. Per loop, tabs are placed evenly by arc
// length, centred at (i+0.5)/N of the loop, each length_mm long;
// the per-loop counts sum to the layer's count (remainder to the
// longest loop; a loop too short to hold a tab with a gap gets none).
// Recorded in the entry's tabs field with arc-length positions, so
// the count/length can be checked against manifest.txt `# tabs:`.
//
// A loop the tool cannot fit (no offset ring at tool radius — e.g.
// the Kookabus groove pockets vs the 0.50 mm endmill) produces NO
// moves for that loop and is recorded in the entry's `skipped` list
// and the section's `skipped` list with reason `tool_too_large`.
// It is a recorded skip, never a silent omission and never a job
// failure: the rest of the job still cuts.
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  parseDxf, entitiesToSegs, parseLwpl, repairArcsInLayer, assemble,
  offsetLoop, loopPoints, segPoints, areaOf, pointInPolygon, distToLoop, dist,
  TAU, norm, segStart, segEnd, segReverse, nestingDepth,
} from "./offset.ts";
import type { Pt, Seg, Loop } from "./offset.ts";
import { flattenToolpaths, summarizeMotion } from "./view3d/model.ts";
import type { ToolpathsIn } from "./view3d/model.ts";

// ---------------------------------------------------------------- types
type Move =
  | { t: "rapid"; x: number; y: number; z: number }
  | { t: "feed"; x: number; y: number; z: number }
  | { t: "arc"; x: number; y: number; z: number; i: number; j: number; cw: boolean };

type ToolpathEntry = {
  operation: string;
  layer: string;
  tool_id: string;
  feed_mm_s: number;
  plunge_mm_s: number;
  spindle_rpm: number;
  pass: { kind: "rough" | "finish"; stepdown_index: number | null };
  z_mm: number | null; // the Z level this entry cuts at (null: spans levels)
  z_top_mm: number;
  z_bottom_mm: number;
  tabs: { count: number; length_mm: number; thickness_mm: number; positions: { loop: number; s_mm: number }[] } | null;
  moves: Move[];
  skipped: { loop: number; reason: string; detail: string }[];
  notes: string[];
};

type NamedError = { code: string; message: string };
function fail(code: string, message: string): never {
  throw { code, message } as NamedError;
}
function isNamed(e: unknown): e is NamedError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

// Round to 0.001 mm for deterministic output; normalise -0 to 0.
const r3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};
// Motion seconds round to 0.1 s — the precision the plan's
// per-layer seconds carry (V3.14).
const r1 = (n: number) => Math.round(n * 10) / 10;
const r1map = (r: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of Object.keys(r).sort()) out[k] = r1(r[k]);
  return out;
};
const mvRapid = (x: number, y: number, z: number): Move => ({ t: "rapid", x: r3(x), y: r3(y), z: r3(z) });
const mvFeed = (x: number, y: number, z: number): Move => ({ t: "feed", x: r3(x), y: r3(y), z: r3(z) });
const mvArc = (x: number, y: number, z: number, i: number, j: number, cw: boolean): Move =>
  ({ t: "arc", x: r3(x), y: r3(y), z: r3(z), i: r3(i), j: r3(j), cw });

// ---------------------------------------------------------------- contour helpers
function segLength(s: Seg): number {
  if (s.kind === "line") return dist(s.p1, s.p2);
  const span = norm(s.ccw ? s.a1 - s.a0 : s.a0 - s.a1) || TAU;
  return s.r * span;
}
function contourLength(segs: Seg[]): number {
  return segs.reduce((a, s) => a + segLength(s), 0);
}
function arcSpan(s: Extract<Seg, { kind: "arc" }>): number {
  return norm(s.ccw ? s.a1 - s.a0 : s.a0 - s.a1) || TAU;
}
function arcPoint(s: Extract<Seg, { kind: "arc" }>, a: number): Pt {
  return { x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) };
}
// Traverse a closed contour starting at its first segment's start.
// Z interpolates from z0 to z1 by arc length (z0 == z1: planar).
// The caller must already be at the contour start (at z0).
function contourMoves(segs: Seg[], z0: number, z1: number): Move[] {
  const total = contourLength(segs);
  const moves: Move[] = [];
  let done = 0;
  for (const s of segs) {
    const len = segLength(s);
    const zEnd = total > 0 ? z0 + ((z1 - z0) * (done + len)) / total : z1;
    if (s.kind === "line") {
      moves.push(mvFeed(s.p2.x, s.p2.y, zEnd));
    } else {
      const e = segEnd(s);
      moves.push(mvArc(e.x, e.y, zEnd, s.c.x - segStart(s).x, s.c.y - segStart(s).y, !s.ccw));
    }
    done += len;
  }
  return moves;
}
// Current XY = the last emitted move's end point (used for the
// final retract; tracking it in a variable trips TS narrowing
// because the assignments happen inside forEach closures).
function lastXY(moves: Move[]): Pt | null {
  const m = moves[moves.length - 1];
  if (!m) return null;
  return { x: m.x, y: m.y };
}

// Reverse a closed contour's traversal (for CW outer profiles and
// island contours). Segment order reverses and each segment flips.
function reverseContour(segs: Seg[]): Seg[] {
  return [...segs].reverse().map(segReverse);
}
// The point on a loop farthest from its centroid: a convex extreme
// point, safe to approach from outside the part.
function farthestPoint(segs: Seg[]): { p: Pt; c: Pt } {
  const pts = loopPoints({ segs });
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  let best = pts[0], bd = -1;
  for (const p of pts) { const d = dist(p, c); if (d > bd) { bd = d; best = p; } }
  return { p: best, c };
}

// Rotate a closed contour so it starts at point p (which lies on
// it): split the segment containing p and reorder the list. The
// lead-in ramp lands at the contour start, so the contour must start
// where the ramp lands — the farthest (convex extreme) point — or
// the first arc's i,j is computed from a start the tool never
// reaches (a real gouge: the P01/P02 container profiles' ramp landed
// at the farthest point while the contour started at segStart, and
// the contour arc then swept a different circle, dipping to 0.13 mm
// from the outline).
function rotateLoopStart(segs: Seg[], p: Pt): Seg[] {
  let hit = -1, hitT = 0, hitD = Infinity;
  segs.forEach((s, i) => {
    if (s.kind === "line") {
      const dx = s.p2.x - s.p1.x, dy = s.p2.y - s.p1.y;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) return;
      const t = ((p.x - s.p1.x) * dx + (p.y - s.p1.y) * dy) / L2;
      if (t < -0.001 || t > 1.001) return;
      const d = dist(p, { x: s.p1.x + t * dx, y: s.p1.y + t * dy });
      if (d < hitD) { hit = i; hitT = Math.min(1, Math.max(0, t)); hitD = d; }
    } else {
      if (Math.abs(dist(p, s.c) - s.r) > 0.05) return;
      const a = Math.atan2(p.y - s.c.y, p.x - s.c.x);
      const span = arcSpan(s);
      const rel = s.ccw ? norm(a - s.a0) : norm(s.a0 - a);
      if (rel > span + 0.01) return;
      if (Math.abs(dist(p, s.c) - s.r) < hitD) { hit = i; hitT = rel / span; hitD = Math.abs(dist(p, s.c) - s.r); }
    }
  });
  if (hit < 0 || hitD > 0.05) return segs; // p not on the loop: leave it
  const s = segs[hit];
  const before = segs.slice(0, hit), after = segs.slice(hit + 1);
  if (hitT < 0.01) return [...segs.slice(hit), ...before]; // p is the segment start
  if (hitT > 0.99) return [...after, ...segs.slice(0, hit + 1)]; // p is the segment end
  let first: Seg, second: Seg;
  if (s.kind === "line") {
    first = { kind: "line", p1: s.p1, p2: p };
    second = { kind: "line", p1: p, p2: s.p2 };
  } else {
    const span = arcSpan(s);
    const aMid = s.ccw ? s.a0 + span * hitT : s.a0 - span * hitT;
    first = { kind: "arc", c: s.c, r: s.r, a0: s.a0, a1: aMid, ccw: s.ccw };
    second = { kind: "arc", c: s.c, r: s.r, a0: aMid, a1: s.a1, ccw: s.ccw };
  }
  return [second, ...after, ...before, first];
}

// Tabs: even spacing by arc length along one loop, centred at
// (i+0.5)/N so no tab straddles the contour start. Returns the
// [s0, s1] arc-length spans (clamped inside the loop).
function tabSpans(total: number, count: number, length: number): [number, number][] {
  if (count <= 0 || total <= 0) return [];
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const centre = ((i + 0.5) * total) / count;
    const s0 = Math.max(0, centre - length / 2);
    const s1 = Math.min(total, centre + length / 2);
    if (s1 - s0 > 0.01) spans.push([s0, s1]);
  }
  return spans;
}
// Extend each tab span by one tool radius on both sides, splitting
// across the contour start when the extension wraps. The tool must
// already be at tab height when its disc first touches the span:
// a lift exactly at the span boundary leaves the disc (at zBot)
// reaching one radius into the span from each end, so a 5 mm span
// under a 6.35 mm tool is cut away entirely. Lifting a radius
// early leaves exactly the intended span at tab height — the discs
// at the lift/drop points stop at the span edges. A span itself
// never straddles the start (tabSpans centres at (i+0.5)/N), so
// only the extension wraps. Overlapping extensions (max-density
// tabs: spacing 1.5x length < length + 2R) merge naturally — the
// atom test below is a midpoint membership test over the list.
function extendTabSpans(spans: [number, number][], toolR: number, total: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const a2 = a - toolR, b2 = b + toolR;
    if (a2 >= 0 && b2 <= total) { out.push([a2, b2]); continue; }
    if (a2 < 0 && b2 <= total) { out.push([0, b2]); out.push([total + a2, total]); continue; }
    if (a2 >= 0 && b2 > total) { out.push([a2, total]); out.push([0, b2 - total]); continue; }
    // A span longer than the contour (degenerate input): the whole
    // contour is lifted.
    out.push([0, total]);
  }
  return out;
}

// Traverse a contour at zBot with tabs: inside a tab span the tool
// rides at zBot + thickness, outside at zBot. Segments are split at
// the (radius-extended) tab boundaries; a vertical feed move is
// emitted at each boundary. `spans` are the LIFTED intervals from
// extendTabSpans, not the plan spans. `startZ` is the tool's actual
// z on arrival at the contour start (the descent's end z, or the
// repositioning plunge's z) — the first atom's vertical move is
// emitted from it, so the traversal never assumes the tool is at
// zBot. The caller must already be at the contour start.
function tabbedContourMoves(segs: Seg[], zBot: number, thickness: number, spans: [number, number][], startZ: number): Move[] {
  if (!spans.length) return contourMoves(segs, zBot, zBot);
  const total = contourLength(segs);
  // Build atoms: each segment split at the tab boundaries inside it.
  type Atom = { seg: Seg; s0: number; s1: number; inTab: boolean };
  const atoms: Atom[] = [];
  let done = 0;
  for (const s of segs) {
    const len = segLength(s);
    const cuts = new Set<number>([0, len]);
    for (const [a, b] of spans) {
      if (a > done && a < done + len) cuts.add(a - done);
      if (b > done && b < done + len) cuts.add(b - done);
    }
    const sorted = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k + 1 < sorted.length; k++) {
      const f0 = sorted[k] / len, f1 = sorted[k + 1] / len;
      const mid = done + (sorted[k] + sorted[k + 1]) / 2;
      const inTab = spans.some(([a, b]) => mid >= a && mid <= b);
      let sub: Seg;
      if (s.kind === "line") {
        sub = { kind: "line",
          p1: { x: s.p1.x + (s.p2.x - s.p1.x) * f0, y: s.p1.y + (s.p2.y - s.p1.y) * f0 },
          p2: { x: s.p1.x + (s.p2.x - s.p1.x) * f1, y: s.p1.y + (s.p2.y - s.p1.y) * f1 } };
      } else {
        const span = arcSpan(s);
        const a0 = s.ccw ? s.a0 + span * f0 : s.a0 - span * f0;
        const a1 = s.ccw ? s.a0 + span * f1 : s.a0 - span * f1;
        sub = { kind: "arc", c: s.c, r: s.r, a0, a1, ccw: s.ccw };
      }
      atoms.push({ seg: sub, s0: done + sorted[k], s1: done + sorted[k + 1], inTab });
    }
    done += len;
  }
  void total;
  const moves: Move[] = [];
  let curZ = startZ;
  let cur: Pt = segStart(segs[0]);
  for (const a of atoms) {
    const z = a.inTab ? zBot + thickness : zBot;
    const st = segStart(a.seg);
    if (Math.abs(z - curZ) > 1e-9) {
      moves.push(mvFeed(st.x, st.y, z)); // vertical rise / drop at the boundary
      curZ = z;
    }
    if (a.seg.kind === "line") {
      moves.push(mvFeed(a.seg.p2.x, a.seg.p2.y, z));
    } else {
      const e = segEnd(a.seg);
      moves.push(mvArc(e.x, e.y, z, a.seg.c.x - st.x, a.seg.c.y - st.y, !a.seg.ccw));
    }
    cur = segEnd(a.seg);
  }
  void cur;
  return moves;
}

// ---------------------------------------------------------------- job model
type JobTool = { id: string; kind: string; dia_mm: number; feed_mm_s: number; plunge_mm_s: number; spindle_rpm: number; stepdown_mm: number; stepover_mm: number };
type PlanLayer = { operation: string; kind: string; layer: string; tool_id: string; allowance_mm: number; tabs: { count: number; length_mm: number; thickness_mm: number } | null };
type JobLayer = { layer: string; operation: string; part: string; start_depth: number; cut_depth: number; floor_z?: number | null; centres?: [number, number][]; diameter?: number; est?: Record<string, number> };
type JobPart = { name: string; z_top: number };

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail("job_invalid", `job.json: expected a number for ${name}, got ${JSON.stringify(v)}`);
  return v;
}
function str(v: unknown, name: string): string {
  if (typeof v !== "string") fail("job_invalid", `job.json: expected a string for ${name}, got ${JSON.stringify(v)}`);
  return v;
}

// Z levels for a feature from top Z to bottom Z with a fixed
// stepdown; the last level lands exactly on the bottom.
function zLevels(zTop: number, zBot: number, stepdown: number): number[] {
  if (!(stepdown > 0)) fail("bad_stepdown", `stepdown must be > 0, got ${stepdown}`);
  const depth = zTop - zBot;
  if (depth <= 0) return [];
  const n = Math.ceil(depth / stepdown - 1e-9);
  const levels: number[] = [];
  for (let k = 1; k <= n; k++) levels.push(k === n ? zBot : zTop - k * stepdown);
  return levels;
}

// Normalise a contour to CCW (offsetLoop does this internally for
// offsets; through-cuts use the raw loop, so normalise here).
function normaliseCCW(segs: Seg[]): Seg[] {
  const pts = loopPoints({ segs });
  if (areaOf(pts) < 0) return [...segs].reverse().map(segReverse);
  return segs;
}

// ---------------------------------------------------------------- drill (peck) + bore (helical)
function buildDrill(layer: JobLayer, plan: PlanLayer, tool: JobTool, part: JobPart, clearanceZ: number): ToolpathEntry {
  const zTop = part.z_top;
  const zBot = zTop - layer.start_depth - layer.cut_depth;
  const centres = (layer.centres ?? []).map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (!centres.length) fail("no_hole_centres", `drill layer ${layer.layer} has no centres in job.json`);
  const entry: ToolpathEntry = {
    operation: "drill", layer: layer.layer, tool_id: tool.id,
    feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
    pass: { kind: "rough", stepdown_index: null }, z_mm: r3(zBot), z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
    tabs: null, moves: [], skipped: [], notes: [],
  };
  if (plan.kind === "bore") {
    // Bore: helical entry then one full circular pass at the bottom.
    // Never a straight plunge: the tool orbits the bore centre while
    // descending, pitch = the tool's stepdown per revolution.
    const dia = num(layer.diameter, `layer ${layer.layer} diameter`);
    const rh = (dia - tool.dia_mm) / 2;
    if (!(rh > 0.05)) fail("bore_too_small", `bore ${layer.layer}: bore dia ${dia} leaves no room for a helix with tool ${tool.id} dia ${tool.dia_mm}`);
    const pitch = tool.stepdown_mm;
    const depth = zTop - zBot;
    const revs = Math.max(1, Math.ceil(depth / pitch - 1e-9));
    const dzPerArc = depth / (revs * 2);
    entry.operation = "bore";
    entry.pass = { kind: "rough", stepdown_index: null };
    for (const c of centres) {
      const sx = c.x + rh, sy = c.y;
      entry.moves.push(mvRapid(sx, sy, clearanceZ));
      entry.moves.push(mvFeed(sx, sy, zTop)); // down through air to the surface
      let z = zTop;
      for (let r = 0; r < revs; r++) {
        for (let half = 0; half < 2; half++) {
          z -= dzPerArc;
          const endX = half === 0 ? c.x - rh : c.x + rh;
          // semicircle around the bore centre: i,j from the arc start
          const startX = half === 0 ? c.x + rh : c.x - rh;
          entry.moves.push(mvArc(endX, c.y, z, c.x - startX, 0, false)); // CCW (G3)
        }
      }
      // one full circular pass at the bottom to finish the wall
      entry.moves.push(mvArc(c.x - rh, c.y, zBot, -rh, 0, false));
      entry.moves.push(mvArc(c.x + rh, c.y, zBot, rh, 0, false));
      // Central pillar: the helix orbits at rh and its disc reaches
      // inward only to rh - toolR. When rh > toolR the bore leaves a
      // central pillar of radius rh - toolR running the full depth —
      // a through hole blocked by a 2.4 mm core on Kookabus D3.40 /
      // EM0.50 (the sim caught it: every drill probe read the stock
      // top). Clear it with a helical descent at each radius that
      // tiles the central disc (step < tool dia so the annuli
      // overlap; the first helix at toolR covers the centre). A
      // bottom-only circle would leave the pillar standing above the
      // floor, so the clearing helices descend the full depth, like
      // the main helix. Their discs reach at most rh - toolR, so
      // they cannot touch the wall.
      const toolR = tool.dia_mm / 2;
      if (rh > toolR) {
        const pillarR = rh - toolR;
        const step = tool.dia_mm * 0.8;
        const n = Math.max(0, Math.ceil((pillarR - 2 * toolR) / step - 1e-9));
        for (let k = 0; k <= n; k++) {
          const r = toolR + k * step;
          entry.moves.push(mvRapid(c.x + r, c.y, clearanceZ));
          entry.moves.push(mvFeed(c.x + r, c.y, zTop));
          let z = zTop;
          for (let rev = 0; rev < revs; rev++) {
            for (let half = 0; half < 2; half++) {
              z -= dzPerArc;
              const endX = half === 0 ? c.x - r : c.x + r;
              const startX = half === 0 ? c.x + r : c.x - r;
              entry.moves.push(mvArc(endX, c.y, z, c.x - startX, 0, false));
            }
          }
          // Flat pass at the bottom: the helix leaves a ramp (up to
          // a stepdown high) around the floor; a level circle at
          // zBot flattens it, as the wall pass does at rh.
          entry.moves.push(mvArc(c.x - r, c.y, zBot, -r, 0, false));
          entry.moves.push(mvArc(c.x + r, c.y, zBot, r, 0, false));
        }
      }
      entry.moves.push(mvRapid(c.x + rh, c.y, clearanceZ));
    }
    return entry;
  }
  // Peck drill: peck depth defaults to one tool diameter (no peck
  // depth exists in the config). Pecks start at the stock top (safe
  // whatever order the pockets run in) and retract to clearance
  // between pecks; the final peck ends exactly at the hole bottom.
  const peck = tool.dia_mm;
  const depth = zTop - zBot;
  const nPecks = Math.max(1, Math.ceil(depth / peck - 1e-9));
  for (const c of centres) {
    entry.moves.push(mvRapid(c.x, c.y, clearanceZ));
    for (let k = 1; k <= nPecks; k++) {
      const pz = k === nPecks ? zBot : zTop - k * peck;
      entry.moves.push(mvFeed(c.x, c.y, pz));
      entry.moves.push(mvRapid(c.x, c.y, clearanceZ));
    }
  }
  return entry;
}

// ---------------------------------------------------------------- pockets
type PocketGeom = {
  outers: { loop: Loop; pts: Pt[]; islands: { loop: Loop; pts: Pt[] }[] }[];
  skipped: { loop: number; reason: string; detail: string }[];
};
// Group a layer's loops into outer loops (even nesting depth) with
// their islands (odd depth), by containment.
function pocketGeometry(loops: Loop[]): PocketGeom {
  const pts = loops.map((l) => loopPoints(l));
  const depths = nestingDepth(loops, pts);
  const skipped: PocketGeom["skipped"] = [];
  const outers: PocketGeom["outers"] = [];
  loops.forEach((loop, i) => {
    if (!loop.closed) { skipped.push({ loop: i, reason: "open_loop", detail: `loop ${i} did not close during assembly` }); return; }
    if (depths[i] % 2 === 0) outers.push({ loop, pts: pts[i], islands: [] });
  });
  loops.forEach((loop, i) => {
    if (!loop.closed || depths[i] % 2 === 0) return;
    // parent = the smallest even-depth loop containing this island
    let parent: PocketGeom["outers"][number] | null = null;
    for (const o of outers) {
      if (pointInPolygon(pts[i][0], o.pts) && (!parent || Math.abs(areaOf(o.pts)) < Math.abs(areaOf(parent.pts)))) parent = o;
    }
    if (parent) parent.islands.push({ loop, pts: pts[i] });
    else skipped.push({ loop: i, reason: "orphan_island", detail: `island loop ${i} has no containing outer loop` });
  });
  return { outers, skipped };
}
// Fill narrow rectangular notches (slots) in a pocket boundary before
// computing rings. A notch narrower than the tool can never be cut —
// the tool does not fit in it — but its two sides pinch the ring
// offsets: the bridge between two facing notches erodes away and the
// offset splits into two loops, which the single-loop offset cannot
// represent, so pocketRings stops at the first ring and the pocket's
// interior is never cut. (Kookabus P01: two 1.6 mm slots facing each
// other across a 12 mm bridge; EM9.53. The rings stopped after the
// outermost and the 18.8 mm pocket was left as a solid block — the
// sim caught it.) Filling the notch treats it as solid for clearing;
// the notch itself stays uncut, which is the correct outcome for a
// tool that cannot fit in it, and the verifier's probes (inset by a
// tool radius from every wall) never land in it.
// A notch is three consecutive line segments A->B, B->C, C->D where AB
// and CD are parallel and opposite (the slot's sides), BC is short and
// perpendicular (the end wall, whose length is the slot width), and
// the turns at B and C are concave (turning away from the pocket
// interior — right turns on a CCW loop, left turns on a CW one). A
// convex protrusion has the opposite turn sense and is NOT filled:
// it is a boss the tool must cut around. The fill replaces A->B->C->D
// with the straight mouth A->D. The filled slots are returned as
// axis-aligned bounding boxes (the ledges): the ring-clipping test
// needs them (see ringRuns) to know what the tool disc must not
// overlap. For an axis-aligned slot the bbox is exact; for a rotated
// slot it over-covers, which is conservative (a safe run may be
// dropped, never an unsafe one kept).
function fillNarrowSlots(loop: Loop, minWidth: number): { loop: Loop; ledges: { x0: number; y0: number; x1: number; y1: number }[] } {
  const ccw = areaOf(loopPoints(loop)) > 0;
  const ledges: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let segs = [...loop.segs];
  for (let pass = 0; pass < 8; pass++) {
    let filled = false;
    for (let i = 0; i < segs.length; i++) {
      const s0 = segs[i], s1 = segs[(i + 1) % segs.length], s2 = segs[(i + 2) % segs.length];
      if (s0.kind !== "line" || s1.kind !== "line" || s2.kind !== "line") continue;
      const A = s0.p1, B = s0.p2, C = s1.p2, D = s2.p2;
      const ab = { x: B.x - A.x, y: B.y - A.y };
      const bc = { x: C.x - B.x, y: C.y - B.y };
      const cd = { x: D.x - C.x, y: D.y - C.y };
      const lab = Math.hypot(ab.x, ab.y), lbc = Math.hypot(bc.x, bc.y), lcd = Math.hypot(cd.x, cd.y);
      if (lab < 1e-9 || lbc < 1e-9 || lcd < 1e-9) continue;
      if (lbc >= minWidth) continue; // end wall is the slot width
      if (lab <= lbc || lcd <= lbc) continue; // sides longer than the end wall
      const dotAB_CD = (ab.x * cd.x + ab.y * cd.y) / (lab * lcd);
      const dotAB_BC = (ab.x * bc.x + ab.y * bc.y) / (lab * lbc);
      if (dotAB_CD > -0.99 || Math.abs(dotAB_BC) > 0.1) continue;
      const crossB = ab.x * bc.y - ab.y * bc.x;
      const crossC = bc.x * cd.y - bc.y * cd.x;
      const concave = ccw ? crossB < 0 && crossC < 0 : crossB > 0 && crossC > 0;
      if (!concave) continue;
      const ad = { x: D.x - A.x, y: D.y - A.y };
      if (Math.hypot(ad.x, ad.y) > minWidth) continue;
      ledges.push({
        x0: Math.min(A.x, B.x, C.x, D.x), y0: Math.min(A.y, B.y, C.y, D.y),
        x1: Math.max(A.x, B.x, C.x, D.x), y1: Math.max(A.y, B.y, C.y, D.y),
      });
      segs.splice(i, 3, { kind: "line", p1: A, p2: D });
      filled = true;
      break;
    }
    if (!filled) break;
  }
  // Merge consecutive collinear line segments: filling a slot leaves
  // the mouth collinear with the wall on both sides, and at large
  // offsets the short mouth segment spikes out of the shrunken ring
  // (its endpoints sit past the ring's corners) and the offset
  // self-intersects. A single wall segment has no such spike.
  const mergeCollinear = (ss: Seg[]): Seg[] => {
    let out = [...ss];
    for (let pass = 0; pass < 8; pass++) {
      let merged = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[i], b = out[(i + 1) % out.length];
        if (a.kind !== "line" || b.kind !== "line") continue;
        const v1 = { x: a.p2.x - a.p1.x, y: a.p2.y - a.p1.y };
        const v2 = { x: b.p2.x - b.p1.x, y: b.p2.y - b.p1.y };
        const cross = v1.x * v2.y - v1.y * v2.x;
        const dot = v1.x * v2.x + v1.y * v2.y;
        if (Math.abs(cross) > 1e-9 || dot <= 0) continue;
        out.splice(i, 2, { kind: "line", p1: a.p1, p2: b.p2 });
        merged = true;
        break;
      }
      if (!merged) break;
    }
    return out;
  };
  return { loop: { layer: loop.layer, segs: mergeCollinear(segs), closed: loop.closed }, ledges };
}
// Rings for one outer loop at a given wall offset (toolR + allowance):
// successive inward offsets at stepover spacing until the offset
// vanishes or comes too close to an island.
function pocketRings(outer: PocketGeom["outers"][number], wallOff: number, stepover: number, toolR: number): { rings: Seg[][]; firstFailedD: number | null; filled: boolean; ledges: { x0: number; y0: number; x1: number; y1: number }[] } {
  const rings: Seg[][] = [];
  let firstFailedD: number | null = null;
  // Narrow notches are filled first (see fillNarrowSlots): without
  // it the ring offsets pinch off at the bridge between facing
  // notches and the interior is never cut.
  const { loop: filledLoop, ledges } = fillNarrowSlots(outer.loop, 2 * toolR);
  const filled = filledLoop.segs.length !== outer.loop.segs.length;
  const loop = filledLoop;
  for (let k = 0; ; k++) {
    const d = -(wallOff + k * stepover);
    const off = offsetLoop(loop, d);
    if (!off) { firstFailedD = d; break; }
    const fp = loopPoints({ segs: off });
    let ok = true;
    for (const isl of outer.islands) {
      for (let s = 0; s < fp.length; s += Math.max(1, Math.floor(fp.length / 48))) {
        if (distToLoop(fp[s], isl.pts) < wallOff - 0.01) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) { firstFailedD = d; break; }
    rings.push(off);
    if (k > 200) { firstFailedD = d; break; }
  }
  return { rings, firstFailedD, filled, ledges };
}

// Split a ring into the runs that lie inside the pocket's region
// (the original notched loop). A ring computed on the filled loop
// (see fillNarrowSlots) crosses a filled notch — a ledge belonging
// to another pocket (Kookabus: the D18.80 pocket's 1.6 mm slots are
// the D13.80 pocket, floor 8, while the D18.80 cuts to 3). Traversing
// the ring whole over-cuts the ledge by 5 mm. Sample the ring finely
// and keep only the inside runs, as polylines; the caller lifts
// between runs so the tool never drags across a ledge at depth.
// A ring fully inside its region is returned unchanged (arcs
// preserved) — clipping only kicks in where a notch was filled.
// A sample is kept only if it is inside the region AND its tool disc
// does not overlap any ledge (dist from the sample to each ledge
// rect >= toolR). The disc test is against the ledges, not against
// the region's boundary: a ring segment near a slot wall over-cuts
// only same-floor pocket material in the direction along the wall,
// and the region-boundary test (distToLoop >= toolR) drops it —
// the Kookabus bridge between the two slots (a 12 x 1.6 mm strip of
// D18.80 floor) is reachable only by a run whose disc sits 0.9 mm
// from the slot walls, and the old test left it uncut. The outer
// walls need no test here: the rings are offset from the filled loop
// by toolR by construction, so they already sit toolR from them.
function ringRuns(ring: Seg[], regionPts: Pt[], ledges: { x0: number; y0: number; x1: number; y1: number }[], stepMm: number, toolR: number): Seg[][] {
  const distToRect = (p: Pt, r: { x0: number; y0: number; x1: number; y1: number }): number => {
    const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
    const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
    return Math.hypot(dx, dy);
  };
  const keep = (p: Pt): boolean =>
    pointInPolygon(p, regionPts) && ledges.every((r) => distToRect(p, r) >= toolR - 0.01);
  const dense: Pt[] = [];
  for (const s of ring) {
    if (s.kind === "line") {
      const len = segLength(s);
      const n = Math.max(1, Math.ceil(len / stepMm));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        dense.push({ x: s.p1.x + (s.p2.x - s.p1.x) * t, y: s.p1.y + (s.p2.y - s.p1.y) * t });
      }
    } else {
      const sp = segPoints(s, 2);
      dense.push(...sp.slice(0, -1));
    }
  }
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  // Bisect between a failing point a and a passing point b to find
  // the run's entry/exit crossing. Without this a kept window
  // narrower than the sampling step yields a single dense point and
  // is dropped (a run needs >= 2 points) — the Kookabus bridge is
  // 2.48 mm wide at a 2 mm step, so it vanished. The crossings give
  // it entry + sample + exit = a valid run.
  const crossing = (a: Pt, b: Pt): Pt => {
    let lo = a, hi = b;
    for (let i = 0; i < 12; i++) {
      const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
      if (keep(mid)) hi = mid; else lo = mid;
    }
    return hi;
  };
  let prev: Pt | null = null;
  let prevKeep = false;
  for (const p of dense) {
    const k = keep(p);
    if (k && !prevKeep) {
      if (prev) run.push(crossing(prev, p));
      run.push(p);
    } else if (k) {
      run.push(p);
    } else if (!k && prevKeep) {
      if (prev) run.push(crossing(p, prev));
      flush();
    }
    prev = p; prevKeep = k;
  }
  flush();
  // The ring is closed: a run split by the start point wraps around.
  if (runs.length > 1 && dense.length > 0 && keep(dense[0]) && keep(dense[dense.length - 1])) {
    const first = runs.shift()!;
    const last = runs.pop()!;
    runs.push([...last, ...first]);
  }
  if (runs.length === 1 && runs[0].length === dense.length) return [ring];
  return runs.map((r) => {
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < r.length; i++) segs.push({ kind: "line", p1: r[i], p2: r[i + 1] });
    return segs;
  });
}

function buildPocket(layer: JobLayer, plan: PlanLayer, tool: JobTool, part: JobPart, clearanceZ: number, loops: Loop[]): ToolpathEntry[] {
  const zTop = part.z_top - layer.start_depth;
  const zBot = layer.floor_z ?? part.z_top - layer.start_depth - layer.cut_depth;
  const toolR = tool.dia_mm / 2;
  const stepover = tool.stepover_mm > 0 ? tool.stepover_mm : tool.dia_mm * 0.4;
  const allowance = plan.allowance_mm > 0 ? plan.allowance_mm : 0;
  const geom = pocketGeometry(loops);
  const entries: ToolpathEntry[] = [];
  const skipped = [...geom.skipped];
  // Ring sets are Z-independent: compute once per outer loop.
  // Runs are Z-independent too: a filled loop's rings are split
  // into runs once and reused at every level (and the split is
  // known here, so a loop whose rings clip to nothing is recorded
  // as skipped instead of silently cutting nothing — V3.4 fix
  // round: Kookabus D0.60 loop 4).
  const ringSets = geom.outers.map((o) => {
    const rough = pocketRings(o, toolR + allowance, stepover, toolR);
    const runs: Seg[][] = [];
    if (rough.filled) for (const ring of rough.rings) runs.push(...ringRuns(ring, o.pts, rough.ledges, 2, toolR));
    return {
      outer: o,
      rough,
      finish: allowance > 0 ? pocketRings(o, toolR, stepover, toolR) : null,
      runs,
    };
  });
  for (const rs of ringSets) {
    if (!rs.rough.rings.length) {
      skipped.push({ loop: geom.outers.indexOf(rs.outer), reason: "tool_too_large", detail: `no ring fits at wall offset ${(toolR + allowance).toFixed(3)} mm (tool ${tool.id})` });
    } else if (rs.rough.filled && !rs.runs.length) {
      // The filled loop offsets, but every ring clips to nothing
      // inside the region (the tool cannot reach any of it without
      // overlapping a filled notch) — uncut, and recorded, never
      // silent. (Kookabus D0.60 loop 4: a comb whose fingers and
      // gaps are all narrower than the 0.50 mm tool.)
      skipped.push({ loop: geom.outers.indexOf(rs.outer), reason: "tool_too_large", detail: `filled-loop rings clip to no cuttable run (tool ${tool.id} cannot reach the region without overlapping a filled notch)` });
    }
  }
  const levels = zLevels(zTop, zBot, tool.stepdown_mm);
  if (!levels.length) {
    skipped.push({ loop: -1, reason: "zero_depth", detail: `pocket ${layer.layer} has no depth (top ${zTop} bottom ${zBot})` });
  }
  levels.forEach((levelZ, li) => {
    const prevZ = li === 0 ? zTop : levels[li - 1];
    const isBottom = li === levels.length - 1;
    const entry: ToolpathEntry = {
      operation: "pocket", layer: layer.layer, tool_id: tool.id,
      feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
      pass: { kind: "rough", stepdown_index: li }, z_mm: r3(levelZ), z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
      tabs: null, moves: [], skipped: [], notes: [],
    };
    // Layer-level skips (no ring fits, open loops) are recorded once,
    // on the first level entry; per-entry skips (island contours that
    // vanish) are recorded on the entry where they happen.
    if (li === 0) entry.skipped.push(...skipped);
    let cur: Pt | null = null;
    for (const rs of ringSets) {
      const rings = rs.rough.rings;
      if (!rings.length) continue;
      if (!rs.rough.filled) {
        // Unfilled loop: the rings already sit a tool radius from
        // every wall, so traverse them as before — ramp on the first
        // (outermost) ring, feed between rings at depth. (A feed
        // between two disjoint outer loops at depth would plow
        // through the material between them — hence the retract
        // before the first ring — and a single diagonal rapid from
        // depth to (start, clearance) does the same thing while
        // rising: the tool drags across the island/wall between
        // regions while still below the stock top. The sim caught
        // exactly that groove.)
        const start = segStart(rings[0][0]);
        if (cur) entry.moves.push(mvRapid(cur.x, cur.y, clearanceZ));
        entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
        entry.moves.push(mvFeed(start.x, start.y, prevZ));
        entry.moves.push(...contourMoves(rings[0], prevZ, levelZ));
        cur = start;
        // Single-ring pocket: the ramp IS the only traversal, so the
        // floor is left sloped (prevZ -> levelZ around the loop) —
        // nothing flattens it. On the bottom level, add a planar
        // traversal at levelZ so the floor is flat. (Multi-ring
        // pockets are flattened by their inner rings, whose discs
        // overlap the outermost ring's path.) The sim caught this on
        // eight_parts P07 (a 4x10 slot, one ring): the floor read
        // 7.61 at the ramp's high end vs the 7.50 floor.
        if (isBottom && rings.length === 1) {
          entry.moves.push(...contourMoves(rings[0], levelZ, levelZ));
        }
        for (let ri = 1; ri < rings.length; ri++) {
          const ns = segStart(rings[ri][0]);
          if (dist(cur, ns) > 0.001) entry.moves.push(mvFeed(ns.x, ns.y, levelZ)); // feed between rings at depth
          entry.moves.push(...contourMoves(rings[ri], levelZ, levelZ));
          cur = ns;
        }
      } else {
        // Filled loop: split each ring into the runs inside the
        // pocket's region (ringRuns) — a ring on the filled loop
        // that crosses a filled notch is clipped to the runs outside
        // the ledge, so the tool never cuts a neighbouring pocket's
        // floor. Each run is entered from clearance (a vertical
        // retract first, then a horizontal rapid at clearance, then
        // a feed down) — a diagonal rapid or a feed at depth between
        // runs would drag the tool across the ledge.
        // Entry (V3.4 fix round — supersedes fix 9): every run
        // ramps in, never plunges. Fix 9 fed non-first runs straight
        // down to levelZ, a vertical feed from clearance into solid
        // at a fresh XY (136 flagged plunges on Kookabus). Each run
        // now feeds vertically only to entryZ, ramps down the run
        // to the level, then traverses the run flat at the level:
        // the ramp alone leaves a sloped floor (high at the run
        // start), and only the first run's slope used to be
        // flattened by the inner rings' overlap, so every run
        // flattens itself. The flat traversal re-cuts exactly the
        // run the ramp cut — no new material, no ledge contact.
        // entryZ is the higher of the floor the previous level cut
        // (prevZ) and one stepdown above this level, capped at the
        // stock top. They agree except on a partial final step,
        // where the previous level sits less than a stepdown above
        // this one — feeding to prevZ there ends below the nominal
        // previous level and reads as a plunge. The feed to entryZ
        // is always through open space: the previous level cleared
        // the pocket down to prevZ, and entryZ >= prevZ.
        const allRuns = rs.runs;
        for (const run of allRuns) {
          const start = segStart(run[0]);
          if (cur) entry.moves.push(mvRapid(cur.x, cur.y, clearanceZ));
          entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
          const entryZ = Math.max(prevZ, Math.min(zTop, levelZ + tool.stepdown_mm));
          entry.moves.push(mvFeed(start.x, start.y, entryZ));
          entry.moves.push(...contourMoves(run, entryZ, levelZ));
          entry.moves.push(...contourMoves(run, levelZ, levelZ));
          // The tool ends at the run's end (for a closed ring that
          // is its start; for a clipped run it is the far end).
          cur = segEnd(run[run.length - 1]);
        }
      }
      // Island contours (outward offset from the island, CW): the
      // tool goes around the island material.
      for (const isl of rs.outer.islands) {
        const ic = offsetLoop(isl.loop, toolR + allowance);
        if (!ic) { entry.skipped.push({ loop: geom.outers.indexOf(rs.outer), reason: "island_too_small", detail: `island contour at offset ${(toolR + allowance).toFixed(3)} mm vanished` }); continue; }
        const rev = reverseContour(ic);
        const ns = segStart(rev[0]);
        if (cur && dist(cur, ns) > 0.001) entry.moves.push(mvFeed(ns.x, ns.y, levelZ));
        entry.moves.push(...contourMoves(rev, levelZ, levelZ));
        cur = ns;
      }
    }
    if (cur) entry.moves.push(mvRapid(cur.x, cur.y, clearanceZ));
    entries.push(entry);
  });
  // Finish pass (single full-depth contour) where the plan calls for
  // one: helical descent over one revolution, then one planar
  // revolution at the bottom.
  if (allowance > 0) {
    const entry: ToolpathEntry = {
      operation: "pocket", layer: layer.layer, tool_id: tool.id,
      feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
      pass: { kind: "finish", stepdown_index: null }, z_mm: null, z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
      tabs: null, moves: [], skipped: [], notes: [`finish allowance ${allowance} mm`],
    };
    for (const rs of ringSets) {
      const fr = rs.finish?.rings ?? [];
      if (!fr.length) continue;
      const contour = fr[0]; // outermost = the wall contour
      const start = segStart(contour[0]);
      entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
      entry.moves.push(mvFeed(start.x, start.y, zTop));
      entry.moves.push(...contourMoves(contour, zTop, zBot));
      entry.moves.push(...contourMoves(contour, zBot, zBot));
      for (const isl of rs.outer.islands) {
        const ic = offsetLoop(isl.loop, toolR);
        if (!ic) { entry.skipped.push({ loop: geom.outers.indexOf(rs.outer), reason: "island_too_small", detail: `finish island contour at offset ${toolR.toFixed(3)} mm vanished` }); continue; }
        const rev = reverseContour(ic);
        const ns = segStart(rev[0]);
        entry.moves.push(mvRapid(ns.x, ns.y, clearanceZ));
        entry.moves.push(mvFeed(ns.x, ns.y, zTop));
        entry.moves.push(...contourMoves(rev, zTop, zBot));
        entry.moves.push(...contourMoves(rev, zBot, zBot));
      }
    }
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------- profiles
// Distribute a layer's tab count across its loops by perimeter share
// (remainder to the longest loop; a loop too short to hold a tab
// with a gap between tabs gets none). Returns per-loop tab counts
// that sum to the layer count whenever the total perimeter can hold
// them, else as many as fit.
function distributeTabs(perims: number[], count: number, length: number): number[] {
  const total = perims.reduce((a, b) => a + b, 0);
  const out = perims.map((p) => {
    if (total <= 0) return 0;
    let n = Math.round((count * p) / total);
    const maxFit = Math.floor(p / (length * 1.5));
    return Math.max(0, Math.min(n, maxFit));
  });
  let placed = out.reduce((a, b) => a + b, 0);
  // Fix the total up/down on the longest loop (within its capacity).
  const order = perims.map((p, i) => i).sort((a, b) => perims[b] - perims[a]);
  for (const i of order) {
    if (placed >= count) break;
    const maxFit = Math.floor(perims[i] / (length * 1.5));
    const add = Math.min(count - placed, maxFit - out[i]);
    if (add > 0) { out[i] += add; placed += add; }
  }
  for (const i of order) {
    if (placed <= count) break;
    const cut = Math.min(placed - count, out[i]);
    out[i] -= cut; placed -= cut;
  }
  return out;
}

function buildProfile(layer: JobLayer, plan: PlanLayer, tool: JobTool, part: JobPart, clearanceZ: number, loops: Loop[]): ToolpathEntry[] {
  const zTop = part.z_top - layer.start_depth;
  const zBot = part.z_top - layer.start_depth - layer.cut_depth;
  const toolR = tool.dia_mm / 2;
  // Tabs only make sense when the tab height sits below the cut
  // top: a tab thicker than the cut would ride above the stock and
  // there is nothing to leave. (No reference job hits this; it is
  // a guard, not a behaviour change for real plans.)
  const useTabs = !!plan.tabs && zBot + plan.tabs.thickness_mm < zTop;
  const tabThick = useTabs ? plan.tabs!.thickness_mm : 0;
  const isThroughCut = /THROUGH_CUT/.test(layer.layer);
  const entries: ToolpathEntry[] = [];
  const skipped: ToolpathEntry["skipped"] = [];
  // One contour per closed loop: outward by tool radius for an outer
  // profile, centred (offset 0) for a through-cut slot. Outer
  // profiles traverse CW (climb); through-cuts CCW.
  type Contour = { segs: Seg[]; perim: number; loopIndex: number };
  const contours: Contour[] = [];
  loops.forEach((loop, li) => {
    if (!loop.closed) { skipped.push({ loop: li, reason: "open_loop", detail: `loop ${li} did not close during assembly` }); return; }
    if (isThroughCut) {
      const ccw = normaliseCCW(loop.segs);
      contours.push({ segs: ccw, perim: contourLength(ccw), loopIndex: li });
    } else {
      const off = offsetLoop(loop, toolR);
      if (!off) { skipped.push({ loop: li, reason: "offset_failed", detail: `outward offset by tool radius ${toolR} mm failed (see docs-v3/offset_spike.md known limits)` }); return; }
      contours.push({ segs: reverseContour(off), perim: contourLength(off), loopIndex: li });
    }
  });
  // Outer profiles: rotate each contour to start at its farthest
  // (convex extreme) point, where the level-0 lead-in ramp lands
  // (see rotateLoopStart). Through-cuts ramp along the slot from
  // its own start and are left alone.
  if (!isThroughCut) {
    contours.forEach((c) => {
      const { p } = farthestPoint(c.segs);
      c.segs = rotateLoopStart(c.segs, p);
      c.perim = contourLength(c.segs);
    });
  }
  if (!contours.length) {
    // No contour at all: record the layer as a single empty entry so
    // the 1:1 plan-layer mapping is auditable.
    entries.push({
      operation: "profile", layer: layer.layer, tool_id: tool.id,
      feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
      pass: { kind: "rough", stepdown_index: null }, z_mm: null, z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
      tabs: useTabs ? { count: plan.tabs!.count, length_mm: plan.tabs!.length_mm, thickness_mm: plan.tabs!.thickness_mm, positions: [] } : null,
      moves: [], skipped, notes: ["no contour produced for any loop"],
    });
    return entries;
  }
  const allowance = plan.allowance_mm > 0 ? plan.allowance_mm : 0;
  // Tabs (bottom pass only) are distributed across the loops.
  const tabCounts = useTabs ? distributeTabs(contours.map((c) => c.perim), plan.tabs!.count, plan.tabs!.length_mm) : contours.map(() => 0);
  const tabPositions: { loop: number; s_mm: number }[] = [];
  contours.forEach((c, ci) => {
    for (const [s0, s1] of tabSpans(c.perim, tabCounts[ci], plan.tabs!.length_mm)) {
      tabPositions.push({ loop: c.loopIndex, s_mm: r3((s0 + s1) / 2) });
    }
  });
  const tabsField = useTabs ? { count: plan.tabs!.count, length_mm: plan.tabs!.length_mm, thickness_mm: plan.tabs!.thickness_mm, positions: tabPositions } : null;
  // The rough levels stop at the tab height, not zBot: a rough
  // level below the tab height cuts the tab spans away before the
  // bottom pass ever runs (the sim caught this — with levels down
  // to 0.5 the tabs came out at 0.57 mm, not 1 mm). The tabbed
  // traversal on the last level is the only thing that cuts below
  // the tab height, and it skips the spans. Without tabs the
  // levels run to zBot as before.
  const roughBot = useTabs ? zBot + tabThick : zBot;
  const levels = zLevels(zTop, roughBot, tool.stepdown_mm);
  const rampLen = Math.max(2 * tool.dia_mm, 10);
  levels.forEach((levelZ, li) => {
    const prevZ = li === 0 ? zTop : levels[li - 1];
    const isBottom = li === levels.length - 1;
    // On the bottom pass with tabs the cutting floor is the tab
    // height, not zBot: the level's entry ramp / helical descent
    // falls linearly with arc length, so descending to zBot would
    // cut the tab spans in the second half of the contour below the
    // tab height, and the tabbed traversal that follows cannot
    // restore material. The tabbed traversal then cuts zBot outside
    // the spans; the entry still reaches zBot, so z_mm is unchanged.
    const bottomZ = isBottom && useTabs
      ? Math.max(levelZ, zBot + tabThick)
      : levelZ;
    const entry: ToolpathEntry = {
      operation: "profile", layer: layer.layer, tool_id: tool.id,
      feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
      pass: { kind: "rough", stepdown_index: li }, z_mm: r3(levelZ), z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
      tabs: isBottom ? tabsField : null, moves: [], skipped: li === 0 ? [...skipped] : [], notes: [],
    };
    contours.forEach((c, ci) => {
      const start = segStart(c.segs[0]);
      if (li === 0 && !isThroughCut) {
        // Lead-in: approach from outside the part (convex extreme
        // point, outward from the centroid), ramp down to the level.
        // The approach direction is computed from the contour's
        // actual START, not from a fresh farthestPoint call: on a
        // circle every sampled point is (nearly) equidistant from
        // the centroid, so re-computing the farthest point after
        // the rotation's arc-split shifts the sampled centroid by
        // a fraction of a millimetre and flips the argmax to the
        // opposite side of the circle — the approach point then
        // sits across the part from the start and the ramp ploughs
        // straight through it (a real gouge the sim caught: the
        // container profiles' ramps were 65 mm chords across the
        // part instead of 12.7 mm approaches from outside it).
        const { c: cen } = farthestPoint(c.segs);
        const dx = start.x - cen.x, dy = start.y - cen.y;
        const dl = Math.hypot(dx, dy) || 1;
        const ax = start.x + (dx / dl) * rampLen, ay = start.y + (dy / dl) * rampLen;
        // Retract vertically to clearance at the current XY before
        // the horizontal rapid to the approach point: a diagonal
        // rapid from the previous contour's end (at the level) drags
        // the tool across the part while still below the stock top
        // (the sim caught this on Kookabus P02's through-cut: a
        // rapid from (221.82,61.36,11.65) to (316.15,62.12,26.80)
        // gouged a ramp across the part). The later-levels branch
        // already retracts; the level-0 branches did not.
        const at0 = lastXY(entry.moves);
        if (at0) entry.moves.push(mvRapid(at0.x, at0.y, clearanceZ));
        entry.moves.push(mvRapid(ax, ay, clearanceZ));
        entry.moves.push(mvFeed(ax, ay, zTop + 0.5));
        // The ramp lands at the contour start (== the farthest point
        // after the rotation above), so the contour arc's i,j is
        // computed from the point the tool actually reaches.
        entry.moves.push(mvFeed(start.x, start.y, bottomZ)); // lead-in ramp
        entry.moves.push(...contourMoves(c.segs, bottomZ, bottomZ));
      } else if (li === 0 && isThroughCut) {
        // Slot entry: ramp down along the start of the slot itself.
        // (Vertical retract first — see the lead-in branch above:
        // a diagonal rapid from the previous contour's end gouges.)
        const at0 = lastXY(entry.moves);
        if (at0) entry.moves.push(mvRapid(at0.x, at0.y, clearanceZ));
        entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
        entry.moves.push(mvFeed(start.x, start.y, zTop + 0.5));
        const total = contourLength(c.segs);
        const ramp = Math.min(rampLen, total / 2);
        // Descend from zTop+0.5 to the floor over the first `ramp` mm.
        const zAt = (s: number) => (s >= ramp ? bottomZ : zTop + 0.5 + ((bottomZ - (zTop + 0.5)) * s) / ramp);
        let done = 0;
        for (const s of c.segs) {
          const len = segLength(s);
          if (s.kind === "line") {
            entry.moves.push(mvFeed(s.p2.x, s.p2.y, zAt(done + len)));
          } else {
            const e = segEnd(s);
            entry.moves.push(mvArc(e.x, e.y, zAt(done + len), s.c.x - segStart(s).x, s.c.y - segStart(s).y, !s.ccw));
          }
          done += len;
        }
      } else {
        // Later levels: helical descent along the contour itself.
        const at = lastXY(entry.moves);
        if (at) entry.moves.push(mvRapid(at.x, at.y, clearanceZ));
        entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
        entry.moves.push(mvFeed(start.x, start.y, prevZ));
        entry.moves.push(...contourMoves(c.segs, prevZ, bottomZ));
      }
      void ci;
    });
    // Bottom pass: one more full traversal at zBot with the tabs
    // (the tool rides tab_thickness high over each tab span). The
    // lift/drop points sit one tool radius outside each span (see
    // extendTabSpans), so the tool is already up when its disc
    // first touches the span.
    if (isBottom && useTabs) {
      contours.forEach((c, ci) => {
        const start = segStart(c.segs[0]);
        const spans = tabSpans(c.perim, tabCounts[ci], plan.tabs!.length_mm);
        const lifted = extendTabSpans(spans, toolR, c.perim);
        const tabHeight = zBot + tabThick;
        // Entry height: the descent ended at tabHeight, so a tool
        // already at the contour start arrives at tabHeight; a tool
        // repositioned from another contour is plunged to the first
        // atom's z (tabHeight when the lifted interval wraps over
        // the start, else zBot).
        const firstTab = lifted.some(([a, b]) => 0 >= a && 0 <= b);
        const entryZ = firstTab ? tabHeight : zBot;
        const at = lastXY(entry.moves);
        let startZ: number;
        if (at && dist(at, start) > 0.001) {
          entry.moves.push(mvRapid(at.x, at.y, clearanceZ));
          entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
          entry.moves.push(mvFeed(start.x, start.y, entryZ));
          startZ = entryZ;
        } else {
          startZ = tabHeight;
        }
        entry.moves.push(...tabbedContourMoves(c.segs, zBot, tabThick, lifted, startZ));
      });
    }
    const at = lastXY(entry.moves);
    if (at) entry.moves.push(mvRapid(at.x, at.y, clearanceZ));
    entries.push(entry);
  });
  // Finish pass for a profile where the plan calls for one.
  if (allowance > 0) {
    const entry: ToolpathEntry = {
      operation: "profile", layer: layer.layer, tool_id: tool.id,
      feed_mm_s: tool.feed_mm_s, plunge_mm_s: tool.plunge_mm_s, spindle_rpm: tool.spindle_rpm,
      pass: { kind: "finish", stepdown_index: null }, z_mm: null, z_top_mm: r3(zTop), z_bottom_mm: r3(zBot),
      tabs: null, moves: [], skipped: [], notes: [`finish allowance ${allowance} mm`],
    };
    // Finish contour: offset by exactly toolR (the wall), not the
    // rough offset. For through-cuts the finish is the centred loop.
    loops.forEach((loop, li) => {
      if (!loop.closed) return;
      let contour: Seg[];
      if (isThroughCut) contour = normaliseCCW(loop.segs);
      else {
        const off = offsetLoop(loop, toolR);
        if (!off) return;
        contour = reverseContour(off);
      }
      const start = segStart(contour[0]);
      entry.moves.push(mvRapid(start.x, start.y, clearanceZ));
      entry.moves.push(mvFeed(start.x, start.y, zTop));
      entry.moves.push(...contourMoves(contour, zTop, zBot));
      entry.moves.push(...contourMoves(contour, zBot, zBot));
      void li;
    });
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------- main
function main(): void {
  const argv = process.argv.slice(2);
  const jobDirArg = argv.find((a: string) => !a.startsWith("-"));
  if (!jobDirArg) {
    console.log(JSON.stringify({ ok: false, error: "usage_error", message: "usage: bun ts/toolpaths.ts <job-dir>" }));
    process.exit(1);
  }
  const jobDir = jobDirArg;
  try {
    const jobText = (() => {
      try { return readFileSync(join(jobDir, "job.json"), "utf-8"); }
      catch { fail("job_invalid", `no job.json in ${jobDir} — not a v2 job dir`); }
    })();
    const job = JSON.parse(jobText as string) as Record<string, unknown>;
    if (num(job.job_version, "job_version") < 2) {
      fail("toolpaths_unavailable", `${jobDir} is a v1 job — toolpaths need the V2.2 job model (job.json). Re-run \`mldxf plan\` on the source STEP instead`);
    }
    const layers = job.layers as JobLayer[];
    // Multi-part jobs carry a parts list; single-part jobs (e.g. the
    // machined plate) have parts: null and a top-level z_top, and
    // their layers carry no `part` field. Normalise to one implicit
    // part so the rest of the generator is shape-agnostic.
    const rawParts = job.parts as JobPart[] | null | undefined;
    const parts: JobPart[] = (Array.isArray(rawParts) && rawParts.length)
      ? rawParts
      : [{ name: "__single__", z_top: num(job.z_top, "z_top (single-part job)") }];
    const toolPlan = job.tool_plan as { chosen?: string; plans: { tools: JobTool[]; layers: PlanLayer[] }[] };
    if (!toolPlan?.plans?.length) fail("no_plan", `${jobDir} has no tool plan in job.json`);
    const chosenLetter = typeof toolPlan.chosen === "string" ? toolPlan.chosen : "A";
    const planIndex = Math.max(0, Math.min(toolPlan.plans.length - 1, chosenLetter.charCodeAt(0) - 65));
    const plan = toolPlan.plans[planIndex];
    const tools = new Map(plan.tools.map((t) => [t.id, t]));
    const layerByName = new Map(layers.map((l) => [l.layer, l]));
    const partByName = new Map(parts.map((p) => [p.name, p]));
    const cutOrder = (job.cut_order as string[] | undefined) ?? ["drill", "pocket", "profile"];
    const cutIndex = (op: string) => { const i = cutOrder.indexOf(op); return i < 0 ? cutOrder.length : i; };
    const clearanceZ = Math.max(...parts.map((p) => p.z_top)) + 5.0;
    // The job's root DXF: prefer the file named after the job dir.
    const rootFiles = readdirSync(jobDir).filter((f: string) => f.toLowerCase().endsWith(".dxf"));
    let dxfName = rootFiles.find((f: string) => f === `${basename(jobDir)}.dxf`) ?? (rootFiles.length === 1 ? rootFiles[0] : undefined);
    if (!dxfName) {
      if (!rootFiles.length) fail("dxf_not_found", `no .dxf file in ${jobDir}`);
      fail("dxf_ambiguous", `multiple .dxf files in ${jobDir}: ${rootFiles.join(", ")}`);
    }
    const dxfText = readFileSync(join(jobDir, dxfName), "utf-8");
    const ents = parseDxf(dxfText);
    const byLayer = entitiesToSegs(ents);
    for (const l of parseLwpl(dxfText)) {
      const segs: Seg[] = [];
      for (let i = 0; i + 1 < l.pts.length; i++) segs.push({ kind: "line", p1: l.pts[i], p2: l.pts[i + 1] });
      if (!byLayer.has(l.layer)) byLayer.set(l.layer, []);
      byLayer.get(l.layer)!.push(...segs);
    }
    // Assemble loops per layer (with the classifier arc-span repair).
    const loopsByLayer = new Map<string, Loop[]>();
    for (const [name, segs] of byLayer) {
      repairArcsInLayer(segs);
      loopsByLayer.set(name, assemble(segs));
    }
    // Emit in cut order, stable by plan order.
    const planLayers = plan.layers.map((pl, i) => ({ pl, i })).sort((a, b) => cutIndex(a.pl.operation) - cutIndex(b.pl.operation) || a.i - b.i);
    const operations: ToolpathEntry[] = [];
    const skippedAll: { layer: string; loop: number; reason: string; detail: string }[] = [];
    for (const { pl } of planLayers) {
      const jl = layerByName.get(pl.layer);
      if (!jl) fail("layer_missing", `plan layer ${pl.layer} is not in job.json layers`);
      // Layers without a `part` field belong to the single part.
      const part = jl.part ? partByName.get(jl.part) : parts[0];
      if (!part) fail("part_missing", `layer ${pl.layer} names part ${jl.part}, not in job.json parts`);
      const tool = tools.get(pl.tool_id);
      if (!tool) fail("tool_unknown", `plan layer ${pl.layer} names tool ${pl.tool_id}, not in the chosen plan`);
      const loops = loopsByLayer.get(pl.layer);
      if (!loops) fail("layer_missing_in_dxf", `plan layer ${pl.layer} has no entities in ${dxfName}`);
      let made: ToolpathEntry[] = [];
      if (pl.operation === "drill") made = [buildDrill(jl, pl, tool, part, clearanceZ)];
      else if (pl.operation === "pocket") made = buildPocket(jl, pl, tool, part, clearanceZ, loops);
      else if (pl.operation === "profile") made = buildProfile(jl, pl, tool, part, clearanceZ, loops);
      else fail("operation_unknown", `plan layer ${pl.layer} has unknown operation ${pl.operation}`);
      for (const e of made) {
        console.error(`toolpaths: ${e.layer} ${e.operation} pass=${e.pass.kind} level=${e.pass.stepdown_index} moves=${e.moves.length}`);
        for (const s of e.skipped) skippedAll.push({ layer: e.layer, ...s });
        operations.push(e);
      }
    }
    const stats = { operations: operations.length, moves: 0, rapid: 0, feed: 0, arc: 0 };
    for (const e of operations) for (const m of e.moves) { stats.moves++; stats[m.t]++; }
    const section = {
      version: 1,
      generator: "ts/toolpaths.ts",
      plan: chosenLetter,
      clearance_z_mm: r3(clearanceZ),
      z_model: "Z=0 at bottom of stock; cut-bottom Z = z_top - start_depth - cut_depth",
      cut_order: cutOrder,
      operations,
      skipped: skippedAll,
      stats,
    };
    // V3.14: motion time, from the same duration model the 3D view's
    // playback timeline uses (flattenToolpaths). It is derived data —
    // a deterministic function of the moves — so the rerun identity
    // comparison ignores these three fields (mldxf.py) and old v3
    // jobs gain them on their next toolpaths run.
    const motion = summarizeMotion(flattenToolpaths(section as unknown as ToolpathsIn));
    const sectionWithMotion = {
      ...section,
      motion_time_s: r1(motion.totalSeconds),
      motion_by_tool: r1map(motion.byTool),
      motion_by_operation: r1map(motion.byOperation),
    };
    console.log(JSON.stringify({ ok: true, toolpaths: sectionWithMotion, stats }));
  } catch (e) {
    if (isNamed(e)) {
      console.log(JSON.stringify({ ok: false, error: e.code, message: e.message }));
      process.exit(1);
    }
    const err = e as Error;
    console.log(JSON.stringify({ ok: false, error: "internal_error", message: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` }));
    process.exit(2);
  }
}
main();
