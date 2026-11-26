#!/usr/bin/env python3
"""Joint end-to-end verification for V2 wave 3 (V2.4 + V2.6 + V2.7).

Drives the integrated UI the way a user would, through the live server:
  1. GET / serves the shell (with the job-prep script wired in).
  2. Edit a library value through the API exactly as the Tools tab does
     (PUT /api/tools) — add EM3.17 + D2.25 as owned — and confirm the
     CLI sees them.
  3. Run the real container STEP through the UI flow (multipart upload
     + auto=true, as job-prep.js sends it), follow status to completion.
  4. Confirm the plan (Plan A 3 tools / 7.7 min), owned flags, and the
     workholding note in the fetched job.
  5. Download DXF + manifest.txt + report.md + zip; check the zip.
  6. Run the same STEP through `mldxf plan` (CLI) and compare the two
     job dirs: manifest ignoring created_at/job_id + the nondeterministic
     outputs hashes (scope §8 Q4), DXF by canonical signature.

Usage: python3 verify_v23_joint.py [--port N] [--keep]
Exit code = number of failed checks. Leaves the throwaway home under
/tmp/mldxf-v23-joint-home (and the jobs) unless --keep is given a path.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent
STEP = REPO / "test" / "real_container.step"
PORT = int(os.environ.get("V23_PORT", "3141"))
BASE = f"http://127.0.0.1:{PORT}"

failures = 0


def check(label, cond, detail=""):
    global failures
    print(f"  {'PASS' if cond else 'FAIL'} {label}"
          + ("" if cond or not detail else f" :: {detail}"))
    if not cond:
        failures += 1


def http(method, path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_json(path):
    status, raw = http("GET", path)
    return status, json.loads(raw.decode())


def put_json(path, obj):
    status, raw = http("PUT", path, json.dumps(obj).encode(),
                       {"Content-Type": "application/json"})
    return status, json.loads(raw.decode())


def wait_for_health(proc, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            status, _ = http("GET", "/api/health")
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def multipart_step(step_path, fields):
    """Build a multipart body with the STEP in the `step` field."""
    boundary = "----v23jointboundary"
    buf = io.BytesIO()
    for key, value in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        buf.write(f"{value}\r\n".encode())
    data = step_path.read_bytes()
    buf.write(f"--{boundary}\r\n".encode())
    buf.write(f'Content-Disposition: form-data; name="step"; '
              f'filename="{step_path.name}"\r\n'.encode())
    buf.write(b"Content-Type: application/octet-stream\r\n\r\n")
    buf.write(data)
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return buf.getvalue(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def canonical_dxf_signature(path):
    sys.path.insert(0, str(REPO))
    import mldxf_dxf
    try:
        return mldxf_dxf.dxf_signature(path)
    except ImportError:
        # ezdxf lives in the repo venv, not system python.
        venv_python = REPO / ".venv" / "bin" / "python"
        r = subprocess.run(
            [str(venv_python), "-c",
             "import sys; sys.path.insert(0, %r); import mldxf_dxf; "
             "print(mldxf_dxf.dxf_signature(%r))" % (str(REPO), str(path))],
            capture_output=True, text=True, check=True)
        return r.stdout.strip()


def compare_jobs(ui_job_dir, cli_job_dir):
    """Compare two job dirs the way scope §8 Q4 allows: job.json
    identical except created_at/job_id and the outputs sha256 of
    nondeterministic files; DXF by canonical signature; manifest.txt
    byte-identical; report.md identical except the run's own paths."""
    ui = json.loads((ui_job_dir / "job.json").read_text())
    cli = json.loads((cli_job_dir / "job.json").read_text())
    for key in ("created_at", "job_id"):
        ui.pop(key, None)
        cli.pop(key, None)
    # outputs: keep filenames only — sha256 of nondeterministic files
    # (DXF, exported STEPs, per-part manifests) differs per run.
    for job in (ui, cli):
        job["outputs"] = sorted(
            (o.get("file") or o.get("path") or o.get("name") or o)
            if isinstance(o, dict) else o
            for o in job.get("outputs", []))
    # source_step differs (upload copy vs the repo path) — the sha256
    # is the identity check.
    ui.pop("source_step", None)
    cli.pop("source_step", None)
    same_manifest = ui == cli
    if not same_manifest:
        for key in sorted(set(ui) | set(cli)):
            if ui.get(key) != cli.get(key):
                print(f"    job.json differs at key: {key}")
    check("UI job vs CLI job: job.json identical (modulo created_at/job_id, "
          "outputs hashes, source_step path)", same_manifest)
    ui_txt = (ui_job_dir / "manifest.txt").read_text()
    cli_txt = (cli_job_dir / "manifest.txt").read_text()
    check("UI job vs CLI job: manifest.txt byte-identical", ui_txt == cli_txt)
    dxf_name = next(
        (o.get("file") for o in (json.loads((ui_job_dir / "job.json").read_text())
                                 .get("outputs", []))
         if isinstance(o, dict) and o.get("file", "").endswith(".dxf")
         and "/" not in o["file"]),
        "job.dxf")
    ui_sig = canonical_dxf_signature(ui_job_dir / dxf_name)
    cli_sig = canonical_dxf_signature(cli_job_dir / dxf_name)
    check("UI job vs CLI job: DXF identical by canonical signature",
          ui_sig == cli_sig)


def main():
    home = Path(tempfile.mkdtemp(prefix="mldxf-v23-joint-home-"))
    env = dict(os.environ, MLDXF_HOME=str(home))
    print(f"home: {home}")
    # 0. init the home from the shipped examples (as a first run does).
    r = subprocess.run([sys.executable, "mldxf.py", "init"], cwd=REPO,
                       env=env, capture_output=True, text=True)
    check("mldxf init creates the home from examples", r.returncode == 0,
          r.stderr[-300:] if r.returncode else "")

    server = subprocess.Popen(
        ["bun", "run", "server/server.ts", "--port", str(PORT)],
        cwd=REPO, env=env, stdout=open("/tmp/v23-joint-server.log", "wb"),
        stderr=subprocess.STDOUT)
    try:
        check("server starts and answers /api/health",
              wait_for_health(server), "server died — see /tmp/v23-joint-server.log")

        # 1. The shell, with job-prep wired in.
        status, raw = http("GET", "/")
        shell = raw.decode()
        check("GET / serves the app shell", status == 200 and "tab-nav" in shell)
        check("shell links a favicon (no 404 on load)",
              'rel="icon"' in shell, "no favicon link in the shell")
        check("shell loads job-prep.js before app.js",
              shell.index("job-prep.js") < shell.index("app.js"))
        status, _ = http("GET", "/public/job-prep.js")
        check("GET /public/job-prep.js serves the module", status == 200)

        # 2. Library edit exactly as the Tools tab does it.
        status, tools = get_json("/api/tools")
        check("GET /api/tools ok", status == 200 and tools.get("ok"))
        entries = tools["tools"]["tools"]
        v_before = tools["tools"]["version"]
        by_id = {t["id"]: t for t in entries}
        for tool_id, label in (("EM3.17", "1/8in"), ("D2.25", "2.25 mm")):
            if tool_id not in by_id:
                base = dict(by_id["EM6.35"])
                base.update({"id": tool_id,
                             "dia_mm": 3.17 if tool_id == "EM3.17" else 2.25,
                             "kind": "endmill" if tool_id.startswith("EM") else "drill",
                             "native_label": label,
                             "notes": "added by joint verification"})
                entries.append(base)
        status, saved = put_json("/api/tools", {"tools": entries})
        check("PUT /api/tools saves (validate-then-save)",
              status == 200 and saved.get("ok"), str(saved)[:200])
        check("tools version bumped on save",
              saved.get("tools", {}).get("version") == v_before + 1,
              f"was {v_before}, now {saved.get('tools', {}).get('version')}")
        r = subprocess.run([sys.executable, "mldxf.py", "tools", "list", "--json"],
                           cwd=REPO, env=env, capture_output=True, text=True)
        cli_tools = json.loads(r.stdout)
        ids = {t["id"] for t in cli_tools["tools"]["tools"]}
        check("CLI sees the tools the UI saved",
              {"EM3.17", "D2.25"} <= ids, f"CLI ids: {sorted(ids)}")

        # 3. Run the real container through the UI flow.
        body, headers = multipart_step(STEP, {"auto": "true"})
        status, raw = http("POST", "/api/jobs", body, headers)
        created = json.loads(raw.decode()) if raw else {}
        job_id = created.get("job_id") or created.get("job", {}).get("job_id")
        check("POST /api/jobs (multipart + auto) returns 202 + job id",
              status == 202 and bool(job_id), f"status {status}: {str(created)[:200]}")
        if not job_id:
            return failures
        print(f"job: {job_id}")
        deadline = time.time() + 600
        job_status = None
        while time.time() < deadline:
            status, st = get_json(f"/api/jobs/{job_id}/status")
            job_status = st.get("status")
            if job_status in ("complete", "failed", "interrupted", "cancelled"):
                break
            time.sleep(5)
        check("UI run completes", job_status == "complete",
              f"final status: {job_status}")

        # 4. The fetched job: plan, owned flags, workholding note.
        status, job = get_json(f"/api/jobs/{job_id}")
        check("GET /api/jobs/:id ok", status == 200 and job.get("ok"))
        manifest = job.get("job", {})
        plans = (manifest.get("tool_plan") or {}).get("plans") or []
        plan_a = plans[0] if plans else {}
        minutes = plan_a.get("total_seconds", 0) / 60.0
        check("Plan A is 3 tools / 7.7 min (auto) (V3.14 calibrated)",
              len(plan_a.get("tools", [])) == 3 and abs(minutes - 7.7) < 0.05,
              f"got {len(plan_a.get('tools', []))} tools / {minutes:.1f} min")
        owned = {t["id"]: t.get("owned") for t in plan_a.get("tools", [])}
        check("Plan A tools all owned after the library edit",
              owned == {"EM3.17": True, "D2.25": True, "EM6.35": True},
              f"owned: {owned}")
        check("workholding is null (V2.9, not invented)",
              manifest.get("workholding") is None)
        ui_job_dir = home / "jobs" / job_id

        # 5. Downloads. The DXF is named after the STEP stem (v1 naming —
        # real_container.dxf), not job.dxf: download it by its outputs name.
        outputs = manifest.get("outputs") or []
        if not outputs:
            outputs = json.loads((ui_job_dir / "job.json").read_text()).get("outputs", [])
        dxf_name = next(
            (o["file"] for o in outputs
             if isinstance(o, dict) and o.get("file", "").endswith(".dxf")
             and "/" not in o["file"]),
            None)
        check("job outputs name the DXF", bool(dxf_name), str(dxf_name))
        for name in ([dxf_name] if dxf_name else []) + ["manifest.txt", "report.md"]:
            status, raw = http("GET", f"/api/jobs/{job_id}/download/{name}")
            check(f"download {name} served", status == 200 and len(raw) > 0,
                  f"status {status}")
        status, raw = http("GET", f"/api/jobs/{job_id}/download/zip")
        ok_zip = False
        if status == 200:
            try:
                ok_zip = zipfile.ZipFile(io.BytesIO(raw)).testzip() is None
            except zipfile.BadZipFile:
                ok_zip = False
        check("download zip served and valid", ok_zip, f"status {status}")
        report = (ui_job_dir / "report.md").read_text()
        check("report.md carries the inventory section",
              "## Tool inventory (advisory" in report)

        # 6. CLI parity: same STEP, same home, same --auto.
        cli_out = home / "jobs" / "cli-parity"
        r = subprocess.run(
            [sys.executable, "mldxf.py", "plan", str(STEP), "-o", str(cli_out),
             "--auto", "--json"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=600)
        check("CLI run of the same STEP succeeds", r.returncode == 0,
              r.stderr[-300:] if r.returncode else "")
        if r.returncode == 0:
            compare_jobs(ui_job_dir, cli_out)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
    print(f"\n{failures} failed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
