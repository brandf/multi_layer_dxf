#!/usr/bin/env bun
// V3.4 tool model — a tool is DATA, not code (V3_SCOPE.md §5.3).
//
// A tool is a profile function: radius as a function of height above
// the tip, r(z), plus the parameters that define it. The sim's hot
// loop only ever asks one question — "at column (x, y), how low does
// this tool, on this move, cut?" — and the answer comes from the
// profile, so a new tool type is new profile data, not a new engine.
//
// The sim needs the inverse of r(z): h(r), the height of the cutting
// envelope above the tip at radius r from the tool axis. Every profile
// below defines both, so r(h(r)) == r wherever the profile is defined.
// The model is shared by the generator, the sim, and the posts: one
// tool definition, read from the tool's entry (the manifest tool id +
// the plan's shape data). Flutes, helix angle, and stickout do NOT
// affect the stock model and are not in the sim.
//
// Profiles (V3_SCOPE.md §5.3):
//   flat endmill  r(z) = R for z >= 0 (flat tip: a disc at z = 0)
//   ball-nose     r(z) = sqrt(R^2 - (R-z)^2) for 0 <= z <= R, then R above
//   V-bit         r(z) = z * tan(theta/2) (cone from a sharp tip)
//   bull-nose     r(z) = R - rc + sqrt(rc^2 - (rc-z)^2) for 0 <= z <= rc,
//                 then R above (torus fillet of corner radius rc)
//
// A V-bit's "diameter" is its maximum usable diameter (where the cone
// meets the shank); the cone is defined by the included angle alone,
// and h(r) is capped at that diameter. A bull-nose's corner radius
// must be <= R; a corner radius of 0 IS a flat endmill, and R IS a
// ball-nose — the constructor normalises those, so the three are one
// family, not three engines.
//
// No I/O, no DOM, no Node/Bun APIs: this module runs in Bun, in the
// browser bundle (the view), and in tests.

export type ToolProfileKind = "flat" | "ball-nose" | "v-bit" | "bull-nose";

export type ToolProfile = {
  kind: ToolProfileKind;
  /** Tool diameter in mm (the envelope radius is diameter / 2). */
  diameterMm: number;
  /** V-bit included angle in degrees (v-bit only). */
  angleDeg: number | null;
  /** Bull-nose corner radius in mm (bull-nose only). */
  cornerRadiusMm: number | null;
  /** Envelope radius (diameter / 2), for the hot loop. */
  radiusMm: number;
  /** Radius of the tool at height z above the tip (mm). */
  radiusAt(z: number): number;
  /** Height of the cutting envelope above the tip at radius r (mm).
   *  h(0) is 0 for every profile (the tip touches first); h grows
   *  with r. A column at radius r from the tool axis is cut down to
   *  (tool tip Z) + h(r) — never lower. */
  heightAt(r: number): number;
};

function checkDiameter(diameterMm: number): number {
  if (typeof diameterMm !== "number" || !Number.isFinite(diameterMm) || diameterMm <= 0) {
    throw new Error(`tool diameter must be a positive finite number (got ${diameterMm})`);
  }
  return diameterMm;
}

/** Flat endmill: the tip is a disc at z = 0, so the envelope is flat. */
export function makeFlatEndmill(diameterMm: number): ToolProfile {
  const d = checkDiameter(diameterMm);
  const R = d / 2;
  return {
    kind: "flat",
    diameterMm: d,
    angleDeg: null,
    cornerRadiusMm: null,
    radiusMm: R,
    radiusAt(_z: number): number {
      return R;
    },
    heightAt(_r: number): number {
      return 0;
    },
  };
}

/** Ball-nose (hemisphere tip): h(r) = R - sqrt(R^2 - r^2). */
export function makeBallNose(diameterMm: number): ToolProfile {
  const d = checkDiameter(diameterMm);
  const R = d / 2;
  return {
    kind: "ball-nose",
    diameterMm: d,
    angleDeg: null,
    cornerRadiusMm: null,
    radiusMm: R,
    radiusAt(z: number): number {
      if (z <= 0) return 0;
      if (z >= R) return R;
      return Math.sqrt(R * R - (R - z) * (R - z));
    },
    heightAt(r: number): number {
      if (r <= 0) return 0;
      if (r >= R) return R;
      return R - Math.sqrt(R * R - r * r);
    },
  };
}

/** V-bit (cone from a sharp tip): r(z) = z * tan(theta/2), so
 * h(r) = r / tan(theta/2). The cone is capped at the stated
 * diameter — beyond it the bit does not exist. */
export function makeVBit(angleDeg: number, diameterMm: number): ToolProfile {
  if (typeof angleDeg !== "number" || !Number.isFinite(angleDeg) || angleDeg <= 0 || angleDeg >= 180) {
    throw new Error(`V-bit included angle must be in (0, 180) degrees (got ${angleDeg})`);
  }
  const d = checkDiameter(diameterMm);
  const R = d / 2;
  const tanHalf = Math.tan(((angleDeg / 2) * Math.PI) / 180);
  return {
    kind: "v-bit",
    diameterMm: d,
    angleDeg,
    cornerRadiusMm: null,
    radiusMm: R,
    radiusAt(z: number): number {
      if (z <= 0) return 0;
      return Math.min(R, z * tanHalf);
    },
    heightAt(r: number): number {
      if (r <= 0) return 0;
      return r / tanHalf;
    },
  };
}

/** Bull-nose / corner-radius (torus fillet): flat across the middle
 * (r <= R - rc), then the fillet up to the corner radius. A corner
 * radius of 0 normalises to a flat endmill; rc == R IS a ball-nose. */
export function makeBullNose(diameterMm: number, cornerRadiusMm: number): ToolProfile {
  const d = checkDiameter(diameterMm);
  const R = d / 2;
  if (typeof cornerRadiusMm !== "number" || !Number.isFinite(cornerRadiusMm) || cornerRadiusMm < 0 || cornerRadiusMm > R) {
    throw new Error(`bull-nose corner radius must be in [0, ${R}] mm (got ${cornerRadiusMm})`);
  }
  if (cornerRadiusMm === 0) return makeFlatEndmill(d);
  if (cornerRadiusMm === R) return makeBallNose(d);
  const rc = cornerRadiusMm;
  const rFlat = R - rc;
  return {
    kind: "bull-nose",
    diameterMm: d,
    angleDeg: null,
    cornerRadiusMm: rc,
    radiusMm: R,
    radiusAt(z: number): number {
      if (z <= 0) return 0;
      if (z >= rc) return R;
      return rFlat + Math.sqrt(rc * rc - (rc - z) * (rc - z));
    },
    heightAt(r: number): number {
      if (r <= rFlat) return 0;
      if (r >= R) return rc;
      const dr = r - rFlat;
      return rc - Math.sqrt(rc * rc - dr * dr);
    },
  };
}

// ---------------------------------------------------------------- plan tools
//
// A V3.1 plan tool entry: {id, kind, dia_mm, ...}. The V3 toolpaths
// are flat-endmill 2.5D only (V4 adds ball-nose / V-bit generation),
// so every plan tool today maps to a flat profile: kind "endmill"
// and kind "drill" alike — a drill bit's peck cuts a flat-bottomed
// hole in the dexel model (its point angle is not modelled; the
// generator's drill pecks to an exact depth, and the sim shows
// that depth). The mapping is the one place that knows this, so
// when the inventory gains shape data (scope §11.5 — ball-nose
// diameters, V-bit included angles), this is where the new kinds
// plug in: a plan entry naming kind "ball-nose" / "v-bit" /
// "bull-nose" with its parameters becomes that profile, and no
// engine code changes.

export type PlanToolIn = {
  id: string;
  kind: string;
  dia_mm: number;
  /** Ball-nose / bull-nose: present when the inventory records it. */
  corner_radius_mm?: number | null;
  /** V-bit included angle in degrees, when the inventory records it. */
  angle_deg?: number | null;
};

/** One plan tool entry -> its profile. Throws on an unknown kind
 * or a missing/invalid diameter — the sim never guesses a tool. */
export function profileForPlanTool(tool: PlanToolIn): ToolProfile {
  if (!tool || typeof tool.id !== "string") {
    throw new Error("plan tool has no id");
  }
  const dia = tool.dia_mm;
  if (typeof dia !== "number" || !Number.isFinite(dia) || dia <= 0) {
    throw new Error(`plan tool ${tool.id} has no usable dia_mm (got ${dia})`);
  }
  switch (tool.kind) {
    case "endmill":
    case "drill":
      return makeFlatEndmill(dia);
    case "ball-nose":
      return makeBallNose(dia);
    case "v-bit": {
      if (typeof tool.angle_deg !== "number") {
        throw new Error(`plan tool ${tool.id} is a V-bit with no angle_deg recorded`);
      }
      return makeVBit(tool.angle_deg, dia);
    }
    case "bull-nose": {
      if (typeof tool.corner_radius_mm !== "number") {
        throw new Error(`plan tool ${tool.id} is a bull-nose with no corner_radius_mm recorded`);
      }
      return makeBullNose(dia, tool.corner_radius_mm);
    }
    default:
      throw new Error(`plan tool ${tool.id} has unknown kind ${JSON.stringify(tool.kind)} — no profile for it`);
  }
}

/** Resolve every tool id the job's toolpaths use to a profile, from
 * the chosen plan's tool list. Throws on a tool the plan does not
 * name — a toolpath naming a tool outside its plan is a generator
 * bug, and the sim refuses rather than simulating with a guessed
 * diameter. */
export function toolTableFromPlan(
  planTools: PlanToolIn[],
  toolIds: string[],
): Map<string, ToolProfile> {
  const byId = new Map<string, PlanToolIn>();
  for (const t of planTools ?? []) {
    if (t && typeof t.id === "string") byId.set(t.id, t);
  }
  const out = new Map<string, ToolProfile>();
  for (const id of toolIds) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`tool ${id} is used by the toolpaths but is not in the chosen plan`);
    }
    out.set(id, profileForPlanTool(entry));
  }
  return out;
}
