#!/usr/bin/env python3
"""Verification for V2.8 (Jobs tab: list + rerun + 2D layout preview).

Starts the server via `bun run server/server.ts` against a throwaway
MLDXF_HOME and checks, in order:

  1. GET /api/jobs lists a real v2 job created via the CLI, a v2 job
     created via the UI, and a v1 job fixture — newest first, with
     the plan summary (Plan A tools/time, parts, layers) and status.
  2. GET /api/jobs/:id on the v2 CLI job: layout P01 (20,20) /
     P02 (83.7,20), material 150x90x10, clamp margin 20,
     workholding null, Plan A 3 tools / 7.0 min.
  3. GET /api/jobs/:id on the v1 job: job_version 1, same layout,
     no outputs list — the UI's read-only case.
  4. GET /api/jobs/:id on the synthetic workholding job (a copy of
     the v2 CLI job whose job.json carries a V2.9-shaped workholding
     section — the clamp-marker path cannot be fed by the CLI until
     V2.9 lands): two clamps at (10,45) and (140,45).
  5. POST /api/jobs/:id/rerun on the v1 job -> 400 rerun_unavailable.
  6. A job created via the UI (multipart POST /api/jobs, auto on)
     completes with Plan A 3 tools / 7.0 min and the same layout.
  7. Downloads serve the job's outputs (DXF, manifest.txt,
     report.md, zip — the zip validated with Python's zipfile),
     for the v2 job and the v1 job.
  8. POST /api/jobs/:id/rerun on the v2 CLI job reproduces it in
     place: 200 ok, created_at changes, plan totals identical, DXF
     identical by canonical entity+layer signature (ezdxf bytes are
     nondeterministic, V2_SCOPE.md §8 Q4).

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

    # v2 job via the CLI (real container, --auto, 150x90x10).
    cli_dir = jobs_root / CLI_JOB_ID
    r = subprocess.run(
        [VENV_PY, str(REPO / "mldxf.py"), "plan", str(CONTAINER_STEP),
         "-o", str(cli_dir), "--auto", "--material", "150x90x10", "--json"],
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
        check("v2 list summary: Plan A 3 tools, 2 changes, 7.0 min",
              plan.get("id") == "A" and len(plan.get("tools") or []) == 3
              and plan.get("tool_changes") == 2 and plan.get("minutes") == 7.0,
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
        check("v2 layout: P01 at (20,20) 46x46",
              by_name.get("P01_P01", {}).get("x_mm") == 20.0
              and by_name.get("P01_P01", {}).get("y_mm") == 20.0
              and by_name.get("P01_P01", {}).get("w_mm") == 46.0
              and by_name.get("P01_P01", {}).get("d_mm") == 46.0,
              str(layout))
        check("v2 layout: P02 at (83.7,20) 46x46",
              by_name.get("P02_P02", {}).get("x_mm") == 83.7
              and by_name.get("P02_P02", {}).get("y_mm") == 20.0,
              str(layout))
        check("v2 material 150x90x10, clamp margin 20, workholding null",
              job.get("material") == {"x": 150.0, "y": 90.0, "thickness": 10.0}
              and job.get("clamp_margin_mm") == 20.0
              and job.get("workholding") is None,
              f"material={job.get('material')} margin={job.get('clamp_margin_mm')} "
              f"wh={job.get('workholding')}")
        plans = (job.get("tool_plan") or {}).get("plans") or []
        check("v2 Plan A: 3 tools, 418.8 s (7.0 min)",
              plans and plans[0].get("total_seconds") == 418.8
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
        check("v1 layout matches the v2 layout",
              v1job.get("layout") == layout, str(v1job.get("layout")))
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
        # blue boxes are bounding rectangles, not the part shape.
        # The HTTP harness cannot render the DOM, so these are
        # source-level regression checks on the preview builder
        # (the live Chromium verification covers the rendered
        # preview); the API half above proves the job really
        # carries the layout the preview draws.
        check("preview re-draws the usable-area boundary over the parts",
              "usable-area-top" in preview_fn
              and preview_fn.index("usable-area-top")
              > preview_fn.index("'data-role': 'part'"),
              "no usable-area-top re-draw after the part rects")
        check("preview caption says parts are bounding rectangles",
              "parts shown as bounding rectangles" in preview_fn,
              "caption does not name the boxes as bounding rectangles")

        # ---- 5. rerun v1 -> rerun_unavailable --------------------------
        status, raw = req("POST", f"/api/jobs/{V1_JOB_ID}/rerun", {})
        body = json.loads(raw) if raw else {}
        check("POST rerun on v1 job -> 400 rerun_unavailable",
              status == 400 and body.get("error") == "rerun_unavailable",
              f"status={status} body={str(body)[:300]}")

        # ---- 6. job via the UI ------------------------------------------
        ui_body, ui_headers = multipart_step(
            CONTAINER_STEP, {"auto": "true", "material": "150x90x10"})
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
            check("UI job Plan A: 3 tools, 418.8 s (7.0 min)",
                  ui_plans and ui_plans[0].get("total_seconds") == 418.8
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
            check("rerun plan totals identical (418.8 s, 3 tools)",
                  plans2 and plans2[0].get("total_seconds")
                  == (plan_before[0].get("total_seconds") if plan_before else None)
                  and len(plans2[0].get("tools") or []) == 3, str(plans2[:1]))
            check("rerun layout identical",
                  job2.get("layout") == layout, str(job2.get("layout")))
            sig_after = dxf_signature(cli_dir / "real_container.dxf")
            check("rerun DXF identical by canonical signature",
                  sig_after == sig_before, f"before={sig_before[:80]} after={sig_after[:80]}")

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
