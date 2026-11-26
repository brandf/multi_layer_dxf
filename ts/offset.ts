// Geometry for the V3.1 TypeScript toolpath generator: DXF parsing,
// loop assembly (with the classifier arc-span repair), and the
// hand-rolled polygon offsetter (Candidate B — see
// docs-v3/offset_spike.md for the verdict, the rules this code
// proves, and the known limits). Dependency-free; Bun-runnable.
// This module only does geometry: it never reads job.json and never
// writes anything. The move emitter lives in toolpaths.ts.
type Pt = { x: number; y: number };
type Seg =
  | { kind: "line"; p1: Pt; p2: Pt }
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number; ccw: boolean };
type Loop = { layer: string; segs: Seg[]; closed: boolean };

const TAU = Math.PI * 2;
const norm = (a: number) => { let x = a % TAU; if (x < 0) x += TAU; return x; };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

// ---------- minimal DXF text parser ----------
function parseDxf(text: string): { layer: string; ent: string; vals: Map<number, string> }[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  const out: { layer: string; ent: string; vals: Map<number, string> }[] = [];
  let inEntities = false, cur: { layer: string; ent: string; vals: Map<number, string> } | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const [code, val] of pairs) {
    if (code === 2 && val === "ENTITIES") { inEntities = true; continue; }
    if (code === 2) { inEntities = false; continue; }
    if (code === 0) {
      if (val === "SECTION") { flush(); continue; }
      if (val === "ENDSEC") { flush(); inEntities = false; continue; }
      if (inEntities) { flush(); cur = { layer: "", ent: val, vals: new Map() }; continue; }
    }
    if (cur) {
      if (code === 8) cur.layer = val.trim();
      else cur.vals.set(code, val);
    }
  }
  flush();
  return out;
}
const f = (m: Map<number, string>, c: number) => parseFloat(m.get(c) ?? "NaN");

function entitiesToSegs(ents: ReturnType<typeof parseDxf>): Map<string, Seg[]> {
  const byLayer = new Map<string, Seg[]>();
  const push = (layer: string, s: Seg) => {
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(s);
  };
  for (const e of ents) {
    const v = e.vals;
    if (e.ent === "CIRCLE") {
      push(e.layer, { kind: "arc", c: { x: f(v, 10), y: f(v, 20) }, r: f(v, 40), a0: 0, a1: TAU, ccw: true });
    } else if (e.ent === "LINE") {
      push(e.layer, { kind: "line", p1: { x: f(v, 10), y: f(v, 20) }, p2: { x: f(v, 11), y: f(v, 21) } });
    } else if (e.ent === "ARC") {
      push(e.layer, { kind: "arc", c: { x: f(v, 10), y: f(v, 20) }, r: f(v, 40), a0: (f(v, 50) * Math.PI) / 180, a1: (f(v, 51) * Math.PI) / 180, ccw: true });
    }
  }
  return byLayer;
}

function parseLwpl(text: string): { layer: string; pts: Pt[]; closed: boolean; bulges: number[] }[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  const out: { layer: string; pts: Pt[]; closed: boolean; bulges: number[] }[] = [];
  let inEntities = false, cur: { layer: string; pts: Pt[]; closed: boolean; bulges: number[] } | null = null;
  let px: number | null = null;
  for (const [code, val] of pairs) {
    if (code === 2 && val === "ENTITIES") { inEntities = true; continue; }
    if (code === 2) { inEntities = false; continue; }
    if (code === 0) {
      if (val === "SECTION" || val === "ENDSEC") { if (cur) out.push(cur); cur = null; if (val === "ENDSEC") inEntities = false; continue; }
      if (inEntities) { if (cur) out.push(cur); cur = val === "LWPOLYLINE" ? { layer: "", pts: [], closed: false, bulges: [] } : null; px = null; continue; }
    }
    if (!cur) continue;
    if (code === 8) cur.layer = val.trim();
    else if (code === 70) cur.closed = (parseInt(val, 10) & 1) === 1;
    else if (code === 10) px = parseFloat(val);
    else if (code === 20 && px !== null) { cur.pts.push({ x: px, y: parseFloat(val) }); px = null; }
    else if (code === 42) cur.bulges.push(parseFloat(val));
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- loop assembly ----------
function segStart(s: Seg): Pt { return s.kind === "line" ? s.p1 : { x: s.c.x + s.r * Math.cos(s.a0), y: s.c.y + s.r * Math.sin(s.a0) }; }
function segEnd(s: Seg): Pt { return s.kind === "line" ? s.p2 : { x: s.c.x + s.r * Math.cos(s.a1), y: s.c.y + s.r * Math.sin(s.a1) }; }
function segReverse(s: Seg): Seg {
  if (s.kind === "line") return { kind: "line", p1: s.p2, p2: s.p1 };
  return { kind: "arc", c: s.c, r: s.r, a0: s.a1, a1: s.a0, ccw: !s.ccw };
}

// Layer-level arc repair: the classifier stores some ARC spans in a
// frame-mirrored quadrant (STEP truth: machined PROFILE_THRU top-right
// corner is 0..90deg, the DXF stores 90..180; POCKET_D18.80 fillets
// likewise). A stored endpoint that coincides with no other segment's
// endpoint dangles; if exactly two other endpoints lie on the arc's
// circle, the true span runs between them — pick the sweep whose
// magnitude equals the stored span (both sweeps can match at 90deg;
// prefer CCW, the assembler reverses as needed).
function repairArcsInLayer(segs: Seg[]): number {
  const endpoints: { p: Pt; seg: number }[] = [];
  segs.forEach((s, i) => {
    if (s.kind === "line") { endpoints.push({ p: s.p1, seg: i }, { p: s.p2, seg: i }); }
    else if (s.kind === "arc" && Math.abs(norm(s.a1 - s.a0) - TAU) > 1e-9) { endpoints.push({ p: segStart(s), seg: i }, { p: segEnd(s), seg: i }); }
  });
  let repaired = 0;
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    if (s.kind !== "arc" || Math.abs(norm(s.a1 - s.a0) - TAU) < 1e-9) continue;
    const stored = [segStart(s), segEnd(s)];
    const genuine = stored.map((p) => endpoints.some((e) => e.seg !== si && dist(p, e.p) < 0.01));
    if (genuine[0] && genuine[1]) continue;
    const cands = endpoints.filter((e) => e.seg !== si && Math.abs(dist(e.p, s.c) - s.r) < 0.05).map((e) => e.p);
    const uniq: Pt[] = [];
    for (const p of cands) if (!uniq.some((q) => dist(p, q) < 0.01)) uniq.push(p);
    if (uniq.length !== 2) continue;
    const storedSpan = norm(s.a1 - s.a0) || TAU;
    const aA = Math.atan2(uniq[0].y - s.c.y, uniq[0].x - s.c.x);
    const aB = Math.atan2(uniq[1].y - s.c.y, uniq[1].x - s.c.x);
    const ccwSpan = norm(aB - aA), cwSpan = norm(aA - aB);
    const tol = (2 * Math.PI) / 180;
    if (Math.abs(ccwSpan - storedSpan) < tol) { s.a0 = aA; s.a1 = aB; s.ccw = true; repaired++; }
    else if (Math.abs(cwSpan - storedSpan) < tol) { s.a0 = aA; s.a1 = aB; s.ccw = false; repaired++; }
  }
  return repaired;
}

// Direction of travel at a segment's start / end (unit tangent).
function segDirStart(s: Seg): Pt {
  if (s.kind === "line") { const L = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y); return { x: (s.p2.x - s.p1.x) / L, y: (s.p2.y - s.p1.y) / L }; }
  const a = s.a0 + (s.ccw ? 1 : -1) * 0.001;
  return { x: -Math.sin(a) * (s.ccw ? 1 : -1), y: Math.cos(a) * (s.ccw ? 1 : -1) };
}
function segDirEnd(s: Seg): Pt {
  if (s.kind === "line") { const L = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y); return { x: (s.p2.x - s.p1.x) / L, y: (s.p2.y - s.p1.y) / L }; }
  const a = s.a1 - (s.ccw ? 1 : -1) * 0.001;
  return { x: -Math.sin(a) * (s.ccw ? 1 : -1), y: Math.cos(a) * (s.ccw ? 1 : -1) };
}

function assemble(segs: Seg[]): Loop[] {
  const loops: Loop[] = [];
  const unused = [...segs];
  while (unused.length) {
    const first = unused.shift()!;
    const chain: Seg[] = [first];
    let closed = false;
    for (let guard = 0; guard < 10000; guard++) {
      const end = segEnd(chain[chain.length - 1]);
      if (dist(end, segStart(chain[0])) < 0.01) { closed = true; break; }
      // All unused segments meeting this endpoint; at a junction
      // (degree > 2) take the straightest continuation — a slot's
      // two walls meet at the end cap, and the first-match choice
      // turns back along the other wall (sliver loop).
      const cands: number[] = [];
      unused.forEach((s, i) => { if (dist(segStart(s), end) < 0.01 || dist(segEnd(s), end) < 0.01) cands.push(i); });
      if (!cands.length) break;
      const dir = segDirEnd(chain[chain.length - 1]);
      cands.sort((a, b) => {
        const sa = unused[a], sb = unused[b];
        const da = dist(segStart(sa), end) < 0.01 ? segDirStart(sa) : { x: -segDirEnd(sa).x, y: -segDirEnd(sa).y };
        const db = dist(segStart(sb), end) < 0.01 ? segDirStart(sb) : { x: -segDirEnd(sb).x, y: -segDirEnd(sb).y };
        // straightest = largest dot product with current direction
        return (db.x * dir.x + db.y * dir.y) - (da.x * dir.x + da.y * dir.y);
      });
      const s = unused.splice(cands[0], 1)[0];
      chain.push(dist(segStart(s), end) < 0.01 ? s : segReverse(s));
    }
    if (!closed) {
      // Repair: an ARC whose stored span is the frame-mirrored one
      // has both neighbour points on its circle but its stored
      // endpoints elsewhere. Re-derive the span from the neighbours.
      if (repairArcSpans(chain)) {
        const end = segEnd(chain[chain.length - 1]);
        if (dist(end, segStart(chain[0])) < 0.01) closed = true;
      }
    }
    loops.push({ layer: "", segs: chain, closed });
  }
  // A closed chain enclosing no area is not a feature: a duplicated
  // segment builds an out-and-back sliver (eight_parts P07 pocket's
  // y=30 midline appears twice in the DXF). Drop it.
  return loops.filter((l) => !l.closed || Math.abs(areaOf(loopPoints(l))) > 1e-6);
}

// Re-derive arc spans from neighbour endpoints in the chain.
// Returns true if any arc was changed.
function repairArcSpans(chain: Seg[]): boolean {
  const pts: Pt[] = [];
  for (const s of chain) pts.push(segStart(s));
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p.x * q.y - q.x * p.y; }
  const ccw = area > 0;
  let changed = false;
  const n = chain.length;
  for (let i = 0; i < n; i++) {
    const s = chain[i];
    if (s.kind !== "arc" || Math.abs(norm(s.a1 - s.a0) - TAU) < 1e-9) continue; // full circle
    const prevEnd = segEnd(chain[(i + n - 1) % n]);
    const nextStart = segStart(chain[(i + 1) % n]);
    if (Math.abs(dist(prevEnd, s.c) - s.r) > 0.05 || Math.abs(dist(nextStart, s.c) - s.r) > 0.05) continue;
    if (dist(segStart(s), prevEnd) < 0.01 && dist(segEnd(s), nextStart) < 0.01) continue; // already fine
    const a0 = Math.atan2(prevEnd.y - s.c.y, prevEnd.x - s.c.x);
    const a1 = Math.atan2(nextStart.y - s.c.y, nextStart.x - s.c.x);
    chain[i] = { kind: "arc", c: s.c, r: s.r, a0, a1, ccw };
    changed = true;
  }
  return changed;
}

// ---------- geometry helpers ----------
function segPoints(s: Seg, maxStepDeg = 5): Pt[] {
  if (s.kind === "line") return [s.p1, s.p2];
  const span = s.ccw ? norm(s.a1 - s.a0) || TAU : -(norm(s.a0 - s.a1) || TAU);
  const n = Math.max(2, Math.ceil(Math.abs(span) / ((maxStepDeg * Math.PI) / 180)));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = s.a0 + (span * i) / n;
    pts.push({ x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) });
  }
  return pts;
}
function loopPoints(loop: { segs: Seg[] }): Pt[] {
  const pts: Pt[] = [];
  for (const s of loop.segs) { const p = segPoints(s); pts.push(...p.slice(0, -1)); }
  return pts;
}
function areaOf(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function distToLoop(p: Pt, loopPts: Pt[]): number {
  let md = Infinity;
  for (let j = 0; j < loopPts.length; j++) md = Math.min(md, distToSeg(p, loopPts[j], loopPts[(j + 1) % loopPts.length]));
  return md;
}

// ---------- exact offset ----------
function offsetSeg(s: Seg, d: number): Seg | null {
  if (s.kind === "line") {
    const dx = s.p2.x - s.p1.x, dy = s.p2.y - s.p1.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return null;
    const nx = (dy / L) * d, ny = (-dx / L) * d; // CCW loop: outward = right normal
    return { kind: "line", p1: { x: s.p1.x + nx, y: s.p1.y + ny }, p2: { x: s.p2.x + nx, y: s.p2.y + ny } };
  }
  const r2 = s.r + (s.ccw ? d : -d);
  if (r2 <= 1e-6) return null;
  return { kind: "arc", c: s.c, r: r2, a0: s.a0, a1: s.a1, ccw: s.ccw };
}
function lineLineIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y, d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}
function segIntersectCandidates(a: Seg, b: Seg): Pt[] {
  if (a.kind === "line" && b.kind === "line") {
    const p = lineLineIntersect(a.p1, a.p2, b.p1, b.p2);
    return p ? [p] : [];
  }
  const lineCircle = (ln: Seg & { kind: "line" }, ar: Seg & { kind: "arc" }): Pt[] => {
    const dx = ln.p2.x - ln.p1.x, dy = ln.p2.y - ln.p1.y, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;
    const fx = ar.c.x - ln.p1.x, fy = ar.c.y - ln.p1.y;
    const t = fx * ux + fy * uy;
    const px = ln.p1.x + t * ux, py = ln.p1.y + t * uy;
    const h2 = ar.r * ar.r - (px - ar.c.x) ** 2 - (py - ar.c.y) ** 2;
    if (h2 < 0) return [];
    const h = Math.sqrt(h2);
    return [{ x: px + h * ux, y: py + h * uy }, { x: px - h * ux, y: py - h * uy }];
  };
  const circleCircle = (a2: Seg & { kind: "arc" }, b2: Seg & { kind: "arc" }): Pt[] => {
    const d = dist(a2.c, b2.c);
    if (d < 1e-9 || d > a2.r + b2.r || d < Math.abs(a2.r - b2.r)) return [];
    const t = (a2.r * a2.r - b2.r * b2.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a2.r * a2.r - t * t));
    const mx = a2.c.x + ((b2.c.x - a2.c.x) * t) / d, my = a2.c.y + ((b2.c.y - a2.c.y) * t) / d;
    const rx = (-(b2.c.y - a2.c.y) * h) / d, ry = ((b2.c.x - a2.c.x) * h) / d;
    return [{ x: mx + rx, y: my + ry }, { x: mx - rx, y: my - ry }];
  };
  if (a.kind === "line" && b.kind === "arc") return lineCircle(a, b);
  if (a.kind === "arc" && b.kind === "line") return lineCircle(b, a);
  return circleCircle(a as Seg & { kind: "arc" }, b as Seg & { kind: "arc" });
}
function onSeg(p: Pt, s: Seg, tol: number): boolean {
  if (s.kind === "line") {
    const dx = s.p2.x - s.p1.x, dy = s.p2.y - s.p1.y, L2 = dx * dx + dy * dy;
    const t = L2 ? ((p.x - s.p1.x) * dx + (p.y - s.p1.y) * dy) / L2 : 0;
    return t >= -tol / Math.max(1e-9, Math.sqrt(L2)) && t <= 1 + tol / Math.max(1e-9, Math.sqrt(L2));
  }
  const ang = Math.atan2(p.y - s.c.y, p.x - s.c.x);
  const span = s.ccw ? norm(s.a1 - s.a0) || TAU : norm(s.a0 - s.a1) || TAU;
  const rel = s.ccw ? norm(ang - s.a0) : norm(s.a0 - ang);
  const arcTol = tol / Math.max(1e-9, s.r);
  return rel <= span + arcTol || rel >= TAU - arcTol;
}

// Angle on the same 2PI branch as `ref`: atan2 wraps at +-PI, and
// naively assigning the wrapped angle to an arc endpoint makes the
// arc sweep the long way round.
function branchAngle(a: number, ref: number): number {
  while (a - ref > Math.PI) a -= TAU;
  while (a - ref < -Math.PI) a += TAU;
  return a;
}

const TRACE = !!process.env.TOOLPATHS_DEBUG;
const trace = (m: string) => { if (TRACE) console.error("  [offsetLoop d=" + m + "]"); };
function offsetLoop(loop: Loop, d: number): Seg[] | null {
  const pts = loopPoints(loop);
  const ccw = areaOf(pts) > 0;
  let segs = loop.segs;
  if (!ccw) segs = [...segs].reverse().map(segReverse);
  // Offset each segment; an arc whose offset radius vanishes is
  // dropped (its neighbours meet at a miter) — only an empty loop dies.
  const kept: { orig: Seg; off: Seg; idx: number }[] = [];
  for (let si = 0; si < segs.length; si++) {
    const o = offsetSeg(segs[si], d);
    if (o) kept.push({ orig: segs[si], off: o, idx: si });
  }
  if (!kept.length) { trace(`${d} empty after arc drops`); return null; }
  const out: Seg[] = [];
  const n = kept.length;
  for (let i = 0; i < n; i++) {
    const prev = kept[(i + n - 1) % n].off!, cur = kept[i].off!;
    const vertex = segEnd(kept[(i + n - 1) % n].orig);
    const joinTol = 2 * Math.abs(d) + 5;
    const cands = segIntersectCandidates(prev, cur)
      .filter((p) => onSeg(p, prev, joinTol) && onSeg(p, cur, joinTol));
    cands.sort((a, b) => dist(a, vertex) - dist(b, vertex));
    let join = cands[0];
    const adjacent = kept[i].idx === (kept[(i + n - 1) % n].idx + 1) % segs.length;
    if (join && d > 0 && adjacent) {
      // A round join is only valid if the arc stays clear of the rest
      // of the boundary: a convex corner shadowed by a nearby wall
      // (Kookabus P02 profile: the corner next to the 4 mm notch)
      // gouges with a round join, but the miter is clear — keep the
      // miter then. (The min-distance guard remains the backstop.)
      const pe = segEnd(prev), cs = segStart(cur);
      const v = vertex;
      const a0 = Math.atan2(pe.y - v.y, pe.x - v.x);
      const a1 = Math.atan2(cs.y - v.y, cs.x - v.x);
      const span = norm(a1 - a0) || TAU;
      const steps = Math.max(1, Math.ceil(span / (Math.PI / 36)));
      let gouges = false;
      for (let k = 0; k <= steps; k++) {
        const a = a0 + (span * k) / steps;
        const p = { x: v.x + Math.abs(d) * Math.cos(a), y: v.y + Math.abs(d) * Math.sin(a) };
        if (distToLoop(p, pts) < Math.abs(d) - 0.05) { gouges = true; break; }
      }
      if (!gouges) {
      // convex corner? (CCW loop: left turn at the vertex). Only at a
      // genuine sharp vertex: where an arc was dropped between the two
      // neighbours its offset radius went negative and the corner
      // becomes sharp, so the miter IS the join (a round arc around
      // the dropped arc's centre would gouge the corner).
      const inDir = segDirEnd(kept[(i + n - 1) % n].orig);
      const outDir = segDirStart(kept[i].orig);
      const cross = inDir.x * outDir.y - inDir.y * outDir.x;
      if (cross > 0 && dist(join, vertex) > Math.abs(d) + 0.01) join = undefined as unknown as Pt;
      }
    }
    if (join) {
      if (out.length) {
        const last = out[out.length - 1];
        if (last.kind === "line") last.p2 = join;
        else last.a1 = branchAngle(Math.atan2(join.y - last.c.y, join.x - last.c.x), last.a1);
      }
      if (cur.kind === "line") out.push({ kind: "line", p1: join, p2: cur.p2 });
      else out.push({ kind: "arc", c: cur.c, r: cur.r, a0: branchAngle(Math.atan2(join.y - cur.c.y, join.x - cur.c.x), cur.a0), a1: cur.a1, ccw: cur.ccw });
    } else {
      const pe = segEnd(prev), cs = segStart(cur);
      if (dist(pe, cs) > 1e-6) {
        const a0 = Math.atan2(pe.y - vertex.y, pe.x - vertex.x);
        const a1 = Math.atan2(cs.y - vertex.y, cs.x - vertex.x);
        out.push({ kind: "arc", c: vertex, r: Math.abs(d), a0, a1, ccw: true });
      }
      out.push(cur);
    }
  }
  // close: trim the last segment's end to the first segment's start
  // (the i=0 join set the first start but never trimmed the last end)
  const first = out[0], last = out[out.length - 1];
  const gap = dist(segEnd(last), segStart(first));
  if (gap > 0.01) {
    if (gap > 2 * Math.abs(d) + 1) { trace(`${d} closing gap ${fmt(gap)}`); return null; }
    const p = segStart(first);
    if (last.kind === "line") last.p2 = p;
    else last.a1 = branchAngle(Math.atan2(p.y - last.c.y, p.x - last.c.x), last.a1);
  }
  // Fix arc sweep directions (see above) before the guards run.
  for (const o of out) {
    if (o.kind !== "arc") continue;
    const orig = kept.find((k) => k.orig.kind === "arc" && dist(k.orig.c, o.c) < 0.01 && Math.abs(Math.abs(o.r - k.orig.r) - Math.abs(d)) < 0.05);
    if (!orig || orig.orig.kind !== "arc") continue;
    const span = norm(o.a1 - o.a0) || TAU;
    if (span >= TAU - 1e-9) continue; // full circle: direction-free
    const om = orig.orig;
    const omA = om.ccw ? norm(om.a1 - om.a0) || TAU : norm(om.a0 - om.a1) || TAU;
    const omMid = om.ccw ? om.a0 + omA / 2 : om.a0 - omA / 2;
    const omPt = { x: om.c.x + om.r * Math.cos(omMid), y: om.c.y + om.r * Math.sin(omMid) };
    const midCCW = { x: o.c.x + o.r * Math.cos(o.a0 + span / 2), y: o.c.y + o.r * Math.sin(o.a0 + span / 2) };
    const midCW = { x: o.c.x + o.r * Math.cos(o.a0 - (TAU - span) / 2), y: o.c.y + o.r * Math.sin(o.a0 - (TAU - span) / 2) };
    const wantCCW = dist(midCCW, omPt) <= dist(midCW, omPt);
    // Set the sweep flag only: a0/a1 are the join angles in loop
    // order (start = previous join, end = next join); flipping the
    // flag picks the short arc through the correct midpoint.
    if (wantCCW !== o.ccw) o.ccw = wantCCW;
  }
  // Trim arcs the neighbouring lines cross behind: when an offset arc
  // grows past the point where its two neighbouring offset lines meet
  // (erosion distance past a small corner radius), the lines cross
  // on their own segments and the arc lies closer than |d| to the
  // other wall — the true boundary is the miter, not the arc.
  // Drop the arc and join the lines at their intersection.
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (o.kind !== "arc") continue;
      const prev = out[(i + out.length - 1) % out.length];
      const next = out[(i + 1) % out.length];
      if (prev.kind !== "line" || next.kind !== "line") continue;
      for (const p of segIntersectCandidates(prev, next)) {
        if (onSeg(p, prev, 0.01) && onSeg(p, next, 0.01) && distToLoop(p, pts) >= Math.abs(d) - 0.05) {
          prev.p2 = p; next.p1 = p;
          out.splice(i, 1);
          trimmed = true;
          break;
        }
      }
      if (trimmed) break;
    }
  }
  if (Math.abs(areaOf(loopPoints({ segs: out }))) < 1e-6) { trace(`${d} zero area`); return null; }
  if (out.length > 1 && selfIntersects(out)) {
    trace(`${d} self-intersects`);
    if (TRACE) for (const o of out) console.error("    si", o.kind === "line" ? `L(${fmt(o.p1.x)},${fmt(o.p1.y)})->(${fmt(o.p2.x)},${fmt(o.p2.y)})` : `A c(${fmt(o.c.x)},${fmt(o.c.y)}) r${fmt(o.r)} a0=${fmt(o.a0)} a1=${fmt(o.a1)} ccw=${o.ccw}`);
    return null;
  }
  // Parallel-curve guard: every point of a valid offset lies at
  // distance >= |d| from the original boundary (miter vertices lie
  // farther; round-join points lie exactly |d| from the vertex).
  // When the offset distance exceeds the local half-width the offset
  // lines cross and the joins build a spurious inverted loop whose
  // points sit closer than |d| to the wall — reject it here.
  for (const p of loopPoints({ segs: out })) {
    if (distToLoop(p, pts) < Math.abs(d) - 0.05) { trace(`${d} min-dist guard at (${fmt(p.x)},${fmt(p.y)}) dist=${fmt(distToLoop(p, pts))}`); return null; }
    // an inward offset must stay inside the loop, an outward one
    // outside it: at a tooth where the strip is ~2|d| wide the
    // erosion pinches off and the miter lands on the wrong side.
    if (d < 0 ? !pointInPolygon(p, pts) && distToLoop(p, pts) > 0.01 : pointInPolygon(p, pts) && distToLoop(p, pts) > 0.01) { trace(`${d} side guard at (${fmt(p.x)},${fmt(p.y)})`); return null; }
  }
  return out;
}
function segsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function selfIntersects(segs: Seg[]): boolean {
  const fp = loopPoints({ segs });
  for (let i = 0; i < fp.length; i++) {
    const a1 = fp[i], a2 = fp[(i + 1) % fp.length];
    for (let j = i + 2; j < fp.length; j++) {
      if (i === 0 && j === fp.length - 1) continue;
      if (segsCross(a1, a2, fp[j], fp[(j + 1) % fp.length])) return true;
    }
  }
  return false;
}

// Nesting: depth = number of other loops containing this loop's
// first point. Even depth = outer boundary, odd = island.
function nestingDepth(loops: Loop[], pts: Pt[][]): number[] {
  return loops.map((_, i) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue;
      if (pointInPolygon(pts[i][0], pts[j])) depth++;
    }
    return depth;
  });
}

export {
  parseDxf, entitiesToSegs, parseLwpl, repairArcsInLayer, assemble,
  offsetLoop, loopPoints, segPoints, areaOf, pointInPolygon,
  distToLoop, distToSeg, dist, fmt, norm, TAU, segStart, segEnd,
  segReverse, segDirStart, segDirEnd, nestingDepth, selfIntersects,
};
export type { Pt, Seg, Loop };
