#!/usr/bin/env bun
// V3.6 native Masso posts — Onefinity Elite (Masso) Foreman,
// Brandon's machine, the reference post (V3_SCOPE.md §6.2).
//
// Two variants, one machine: `masso-mm` (G21) and `masso-inch`
// (G20). Same hooks, same limits, different units — the variant
// is the units word and the number formatting, nothing else.
//
// Masso specifics, each with its source:
// - M6 tool change with a manual-change stop (no ATC): `T<n> M6`
//   moves the spindle to the configured change position and waits
//   for the operator to change the bit and press cycle start
//   (Onefinity forum, Tool Change Walkthrough; Sherline's Masso
//   program notes: "Upon the tool change command, the tool will
//   move to a change position or machine home. The screen will ask
//   you to change the tool, then hit the cycle start button").
//   The post emits the change at the clearance plane, never at
//   cut depth (the core rapids Z up first).
// - No G43: Masso does not support tool-length compensation
//   (Onefinity forum, Tool Change Syntax: "Masso does not
//   currently support G43"); tool lengths live in the Masso tool
//   table and are measured with the tool setter. This post never
//   emits G43/G49.
// - Spindle: `M3 S<rpm>` / `M5`. Units: G20/G21 matching the
//   variant (Masso docs, G20/G21 pages). Absolute positioning
//   G90, XY plane G17, feed-per-minute G94, work offset G54.
// - Drills: EXPLICIT peck moves (see ts/posts/common.ts — the
//   canned-cycle proof and the reason). Masso DOES support G83
//   (docs.masso.com.au/supported-g-codes/g83-peck-drilling-for-deeper-holes:
//   "G83 X Y Z R Q K F", modal, cancel G80), but this post does
//   not use it.
// - No coolant words: the Foreman as configured fits no coolant;
//   the coolant hook returns [] (the core still calls it, so a
//   future coolant fitment is one hook, not a core change).
// - End of program: M30 (Sherline Masso notes).
//
// Limits (published Onefinity Elite numbers — Elite Series
// Installation and Operation Instructions, Features and
// Specifications p.16; MindKits Elite Foreman listing):
// - Rapids X/Y 400 ipm (10,160 mm/min), Z 300 ipm (7,620
//   mm/min). The cutting-feed limit is the X/Y rapid rate — a
//   cutting feed can never exceed the machine's fastest motion.
// - Z travel: Z-20 slider, 165 mm.
// - Spindle: the Makita RT0701C trim router fitted to the
//   Foreman runs 10,000–30,000 rpm; the limit is its top speed.
//   (If Brandon fits a different spindle, V3.8's post config is
//   where the number changes — the post refuses above 30,000
//   rather than guessing a new spindle's range.)
// - Bed: 1222.4 x 1222.4 mm (machine.json).

import { headerComments } from "./common.ts";
import type { PostContext, PostDef, ToolEntry } from "./common.ts";

const MASSO_LIMITS = {
  maxFeedMmMin: 10160,
  maxSpindleRpm: 30000,
  zTravelMm: 165,
  bedWidthMm: 1222.4,
  bedDepthMm: 1222.4,
};

function massoHeader(unitsWord: "G20" | "G21", unitsName: string) {
  return (ctx: PostContext): string[] => [
    ...headerComments(ctx),
    `(Post: Onefinity Masso, ${unitsName} — T<n> M6 manual tool change, no G43, no canned cycles)`,
    "G90",
    "G17",
    unitsWord,
    "G94",
    "G40",
    "G54",
  ];
}

function massoToolChange(ctx: PostContext, tool: ToolEntry, spindleRpm: number): string[] {
  return [
    `(Tool change: ${tool.id} — ${tool.name}, ${tool.diaMm} mm)`,
    `T${tool.toolNumber} M6`,
    `(Masso moves to the tool-change position and waits — change the bit, press cycle start)`,
    ...massoSpindleOn(ctx, spindleRpm),
  ];
}

function massoSpindleOn(_ctx: PostContext, spindleRpm: number): string[] {
  return [`M3 S${Math.round(spindleRpm)}`];
}

function massoFooter(ctx: PostContext): string[] {
  return [
    "M5",
    `G0 X${ctx.fmt(0)} Y${ctx.fmt(0)}`,
    "M30",
  ];
}

function noCoolant(_ctx: PostContext): string[] {
  return [];
}

export const MASSO_MM: PostDef = {
  id: "masso-mm",
  label: "Onefinity Masso (mm)",
  units: "mm",
  description:
    "Onefinity Elite (Masso) Foreman, metric. G21, M6 manual tool change, explicit peck moves, no G43.",
  limits: MASSO_LIMITS,
  hooks: {
    header: massoHeader("G21", "mm"),
    toolChange: massoToolChange,
    spindleOn: massoSpindleOn,
    coolantOn: noCoolant,
    coolantOff: noCoolant,
    footer: massoFooter,
  },
};

export const MASSO_INCH: PostDef = {
  id: "masso-inch",
  label: "Onefinity Masso (inch)",
  units: "inch",
  description:
    "Onefinity Elite (Masso) Foreman, imperial. G20, M6 manual tool change, explicit peck moves, no G43.",
  limits: MASSO_LIMITS,
  hooks: {
    header: massoHeader("G20", "inch"),
    toolChange: massoToolChange,
    spindleOn: massoSpindleOn,
    coolantOn: noCoolant,
    coolantOff: noCoolant,
    footer: massoFooter,
  },
};
