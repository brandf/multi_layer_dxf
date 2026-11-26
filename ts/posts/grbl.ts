#!/usr/bin/env bun
// V3.6 GRBL post — the generic hobby post (V3_SCOPE.md §6.2).
//
// GRBL specifics:
// - Units: G21 (mm). GRBL is a metric-native controller; this post
//   is mm-only by design — an inch GRBL machine is a different
//   post, not a flag on this one.
// - Tool change: stock GRBL has NO M6 tool-change behaviour (no
//   ATC, no change routine — M6 is not a supported command), so
//   the post stops the program with M0 and tells the operator
//   which tool to load; the operator changes the bit by hand and
//   presses resume. The T word is emitted as a comment only
//   (informational — the sender/operator reads it, GRBL does
//   not act on it). GrblHAL machines with real M6 support are a
//   different post.
// - Spindle: `M3 S<rpm>` / `M5` (GRBL 1.1 spindle PWM).
// - No canned cycles: GRBL does not support G81/G83 — drills are
//   explicit peck moves, as for Masso (and for the same reason).
// - No coolant words by default (M7/M8/M9 need a coolant output
//   wired and enabled — the hook returns [], a machine with
//   coolant overrides it in its own post module).
// - End of program: M30. Absolute G90, XY plane G17,
//   feed-per-minute G94, work offset G54.
//
// Limits — GENERIC defaults, not a measured machine: GRBL runs
// everything from 3018-class routers to home-built machines, so
// no single machine's numbers apply. The defaults are
// conservative (5,000 mm/min feed, 24,000 rpm spindle, 100 mm Z
// travel, no bed check) and deliberately refuse jobs above them
// rather than guessing a machine's capability: a real machine's
// numbers belong in its own post module (copy this file, change
// the limits — see ts/posts/template.ts) or in V3.8's post
// config. The refusal message names the limit, so the operator
// knows which number to fix.

import { headerComments } from "./common.ts";
import type { PostContext, PostDef, ToolEntry } from "./common.ts";

function grblHeader(ctx: PostContext): string[] {
  return [
    ...headerComments(ctx),
    "(Post: GRBL (generic hobby) — mm, M0 manual tool change, no canned cycles)",
    "G90",
    "G17",
    "G21",
    "G94",
    "G40",
    "G54",
  ];
}

function grblToolChange(ctx: PostContext, tool: ToolEntry, spindleRpm: number): string[] {
  return [
    `(Tool change: ${tool.id} — ${tool.name}, ${tool.diaMm} mm)`,
    `(T${tool.toolNumber} — informational; stock GRBL has no M6)`,
    "M5",
    `M0 (Change tool to ${tool.id} — ${tool.name}, then resume)`,
    ...grblSpindleOn(ctx, spindleRpm),
  ];
}

function grblSpindleOn(_ctx: PostContext, spindleRpm: number): string[] {
  return [`M3 S${Math.round(spindleRpm)}`];
}

function grblFooter(ctx: PostContext): string[] {
  return [
    "M5",
    `G0 X${ctx.fmt(0)} Y${ctx.fmt(0)}`,
    "M30",
  ];
}

function noCoolant(_ctx: PostContext): string[] {
  return [];
}

export const GRBL: PostDef = {
  id: "grbl",
  label: "GRBL (generic hobby, mm)",
  units: "mm",
  description:
    "Generic GRBL hobby controller, metric. G21, M0 manual tool change (stock GRBL has no M6), explicit peck moves.",
  limits: {
    maxFeedMmMin: 5000,
    maxSpindleRpm: 24000,
    zTravelMm: 100,
    bedWidthMm: null,
    bedDepthMm: null,
  },
  hooks: {
    header: grblHeader,
    toolChange: grblToolChange,
    spindleOn: grblSpindleOn,
    coolantOn: noCoolant,
    coolantOff: noCoolant,
    footer: grblFooter,
  },
};
