#!/usr/bin/env python3
"""Verification for V2.8 (Jobs tab: list + rerun + 2D layout preview).

Starts the server via `bun run server/server.ts` against a throwaway
MLDXF_HOME and checks, in order:

  1. GET /api/jobs lists a real v2 job created via the CLI, a v2 job
     created via the UI, and a v1 job fixture — newest first, with
     the plan summary (Plan A tools/time, parts, layers) and status.
  2. GET /api/jobs/:id on the v2 CLI job: layout P01 (21.35,21.35) /
     P02 (85.05,21.35), material 160x90x10, clamp margin 15,
     workholding null, Plan A 3 tools / 7.7 min (V3.14).
  3. GET /api/jobs/:id on the v1 job: job_version 1, same layout,
     no outputs list — the UI's read-only case.
  4. GET /api/jobs/:id on the synthetic workholding job (a copy of
     the v2 CLI job whose job.json carries a V2.9-shaped workholding
     section — the clamp-marker path cannot be fed by the CLI until
     V2.9 lands): two clamps at (10,45) and (140,45).
  5. POST /api/jobs/:id/rerun on the v1 job -> 400 rerun_unavailable.
  6. A job created via the UI (multipart POST /api/jobs, auto on)
     completes with Plan A 3 tools / 7.7 min and the same layout.
  7. Downloads serve the job's outputs (DXF, manifest.txt,
     report.md, zip — the zip validated with Python's zipfile),
     for the v2 job and the v1 job.
  8. POST /api/jobs/:id/rerun on the v2 CLI job reproduces it in
     place: 200 ok, created_at changes, plan totals identical, DXF
     identical by canonical entity+layer signature (ezdxf bytes are
     nondeterministic, V2_SCOPE.md §8 Q4).
  9. V3.2 toolpaths: POST /api/jobs/:id/toolpaths on the v1 job
     refuses with toolpaths_unavailable; on the v2 CLI job it
     returns 202, completes async, and the job is v3 with 14 ops /
     220 moves (the --auto reference counts), manifest.txt and the
     DXF unchanged, manifest.json byte-identical to job.json, GET
     .../validate agreeing, the list summary carrying the
     toolpaths; re-generating is idempotent and a rerun of the v3
     job reproduces the toolpaths byte-for-byte; `mldxf job`
     shows the summary; `mldxf gcode` posts through Masso-mm
     (verified round-trip, entry recorded, manifest.json
     byte-identical) and POST /api/jobs/:id/gcode posts
     masso-inch the same way, with the .nc downloadable and its
     bytes matching the recorded sha; `mldxf sim --verify` passes
     and writes the `sim` section (V3.4).
 10. V3.14 cut-time feedback: the toolpaths section carries the
     motion time (222.3 s on the reference container) plus
     per-tool/per-operation breakdowns, and a rerun of the v3 job
     keeps it; `bun ts/cuttime.ts` recomputation agrees with the
     recorded motion; `mldxf job` and report.md show the plan
     estimate next to the motion time, with the report section
     appearing exactly once; a pre-V3.14 v3 job (toolpaths without
     motion) gains motion on rerun.
 11. V3.16 guides contact balance: direct compute_guides calls on
     the v2 CLI job with the parity fixture's slots/clamps — the
     balance is unproven (hold force unrated), the worst cut is
     2.58 N on a profile circle, the required hold-down is
     30.47 N at the farthest clamp (hand-verified here from the
     raw numbers: yaw moment about each pivot, inter-clamp
     lever, mu 0.2, safety factor 2.0), supports every part
     within 45 mm of its profile, clears keep-out (verified from
     the job's own geometry, not the module's clears()), and the
     fixture limitation is named (no slot along the left edge);
     a top-slot-only home returns a placement with verdict
     unproven and a short-slot layout returns one with verdict
     insufficient (a single contact can never balance a moment)
     — there is no edge-based refusal any more; the UI
     workholding sections render the balance banner and a Role
     column (source-level checks).
 12. V3.8 post-processor config + verification stamp: the home
     machine.json names the post (grbl) and the CLI honors it
     with no --post; an unknown post is refused with
     post_unknown; an over-limit feed is refused with
     post_limit_exceeded and writes nothing; `mldxf gcode
     --verify` exits 0 on the recorded file and leaves job.json
     untouched, refuses a hand-corrupted file with
     gcode_sha_mismatch and flips its stamp to verified:false
     (visible through the API), and refuses toolpaths moved
     after posting with gcode_unverified; the Preferences post
     choice mirrors into machine.json while a VCarve post name
     leaves it alone; the served app.js offers the four native
     posts in the dropdowns (source-level — the DOM harness does
     not load app.js).

The UI's rendering itself (list rows, detail view, SVG preview
rects, clicking Rerun in the browser) is verified by the live
Chromium E2E driver (see /tmp/v28_e2e.ts run notes) — this harness
is the HTTP replay half.

Usage: python3 server/verify_v28.py [--port N]
Logs to stdout; exit code = number of failed checks (0 = all pass).
The server log goes to server/verify_v28.log. The test home lives
under ~/workspace/v28-verify-home (recreated each run — under the
workspace, not /tmp, because a runtime restart wipes /tmp and this
harness's fixtures must survive one).

NOTE: the server keeps its retained-inputs index under the shared
OS temp dir (/tmp/mldxf-server/server-state.json), and each entry
records the home it belongs to — GET /api/jobs lists only this
home's jobs, so retained runs from other homes never appear.
(Same-home stale retained entries from earlier runs of this same
home path can still appear as interrupted rows, so list checks
assert on the fixture ids ("contains"), never on an exact total
count.)
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

REPO = Path("/home/hatch/workspace/multi_layer_dxf")
VENV_PY = str(REPO / ".venv" / "bin" / "python")
BUN = "/opt/hatch-image/bin/bun"
HOME = Path("/home/hatch/workspace/v28-verify-home")
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8471
BASE = f"http://127.0.0.1:{PORT}"
LOG = REPO / "server" / "verify_v28.log"
CONTAINER_STEP = REPO / "test" / "real_container.step"

CLI_JOB_ID = "20261122-220000-real-container"
V1_JOB_ID = "20200102-000000-v1-real-container"
WH_JOB_ID = "20261122-220001-wh-test"

PASSES: list[str] = []
FAILURES: list[str] = []


def check(label, cond, detail=""):
    if cond:
        PASSES.append(label)
        print(f"  PASS {label}", flush=True)
    else:
        FAILURES.append(f"{label} :: {detail}")
        print(f"  FAIL {label} :: {detail}", flush=True)


def req(method, path, body=None, headers=None, timeout=60):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=hdrs)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_json(path, timeout=60):
    status, raw = req("GET", path, timeout=timeout)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {}


def dxf_signature(path):
    r = subprocess.run(
        [VENV_PY, "-c",
         "import sys; sys.path.insert(0, %r); import mldxf_dxf; print(mldxf_dxf.dxf_signature(%r))"
         % (str(REPO), str(path))],
        capture_output=True, text=True, check=True)
    return r.stdout.strip()


def multipart_step(step_path, fields):
    boundary = "----v28-" + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            .encode())
    data = step_path.read_bytes()
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"step\"; "
        f"filename=\"{step_path.name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        .encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def wait_for_status(job_id, timeout=600):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, body = get_json(f"/api/jobs/{job_id}/status", timeout=30)
        last = body
        if body.get("status") in ("complete", "failed", "interrupted"):
            return body
        time.sleep(5)
    return last or {}


def main():
    print("== V2.8 verification ==", flush=True)
    print(f"home={HOME} port={PORT}", flush=True)

    # ---- fixtures ------------------------------------------------------
    if HOME.exists():
        shutil.rmtree(HOME)
    env = dict(os.environ, MLDXF_HOME=str(HOME))
    r = subprocess.run([VENV_PY, str(REPO / "mldxf.py"), "init"],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, f"mldxf init failed: {r.stdout} {r.stderr}"
    jobs_root = HOME / "jobs"
    jobs_root.mkdir(parents=True, exist_ok=True)

    # v2 job via the CLI (real container, --auto, 160x90x10).
    cli_dir = jobs_root / CLI_JOB_ID
    r = subprocess.run(
        [VENV_PY, str(REPO / "mldxf.py"), "plan", str(CONTAINER_STEP),
         "-o", str(cli_dir), "--auto", "--material", "160x90x10", "--json"],
        capture_output=True, text=True, env=env, timeout=600)
    assert r.returncode == 0, f"CLI plan failed: {r.stderr[-2000:]}"
    cli_job = json.loads(r.stdout)["job"]
    print(f"CLI v2 job: {CLI_JOB_ID} Plan A "
          f"{cli_job['tool_plan']['plans'][0]['total_seconds']}s", flush=True)

    # v1 job fixture: the real v1 manifest.json only (no job.json).
    shutil.copytree(REPO / "test" / "real_container_out", jobs_root / V1_JOB_ID)

    # Synthetic workholding job: copy of the v2 CLI job, job.json
    # patched ONLY to carry a V2.9-shaped workholding section, so the
    # clamp-marker path in the preview can be verified before V2.9
    # lands. Not a CLI-produced job; labelled as such here.
    wh_dir = jobs_root / WH_JOB_ID
    shutil.copytree(cli_dir, wh_dir)
    wh_path = wh_dir / "job.json"
    wh = json.loads(wh_path.read_text())
    wh["job_id"] = WH_JOB_ID
    wh["created_at"] = "2026-11-23T06:10:00+00:00"
    wh["workholding"] = {
        "recommendation": "2 clamps: 2x T-track clamps at (10, 45) and (140, 45)",
        "clamps": [
            {"clamp_id": "TC1", "method": "t_track_clamp", "slot": "x@150",
             "x_mm": 10.0, "y_mm": 45.0, "reason": "supports the P01 profile cut"},
            {"clamp_id": "TC2", "method": "t_track_clamp", "slot": "x@150",
             "x_mm": 140.0, "y_mm": 45.0, "reason": "supports the P02 profile cut"},
        ],
    }
    wh_path.write_text(json.dumps(wh, indent=2, sort_keys=True))

    # ---- server --------------------------------------------------------
    logf = open(LOG, "wb")
    server = subprocess.Popen(
        [BUN, "run", "server/server.ts", "--port", str(PORT)],
        cwd=REPO, env=env, stdout=logf, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 30
        up = False
        while time.time() < deadline:
            try:
                status, _ = get_json("/api/health", timeout=5)
                if status == 200:
                    up = True
                    break
            except Exception:
                pass
            time.sleep(1)
        check("server starts and answers /api/health", up)
        if not up:
            print("server log tail:")
            print(Path(LOG).read_text()[-3000:])
            return 1

        # ---- 1. list ---------------------------------------------------
        status, body = get_json("/api/jobs")
        jobs = body.get("jobs", []) if body.get("ok") else []
        by_id = {j["id"]: j for j in jobs}
        check("GET /api/jobs 200 with a jobs list", status == 200 and body.get("ok") is True,
              f"status={status} body={str(body)[:200]}")
        check("list contains the v2 CLI job, the v1 job and the wh job",
              all(i in by_id for i in (CLI_JOB_ID, V1_JOB_ID, WH_JOB_ID)),
              f"ids={[j['id'] for j in jobs]}")
        mine = [j["id"] for j in jobs
                if j["id"] in (CLI_JOB_ID, V1_JOB_ID, WH_JOB_ID)]
        check("list is newest first among the fixtures",
              mine == [WH_JOB_ID, CLI_JOB_ID, V1_JOB_ID], f"order={mine}")
        cli_entry = by_id.get(CLI_JOB_ID, {})
        check("v2 list entry: job_version 2, status complete",
              cli_entry.get("job_version") == 2 and cli_entry.get("status") == "complete",
              str(cli_entry))
        plan = (cli_entry.get("summary") or {}).get("plan") or {}
        check("v2 list summary: Plan A 3 tools, 2 changes, 7.7 min",
              plan.get("id") == "A" and len(plan.get("tools") or []) == 3
              and plan.get("tool_changes") == 2 and plan.get("minutes") == 7.7,
              str(plan))
        check("v2 list summary: 2 parts, 8 layers",
              (cli_entry.get("summary") or {}).get("parts") == 2
              and (cli_entry.get("summary") or {}).get("layers") == 8,
              str(cli_entry.get("summary")))
        v1_entry = by_id.get(V1_JOB_ID, {})
        check("v1 list entry: job_version 1, status complete",
              v1_entry.get("job_version") == 1 and v1_entry.get("status") == "complete",
              str(v1_entry))

        # ---- 2. v2 detail ----------------------------------------------
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        job = body.get("job") or {}
        check("GET v2 job 200, job_version 2",
              status == 200 and job.get("job_version") == 2, f"status={status}")
        layout = job.get("layout") or []
        by_name = {e.get("name"): e for e in layout}
        check("v2 layout: P01 at (21.35,21.35) 46x46",
              by_name.get("P01_P01", {}).get("x_mm") == 21.35
              and by_name.get("P01_P01", {}).get("y_mm") == 21.35
              and by_name.get("P01_P01", {}).get("w_mm") == 46.0
              and by_name.get("P01_P01", {}).get("d_mm") == 46.0,
              str(layout))
        check("v2 layout: P02 at (85.05,21.35) 46x46",
              by_name.get("P02_P02", {}).get("x_mm") == 85.05
              and by_name.get("P02_P02", {}).get("y_mm") == 21.35,
              str(layout))
        check("v2 material 160x90x10, clamp margin 15, workholding null",
              job.get("material") == {"x": 160.0, "y": 90.0, "thickness": 10.0}
              and job.get("clamp_margin_mm") == 15.0
              and job.get("workholding") is None,
              f"material={job.get('material')} margin={job.get('clamp_margin_mm')} "
              f"wh={job.get('workholding')}")
        plans = (job.get("tool_plan") or {}).get("plans") or []
        check("v2 Plan A: 3 tools, 464.1 s (7.7 min)",
              plans and plans[0].get("total_seconds") == 464.1
              and len(plans[0].get("tools") or []) == 3, str(plans[:1]))
        check("v2 outputs list the DXF, manifest.txt and report.md",
              {"real_container.dxf", "manifest.txt", "report.md"}
              <= {o.get("file") for o in job.get("outputs") or []},
              str([o.get("file") for o in job.get("outputs") or []]))
        created_before = job.get("created_at")

        # ---- 3. v1 detail ----------------------------------------------
        status, body = get_json(f"/api/jobs/{V1_JOB_ID}")
        v1job = body.get("job") or {}
        check("GET v1 job 200, job_version 1",
              status == 200 and v1job.get("job_version") == 1, f"status={status}")
        # The v1 fixture is a FROZEN artifact (test/real_container_out,
        # a v1 manifest.json only — the v1 output format no longer
        # exists, so it cannot be regenerated): its layout is the
        # pre-change layout, P01 (20,20) / P02 (83.7,20) on a 150x90
        # sheet with a 20 mm margin, and its DXF/report/parts agree
        # with that layout. It no longer matches a fresh v2 run
        # (Nov 25-26, 2026 layout change: P01 (21.35,21.35) / P02
        # (85.05,21.35), 160x90, margin 15). Pin the frozen values
        # here instead: the check still fails if the fixture or the
        # API's v1 layout reading drifts, and it documents that the
        # v1 job is history, not a live layout.
        check("v1 layout is the frozen pre-change layout",
              v1job.get("layout") == [
                  {"name": "P01_P01", "x_mm": 20.0, "y_mm": 20.0,
                   "w_mm": 46.0, "d_mm": 46.0, "rotate_z_deg": 0,
                   "profile_tool_dia_mm": 6.35},
                  {"name": "P02_P02", "x_mm": 83.7, "y_mm": 20.0,
                   "w_mm": 46.0, "d_mm": 46.0, "rotate_z_deg": 0,
                   "profile_tool_dia_mm": 6.35}],
              str(v1job.get("layout")))
        check("v1 job carries no outputs list (read-only case)",
              v1job.get("outputs") is None, f"outputs={v1job.get('outputs')}")

        # ---- 4. workholding fixture detail -----------------------------
        status, body = get_json(f"/api/jobs/{WH_JOB_ID}")
        whjob = body.get("job") or {}
        wh_clamps = (whjob.get("workholding") or {}).get("clamps") or []
        check("wh job: 2 clamps TC1 (10,45), TC2 (140,45)",
              len(wh_clamps) == 2
              and wh_clamps[0].get("clamp_id") == "TC1"
              and wh_clamps[0].get("x_mm") == 10.0 and wh_clamps[0].get("y_mm") == 45.0
              and wh_clamps[1].get("clamp_id") == "TC2"
              and wh_clamps[1].get("x_mm") == 140.0 and wh_clamps[1].get("y_mm") == 45.0,
              str(wh_clamps))

        # ---- 4b. preview caption agrees with the drawing (round 6) --
        # jobs.js derives the preview caption from the same
        # workholding object the SVG renders from: the wh job's two
        # clamps must be named in the caption, never "No clamp
        # positions recorded". The HTTP harness cannot render the
        # DOM, so this is a source-level regression check on the
        # caption branch (the live Chromium verification covers the
        # rendered preview); the API half above proves the job
        # really carries the 2 clamps the caption must name.
        jobs_js = (REPO / "server" / "public" / "jobs.js").read_text()
        preview_fn = jobs_js.split("function buildLayoutPreview")[1] \
            .split("function rerenderDetailOnly")[0]
        check("preview caption derives from workholdingClamps (same object as the SVG)",
              "workholdingClamps(job)" in preview_fn
              and "drawnWithCoords.length" in preview_fn,
              "caption branch does not derive from workholdingClamps")
        check("preview 'No clamp positions' appears only in the empty-clamps branch",
              preview_fn.count("No clamp positions recorded for this job.") == 1,
              "unconditional no-clamps caption still present in the preview")

        # ---- 4c. preview paint order + caption (round 7) -----------
        # A part whose edge coincides with the usable-area boundary
        # (parts sit at the margin) used to hide the 1px boundary
        # stroke behind its opaque fill. The boundary is now
        # re-drawn over the parts (same paint-order pattern as the
        # sheet border over the clamps), and the caption says the
        # blue boxes are bounding rectangles, not the part shape —
        # and a round part (PROFILE perimeter π·Ø) is drawn as its
        # bounding circle instead (round 15, M1). The caption
        # names both cases, so the drawing and the disclosure can
        # never disagree about which shape is shown. The HTTP
        # harness cannot render the DOM, so these are source-level
        # regression checks on the preview builder (the live
        # Chromium verification covers the rendered preview); the
        # API half above proves the job really carries the layout
        # the preview draws.
        check("preview re-draws the usable-area boundary over the parts",
              "usable-area-top" in preview_fn
              and preview_fn.index("usable-area-top")
              > preview_fn.index("'data-role': 'part'"),
              "no usable-area-top re-draw after the part rects")
        check("preview caption names both drawn shapes (circles for round parts, bounding rectangles otherwise)",
              "round parts shown as circles" in preview_fn
              and "parts shown as bounding rectangles" in preview_fn,
              "caption does not name both the circle and bounding-rectangle cases")
        check("preview derives roundness from the profile perimeter",
              "partIsRound(job" in preview_fn
              and "'data-shape': 'circle'" in preview_fn,
              "no profile-perimeter roundness derivation in the preview builder")

        # ---- 4d. guides contact balance (V3.16) --------------------
        # Direct compute_guides calls (venv python — ezdxf) on the
        # v2 CLI job. The parity fixture's slots (x@6, x@84, y@144)
        # and clamps (test-tt-clamp 20x12, count 4, keep-out 5,
        # top-down, hold force unrated) must yield a placement
        # whose contact balance is UNPROVEN — the worst cut
        # (2.58 N on a profile circle) demands 30.47 N of
        # hold-down at the farthest clamp and the clamp's hold
        # force is unrated (unmeasured, not small) — with the
        # moment numbers re-derived here from the raw cut and
        # clamp positions (yaw moment about each pivot,
        # inter-clamp lever, mu 0.2, safety factor 2.0), not
        # taken from the module's own arithmetic. Every part must
        # be supported within SUPPORT_RADIUS_MM of its profile,
        # keep-out must clear — verified here from the job's own
        # geometry (part circles + drill points), not the
        # module's own clears() — and the fixture limitation must
        # be named: no slot runs along the left edge, so
        # four-side placement is impossible on these slots. A
        # top-slot-only home must still return a placement with
        # verdict unproven, and a short-slot layout one with
        # verdict insufficient (a single contact can never
        # balance a moment) — the old guides_unrestrained
        # refusal is gone; an unproven or insufficient placement
        # warns with the numbers, it is never refused for being
        # one-sided. The driver runs under the venv
        # python (ezdxf) and prints one JSON summary; the
        # assertions live here.
        guides_driver = r'''
import copy, json, math, sys
sys.path.insert(0, sys.argv[2])
import mldxf_guides as g

job_dir = sys.argv[1]
job = json.loads(open(job_dir + "/job.json").read())
dxf = job_dir + "/real_container.dxf"
machine = {
    "bed": {"depth_mm": 1222.4, "width_mm": 1222.4},
    "controller": "masso", "default_material": None,
    "id": "onefinity-elite-foreman",
    "name": "Onefinity Elite (Masso) Foreman",
    "t_track": {"placeholder": False, "slot_width_mm": 8.0,
                "slots": [
                    {"at_y_mm": 6.0, "axis": "x", "from_x_mm": 0.0,
                     "placeholder": False, "to_x_mm": 1222.4},
                    {"at_y_mm": 84.0, "axis": "x", "from_x_mm": 0.0,
                     "placeholder": False, "to_x_mm": 1222.4},
                    {"at_x_mm": 144.0, "axis": "y", "from_y_mm": 0.0,
                     "placeholder": False, "to_y_mm": 1222.4}]},
    "version": 1}
clamps = {"version": 1, "clamps": [
    {"count": 4, "footprint_mm": [20, 12], "id": "test-tt-clamp",
     "keep_out_mm": 5, "method": "t_track_clamp", "t_track": True,
     "type": "top_down"}]}

def _rect_pt_dist(px, py, rect):
    x0, y0, x1, y1 = rect
    dx = max(x0 - px, 0.0, px - x1)
    dy = max(y0 - py, 0.0, py - y1)
    return math.hypot(dx, dy)

def _summarise(wh):
    # Independent geometry checks (plain math on the job's own
    # numbers — NOT the module's clears()): profile circles are
    # r=23 about each part centre; profile clearance required is
    # keep-out 5 + largest profile tool 6.35 = 11.35 mm; drill
    # clearance required is keep-out 5 + drill dia/2 = 6.125 mm.
    # Pocket outlines sit inside the profile circles, so the
    # profile distance binds for them too.
    bal = wh["balance"]
    out = {"verdict": bal["verdict"],
           "required_hold_down_max_n":
               bal["required_hold_down_max_n"],
           "worst_cut": bal["worst_cut"],
           "slots_along_edges": bal["slots_along_edges"],
           "sides_without_slot": bal["sides_without_slot"],
           "safety_factor": bal["safety_factor"],
           "friction_mu_default": bal["friction_mu_default"],
           "z_top_mm": bal["z_top_mm"],
           "per_clamp": bal["per_clamp"],
           "per_pivot": bal["per_pivot"],
           "note": bal["note"],
           "clamps": []}
    parts = {p["name"]: (p["x_mm"] + p["footprint_mm"][0] / 2.0,
                         p["y_mm"] + p["footprint_mm"][1] / 2.0)
             for p in job["parts"]}
    drills = []
    for layer in job["layers"]:
        for cx, cy in layer.get("centres") or []:
            drills.append((cx, cy))
    min_profile = None
    min_drill = None
    support = {}
    for c in wh["clamps"]:
        w, d = c["footprint_mm"]
        rect = (c["x_mm"] - w / 2, c["y_mm"] - d / 2,
                c["x_mm"] + w / 2, c["y_mm"] + d / 2)
        for (pcx, pcy) in parts.values():
            dd = max(0.0, _rect_pt_dist(pcx, pcy, rect) - 23.0)
            min_profile = dd if min_profile is None else min(min_profile, dd)
        for (dcx, dcy) in drills:
            dd = _rect_pt_dist(dcx, dcy, rect)
            min_drill = dd if min_drill is None else min(min_drill, dd)
        for name, (pcx, pcy) in parts.items():
            dd = max(0.0, math.hypot(c["x_mm"] - pcx, c["y_mm"] - pcy) - 23.0)
            support[name] = dd if name not in support else min(support[name], dd)
        out["clamps"].append({"x_mm": c["x_mm"], "y_mm": c["y_mm"],
                              "footprint_mm": c["footprint_mm"],
                              "roles": c["roles"],
                              "contact_type": c["contact_type"]})
    out["support_dists"] = support
    out["support_ok"] = all(v <= 45.0 for v in support.values())
    out["keepout_min_profile"] = min_profile
    out["keepout_min_drill"] = min_drill
    out["keepout_ok"] = (min_profile is not None and min_profile >= 11.35
                         and min_drill is not None and min_drill >= 6.125)
    out["worst_force_n"] = wh["force_model"]["worst_force_n"]
    out["force_statuses"] = [c["force_check"]["status"] for c in wh["clamps"]]
    out["force_notes"] = [c["force_check"]["note"] for c in wh["clamps"]]
    out["force_required"] = [c["force_check"]["required_hold_down_n"]
                             for c in wh["clamps"]]
    # Independent moment re-derivation from the raw worst cut
    # and clamp positions (plain math — NOT the module's
    # _moment_balance): yaw moment about each pivot, then the
    # required hold-down per clamp (yaw via friction couple,
    # lift via hold-down about the tip axis), with safety
    # factor 2.0 and mu 0.2.
    wc = bal["worst_cut"]
    fx = wc["sense"] * wc["force_n"] * wc["tangent"][0]
    fy = wc["sense"] * wc["force_n"] * wc["tangent"][1]
    pos = [(c["x_mm"], c["y_mm"]) for c in wh["clamps"]]
    out["hand_yaw"] = {}
    for (px, py) in pos:
        out["hand_yaw"][f"{px:g},{py:g}"] = abs(
            (wc["x_mm"] - px) * fy - (wc["y_mm"] - py) * fx)
    out["hand_required"] = {}
    for i, (cx, cy) in enumerate(pos):
        req_hold = 0.0
        for j, (px, py) in enumerate(pos):
            if i == j:
                continue
            lever = math.hypot(cx - px, cy - py)
            yaw = out["hand_yaw"][f"{px:g},{py:g}"]
            req_hold = max(req_hold,
                           yaw * 2.0 / (0.2 * lever))
            mx, my = -fy / wc["force_n"], fx / wc["force_n"]
            dperp = abs((cx - px) * my - (cy - py) * mx)
            req_hold = max(req_hold,
                           wc["force_n"] * bal["z_top_mm"] * 2.0
                           / dperp)
        out["hand_required"][f"{cx:g},{cy:g}"] = round(req_hold, 2)
    # The worst cut sits on a profile circle (r=23 about a part
    # centre) — the cut position is real geometry, not a number
    # the module invented.
    out["worst_cut_on_circle"] = min(
        abs(math.hypot(wc["x_mm"] - pcx, wc["y_mm"] - pcy) - 23.0)
        for (pcx, pcy) in parts.values())
    return out

result = {}
wh = g.compute_guides(job, dxf, machine, clamps)
result["fixture"] = _summarise(wh)
top_only = copy.deepcopy(machine)
top_only["t_track"]["slots"] = [
    s for s in top_only["t_track"]["slots"]
    if s["axis"] == "x" and s["at_y_mm"] == 84.0]
result["top_only"] = _summarise(g.compute_guides(job, dxf, top_only, clamps))
short_slot = copy.deepcopy(machine)
short_slot["t_track"]["slots"] = [
    {"axis": "x", "at_y_mm": 84.0, "from_x_mm": 50.0,
     "to_x_mm": 100.0, "placeholder": False}]
try:
    result["short_slot"] = _summarise(
        g.compute_guides(job, dxf, short_slot, clamps))
    result["short_slot"]["error"] = None
except g.GuidesError as e:
    result["short_slot"] = {"error": e.name, "message": e.message}
print(json.dumps(result))
'''
        r = subprocess.run([VENV_PY, "-c", guides_driver, str(cli_dir), str(REPO)],
                           capture_output=True, text=True, timeout=300)
        guides = {}
        try:
            guides = json.loads(r.stdout)
        except ValueError:
            pass
        fx = guides.get("fixture") or {}
        check("guides balance (V3.16): fixture verdict unproven, hold force unrated",
              fx.get("verdict") == "unproven"
              and fx.get("worst_force_n") == 2.58
              and fx.get("force_statuses") == ["unproven", "unproven"]
              and all("unrated" in (n or "") for n in fx.get("force_notes") or []),
              f"rc={r.returncode} out={r.stdout[:300]} err={r.stderr[-500:]}")
        wc = fx.get("worst_cut") or {}
        check("guides balance: worst cut 2.58 N on a profile circle",
              wc.get("force_n") == 2.58
              and wc.get("layer") == "P01_P01__PROFILE_THRU"
              and abs(wc.get("x_mm", 0) - 24.16) <= 0.5
              and abs(wc.get("y_mm", 0) - 33.56) <= 0.5
              and (fx.get("worst_cut_on_circle") or 99) <= 0.5,
              f"worst_cut={wc} on_circle={fx.get('worst_cut_on_circle')}")
        check("guides balance: required hold-down 30.47 N at the farthest clamp",
              fx.get("required_hold_down_max_n") == 30.47
              and sorted(fx.get("force_required") or []) == [7.42, 30.47],
              f"required_max={fx.get('required_hold_down_max_n')} per_clamp={fx.get('force_required')}")
        # The moment numbers, re-derived here from the raw cut
        # and clamp positions — the module's per-pivot yaw
        # moments and per-clamp requirements must agree with
        # plain math (yaw about each pivot, inter-clamp lever,
        # mu 0.2, safety factor 2.0).
        hand_ok = True
        hand_why = ""
        for row in fx.get("per_pivot") or []:
            key = f"{row['pivot_x_mm']:g},{row['pivot_y_mm']:g}"
            if abs(row.get("yaw_moment_n_mm", 0)
                   - (fx.get("hand_yaw") or {}).get(key, -1)) > 0.5:
                hand_ok = False
                hand_why = f"yaw at {key}: module {row.get('yaw_moment_n_mm')} hand {(fx.get('hand_yaw') or {}).get(key)}"
        for ci, reqd in (fx.get("per_clamp") or {}).items():
            c = (fx.get("clamps") or [])[int(ci)]
            key = f"{c['x_mm']:g},{c['y_mm']:g}"
            if abs(reqd.get("required_hold_down_n", 0)
                   - (fx.get("hand_required") or {}).get(key, -1)) > 0.05:
                hand_ok = False
                hand_why = (f"required at {key}: module "
                            f"{reqd.get('required_hold_down_n')} hand "
                            f"{(fx.get('hand_required') or {}).get(key)}")
        check("guides balance: moment numbers agree with the independent hand-check",
              hand_ok and fx.get("safety_factor") == 2.0
              and fx.get("friction_mu_default") == 0.2
              and fx.get("z_top_mm") == 10.0,
              hand_why or f"per_pivot={fx.get('per_pivot')} per_clamp={fx.get('per_clamp')}")
        check("guides balance: fixture limitation named — no left slot, four-side impossible",
              (fx.get("slots_along_edges") or {}) == {"bottom": True, "left": False,
                                                      "right": True, "top": True}
              and fx.get("sides_without_slot") == ["left"]
              and "left" in (fx.get("note") or "")
              and "four-side placement is impossible" in (fx.get("note") or ""),
              f"slots={fx.get('slots_along_edges')} sides={fx.get('sides_without_slot')} note={fx.get('note')}")
        check("guides balance: clamps placed at (70, 6) and (125, 84), top-down hold-down + friction",
              sorted((c["x_mm"], c["y_mm"]) for c in fx.get("clamps") or [])
              == [(70.0, 6.0), (125.0, 84.0)]
              and all(c.get("contact_type") == "top_down"
                      and set(c.get("roles") or [])
                      <= {"hold-down", "friction", "support"}
                      for c in fx.get("clamps") or []),
              f"clamps={fx.get('clamps')}")
        check("guides balance: every part supported within 45 mm of its profile",
              fx.get("support_ok") is True,
              f"support={fx.get('support_dists')}")
        check("guides balance: no clamp violates keep-out (independent geometry)",
              fx.get("keepout_ok") is True,
              f"min_profile={fx.get('keepout_min_profile')} min_drill={fx.get('keepout_min_drill')}")
        top = guides.get("top_only") or {}
        check("guides balance: top-slot-only home warns loudly, missing sides named",
              top.get("verdict") == "unproven"
              and (top.get("sides_without_slot") or []) == ["bottom", "left", "right"]
              and "UNPROVEN" in (top.get("note") or "")
              and "bottom" in (top.get("note") or ""),
              f"top_only={top}")
        short = guides.get("short_slot") or {}
        check("guides balance: short-slot layout returns a placement, insufficient — no refusal",
              short.get("error") is None
              and short.get("verdict") == "insufficient"
              and len(short.get("clamps") or []) == 1
              and "single contact can never balance a moment"
              in (short.get("note") or "")
              and "bottom" in (short.get("note") or ""),
              f"short_slot={short}")
        # UI: the workholding sections surface the balance
        # verdict as a banner and show a Role column (source-level;
        # the live Chromium verification covers the rendered UI).
        jp = (REPO / "server" / "public" / "job-prep.js").read_text()
        jj = (REPO / "server" / "public" / "jobs.js").read_text()
        check("guides balance UI: job-prep shows the balance banner + Role column",
              "wh.balance" in jp and "jp-warn" in jp
              and "{ text: 'Role' }" in jp,
              "job-prep.js has no balance banner / Role column")
        check("guides balance UI: jobs tab shows the balance banner + Role column",
              "wh.balance" in jj and "jobs-warn" in jj
              and "{ text: 'Role' }" in jj,
              "jobs.js has no balance banner / Role column")

        # ---- 5. rerun v1 -> rerun_unavailable --------------------------
        status, raw = req("POST", f"/api/jobs/{V1_JOB_ID}/rerun", {})
        body = json.loads(raw) if raw else {}
        check("POST rerun on v1 job -> 400 rerun_unavailable",
              status == 400 and body.get("error") == "rerun_unavailable",
              f"status={status} body={str(body)[:300]}")

        # ---- 6. job via the UI ------------------------------------------
        ui_body, ui_headers = multipart_step(
            CONTAINER_STEP, {"auto": "true", "material": "160x90x10"})
        status, raw = req("POST", "/api/jobs", ui_body, headers=ui_headers, timeout=30)
        ui_started = json.loads(raw) if raw else {}
        ui_id = (ui_started.get("job") or {}).get("job_id")
        check("POST /api/jobs (multipart, auto) -> 202 with a job id",
              status == 202 and bool(ui_id), f"status={status} body={str(ui_started)[:200]}")
        ui_job = None
        if ui_id:
            final = wait_for_status(ui_id, timeout=600)
            check("UI job reaches complete",
                  final.get("status") == "complete", f"status={final.get('status')} err={final.get('error')}")
            status, body = get_json(f"/api/jobs/{ui_id}")
            ui_job = body.get("job") or {}
            ui_plans = (ui_job.get("tool_plan") or {}).get("plans") or []
            check("UI job Plan A: 3 tools, 464.1 s (7.7 min)",
                  ui_plans and ui_plans[0].get("total_seconds") == 464.1
                  and len(ui_plans[0].get("tools") or []) == 3, str(ui_plans[:1]))
            check("UI job layout matches the CLI job layout",
                  ui_job.get("layout") == layout, str(ui_job.get("layout")))
            check("UI job is v2 with embedded inputs",
                  ui_job.get("job_version") == 2 and ui_job.get("inputs_embedded") is True,
                  f"version={ui_job.get('job_version')} embedded={ui_job.get('inputs_embedded')}")

        # ---- 7. downloads ------------------------------------------------
        for fname, needle in (
                ("real_container.dxf", b"SECTION"),
                ("manifest.txt", b"real_container.dxf"),
                ("report.md", b"Plan A")):
            status, raw = req("GET", f"/api/jobs/{CLI_JOB_ID}/download/{fname}")
            check(f"v2 download {fname} 200, non-empty, contains expected content",
                  status == 200 and len(raw) > 0 and needle in raw,
                  f"status={status} len={len(raw)}")
        status, raw = req("GET", f"/api/jobs/{CLI_JOB_ID}/download/zip")
        zip_ok = False
        zip_names = []
        if status == 200 and raw[:2] == b"PK":
            try:
                import io
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    zip_names = z.namelist()
                    zip_ok = ("job.json" in zip_names
                              and "real_container.dxf" in zip_names
                              and z.testzip() is None)
            except zipfile.BadZipFile as e:
                zip_ok = False
        check("v2 download zip 200, valid zip with job.json + DXF",
              zip_ok, f"status={status} names={zip_names}")
        for fname in ("real_container.dxf", "manifest.txt", "report.md"):
            status, raw = req("GET", f"/api/jobs/{V1_JOB_ID}/download/{fname}")
            check(f"v1 download {fname} 200, non-empty",
                  status == 200 and len(raw) > 0, f"status={status} len={len(raw)}")

        # ---- 8. rerun v2 -------------------------------------------------
        sig_before = dxf_signature(cli_dir / "real_container.dxf")
        plan_before = (job.get("tool_plan") or {}).get("plans") or []
        status, raw = req("POST", f"/api/jobs/{CLI_JOB_ID}/rerun", {}, timeout=600)
        body = json.loads(raw) if raw else {}
        check("POST rerun on v2 job -> 200 ok",
              status == 200 and body.get("ok") is True, f"status={status} body={str(body)[:300]}")
        if body.get("ok"):
            status, body2 = get_json(f"/api/jobs/{CLI_JOB_ID}")
            job2 = body2.get("job") or {}
            check("rerun changed created_at (a new run happened)",
                  job2.get("created_at") and job2.get("created_at") != created_before,
                  f"before={created_before} after={job2.get('created_at')}")
            plans2 = (job2.get("tool_plan") or {}).get("plans") or []
            check("rerun plan totals identical (464.1 s, 3 tools)",
                  plans2 and plans2[0].get("total_seconds")
                  == (plan_before[0].get("total_seconds") if plan_before else None)
                  and len(plans2[0].get("tools") or []) == 3, str(plans2[:1]))
            check("rerun layout identical",
                  job2.get("layout") == layout, str(job2.get("layout")))
            sig_after = dxf_signature(cli_dir / "real_container.dxf")
            check("rerun DXF identical by canonical signature",
                  sig_after == sig_before, f"before={sig_before[:80]} after={sig_after[:80]}")

        # ---- 9. V3.2 toolpaths ------------------------------------------
        # The CLI job is the --auto reference (test/real_container.step
        # --auto --material 160x90x10): 14 operations / 220 moves
        # (66 rapid, 86 feed, 68 arc), 0 skipped loops.
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        job = body.get("job") or {}
        check("v2 job carries no toolpaths before generation",
              job.get("job_version") == 2 and job.get("toolpaths") is None,
              f"version={job.get('job_version')} tp={'toolpaths' in job}")
        status, body = get_json("/api/jobs")
        entry = next((j for j in body.get("jobs", []) if j["id"] == CLI_JOB_ID), None)
        check("v2 list entry summary toolpaths is null",
              entry is not None and (entry.get("summary") or {}).get("toolpaths") is None,
              str(entry)[:200])
        status, val = get_json(f"/api/jobs/{CLI_JOB_ID}/validate")
        check("GET validate on v2 job -> ok, version 2, no toolpaths",
              status == 200 and val.get("ok") is True
              and val.get("job_version") == 2 and val.get("has_toolpaths") is False,
              f"status={status} {str(val)[:200]}")
        status, raw = req("POST", f"/api/jobs/{V1_JOB_ID}/toolpaths", {})
        v1tp = json.loads(raw) if raw else {}
        check("POST toolpaths on v1 job -> 400 toolpaths_unavailable",
              status == 400 and v1tp.get("error") == "toolpaths_unavailable",
              f"status={status} body={str(v1tp)[:200]}")
        manifest_before = (cli_dir / "manifest.txt").read_bytes()
        sig_before = dxf_signature(cli_dir / "real_container.dxf")
        status, raw = req("POST", f"/api/jobs/{CLI_JOB_ID}/toolpaths", {}, timeout=120)
        tp202 = json.loads(raw) if raw else {}
        check("POST toolpaths -> 202 running",
              status == 202 and tp202.get("ok") is True
              and tp202.get("job", {}).get("status") == "running",
              f"status={status} body={str(tp202)[:300]}")
        tpfinal = wait_for_status(CLI_JOB_ID, timeout=300)
        check("toolpaths run completes",
              tpfinal.get("status") == "complete",
              f"status={tpfinal.get('status')} error={tpfinal.get('error')}")
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        job = body.get("job") or {}
        tp = job.get("toolpaths") or {}
        stats = tp.get("stats") or {}
        check("toolpaths: job is v3, 14 ops / 220 moves (66 rapid, 86 feed, 68 arc)",
              job.get("job_version") == 3
              and stats.get("operations") == 14 and stats.get("moves") == 220
              and stats.get("rapid") == 66 and stats.get("feed") == 86
              and stats.get("arc") == 68,
              f"version={job.get('job_version')} stats={stats}")
        check("toolpaths: no loops skipped on the reference container",
              tp.get("skipped") == [], f"skipped={tp.get('skipped')}")
        check("toolpaths: per-operation moves sum to 220",
              sum(len(o.get("moves") or []) for o in tp.get("operations") or []) == 220,
              str([len(o.get("moves") or []) for o in tp.get("operations") or []]))
        check("toolpaths: manifest.txt unchanged (gadget contract frozen)",
              (cli_dir / "manifest.txt").read_bytes() == manifest_before)
        check("toolpaths: DXF unchanged by canonical signature",
              dxf_signature(cli_dir / "real_container.dxf") == sig_before)
        check("toolpaths: manifest.json is job.json (v3, byte-identical)",
              (cli_dir / "manifest.json").read_bytes()
              == (cli_dir / "job.json").read_bytes())
        status, val = get_json(f"/api/jobs/{CLI_JOB_ID}/validate")
        check("GET validate on v3 job -> ok, version 3, has toolpaths",
              status == 200 and val.get("ok") is True
              and val.get("job_version") == 3 and val.get("has_toolpaths") is True,
              f"status={status} {str(val)[:200]}")
        status, body = get_json("/api/jobs")
        entry = next((j for j in body.get("jobs", []) if j["id"] == CLI_JOB_ID), None)
        tps = (entry.get("summary") or {}).get("toolpaths") or {}
        check("list summary carries toolpaths (14 ops, 220 moves, no skips)",
              tps.get("operations") == 14 and tps.get("moves") == 220
              and tps.get("skipped") == [], str(tps)[:300])
        # Re-generating toolpaths on a v3 job is idempotent.
        tp_bytes = json.dumps(tp, indent=2, sort_keys=True)
        status, raw = req("POST", f"/api/jobs/{CLI_JOB_ID}/toolpaths", {}, timeout=120)
        check("POST toolpaths again -> 202 running",
              status == 202, f"status={status} body={str(raw)[:200]}")
        tpfinal = wait_for_status(CLI_JOB_ID, timeout=300)
        check("second toolpaths run completes",
              tpfinal.get("status") == "complete",
              f"status={tpfinal.get('status')} error={tpfinal.get('error')}")
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        check("re-generated toolpaths are identical",
              json.dumps((body.get("job") or {}).get("toolpaths") or {},
                         indent=2, sort_keys=True) == tp_bytes)
        # Rerun of the v3 job reproduces the toolpaths byte-for-byte.
        status, raw = req("POST", f"/api/jobs/{CLI_JOB_ID}/rerun", {}, timeout=600)
        rerun3 = json.loads(raw) if raw else {}
        check("POST rerun on v3 job -> 200 ok",
              status == 200 and rerun3.get("ok") is True,
              f"status={status} body={str(rerun3)[:300]}")
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        job3 = body.get("job") or {}
        check("rerun reproduces identical toolpaths",
              json.dumps(job3.get("toolpaths") or {}, indent=2, sort_keys=True)
              == tp_bytes,
              f"version={job3.get('job_version')}")
        check("rerun keeps the job v3", job3.get("job_version") == 3)
        # CLI: `mldxf job` shows the toolpaths summary.
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "job", str(cli_dir)],
            capture_output=True, text=True, env=env, timeout=60)
        check("mldxf job shows the toolpaths summary",
              "toolpaths (v3, plan A, clearance 14.5 mm): 14 operations, 220 moves" in r.stdout
              and "no loops skipped" in r.stdout,
              r.stdout[:400])
        # ---- 9a. V3.14 cut-time feedback -------------------------------
        # The toolpaths section carries the motion time measured from
        # the toolpaths (222.3 s on this reference container — the
        # Nov 25-26, 2026 layout change moved the parts +1.35 mm,
        # lengthening the rapid traverses; acceptance §6.1 records
        # the frozen 221.7 s and is untouched as history), and a
        # rerun of the v3 job keeps it.
        check("toolpaths: motion_time_s present (222.3 s)",
              abs((tp.get("motion_time_s") or -1) - 222.3) < 0.15,
              f"motion_time_s={tp.get('motion_time_s')}")
        mbt = tp.get("motion_by_tool") or {}
        mbo = tp.get("motion_by_operation") or {}
        check("toolpaths: motion breakdowns present and sum to the total",
              abs(sum(mbt.values()) - 222.3) < 0.3
              and abs(sum(mbo.values()) - 222.3) < 0.3,
              f"by_tool={mbt} by_operation={mbo}")
        tp3 = job3.get("toolpaths") or {}
        check("toolpaths: rerun kept the motion time (222.3 s)",
              abs((tp3.get("motion_time_s") or -1) - 222.3) < 0.15,
              f"motion_time_s={tp3.get('motion_time_s')}")
        # `mldxf job` shows the plan estimate next to the motion time.
        check("mldxf job shows motion time and plan estimate side by side",
              "motion time (measured from the toolpaths): 222.3 s" in r.stdout
              and "plan estimate (Plan A):" in r.stdout
              and "motion time is the toolpath clock, not a machine measurement" in r.stdout,
              r.stdout[:600])
        # report.md carries the Toolpaths (V3.14) section, once.
        report = (cli_dir / "report.md").read_text()
        check("report.md carries the Toolpaths (V3.14) section with motion",
              "## Toolpaths (V3.14)" in report
              and "motion time (measured from the toolpaths): 222.3 s" in report
              and report.count("## Toolpaths (V3.14)") == 1,
              report[report.find("## Toolpaths"):report.find("## Toolpaths") + 400])
        # cuttime recomputation agrees with the recorded motion.
        r = subprocess.run(
            [BUN, str(REPO / "ts" / "cuttime.ts"), str(cli_dir), "--json"],
            capture_output=True, text=True, cwd=REPO, timeout=60)
        cut = json.loads(r.stdout) if r.stdout.strip() else {}
        check("cuttime recomputation equals the recorded motion (222.3 s)",
              r.returncode == 0 and cut.get("ok") is True
              and abs(cut.get("motion_time_s", -1) - 222.3) < 0.15,
              r.stdout[:300])
        # A pre-V3.14 v3 job (toolpaths without motion) gains motion
        # on rerun, and the report section appears exactly once.
        pre_dir = jobs_root / "v314-pre"
        if pre_dir.exists():
            shutil.rmtree(pre_dir)
        shutil.copytree(cli_dir, pre_dir)
        pre_path = pre_dir / "job.json"
        pre_job = json.loads(pre_path.read_text())
        for k in ("motion_time_s", "motion_by_tool", "motion_by_operation"):
            (pre_job.get("toolpaths") or {}).pop(k, None)
        pre_job["job_id"] = "v314-pre"
        pre_path.write_text(json.dumps(pre_job, indent=2, sort_keys=True))
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "rerun", str(pre_dir)],
            capture_output=True, text=True, env=env, timeout=600)
        check("rerun on a pre-V3.14 v3 job -> 0 ok", r.returncode == 0,
              (r.stdout + r.stderr)[-800:])
        pre_job2 = json.loads((pre_dir / "job.json").read_text())
        check("pre-V3.14 rerun gains motion_time_s (222.3 s)",
              abs(((pre_job2.get("toolpaths") or {}).get("motion_time_s") or -1) - 222.3) < 0.15,
              str((pre_job2.get("toolpaths") or {}).get("motion_time_s")))
        pre_report = (pre_dir / "report.md").read_text()
        check("pre-V3.14 rerun report has exactly one Toolpaths section",
              pre_report.count("## Toolpaths (V3.14)") == 1,
              f"count={pre_report.count('## Toolpaths (V3.14)')}")
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "sim", "--verify", str(cli_dir), "--json"],
            capture_output=True, text=True, env=env, timeout=120)
        sim_body = json.loads(r.stdout) if r.stdout.strip() else {}
        sim = (sim_body.get("job") or {}).get("sim") or {}
        # V3.5: checkpoints is the delta-log index (was null in
        # V3.4) — the file, format, move count, and chunk/byte
        # totals must agree with the job and the file on disk.
        # This is the --auto --material 160x90x10 CLI job (14 ops /
        # 220 moves). Its sim stock is the geometry bounds
        # (131.05x67.35), NOT the full 160x90 sheet the --auto-only
        # reference job sims against — same moves, same chunk
        # boundaries, but fewer grid columns, so fewer bytes
        # (34984980, not the reference job's 39528444).
        cps = sim.get("checkpoints") or {}
        check("mldxf sim --verify passes and writes the sim section",
              r.returncode == 0 and sim_body.get("ok") is True
              and sim.get("pitch_mm") == 0.05
              and sim.get("pitch_coarse") is False
              and isinstance(cps, dict)
              and cps.get("file") == "sim/delta.bin"
              and cps.get("format") == 1
              and cps.get("moves") == 220
              and cps.get("chunks") == 8
              and cps.get("bytes") == 34984980
              and cps.get("checkpoints") == [
                  {"chunk": -1, "move": 0, "time_s": 0},
                  {"chunk": 7, "move": 220, "time_s": 222.341819113929},
              ],
              r.stdout[:300])
        check("sim writes the delta log the index points at",
              (cli_dir / "sim" / "delta.bin").is_file()
              and (cli_dir / "sim" / "delta.bin").stat().st_size
              == (cps.get("bytes") or -1),
              str(cps.get("bytes")))
        check("sim keeps manifest.json byte-identical to job.json",
              (cli_dir / "job.json").read_bytes()
              == (cli_dir / "manifest.json").read_bytes())

        # V3.6 G-code: the CLI posts (default Masso-mm) against the
        # recorded sim stock, and the API posts a second post
        # (masso-inch) — each verified, each recorded, each
        # downloadable with bytes matching its recorded sha.
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(cli_dir), "--json"],
            capture_output=True, text=True, env=env, timeout=120)
        gc_body = json.loads(r.stdout) if r.stdout.strip() else {}
        gc_job = gc_body.get("job") or {}
        gc_entries = gc_job.get("gcode") or []
        gc_mm = next((e for e in gc_entries if e.get("post_id") == "masso-mm"), None)
        gc_mm_file = cli_dir / (gc_mm.get("file") if gc_mm else "missing")
        check("mldxf gcode posts Masso-mm, verified, entry recorded",
              r.returncode == 0 and gc_body.get("ok") is True
              and gc_mm is not None and gc_mm.get("verified") is True
              and gc_mm.get("file") == f"gcode/{CLI_JOB_ID}-masso-mm.nc"
              and (gc_body.get("roundtrip") or {}).get("verified") is True
              and (gc_body.get("roundtrip") or {}).get("mismatched") == 0,
              r.stdout[:300])
        check("posted .nc exists and its sha256 matches the entry",
              gc_mm_file.is_file()
              and hashlib.sha256(gc_mm_file.read_bytes()).hexdigest() == (gc_mm or {}).get("sha256"),
              str(gc_mm)[:200])
        check("gcode keeps manifest.json byte-identical to job.json",
              (cli_dir / "job.json").read_bytes()
              == (cli_dir / "manifest.json").read_bytes())
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "job", str(cli_dir)],
            capture_output=True, text=True, env=env, timeout=60)
        check("mldxf job lists the gcode run (verified)",
              "gcode (1 run(s)):" in r.stdout
              and f"masso-mm: gcode/{CLI_JOB_ID}-masso-mm.nc (verified" in r.stdout,
              r.stdout[:500])
        status, raw = req("POST", f"/api/jobs/{CLI_JOB_ID}/gcode",
                          {"post": "masso-inch"}, timeout=120)
        gc202 = json.loads(raw) if raw else {}
        check("POST gcode (masso-inch) -> 202 running",
              status == 202 and gc202.get("ok") is True
              and gc202.get("job", {}).get("status") == "running",
              f"status={status} body={str(gc202)[:300]}")
        gcfinal = wait_for_status(CLI_JOB_ID, timeout=300)
        check("API gcode run completes",
              gcfinal.get("status") == "complete",
              f"status={gcfinal.get('status')} error={gcfinal.get('error')}")
        status, body = get_json(f"/api/jobs/{CLI_JOB_ID}")
        job_g = body.get("job") or {}
        gc_in = next((e for e in job_g.get("gcode") or []
                      if e.get("post_id") == "masso-inch"), None)
        check("API gcode adds the masso-inch entry, verified",
              status == 200 and len(job_g.get("gcode") or []) == 2
              and gc_in is not None and gc_in.get("verified") is True
              and gc_in.get("file") == f"gcode/{CLI_JOB_ID}-masso-inch.nc",
              f"status={status} gcode={job_g.get('gcode')}")
        status, nc_bytes = req(
            "GET",
            f"/api/jobs/{CLI_JOB_ID}/download/gcode/{CLI_JOB_ID}-masso-inch.nc",
            timeout=60)
        check("GET download serves the posted .nc, bytes match the recorded sha",
              status == 200
              and hashlib.sha256(nc_bytes).hexdigest() == (gc_in or {}).get("sha256"),
              f"status={status} len={len(nc_bytes)}")
        status, body = get_json("/api/jobs")
        entry = next((j for j in body.get("jobs", []) if j["id"] == CLI_JOB_ID), None)
        gcs = (entry.get("summary") or {}).get("gcode") or []
        check("list summary carries gcode (2 runs, both verified)",
              len(gcs) == 2 and all(e.get("verified") is True for e in gcs)
              and {e.get("post_id") for e in gcs} == {"masso-mm", "masso-inch"},
              str(gcs)[:300])

        # V3.3 geometry: GET /api/jobs/:id/geometry on the v3 job.
        status, geo = get_json(f"/api/jobs/{CLI_JOB_ID}/geometry")
        check("GET geometry on v3 job -> 200, 8 layers",
              status == 200 and geo.get("ok") is True
              and len(geo.get("layers") or []) == 8,
              f"status={status} {str(geo)[:200]}")
        by_name = {l["layer"]: l for l in geo.get("layers") or []}
        check("geometry: pocket D1.50 Z 9.5 -> 8.0, 3 loops",
              by_name.get("P01_P01__POCKET_D1.50", {}).get("z_top_mm") == 9.5
              and by_name.get("P01_P01__POCKET_D1.50", {}).get("z_bottom_mm") == 8.0
              and by_name.get("P01_P01__POCKET_D1.50", {}).get("loop_count") == 3,
              str(by_name.get("P01_P01__POCKET_D1.50"))[:200])
        check("geometry: drill START1.50 Z 8.0 -> 6.45, 8 loops",
              by_name.get("P01_P01__DRILL_D2.25_D1.55_START1.50", {}).get("z_top_mm") == 8.0
              and by_name.get("P01_P01__DRILL_D2.25_D1.55_START1.50", {}).get("z_bottom_mm") == 6.45
              and by_name.get("P01_P01__DRILL_D2.25_D1.55_START1.50", {}).get("loop_count") == 8,
              str(by_name.get("P01_P01__DRILL_D2.25_D1.55_START1.50"))[:200])
        check("geometry: profiles bottom at Z 0",
              by_name.get("P01_P01__PROFILE_THRU", {}).get("z_bottom_mm") == 0
              and by_name.get("P02_P02__PROFILE_THRU", {}).get("z_bottom_mm") == 0,
              str({k: by_name.get(k, {}).get("z_bottom_mm")
                   for k in ("P01_P01__PROFILE_THRU", "P02_P02__PROFILE_THRU")}))
        check("geometry: bounds x 21.35-131.05, y 21.35-67.35, z 0-9.5",
              geo.get("bounds") == {"x_min": 21.35, "x_max": 131.05,
                                    "y_min": 21.35, "y_max": 67.35,
                                    "z_min": 0, "z_max": 9.5},
              str(geo.get("bounds")))
        check("geometry: every loop's points are finite [x, y] pairs",
              all(isinstance(l.get("loops"), list)
                  and all(isinstance(loop.get("points"), list)
                          and len(loop["points"]) >= 2
                          and all(isinstance(p, list) and len(p) == 2
                                  and all(isinstance(c, (int, float)) for c in p)
                                  for p in loop["points"])
                          for loop in l["loops"])
                  for l in geo.get("layers") or []),
              "a layer carries a malformed loop")
        check("geometry: CLI `mldxf geometry` agrees with the API",
              json.loads(subprocess.run(
                  [VENV_PY, str(REPO / "mldxf.py"), "geometry", str(cli_dir), "--json"],
                  capture_output=True, text=True, env=env, timeout=60).stdout
              ).get("layers") == geo.get("layers"),
              "CLI and API geometry differ")
        status, geo404 = get_json("/api/jobs/does-not-exist-123/geometry")
        check("GET geometry on unknown job -> 404 job_not_found",
              status == 404 and geo404.get("error") == "job_not_found",
              f"status={status} {str(geo404)[:200]}")
        status, geo1 = get_json(f"/api/jobs/{V1_JOB_ID}/geometry")
        check("GET geometry on v1 job -> 400 geometry_unavailable",
              status == 400 and geo1.get("error") == "geometry_unavailable",
              f"status={status} {str(geo1)[:200]}")

        # ---- 4e. post-processor config + verification stamp (V3.8) -----
        # machine.json names the post (grbl here — the home is a
        # throwaway init home, so editing it directly is the test);
        # the CLI honors it with no --post; an unknown post is a
        # named refusal; over-limit moves are refused, not clamped;
        # `mldxf gcode --verify` re-verifies the recorded file and
        # flips a stale verified stamp to false; the Preferences
        # choice mirrors into machine.json; the served app.js
        # carries the real dropdowns. A scratch copy of the CLI job
        # (profile post stripped) is the subject, so the CLI
        # fixture stays pristine.
        home_machine = HOME / "machine.json"
        mach = json.loads(home_machine.read_text())
        check("V3.8: shipped machine.json names post_processor masso-mm",
              mach.get("post_processor") == "masso-mm",
              str(mach.get("post_processor")))
        mach["post_processor"] = "grbl"
        home_machine.write_text(json.dumps(mach, indent=2, sort_keys=True))
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "machine", "validate", "--json"],
            capture_output=True, text=True, env=env, timeout=60)
        check("V3.8: machine.json with post_processor grbl validates",
              r.returncode == 0 and json.loads(r.stdout).get("ok") is True,
              r.stdout[:200])
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "machine", "show"],
            capture_output=True, text=True, env=env, timeout=60)
        check("V3.8: mldxf machine show prints the post processor",
              "post processor: grbl" in r.stdout, r.stdout[:300])
        v38_dir = jobs_root / "20261122-220002-v38-post"
        shutil.copytree(cli_dir, v38_dir)
        v38_job = json.loads((v38_dir / "job.json").read_text())
        v38_job["job_id"] = "20261122-220002-v38-post"
        v38_job["machine_profile"].pop("post_processor", None)
        (v38_dir / "job.json").write_text(
            json.dumps(v38_job, indent=2, sort_keys=True))
        (v38_dir / "manifest.json").write_text(
            json.dumps(v38_job, indent=2, sort_keys=True))
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(v38_dir), "--json"],
            capture_output=True, text=True, env=env, timeout=180)
        v38_body = json.loads(r.stdout) if r.stdout.strip() else {}
        check("V3.8: home machine.json post (grbl) honored with no --post",
              r.returncode == 0 and (v38_body.get("gcode") or {}).get("post_id") == "grbl"
              and (v38_body.get("gcode") or {}).get("verified") is True,
              r.stdout[:300])
        v38_job = json.loads((v38_dir / "job.json").read_text())
        check("V3.8: posted grbl recorded in the job profile + entry",
              v38_job.get("machine_profile", {}).get("post_processor") == "grbl"
              and any(e.get("post_id") == "grbl" and e.get("verified") is True
                      for e in v38_job.get("gcode") or []),
              str(v38_job.get("gcode"))[:300])
        grbl_nc = v38_dir / "gcode" / "20261122-220002-v38-post-grbl.nc"
        check("V3.8: posted grbl header states Z-zero top of material",
              grbl_nc.is_file()
              and "(Z-zero: TOP of material." in grbl_nc.read_text(),
              "grbl .nc missing or header lacks the Z-zero line")
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(v38_dir),
             "--post", "bogus", "--json"],
            capture_output=True, text=True, env=env, timeout=120)
        bogus = json.loads(r.stdout) if r.stdout.strip() else {}
        check("V3.8: unknown post refused (post_unknown, exit 1)",
              r.returncode == 1 and bogus.get("error") == "post_unknown",
              r.stdout[:200])
        v38_job = json.loads((v38_dir / "job.json").read_text())
        check("V3.8: refused unknown post wrote no entry",
              len(v38_job.get("gcode") or []) == 3,
              str(v38_job.get("gcode"))[:300])
        # Over-limit feed on a second scratch copy: refused, nothing
        # recorded. (The fixture ships with .nc files, so the check
        # is entries + bytes unchanged, not "no file exists".)
        over_dir = jobs_root / "20261122-220003-v38-overfeed"
        shutil.copytree(cli_dir, over_dir)
        over_job = json.loads((over_dir / "job.json").read_text())
        over_job["job_id"] = "20261122-220003-v38-overfeed"
        over_job["toolpaths"]["operations"][0]["feed_mm_s"] = 300.0
        (over_dir / "job.json").write_text(
            json.dumps(over_job, indent=2, sort_keys=True))
        (over_dir / "manifest.json").write_text(
            json.dumps(over_job, indent=2, sort_keys=True))
        over_before = (over_dir / "job.json").read_bytes()
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(over_dir),
             "--post", "masso-mm", "--json"],
            capture_output=True, text=True, env=env, timeout=120)
        over_body = json.loads(r.stdout) if r.stdout.strip() else {}
        check("V3.8: over-limit feed refused (post_limit_exceeded, exit 1)",
              r.returncode == 1
              and over_body.get("error") == "post_limit_exceeded",
              r.stdout[:300])
        check("V3.8: refused over-limit post wrote nothing",
              (over_dir / "job.json").read_bytes() == over_before,
              "job.json changed under a refused post")
        # Re-verify: happy path writes nothing; a hand-corrupted
        # file is refused and its stamp flips to false.
        v38_before = (v38_dir / "job.json").read_bytes()
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(v38_dir),
             "--verify", "--post", "grbl", "--json"],
            capture_output=True, text=True, env=env, timeout=180)
        check("V3.8: --verify on the recorded grbl file exits 0",
              r.returncode == 0 and json.loads(r.stdout).get("ok") is True,
              r.stdout[:300])
        check("V3.8: clean --verify leaves job.json bytes untouched",
              (v38_dir / "job.json").read_bytes() == v38_before,
              "job.json changed under a clean re-verification")
        with open(grbl_nc, "a", encoding="utf-8") as f:
            f.write("G1 X0 Y0 Z-99.000 (tampered line)\n")
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(v38_dir),
             "--verify", "--post", "grbl", "--json"],
            capture_output=True, text=True, env=env, timeout=180)
        corrupt = json.loads(r.stdout) if r.stdout.strip() else {}
        check("V3.8: hand-corrupted file refused (gcode_sha_mismatch, exit 1)",
              r.returncode == 1
              and corrupt.get("error") == "gcode_sha_mismatch",
              r.stdout[:300])
        v38_job = json.loads((v38_dir / "job.json").read_text())
        grbl_entry = next((e for e in v38_job.get("gcode") or []
                           if e.get("post_id") == "grbl"), None)
        check("V3.8: corrupted file's stamp flips to verified:false",
              grbl_entry is not None and grbl_entry.get("verified") is False,
              str(v38_job.get("gcode"))[:300])
        status, body = get_json("/api/jobs/20261122-220002-v38-post")
        api_grbl = next((e for e in (body.get("job") or {}).get("gcode") or []
                         if e.get("post_id") == "grbl"), None)
        check("V3.8: API serves the flipped stamp (UNVERIFIED data)",
              status == 200 and api_grbl is not None
              and api_grbl.get("verified") is False,
              f"status={status} {str(body.get('job', {}).get('gcode'))[:200]}")
        # Toolpaths moved after posting: identical bytes, round-trip
        # now fails — the stamp must flip the same way.
        moved_dir = jobs_root / "20261122-220004-v38-moved"
        shutil.copytree(cli_dir, moved_dir)
        moved_job = json.loads((moved_dir / "job.json").read_text())
        moved_job["job_id"] = "20261122-220004-v38-moved"
        for op in moved_job["toolpaths"]["operations"]:
            if op["operation"] in ("pocket", "profile"):
                for mv in op["moves"]:
                    if mv["t"] == "feed":
                        mv["x"] = mv["x"] + 5.0
                        break
                else:
                    continue
                break
        (moved_dir / "job.json").write_text(
            json.dumps(moved_job, indent=2, sort_keys=True))
        (moved_dir / "manifest.json").write_text(
            json.dumps(moved_job, indent=2, sort_keys=True))
        r = subprocess.run(
            [VENV_PY, str(REPO / "mldxf.py"), "gcode", str(moved_dir),
             "--verify", "--post", "masso-mm", "--json"],
            capture_output=True, text=True, env=env, timeout=180)
        moved_body = json.loads(r.stdout) if r.stdout.strip() else {}
        check("V3.8: toolpaths moved after posting refused (gcode_unverified)",
              r.returncode == 1
              and moved_body.get("error") == "gcode_unverified",
              r.stdout[:300])
        moved_job = json.loads((moved_dir / "job.json").read_text())
        check("V3.8: moved-toolpaths stamp flips to verified:false",
              any(e.get("post_id") == "masso-mm"
                  and e.get("verified") is False
                  for e in moved_job.get("gcode") or []),
              str(moved_job.get("gcode"))[:300])
        # Preferences mirror: a native post choice lands in
        # machine.json; a VCarve post name does not touch it.
        status, prefs_body = get_json("/api/preferences")
        prefs = (prefs_body.get("preferences") or {})
        prefs_orig_pp = (prefs.get("vcarve") or {}).get("post_processor")
        prefs["vcarve"]["post_processor"] = "template"
        status, saved_raw = req("PUT", "/api/preferences", prefs)
        saved = json.loads(saved_raw) if saved_raw else {}
        check("V3.8: PUT preferences with post template -> 200",
              status == 200 and saved.get("ok") is True,
              f"status={status} {str(saved)[:200]}")
        status, mach_body = get_json("/api/machine")
        check("V3.8: Preferences post mirrors into machine.json",
              status == 200
              and (mach_body.get("machine") or {}).get("post_processor") == "template",
              f"status={status} {str(mach_body)[:200]}")
        prefs["vcarve"]["post_processor"] = "Onefinity Masso (inch) Latest V6"
        status, saved_raw = req("PUT", "/api/preferences", prefs)
        saved = json.loads(saved_raw) if saved_raw else {}
        status, mach_body = get_json("/api/machine")
        check("V3.8: Preferences VCarve name leaves machine.json alone",
              status == 200
              and (mach_body.get("machine") or {}).get("post_processor") == "template",
              f"status={status} {str(mach_body)[:200]}")
        prefs["vcarve"]["post_processor"] = prefs_orig_pp
        status, saved_raw = req("PUT", "/api/preferences", prefs)
        saved = json.loads(saved_raw) if saved_raw else {}
        check("V3.8: preferences restored after the mirror checks",
              status == 200 and saved.get("ok") is True,
              f"status={status} {str(saved)[:200]}")
        # The served UI carries the real dropdowns (source-level:
        # the DOM harness does not load app.js, so the served bytes
        # plus the save-path loop above are the coverage).
        status, app_js_raw = req("GET", "/public/app.js")
        app_js = app_js_raw.decode("utf-8", "replace") if isinstance(app_js_raw, bytes) else app_js_raw
        check("V3.8: served app.js offers the four native posts",
              status == 200
              and all(f'"{pid}"' in app_js
                      for pid in ("masso-mm", "masso-inch", "grbl", "template"))
              and "data-role" in app_js and "machine-post" in app_js
              and "Not set — pick a post" in app_js,
              f"status={status} len={len(app_js)}")

        # ---- list again --------------------------------------------------
        status, body = get_json("/api/jobs")
        jobs = body.get("jobs", []) if body.get("ok") else []
        ids = {j["id"] for j in jobs}
        expect = {CLI_JOB_ID, V1_JOB_ID, WH_JOB_ID} | ({ui_id} if ui_id else set())
        check("list still contains every fixture + the UI job",
              expect <= ids, f"ids={sorted(ids)}")
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        logf.close()

    print(f"\nV2.8 HTTP replay: {len(PASSES)} pass, {len(FAILURES)} fail", flush=True)
    for f in FAILURES:
        print(f"  FAIL {f}", flush=True)
    return len(FAILURES)


if __name__ == "__main__":
    sys.exit(main())
