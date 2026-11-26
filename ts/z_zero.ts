// Z-zero frame — the single Z-zero setting (docs-v3/z_zero.md).
//
// Two frames exist in the project and they must never be confused:
//   - JOB frame: Z=0 at the BOTTOM of stock. Toolpaths, the sim,
//     geometry, and cut time all live here. A move's Z is a height
//     above the bed.
//   - DISPLAY / MACHINE frame: Z=0 at the job's Z-zero, which is
//     the stock TOP by default (Brandon's workflow: zero X/Y on
//     the sheet corner, Z probe on top of the stock) or the stock
//     BOTTOM when the job says so. The 3D view and the G-code
//     posts both render in this frame.
//
// The setting lives on the job (`job.z_zero`, "top" | "bottom",
// recorded by `mldxf plan` from the --config file, else the home
// preferences.json, else "top"). A job without the field predates
// the setting and reads as "top" — which is also what the posts
// have always emitted, so old jobs re-post byte-identical.
// A job carrying any other value is corrupt: this throws rather
// than silently picking a frame, and the validator
// (ts/validate_job.ts) refuses it at publish time.

export type ZZero = "top" | "bottom";

/** The job's Z-zero: "top" unless the job says "bottom". Throws
 * on any other recorded value — a corrupt frame must never be
 * silently read as either. */
export function zZeroOf(job: Record<string, unknown>): ZZero {
  const v = (job as { z_zero?: unknown }).z_zero;
  if (v === undefined || v === null) return "top";
  if (v === "top" || v === "bottom") return v;
  throw new Error(
    `job z_zero is ${JSON.stringify(v)}, expected "top" or "bottom" — the job's Z-zero frame is corrupt`,
  );
}

/** Convert a job-frame Z (0 at the stock bottom) to the display /
 * machine frame for the job's Z-zero: top subtracts the stock
 * top (the stock spans -stockTop..0, zero on its top face);
 * bottom is the identity (the stock spans 0..stockTop). */
export function displayZ(jobZMm: number, stockTopMm: number, zZero: ZZero): number {
  return zZero === "top" ? jobZMm - stockTopMm : jobZMm;
}
