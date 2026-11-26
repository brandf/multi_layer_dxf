#!/usr/bin/env bun
// V3.6 G-code parser — the round-trip half of §6.4 (V3_SCOPE.md).
//
// Parses posted G-code back into moves (job coordinates, mm,
// Z=0 at the bottom of stock — the inverse of the post's Z
// conversion) so the re-simulation (ts/gcode_verify.ts) can check
// the posted file cuts the same stock the toolpaths cut.
//
// COVERAGE — exactly what the shipped posts emit, no more, no
// less. Anything outside this list is a named error
// (`gcode_parse_unsupported`, naming the code and line), never a
// silent skip — a parser that skipped an unknown word could
// certify a file it did not understand:
//   motion: G0, G1, G2, G3 (with X/Y/Z; arcs with I/J, centre
//     offset from the arc start, incremental — the standard;
//     helical arcs, end Z != start Z); modal motion (a bare XYZ
//     line repeats the last motion word); modal position (an axis
//     word omitted keeps its position); modal feed (F persists).
//   setup: G90 (absolute — G91 is refused), G17 (XY plane;
//     G18/G19 refused), G20/G21 (units — the file must state
//     them before its first motion), G94, G40, G54–G59, G80.
//   spindle/tool: M3 (S rpm), M5, M0/M1 (pause — the GRBL
//     manual-change stop), T<n> M6 (Masso tool change), M9, M30.
//   comments: (...) anywhere, ; to end of line; N line numbers.
//   tool identity: the `(Tool change: <id> ...)` comment the
//     posts emit before a change, falling back to the plan's
//     tool-number map (T<n> -> tool id) when the comment is
//     absent. A tool change that names no tool is an error.
// NOT covered (refused, not approximated): canned cycles
// (G73/G81/G82/G83 — the posts never emit them; a file that
// uses them is outside this parser), cutter compensation
// (G41/G42 — the posts never emit it), G43/G49 (Masso does not
// support G43), dwells (G4), probing (G38.x), subprograms,
// G28/G30/G53 machine-coordinate moves, G92 offsets, G68
// rotation, feed-per-revolution (G95), inverse time (G93).
// A post that needs any of these extends this parser first and
// documents the new coverage here — the parser is the gate, and
// the gate only opens as far as it is tested (ts/gcode.test.ts).
//
// No I/O, no DOM, no Node/Bun APIs.

import type { ZZero } from "./z_zero.ts";

export type ParsedMove = {
  t: "rapid" | "feed" | "arc";
  /** Job coordinates, mm, Z=0 at the bottom of stock. */
  x: number;
  y: number;
  z: number;
  /** Arc centre offset from the arc start, mm (arcs only). */
  i: number | null;
  j: number | null;
  cw: boolean | null;
  /** Tool cutting this move (from the tool-change comment or
   * the T-number map). */
  toolId: string;
  /** Feed rate in mm/min (modal F, converted to mm). Rapids
   * carry null. */
  feedMmMin: number | null;
  /** Source line number (1-based), for error messages. */
  line: number;
};

export type ParsedGcode = {
  units: "mm" | "inch";
  stockTopMm: number;
  moves: ParsedMove[];
  tools: string[];
};

export class GcodeParseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MM_PER_INCH = 25.4;

export function parseGcode(
  text: string,
  opts: { stockTopMm: number; zZero?: ZZero; toolByNumber?: Map<number, string> },
): ParsedGcode {
  const { stockTopMm } = opts;
  if (!(Number.isFinite(stockTopMm) && stockTopMm > 0)) {
    throw new GcodeParseError(
      "gcode_parse_error",
      `cannot parse G-code without a stock top (got ${JSON.stringify(stockTopMm)})`,
    );
  }
  // Machine Z back to job Z (Z=0 at the stock bottom): under top
  // the file's Z-zero is the stock top, so add it back; under
  // bottom the file's Z-zero is already the bed, so add nothing.
  // Default "top" — every caller that posts under top (and every
  // existing test) passes no zZero and keeps the old behaviour.
  const zOff = opts.zZero === "bottom" ? 0 : stockTopMm;
  const toolByNumber = opts.toolByNumber ?? new Map<number, string>();
  const lines = text.split(/\r?\n/);

  let units: "mm" | "inch" | null = null;
  const unitFactor = () => (units === "inch" ? MM_PER_INCH : 1);
  // Machine position, mm (Z=0 at the job's Z-zero — the top of
  // material under top, the bed under bottom; converted to job Z
  // on output). Each axis starts unknown (null): the post's first
  // line is a Z-only rapid to clearance before any XY is
  // positioned, and a Z-only rapid above the stock top cuts
  // nothing, so its unknown XY is carried as 0 in the emitted
  // move (documented below) rather than invented — a feed/arc,
  // or a rapid below the stock top, with an unknown axis is
  // refused outright.
  let pos: { x: number | null; y: number | null; z: number | null } = { x: null, y: null, z: null };
  let modalMotion: "rapid" | "feed" | "arc" | null = null;
  let modalCw: boolean | null = null;
  let modalFeedMmMin: number | null = null;
  let currentTool: string | null = null;
  let pendingToolId: string | null = null;
  const moves: ParsedMove[] = [];
  const tools: string[] = [];

  const fail = (code: string, lineNo: number, message: string): never => {
    throw new GcodeParseError(code, `line ${lineNo}: ${message}`);
  };

  /** Strip (...) comments, honouring nesting: a comment's text
   * may itself contain parentheses (the header does). An
   * unbalanced comment is a parse error, not a silent drop. */
  const stripComments = (s: string, lineNo: number): string => {
    let out = "";
    let depth = 0;
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth < 0) fail("gcode_parse_error", lineNo, "unbalanced ) outside a comment");
        continue;
      }
      if (depth === 0) out += ch;
    }
    if (depth > 0) fail("gcode_parse_error", lineNo, "unbalanced ( — comment never closed");
    return out;
  };

  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    let raw = lines[li];
    // Comments: (...) anywhere on the line, with nesting handled
    // (a comment may contain parentheses in its text). A
    // Tool-change comment names the tool for the change that
    // follows it.
    const commentMatch = /\(\s*Tool change:\s*([A-Za-z0-9_.\-]+)/.exec(raw);
    if (commentMatch) pendingToolId = commentMatch[1];
    raw = stripComments(raw, lineNo);
    const semi = raw.indexOf(";");
    if (semi >= 0) raw = raw.slice(0, semi);
    raw = raw.trim();
    if (!raw) continue;
    // N line numbers (not emitted by our posts, tolerated).
    raw = raw.replace(/^N\d+\s*/i, "");
    if (!raw) continue;

    const words = raw.split(/\s+/);
    let g: number | null = null;
    let m: number | null = null;
    let tNum: number | null = null;
    const axes: { x?: number; y?: number; z?: number; i?: number; j?: number; f?: number; s?: number } = {};
    for (const w of words) {
      const letter = w[0]?.toUpperCase();
      const num = Number(w.slice(1));
      if (!letter || w.length < 2 || !Number.isFinite(num)) {
        fail("gcode_parse_error", lineNo, `unreadable word ${JSON.stringify(w)}`);
      }
      switch (letter) {
        case "G":
          if (g !== null) fail("gcode_parse_error", lineNo, `two G words on one line (${raw})`);
          g = num;
          break;
        case "M":
          if (m !== null) fail("gcode_parse_error", lineNo, `two M words on one line (${raw})`);
          m = num;
          break;
        case "T":
          tNum = num;
          break;
        case "X": axes.x = num; break;
        case "Y": axes.y = num; break;
        case "Z": axes.z = num; break;
        case "I": axes.i = num; break;
        case "J": axes.j = num; break;
        case "F": axes.f = num; break;
        case "S": axes.s = num; break;
        default:
          fail("gcode_parse_unsupported", lineNo, `address word ${letter} is outside the parser's coverage (see ts/gcode_parse.ts)`);
      }
    }

    // --- G words: setup and motion ---
    if (g !== null) {
      switch (g) {
        case 0: modalMotion = "rapid"; modalCw = null; break;
        case 1: modalMotion = "feed"; modalCw = null; break;
        case 2: modalMotion = "arc"; modalCw = true; break;
        case 3: modalMotion = "arc"; modalCw = false; break;
        case 17: break; // XY plane — the only plane the posts use
        case 20: units = "inch"; break;
        case 21: units = "mm"; break;
        case 40: case 54: case 55: case 56: case 57: case 58: case 59:
        case 80: case 90: case 94:
          break; // setup words the posts emit; no state to keep
        case 91:
          fail("gcode_parse_unsupported", lineNo, "G91 incremental positioning is refused — the posts emit absolute (G90) only");
        case 18: case 19:
          fail("gcode_parse_unsupported", lineNo, `G${g} plane selection is outside the parser's coverage (XY plane only)`);
        default:
          fail("gcode_parse_unsupported", lineNo, `G${g} is outside the parser's coverage (see ts/gcode_parse.ts)`);
      }
    }

    // --- M words + T word: tool changes, spindle, stops ---
    if (m !== null) {
      switch (m) {
        case 0: case 1:
          // Program pause (the GRBL manual-change stop): the
          // pending tool-change comment names the new tool.
          if (pendingToolId !== null) {
            currentTool = pendingToolId;
            pendingToolId = null;
            if (!tools.includes(currentTool)) tools.push(currentTool);
          }
          break;
        case 3: case 5: case 9: case 30:
          break; // spindle on/off, coolant off, end — no motion
        case 6: {
          // Tool change: T<n> M6 (same line or T on its own line
          // before). The tool is the pending comment, else the
          // plan's T-number map.
          let id = pendingToolId;
          pendingToolId = null;
          if (id === null && tNum !== null) id = toolByNumber.get(tNum) ?? null;
          if (id === null) {
            fail("gcode_parse_error", lineNo, "tool change (M6) names no tool — no (Tool change: ...) comment and no T-number mapping");
          }
          currentTool = id;
          // `id` was narrowed to a string by the fail above; `!`
          // says so to tsc (loop-assigned locals don't narrow).
          if (!tools.includes(currentTool!)) tools.push(currentTool!);
          break;
        }
        default:
          fail("gcode_parse_unsupported", lineNo, `M${m} is outside the parser's coverage (see ts/gcode_parse.ts)`);
      }
    }
    // A bare T word (no M6 on the line): remember it for the M6
    // that follows on the next line. Our posts put T and M6 on
    // one line, but a split T/M6 is standard Masso form too.
    if (tNum !== null && m !== 6) {
      const id = toolByNumber.get(tNum) ?? null;
      if (id !== null) pendingToolId = id;
    }

    // --- Motion: explicit G word, or modal (bare XYZ line) ---
    const hasAxis = axes.x !== undefined || axes.y !== undefined || axes.z !== undefined;
    if (g === 0 || g === 1 || g === 2 || g === 3 || (g === null && m === null && hasAxis)) {
      if (units === null) {
        fail("gcode_parse_error", lineNo, "motion before any units word (G20/G21) — the file must state its units first");
      }
      if (modalMotion === null) {
        fail("gcode_parse_error", lineNo, "motion with no motion word and no prior modal motion");
      }
      if (currentTool === null) {
        fail("gcode_parse_error", lineNo, "motion before any tool change — the file cuts with no tool loaded");
      }
      const f = unitFactor();
      const nx = axes.x !== undefined ? axes.x * f : pos.x;
      const ny = axes.y !== undefined ? axes.y * f : pos.y;
      const nz = axes.z !== undefined ? axes.z * f : pos.z;
      if (axes.f !== undefined) modalFeedMmMin = axes.f * f;
      if (nx === null || ny === null || nz === null) {
        // An axis is still unknown. The only move the posts emit
        // with an unknown axis is the opening Z-only rapid to
        // clearance (machine Z >= 0, i.e. at/above the stock top
        // — it cuts nothing, so its unknown XY is immaterial and
        // is carried as 0). Anything else with an unknown axis
        // would be a move the parser cannot place — refused.
        const zOnlyClearanceRapid =
          modalMotion === "rapid" && nz !== null && nz >= -1e-9 &&
          axes.x === undefined && axes.y === undefined;
        if (!zOnlyClearanceRapid) {
          fail("gcode_parse_error", lineNo, "motion with an axis the file has never positioned (no prior position to inherit)");
        }
        moves.push({
          t: "rapid", x: 0, y: 0, z: nz! + zOff,
          i: null, j: null, cw: null,
          toolId: currentTool!, feedMmMin: null, line: lineNo,
        });
        pos = { x: null, y: null, z: nz };
        continue;
      }
      if (modalMotion === "arc") {
        if (axes.i === undefined || axes.j === undefined) {
          fail("gcode_parse_error", lineNo, "arc without I/J centre offsets — the posts always emit I/J");
        }
        if (modalCw === null) {
          fail("gcode_parse_error", lineNo, "arc with no direction (G2/G3)");
        }
        moves.push({
          t: "arc", x: nx, y: ny, z: nz + zOff,
          i: axes.i! * f, j: axes.j! * f, cw: modalCw,
          toolId: currentTool!, feedMmMin: modalFeedMmMin, line: lineNo,
        });
      } else {
        moves.push({
          t: modalMotion!, x: nx, y: ny, z: nz + zOff,
          i: null, j: null, cw: null,
          toolId: currentTool!,
          feedMmMin: modalMotion === "rapid" ? null : modalFeedMmMin,
          line: lineNo,
        });
      }
      pos = { x: nx, y: ny, z: nz };
    } else if (hasAxis && g !== null) {
      // An axis word on a non-motion line (e.g. a setup line with
      // coordinates) — outside what the posts emit.
      fail("gcode_parse_unsupported", lineNo, `axis word on a G${g} line is outside the parser's coverage`);
    } else if (axes.f !== undefined) {
      // A bare feed word (no motion on the line): track the modal
      // feed so a later modal move uses it — the posts put F on
      // the motion line, but a feed-only line must not silently
      // change the feed the sim assumes.
      if (units === null) {
        fail("gcode_parse_error", lineNo, "feed word before any units word (G20/G21)");
      }
      modalFeedMmMin = axes.f * unitFactor();
    }
  }

  if (moves.length === 0) {
    throw new GcodeParseError("gcode_parse_error", "file contains no motion — nothing to verify");
  }
  return { units: units ?? "mm", stockTopMm, moves, tools };
}
