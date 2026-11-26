#!/usr/bin/env bun
// V3.6 G-code tests — `bun test ts/gcode.test.ts`.
//
// Covers the post core (Z conversion, units, feeds, tool
// changes, limit refusals), the parser (round-trip of emitted
// text, modal words, refusals of out-of-coverage codes), and the
// registry. The full round-trip SIM comparison runs against real
// jobs through the CLI (`mldxf gcode` on the five reference jobs
// — see docs-v3/gcode.md), not here: it needs a job dir + the
// dexel engine and takes seconds per job.

import { describe, test, expect } from "bun:test";
import { postJob, PostError } from "./posts/common.ts";
import type { JobIn } from "./posts/common.ts";
import { getPost, listPosts, DEFAULT_POST_ID } from "./posts/index.ts";
import { parseGcode, GcodeParseError } from "./gcode_parse.ts";

// A minimal synthetic job: one pocket (flat clearing at Z 8 on a
// 10 mm stock top), one drill peck, one profile arc — enough to
// exercise rapids, feeds, plunge-vs-feed, arcs, and tool changes.
function syntheticJob(overrides?: Partial<JobIn["toolpaths"]>): JobIn {
  return {
    job_id: "test-job",
    toolpaths: {
      version: 1,
      plan: "A",
      clearance_z_mm: 15,
      operations: [
        {
          operation: "drill",
          layer: "L__DRILL_D2.25",
          tool_id: "D2.25",
          feed_mm_s: 4,
          plunge_mm_s: 4,
          spindle_rpm: 20000,
          moves: [
            { t: "rapid", x: 10, y: 10, z: 15 },
            { t: "feed", x: 10, y: 10, z: 7.75 },
            { t: "rapid", x: 10, y: 10, z: 15 },
            { t: "feed", x: 10, y: 10, z: 6.95 },
          ],
        },
        {
          operation: "pocket",
          layer: "L__POCKET_D1.50",
          tool_id: "EM3.17",
          feed_mm_s: 15.88,
          plunge_mm_s: 5.29,
          spindle_rpm: 20000,
          moves: [
            { t: "rapid", x: 20, y: 20, z: 15 },
            { t: "feed", x: 20, y: 20, z: 8 },
            { t: "feed", x: 30, y: 20, z: 8 },
            { t: "arc", x: 30, y: 30, z: 8, i: 0, j: 5, cw: false },
          ],
        },
      ],
      ...(overrides ?? {}),
    },
    planTools: [
      { id: "D2.25", name: "Drill 2.25 mm", toolNumber: 2, diaMm: 2.25, kind: "drill" },
      { id: "EM3.17", name: "End Mill 1/8in", toolNumber: 1, diaMm: 3.175, kind: "endmill" },
    ],
    stockTopMm: 10,
    zZero: "top",
  };
}

describe("registry", () => {
  test("ships four posts; default is masso-mm", () => {
    expect(listPosts().map((p) => p.id).sort()).toEqual(
      ["grbl", "masso-inch", "masso-mm", "template"],
    );
    expect(DEFAULT_POST_ID).toBe("masso-mm");
    expect(getPost("masso-mm").units).toBe("mm");
    expect(getPost("masso-inch").units).toBe("inch");
  });

  test("unknown post is a named refusal", () => {
    expect(() => getPost("nosuch")).toThrow(PostError);
    try {
      getPost("nosuch");
    } catch (e: any) {
      expect(e.code).toBe("post_unknown");
    }
  });
});

describe("masso-mm post", () => {
  test("header states Z-zero top + G21; Z converts stock-bottom to top-zero", () => {
    const out = postJob(syntheticJob(), getPost("masso-mm"));
    expect(out.text).toContain("G21");
    expect(out.text).toContain("Z-zero: TOP of material");
    // Clearance 15 job Z -> machine +5.000; pocket floor 8 -> -2.000.
    expect(out.text).toContain("G0 X10.000 Y10.000 Z5.000");
    expect(out.text).toContain("G1 X20.000 Y20.000 Z-2.000");
    expect(out.text).toContain("G3 X30.000 Y30.000 Z-2.000 I0.000 J5.000");
  });

  test("tool change is T<n> M6 with spindle on; no G43 anywhere", () => {
    const out = postJob(syntheticJob(), getPost("masso-mm"));
    const code = out.text.split("\n").filter((l) => !l.startsWith("(")).join("\n");
    expect(code).toContain("T2 M6");
    expect(code).toContain("M3 S20000");
    expect(code).not.toContain("G43");
    expect(code).not.toContain("G81");
    expect(code).not.toContain("G83");
    expect(out.text).toContain("M30");
  });

  test("Z-only feed uses the plunge feed, XY feed the cutting feed", () => {
    const out = postJob(syntheticJob(), getPost("masso-mm"));
    // Drill plunge 4 mm/s -> 240.0 mm/min; pocket XY feed 15.88 -> 952.8.
    expect(out.text).toContain("G1 X10.000 Y10.000 Z-2.250 F240.0");
    expect(out.text).toContain("G1 X30.000 Y20.000 Z-2.000 F952.8");
  });

  test("deterministic: same job + post -> identical text", () => {
    const a = postJob(syntheticJob(), getPost("masso-mm"));
    const b = postJob(syntheticJob(), getPost("masso-mm"));
    expect(a.text).toBe(b.text);
  });
});

describe("masso-inch post", () => {
  test("G20; coordinates and feeds convert once (no double conversion)", () => {
    const out = postJob(syntheticJob(), getPost("masso-inch"));
    expect(out.text).toContain("G20");
    // Clearance 5 mm -> 0.1969 in; pocket floor -2 mm -> -0.0787 in.
    expect(out.text).toContain("G0 X0.3937 Y0.3937 Z0.1969");
    expect(out.text).toContain("G1 X0.7874 Y0.7874 Z-0.0787");
    // Pocket feed 15.88 mm/s = 952.8 mm/min = 37.51 in/min.
    expect(out.text).toContain("F37.51");
    // Drill plunge 240 mm/min = 9.45 in/min.
    expect(out.text).toContain("F9.45");
  });
});

describe("bottom Z-zero (docs-v3/z_zero.md)", () => {
  test("bottom posts job Z unchanged; header states BOTTOM", () => {
    const job = syntheticJob();
    job.zZero = "bottom";
    const out = postJob(job, getPost("masso-mm"));
    expect(out.text).toContain(
      "(Z-zero: BOTTOM of material (bed). Zero X/Y at the sheet corner, Z on the bed.)",
    );
    expect(out.text).not.toContain("(Z-zero: TOP of material.");
    // Clearance plane jobZ 15 stays machine Z 15 (top would emit 5.000).
    expect(out.text).toContain("G0 Z15.000");
    // Drill plunge jobZ 7.75 stays 7.750; pocket floor jobZ 8 stays 8.000.
    expect(out.text).toContain("G1 X10.000 Y10.000 Z7.750 F240.0");
    expect(out.text).toContain("G1 X30.000 Y20.000 Z8.000 F952.8");
  });

  test("bottom round-trip parses back to job Z only with zZero bottom", () => {
    const job = syntheticJob();
    job.zZero = "bottom";
    const out = postJob(job, getPost("masso-mm"));
    const toolByNumber = new Map([[2, "D2.25"], [1, "EM3.17"]]);
    const parsed = parseGcode(out.text, { stockTopMm: 10, zZero: "bottom", toolByNumber });
    expect(parsed.moves[0].z).toBe(15);
    // The default parse (top) would add the stock top back and
    // misread the same file by 10 mm — the setting matters.
    const misparsed = parseGcode(out.text, { stockTopMm: 10, toolByNumber });
    expect(misparsed.moves[0].z).toBe(25);
  });

  test("top default is unchanged: same job, no zZero -> top header and Z-10", () => {
    const out = postJob(syntheticJob(), getPost("masso-mm"));
    expect(out.text).toContain("(Z-zero: TOP of material.");
    expect(out.text).toContain("G0 Z5.000");
  });
});

describe("grbl + template posts", () => {
  test("grbl uses M0 for the manual change and no M6", () => {
    const out = postJob(syntheticJob(), getPost("grbl"));
    const code = out.text.split("\n").filter((l) => !l.startsWith("(")).join("\n");
    expect(code).toContain("G21");
    expect(code).toContain("M0 (Change tool to D2.25");
    expect(code).not.toContain("M6");
    expect(out.text).toContain("M30");
  });

  test("template posts and carries its copy-me note", () => {
    const out = postJob(syntheticJob(), getPost("template"));
    expect(out.text).toContain("TEMPLATE");
    expect(out.text).toContain("M0 (Change tool to D2.25");
  });
});

describe("limit refusals (never clamp)", () => {
  test("spindle above the post max is refused", () => {
    const job = syntheticJob();
    job.toolpaths.operations[0].spindle_rpm = 99999;
    try {
      postJob(job, getPost("masso-mm"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_limit_exceeded");
      expect(e.message).toContain("30000");
    }
  });

  test("feed above the post max is refused", () => {
    const job = syntheticJob();
    job.toolpaths.operations[1].feed_mm_s = 500; // 30,000 mm/min
    try {
      postJob(job, getPost("grbl"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_limit_exceeded");
      expect(e.message).toContain("5000");
    }
  });

  test("a cut below the stock bottom is refused", () => {
    const job = syntheticJob();
    job.toolpaths.operations[1].moves[1] = { t: "feed", x: 20, y: 20, z: -0.5 };
    try {
      postJob(job, getPost("masso-mm"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_limit_exceeded");
      expect(e.message).toContain("stock bottom");
    }
  });

  test("a tool without a T number is refused, never guessed", () => {
    const job = syntheticJob();
    job.planTools[0].toolNumber = -1;
    try {
      postJob(job, getPost("masso-mm"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_tool_missing");
    }
  });

  test("a job with no operations is refused", () => {
    const job = syntheticJob({ operations: [] });
    try {
      postJob(job, getPost("masso-mm"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_no_toolpaths");
    }
  });

  test("bed check is a travel-span check: off-origin jobs post, over-wide jobs refuse", () => {
    // The machined job's sheet sits at (-60,-40): moves at
    // negative X are valid — what matters is the span.
    const offOrigin = syntheticJob();
    offOrigin.toolpaths.operations[0].moves = [
      { t: "rapid", x: -50, y: -40, z: 15 },
      { t: "feed", x: -50, y: -40, z: 7.75 },
      { t: "rapid", x: -50, y: -40, z: 15 },
      { t: "feed", x: -50, y: -40, z: 6.95 },
    ];
    offOrigin.toolpaths.operations[1].moves = [
      { t: "rapid", x: -40, y: -30, z: 15 },
      { t: "feed", x: -40, y: -30, z: 8 },
      { t: "feed", x: -30, y: -30, z: 8 },
      { t: "arc", x: -30, y: -20, z: 8, i: 0, j: 5, cw: false },
    ];
    const out = postJob(offOrigin, getPost("masso-mm"));
    expect(out.text).toContain("G0 X-50.000 Y-40.000 Z5.000");
    // But a job whose X travel exceeds the bed is refused.
    const tooWide = syntheticJob();
    tooWide.toolpaths.operations[1].moves[2] = { t: "feed", x: 2000, y: 20, z: 8 };
    try {
      postJob(tooWide, getPost("masso-mm"));
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("post_limit_exceeded");
      expect(e.message).toContain("travel span");
    }
  });
});

describe("parser", () => {
  const toolByNumber = new Map<number, string>([[1, "EM3.17"], [2, "D2.25"]]);

  test("parses the masso-mm output back to the same moves (job coords)", () => {
    const job = syntheticJob();
    const posted = postJob(job, getPost("masso-mm"));
    const parsed = parseGcode(posted.text, { stockTopMm: 10, toolByNumber });
    expect(parsed.units).toBe("mm");
    // 8 toolpath moves + tool-change Z-up rapid + footer Z-up rapid
    // + footer park rapid.
    expect(parsed.moves.length).toBe(11);
    const first = parsed.moves[0];
    expect(first.t).toBe("rapid");
    expect([first.x, first.y, first.z]).toEqual([10, 10, 15]);
    expect(first.toolId).toBe("D2.25");
    const zUp = parsed.moves[4];
    expect(zUp.t).toBe("rapid");
    expect([zUp.x, zUp.y, zUp.z]).toEqual([10, 10, 15]);
    const arc = parsed.moves.find((m) => m.t === "arc")!;
    expect([arc.x, arc.y, arc.z]).toEqual([30, 30, 8]);
    expect([arc.i, arc.j, arc.cw]).toEqual([0, 5, false]);
  });

  test("parses the masso-inch output back to the same moves (mm, within rounding)", () => {
    const job = syntheticJob();
    const posted = postJob(job, getPost("masso-inch"));
    const parsed = parseGcode(posted.text, { stockTopMm: 10, toolByNumber });
    expect(parsed.units).toBe("inch");
    const arc = parsed.moves.find((m) => m.t === "arc")!;
    expect(Math.abs(arc.x - 30)).toBeLessThan(0.003);
    expect(Math.abs(arc.z - 8)).toBeLessThan(0.003);
    expect(Math.abs((arc.i ?? 0) - 0)).toBeLessThan(0.003);
    expect(Math.abs((arc.j ?? 0) - 5)).toBeLessThan(0.003);
  });

  test("parses the grbl output (M0 tool change) with the right tools", () => {
    const job = syntheticJob();
    const posted = postJob(job, getPost("grbl"));
    const parsed = parseGcode(posted.text, { stockTopMm: 10, toolByNumber });
    expect(parsed.tools).toEqual(["D2.25", "EM3.17"]);
    expect(parsed.moves.every((m) => m.toolId === "D2.25" || m.toolId === "EM3.17")).toBe(true);
  });

  test("refuses G91, canned cycles, G43, and G28 (outside coverage)", () => {
    for (const line of ["G91", "G81 X10 Y10 Z-5 R2 F100", "G43 H1", "G28 Z0"]) {
      const text = `G90\nG21\nT1 M6\nM3 S1000\n${line}\nM30\n`;
      try {
        parseGcode(text, { stockTopMm: 10, toolByNumber });
        expect.unreachable(`should refuse ${line}`);
      } catch (e: any) {
        expect(e).toBeInstanceOf(GcodeParseError);
        expect(e.code).toBe("gcode_parse_unsupported");
      }
    }
  });

  test("refuses motion before any tool change and before any units word", () => {
    try {
      parseGcode("G90\nG21\nG0 X10 Y10 Z5\nM30\n", { stockTopMm: 10, toolByNumber });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("gcode_parse_error");
    }
    try {
      parseGcode("G90\nT1 M6\nG0 X10 Y10 Z5\nM30\n", { stockTopMm: 10, toolByNumber });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("gcode_parse_error");
    }
  });

  test("modal motion: a bare XYZ line repeats the last motion word", () => {
    const text = "G90\nG21\nT1 M6\nM3 S1000\nG0 X10 Y10 Z5\nX20 Y20\nM30\n";
    const parsed = parseGcode(text, { stockTopMm: 10, toolByNumber });
    expect(parsed.moves.length).toBe(2);
    expect(parsed.moves[1].t).toBe("rapid");
    expect([parsed.moves[1].x, parsed.moves[1].y]).toEqual([20, 20]);
  });
});
