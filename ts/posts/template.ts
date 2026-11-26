#!/usr/bin/env bun
// V3.6 generic template post — the worked example for a third
// machine (V3_SCOPE.md §6.2: "a third machine is a new post
// module, not a generator change").
//
// HOW TO ADD A MACHINE:
//   1. Copy this file to ts/posts/<machine>.ts.
//   2. Change the id, label, units, description, and limits to the
//      machine's own numbers (published specs, not guesses — cite
//      the source in the comment, as masso.ts does).
//   3. Change the hooks below to the machine's dialect: what its
//      tool change looks like (M6? M0? something else?), whether
//      it takes G43, whether it wants coolant words, what its end
//      of program is (M30? M2?). The core (ts/posts/common.ts)
//      still walks the moves, converts Z, and enforces the limits
//      — the new module only says what each line looks like.
//   4. Register it in ts/posts/index.ts (one line in POSTS) and
//      add it to the UI's post list (server/public/job-prep.js
//      POSTS) and the CLI help. The round-trip verifier
//      (ts/gcode_verify.ts) covers it automatically — the parser
//      handles exactly what the posts emit, so a new post that
//      emits only G0/G1/G2/G3 + T/M6/M0/M3/M5/M30 verifies with
//      no parser change; a post that emits anything else needs
//      the parser's coverage extended first (see
//      ts/gcode_parse.ts "Coverage").
//   5. Post the reference container through it and check the
//      round-trip numbers before cutting anything.
//
// This template itself IS a working post (id `template`): metric,
// M0 manual tool change like GRBL, no coolant, M30 end. It is
// deliberately conservative — a machine that needs more than this
// says so in its own module, not by editing this one.
//
// HOOKS — what each one is for (the core calls them in this
// order: header, coolantOn, then per tool change: toolChange,
// then moves as G0/G1/G2/G3 lines the core formats, then
// coolantOff, footer):
//   header     — comments + setup words (G90/G17/G20/G21/G94/G40/G54).
//   toolChange — the lines that change the tool, at the clearance
//                plane (the core rapids Z up first). Must leave the
//                spindle running for the next moves (call
//                spindleOn) or the first cut runs with a dead
//                spindle.
//   spindleOn  — M3 S<rpm> (clockwise). M4 is never emitted: the
//                toolpaths assume a clockwise spindle.
//   coolantOn  — lines that start coolant, or [] when the machine
//                fits none. This template shows the M8 form in a
//                comment — uncomment it only on a machine with a
//                flood output wired.
//   coolantOff — lines that stop coolant (M9), or [].
//   footer     — spindle off, park, end of program. Must not move
//                below the clearance plane: the core rapids Z up
//                before calling it.

import { headerComments } from "./common.ts";
import type { PostContext, PostDef, ToolEntry } from "./common.ts";

function templateHeader(ctx: PostContext): string[] {
  return [
    ...headerComments(ctx),
    "(Post: TEMPLATE — copy this module for a new machine, do not edit it in place)",
    "G90",
    "G17",
    "G21",
    "G94",
    "G40",
    "G54",
  ];
}

function templateToolChange(ctx: PostContext, tool: ToolEntry, spindleRpm: number): string[] {
  return [
    `(Tool change: ${tool.id} — ${tool.name}, ${tool.diaMm} mm)`,
    `(T${tool.toolNumber} — adapt this hook to the machine's tool-change command)`,
    "M5",
    `M0 (Change tool to ${tool.id} — ${tool.name}, then resume)`,
    ...templateSpindleOn(ctx, spindleRpm),
  ];
}

function templateSpindleOn(_ctx: PostContext, spindleRpm: number): string[] {
  return [`M3 S${Math.round(spindleRpm)}`];
}

// No coolant fitted on the template machine. A machine WITH flood
// coolant would return ["M8"] here and ["M9"] from coolantOff.
function templateCoolantOn(_ctx: PostContext): string[] {
  // ["M8"] — flood coolant on (only on a machine with it wired).
  return [];
}

function templateCoolantOff(_ctx: PostContext): string[] {
  return [];
}

function templateFooter(ctx: PostContext): string[] {
  return [
    "M5",
    `G0 X${ctx.fmt(0)} Y${ctx.fmt(0)}`,
    "M30",
  ];
}

export const TEMPLATE: PostDef = {
  id: "template",
  label: "Template (generic, mm — copy for a new machine)",
  units: "mm",
  description:
    "Worked-example template post: metric, M0 manual tool change, no coolant. Copy it for a third machine; do not edit it in place.",
  limits: {
    // Conservative generic defaults (same reasoning as the GRBL
    // post): a real machine's numbers belong in its own module.
    maxFeedMmMin: 5000,
    maxSpindleRpm: 24000,
    zTravelMm: 100,
    bedWidthMm: null,
    bedDepthMm: null,
  },
  hooks: {
    header: templateHeader,
    toolChange: templateToolChange,
    spindleOn: templateSpindleOn,
    coolantOn: templateCoolantOn,
    coolantOff: templateCoolantOff,
    footer: templateFooter,
  },
};
