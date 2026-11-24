#!/usr/bin/env python3
"""Verification for V2.5 (Bun local server + JSON API).

Starts the server via `mldxf serve` (testing cmd_serve too) against
a throwaway MLDXF_HOME and checks, in order:

  1. library CRUD round-trips through the API and is readable by the
     CLI; an invalid T-track slot is refused by the PUT with the
     CLI's named error and the file on disk is unchanged.
  2. API/CLI parity on the real container STEP: a job created via
     POST /api/jobs and the same job via `mldxf plan` on the same
     STEP+config produce identical job dirs (manifest.json compared
     with source_step/outdir paths normalised; DXF by canonical
     entity+layer signature, the run_suite_cli.py approach — ezdxf
     bytes are nondeterministic, V2_SCOPE.md §8 Q4).
  3. GET /api/jobs/:id equals `mldxf job --json` for the same job.
  4. Downloads serve the job's outputs (DXF, manifest.txt,
     report.md, zip — the zip validated with Python's zipfile).
  5. Interrupted-job marking: a job dir with no job.json /
     manifest.json lists as interrupted; killing the server (and
     the CLI run, as a reboot would) mid-Kookabus-run leaves the
     job interrupted after restart, re-runnable from its inputs.
     The list is scoped to this home: a retained entry recorded
     under a foreign home never appears in it.
  6. Cancel: a Kookabus run is cancelled via the API; the CLI
     subprocess is dead and the job is interrupted.
  7. Rerun: POST /api/jobs/:id/rerun on a v1 job passes the CLI's
     rerun_unavailable error through faithfully, and on the v2
     parity job it reproduces the job (same DXF geometry after the
     rerun as before).

Usage: python3 server/verify_v25.py [--port N]
Logs to stdout; exit code = number of failed checks (0 = all pass).
The server log goes to server/verify_v25.log. The test home lives
under /tmp/mldxf-v25-verify-home (recreated each run).
"""
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO = Path("/home/hatch/workspace/multi_layer_dxf")
VENV_PY = str(REPO / ".venv" / "bin" / "python")
BUN = "/opt/hatch-image/bin/bun"
HOME = Path("/tmp/mldxf-v25-verify-home")
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 3117
BASE = f"http://127.0.0.1:{PORT}"
LOG = REPO / "server" / "verify_v25.log"
CONTAINER_STEP = REPO / "test" / "real_container.step"
KOOKABUS_STEP = REPO / "test" / "external" / "kookabus-03-enclosure.step"

PASSES: list[str] = []
FAILURES: list[str] = []


def check(label, cond, detail=""):
    if cond:
        PASSES.append(label)
        print(f"  PASS {label}", flush=True)
    else:
        FAILURES.append(f"{label} :: {detail}")
        print(f"  FAIL {label} :: {detail}", flush=True)


def req(method, path, body=None, raw=False, timeout=30):
    data = None
    headers = {}
    if body is not None:
        data = body if raw else json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, payload
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jreq(method, path, body=None, timeout=30):
    status, payload = req(method, path, body, timeout=timeout)
    try:
        return status, json.loads(payload)
    except (ValueError, TypeError):
        return status, {"_raw": payload[:300].decode("utf-8", "replace")}


def wait_for(cond, timeout, interval=2, label=""):
    deadline = time.monotonic() + timeout
    last_exc = None
    while time.monotonic() < deadline:
        try:
            got = cond()
        except Exception as e:  # e.g. connection refused while starting
            last_exc = e
            got = None
        if got:
            return got
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {label}: {last_exc}")


# ---------------------------------------------------------------- DXF signature
# Same approach as ~/workspace/v21-verification/run_suite_cli.py
# _dxf_signature: sorted modelspace entities (layer, type, rounded
# geometry) + sorted layer names, hashed. DXF bytes are NOT
# reproducible (ezdxf timestamps/GUIDs), geometry is.

def dxf_signature(path):
    code = (
        "import ezdxf, hashlib, sys\n"
        "doc = ezdxf.readfile(sys.argv[1])\n"
        "ents = []\n"
        "for e in doc.modelspace():\n"
        "    d = e.dxf; t = e.dxftype()\n"
        "    if t == 'CIRCLE':\n"
        "        ents.append((d.layer, t, round(d.center.x,4), round(d.center.y,4), round(d.radius,4)))\n"
        "    elif t == 'LINE':\n"
        "        ents.append((d.layer, t, round(d.start.x,4), round(d.start.y,4), round(d.end.x,4), round(d.end.y,4)))\n"
        "    elif t == 'ARC':\n"
        "        ents.append((d.layer, t, round(d.center.x,4), round(d.center.y,4), round(d.radius,4), round(d.start_angle,4), round(d.end_angle,4)))\n"
        "    elif t == 'LWPOLYLINE':\n"
        "        ents.append((d.layer, t, tuple((round(x,4), round(y,4)) for x,y in e.get_points('xy'))))\n"
        "    else:\n"
        "        ents.append((d.layer, t))\n"
        "layers = sorted(l.dxf.name for l in doc.layers)\n"
        "print(hashlib.sha256((chr(10).join(map(str, sorted(map(str, ents)))) + chr(10).join(layers)).encode()).hexdigest())\n"
    )
    r = subprocess.run([VENV_PY, "-c", code, str(path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"dxf signature failed for {path}: {r.stderr[-300:]}")
    return r.stdout.strip()


def normalized_bytes(path, outdir, step_path):
    """File bytes with run-specific values blanked: the run's own
    outdir, and the source STEP path (API run uses the uploaded
    copy, CLI run uses the repo path). For exported STEP files,
    blank the FILE_NAME timestamp (export_step writes now). For
    job.json / manifest.json (v2), blank created_at and job_id
    (each run's own) and the sha256 of .dxf/.step outputs entries
    (ezdxf bytes and exported STEP timestamps are nondeterministic
    — the geometry is compared by signature instead, §8 Q4)."""
    text = path.read_bytes()
    if path.suffix == ".json":
        data = json.loads(text)
        if isinstance(data.get("source_step"), str):
            data["source_step"] = data["source_step"].replace(
                str(outdir), "<job-dir>").replace(str(step_path), "<step>")
        data.pop("created_at", None)
        data.pop("job_id", None)
        outputs = data.get("outputs")
        if isinstance(outputs, list):
            for entry in outputs:
                if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
                    continue
                fname = entry["file"]
                if fname.endswith((".dxf", ".step")):
                    entry["sha256"] = "<nondeterministic>"
                elif fname.endswith(".json"):
                    # Per-part manifests (parts/*/manifest.json) embed
                    # the run's own outdir path in source_step, so
                    # their raw bytes (and hence sha256) differ
                    # run-to-run even though the normalized contents
                    # are identical — the files themselves are
                    # compared normalized below, so the hash adds
                    # nothing here.
                    entry["sha256"] = "<path-dependent>"
        return json.dumps(data, indent=2, sort_keys=True).encode()
    if path.suffix == ".step":
        lines = text.decode("utf-8", "replace").splitlines()
        lines = [ln for ln in lines
                 if not ln.strip().startswith("FILE_NAME(")]
        return "\n".join(lines).encode()
    return (text.decode("utf-8", "replace")
            .replace(str(outdir), "<job-dir>")
            .replace(str(step_path), "<step>").encode())


def compare_job_dirs(api_dir, cli_dir, api_step, cli_step, label):
    api_files = sorted(p.relative_to(api_dir) for p in api_dir.rglob("*") if p.is_file())
    cli_files = sorted(p.relative_to(cli_dir) for p in cli_dir.rglob("*") if p.is_file())
    check(f"{label}: same output file set", api_files == cli_files,
          f"only-api={set(api_files)-set(cli_files)} only-cli={set(cli_files)-set(api_files)}")
    ok = api_files == cli_files
    for rel in api_files:
        if rel not in cli_files:
            continue
        ap, cp = api_dir / rel, cli_dir / rel
        if rel.suffix == ".dxf":
            try:
                same = dxf_signature(ap) == dxf_signature(cp)
            except RuntimeError as e:
                check(f"{label}: dxf signature {rel}", False, str(e))
                return False
            check(f"{label}: geometrically identical {rel}", same, "entities/layers differ")
            ok = ok and same
        else:
            same = (normalized_bytes(ap, api_dir, api_step)
                    == normalized_bytes(cp, cli_dir, cli_step))
            check(f"{label}: identical {rel}", same,
                  "bytes differ after path/timestamp normalisation")
            ok = ok and same
    return ok


def cli(*args, timeout=1200):
    env = dict(os.environ, MLDXF_HOME=str(HOME))
    r = subprocess.run([VENV_PY, str(REPO / "mldxf.py"), *args],
                       capture_output=True, text=True, env=env, timeout=timeout)
    return r


def pgrep(pattern):
    r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
    return [ln for ln in r.stdout.splitlines() if ln.strip()]


def main():
    logf = open(LOG, "w")
    print("V2.5 verification — server + API parity", flush=True)
    print(f"home={HOME} port={PORT} log={LOG}", flush=True)
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(Path("/tmp/mldxf-server"), ignore_errors=True)
    r = cli("init", "--json")
    check("init test home", r.returncode == 0 and json.loads(r.stdout)["ok"], r.stderr[-300:])
    if r.returncode != 0:
        print("cannot init home; aborting", flush=True)
        return 1

    env = dict(os.environ, MLDXF_HOME=str(HOME))
    # Start via `mldxf serve` — this also exercises cmd_serve.
    server = subprocess.Popen(
        [VENV_PY, str(REPO / "mldxf.py"), "serve", "--port", str(PORT)],
        env=env, stdout=logf, stderr=subprocess.STDOUT,
        start_new_session=True)
    try:
        wait_for(lambda: jreq("GET", "/api/health")[0] == 200, 60, 1, "health")
        status, health = jreq("GET", "/api/health")
        check("health via mldxf serve", status == 200 and health.get("service") == "mldxf-server",
              str(health)[:200])
        check("health home matches", health.get("home") == str(HOME), str(health.get("home")))

        # ---- libraries -------------------------------------------------
        print("libraries", flush=True)
        status, tools = jreq("GET", "/api/tools")
        check("GET /api/tools", status == 200 and tools["ok"] and len(tools["tools"]["tools"]) == 5,
              f"status={status} {str(tools)[:200]}")
        tools_body = tools["tools"]
        tools_body["tools"].append({"id": "EM12.70", "kind": "endmill",
                                    "dia_mm": 12.7, "native_label": "1/2in",
                                    "notes": "verify tool"})
        status, saved = jreq("PUT", "/api/tools", tools_body)
        check("PUT /api/tools valid (version bumped 1->2)",
              status == 200 and saved["ok"] and saved["tools"]["version"] == 2
              and len(saved["tools"]["tools"]) == 6,
              f"status={status} {str(saved)[:300]}")
        r = cli("tools", "list", "--json")
        cli_tools = json.loads(r.stdout)["tools"]
        check("CLI reads the API-saved tools",
              cli_tools["version"] == 2 and
              any(t["id"] == "EM12.70" for t in cli_tools["tools"]),
              r.stdout[:200])
        status, machine = jreq("GET", "/api/machine")
        before = hashlib.sha256((HOME / "machine.json").read_bytes()).hexdigest()
        bad = json.loads(json.dumps(machine["machine"]))
        bad["t_track"]["slots"][0]["at_y_mm"] = 99999.0
        status, refused = jreq("PUT", "/api/machine", bad)
        after = hashlib.sha256((HOME / "machine.json").read_bytes()).hexdigest()
        check("PUT /api/machine invalid slot refused with CLI named error",
              status == 400 and refused.get("error") == "config_error"
              and "outside the bed" in refused.get("message", ""),
              f"status={status} {str(refused)[:300]}")
        check("refused PUT left machine.json unchanged", before == after)
        status, prefs = jreq("GET", "/api/preferences")
        check("GET /api/preferences", status == 200 and prefs["ok"]
              and prefs["preferences"]["clamp_margin_mm"] == 20,
              f"status={status} {str(prefs)[:200]}")
        prefs_body = prefs["preferences"]
        prefs_body["clamp_margin_mm"] = 25
        status, saved_prefs = jreq("PUT", "/api/preferences", prefs_body)
        check("PUT /api/preferences saves",
              status == 200 and saved_prefs["ok"]
              and saved_prefs["preferences"]["clamp_margin_mm"] == 25,
              f"status={status} {str(saved_prefs)[:200]}")
        status, prefs2 = jreq("GET", "/api/preferences")
        check("preferences round-trip (GET after PUT)",
              prefs2["preferences"]["clamp_margin_mm"] == 25)
        # restore the example value so later runs see defaults
        prefs_body["clamp_margin_mm"] = 20
        jreq("PUT", "/api/preferences", prefs_body)
        status, clamps = jreq("GET", "/api/clamps")
        check("GET /api/clamps", status == 200 and clamps["ok"],
              f"status={status}")
        # bare-list PUT form for clamps
        status, saved_clamps = jreq("PUT", "/api/clamps", clamps["clamps"]["clamps"])
        check("PUT /api/clamps bare-list form accepted",
              status == 200 and saved_clamps["ok"]
              and saved_clamps["clamps"]["version"] == 2,
              f"status={status} {str(saved_clamps)[:200]}")

        # ---- parity: API job vs CLI job, real container ----------------
        print("parity: POST /api/jobs (real_container.step)", flush=True)
        with open(CONTAINER_STEP, "rb") as f:
            step_bytes = f.read()
        boundary = "----mldxf-verify-boundary"
        multipart = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="step"; filename="real_container.step"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + step_bytes + f"\r\n--{boundary}--\r\n".encode()
        req_obj = urllib.request.Request(
            BASE + "/api/jobs", method="POST", data=multipart,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req_obj, timeout=30) as resp:
            created = json.loads(resp.read())
            create_status = resp.status
        check("POST /api/jobs returns 202 + job id",
              create_status == 202 and created["ok"]
              and created["job"]["status"] == "running",
              f"status={create_status} {str(created)[:300]}")
        api_job_id = created["job"]["job_id"]
        api_dir = Path(created["job"]["job_dir"])
        # In-flight runs must appear in the list even though V2.2's
        # atomic write means the job dir does not exist yet.
        def api_listed_running():
            s, b = jreq("GET", "/api/jobs", timeout=10)
            entry = next((j for j in b.get("jobs", [])
                          if j["id"] == api_job_id), None)
            return entry if entry and entry.get("status") == "running" else None
        listed = wait_for(api_listed_running, 30, 2, "API job listed as running")
        check("in-flight job appears in GET /api/jobs as running",
              listed is not None and listed["status"] == "running",
              str(listed)[:300])
        # SSE check while the run is in flight.
        sse = subprocess.run(["curl", "-s", "--max-time", "8",
                              f"{BASE}/api/jobs/{api_job_id}/events"],
                             capture_output=True, text=True, timeout=30)
        check("SSE progress stream answers with data lines",
              "data:" in sse.stdout and "event: status" in sse.stdout,
              sse.stdout[:200] or sse.stderr[:200])

        def api_done():
            s, b = jreq("GET", f"/api/jobs/{api_job_id}/status", timeout=10)
            return b if s == 200 and b.get("status") in ("complete", "failed") else None
        final = wait_for(api_done, 900, 5, f"API job {api_job_id}")
        check("API container job completes", final["status"] == "complete",
              str(final.get("error"))[:300])
        check("API job dir has manifest.json",
              (api_dir / "manifest.json").is_file())
        api_step = Path(f"/tmp/mldxf-server/uploads/{api_job_id}/real_container.step")

        print("parity: mldxf plan (same STEP, same defaults)", flush=True)
        cli_dir = Path("/tmp/mldxf-v25-verify-cli-job")
        shutil.rmtree(cli_dir, ignore_errors=True)
        r = cli("plan", str(CONTAINER_STEP), "-o", str(cli_dir), "--json")
        check("CLI container job rc==0", r.returncode == 0, r.stderr[-500:])
        compare_job_dirs(api_dir, cli_dir, api_step, CONTAINER_STEP, "parity")

        status, api_job = jreq("GET", f"/api/jobs/{api_job_id}")
        r = cli("job", str(api_dir), "--json")
        cli_job = json.loads(r.stdout)["job"] if r.returncode == 0 else None
        check("GET /api/jobs/:id job equals mldxf job --json",
              status == 200 and api_job.get("job") == cli_job,
              f"status={status} cli_rc={r.returncode}")

        # ---- downloads ---------------------------------------------------
        print("downloads", flush=True)
        status, payload = req("GET", f"/api/jobs/{api_job_id}/download/manifest.txt")
        check("download manifest.txt",
              status == 200 and payload == (api_dir / "manifest.txt").read_bytes(),
              f"status={status}")
        status, payload = req("GET", f"/api/jobs/{api_job_id}/download/report.md")
        check("download report.md",
              status == 200 and payload == (api_dir / "report.md").read_bytes(),
              f"status={status}")
        dxf_name = next(p.name for p in api_dir.glob("*.dxf"))
        status, payload = req("GET", f"/api/jobs/{api_job_id}/download/{dxf_name}")
        check(f"download {dxf_name}",
              status == 200 and len(payload) > 0, f"status={status}")
        status, payload = req("GET", f"/api/jobs/{api_job_id}/download/zip")
        zip_path = Path("/tmp/mldxf-v25-verify.zip")
        zip_path.write_bytes(payload)
        try:
            with zipfile.ZipFile(zip_path) as z:
                names = sorted(z.namelist())
                bad = z.testzip()
            expected = sorted(str(p.relative_to(api_dir))
                              for p in api_dir.rglob("*") if p.is_file())
            check("download zip is valid and holds the whole job dir",
                  status == 200 and bad is None and names == expected,
                  f"status={status} bad={bad} names={names} expected={expected}")
        except zipfile.BadZipFile as e:
            check("download zip is valid", False, str(e))
        status, refused_dl = jreq("GET", f"/api/jobs/{api_job_id}/download/../mldxf.py")
        check("download refuses path traversal",
              status in (400, 404), f"status={status}")
        status, refused_dl = jreq("GET", f"/api/jobs/{api_job_id}/download/inputs")
        check("download refuses non-output names",
              status in (400, 403, 404), f"status={status} {str(refused_dl)[:200]}")

        # ---- interrupted: fake empty dir ---------------------------------
        print("interrupted marking", flush=True)
        fake = HOME / "jobs" / "20200101-000000-fake"
        fake.mkdir(parents=True, exist_ok=True)
        status, listing = jreq("GET", "/api/jobs")
        fake_entry = next((j for j in listing["jobs"] if j["id"] == "20200101-000000-fake"), None)
        check("job dir with no manifest lists as interrupted",
              fake_entry is not None and fake_entry["status"] == "interrupted",
              str(fake_entry)[:300])

        # ---- interrupted: kill server mid-Kookabus-run -------------------
        print("interrupted: kill server mid-run (Kookabus)", flush=True)
        status, created2 = jreq("POST", "/api/jobs",
                                {"step_path": str(KOOKABUS_STEP)}, timeout=30)
        check("POST /api/jobs JSON step_path accepted",
              status == 202 and created2["ok"], f"status={status} {str(created2)[:200]}")
        kook_id = created2["job"]["job_id"]

        def kook_running():
            s, b = jreq("GET", f"/api/jobs/{kook_id}/status", timeout=10)
            return b if s == 200 and b.get("status") == "running" and b.get("pid") else None
        running = wait_for(kook_running, 120, 2, "kookabus run starts")
        kook_pid = running["pid"]
        print(f"  kookabus run {kook_id} pid={kook_pid}, "
              f"{len(running['progress'])} progress lines", flush=True)
        time.sleep(10)  # let the classifier get properly underway
        # Machine-reboot simulation: kill the server AND the CLI run.
        # The Bun server runs in its own process group since the wave-2
        # serve fix (start_new_session), so killing the serve process
        # group alone leaves Bun holding the port and the restart dies
        # with EADDRINUSE. Kill every child process group of the
        # serve process too (the Bun server is its direct child).
        def child_pids(pid):
            out = []
            for d in Path("/proc").iterdir():
                if not d.name.isdigit():
                    continue
                try:
                    stat = (d / "stat").read_text().split()
                    if int(stat[3]) == pid:
                        out.append(int(d.name))
                except (OSError, ValueError, IndexError):
                    pass
            return out

        bun_children = child_pids(server.pid)
        os.killpg(os.getpgid(server.pid), signal.SIGKILL)
        for cpid in bun_children:
            try:
                os.killpg(cpid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.killpg(kook_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(2)
        check("CLI subprocess is dead after the kill",
              not pgrep(f"mldxf.py.*{kook_id}") and not pgrep(str(kook_pid)),
              str(pgrep(str(kook_pid))))
        # Home scoping (V2.11): plant a retained entry for a FOREIGN
        # home in the shared index while the server is down. It must
        # NOT appear in this home's list after the restart, while
        # this home's own killed run still does. The foreign entry's
        # step must exist, or the startup prune drops it first.
        foreign_id = "19000101-000000-foreign-home-job"
        state_file = Path("/tmp/mldxf-server/server-state.json")
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        state[foreign_id] = {
            "stepPath": str(KOOKABUS_STEP),
            "options": {"auto": True},
            "startedAt": "2026-01-01T00:00:00.000Z",
            "home": "/tmp/mldxf-foreign-verify-home",
        }
        state_file.write_text(json.dumps(state, indent=2))
        # Restart the server (direct bun this time — the serve path
        # was already proven above) and re-scan.
        server = subprocess.Popen(
            [BUN, "run", "server.ts", "--port", str(PORT)],
            cwd=str(REPO / "server"),
            env=env, stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True)
        wait_for(lambda: jreq("GET", "/api/health")[0] == 200, 60, 1, "health after restart")
        status, listing = jreq("GET", "/api/jobs")
        kook_entry = next((j for j in listing["jobs"] if j["id"] == kook_id), None)
        check("killed run lists as interrupted after restart",
              kook_entry is not None and kook_entry["status"] == "interrupted",
              str(kook_entry)[:300])
        check("interrupted job is re-runnable from retained inputs",
              bool(kook_entry and kook_entry.get("can_rerun_from_inputs")),
              str(kook_entry)[:300])
        check("foreign-home retained job is NOT listed in this home",
              next((j for j in listing["jobs"] if j["id"] == foreign_id), None) is None,
              f"ids={[j['id'] for j in listing['jobs']]}")
        # Re-run it from its inputs, then cancel the new run quickly
        # (proves the re-run path starts a real run; the full
        # Kookabus run is not needed twice).
        status, rerun = jreq("POST", f"/api/jobs/{kook_id}/rerun", {}, timeout=30)
        check("rerun of interrupted job re-plans from retained inputs",
              status == 202 and rerun.get("rerun_from_inputs") is True,
              f"status={status} {str(rerun)[:300]}")
        new_id = rerun["job"]["job_id"]

        def new_running():
            s, b = jreq("GET", f"/api/jobs/{new_id}/status", timeout=10)
            return b if s == 200 and b.get("status") == "running" and b.get("pid") else None
        running2 = wait_for(new_running, 120, 2, "re-run starts")
        status, cancelled = jreq("POST", f"/api/jobs/{new_id}/cancel", {}, timeout=30)
        check("cancel of the re-run is accepted",
              status == 200 and cancelled.get("status") == "interrupted"
              and cancelled.get("cancelled") is True,
              f"status={status} {str(cancelled)[:300]}")

        def new_done():
            s, b = jreq("GET", f"/api/jobs/{new_id}/status", timeout=10)
            return b if s == 200 and b.get("status") == "interrupted" else None
        wait_for(new_done, 60, 2, "re-run marked interrupted")
        check("cancelled CLI subprocess is dead",
              not pgrep(f"mldxf.py.*{new_id}"),
              str(pgrep(f"mldxf.py.*{new_id}")))

        # ---- cancel: fresh Kookabus run ----------------------------------
        print("cancel: fresh Kookabus run", flush=True)
        status, created3 = jreq("POST", "/api/jobs",
                                {"step_path": str(KOOKABUS_STEP)}, timeout=30)
        kook2_id = created3["job"]["job_id"]

        def kook2_running():
            s, b = jreq("GET", f"/api/jobs/{kook2_id}/status", timeout=10)
            return b if s == 200 and b.get("status") == "running" and b.get("pid") else None
        running3 = wait_for(kook2_running, 120, 2, "second kookabus run starts")
        kook2_pid = running3["pid"]
        print(f"  kookabus run {kook2_id} pid={kook2_pid}", flush=True)
        time.sleep(5)
        status, cancelled2 = jreq("POST", f"/api/jobs/{kook2_id}/cancel", {}, timeout=60)
        check("POST cancel returns interrupted+cancelled",
              status == 200 and cancelled2.get("status") == "interrupted"
              and cancelled2.get("cancelled") is True,
              f"status={status} {str(cancelled2)[:300]}")
        try:
            os.kill(kook2_pid, 0)
            pid_alive = True
        except ProcessLookupError:
            pid_alive = False
        check("cancelled CLI subprocess pid is dead", not pid_alive,
              f"pid {kook2_pid} still alive")
        check("no orphan pipeline process for the cancelled job",
              not pgrep(f"mldxf.py.*{kook2_id}"),
              str(pgrep(f"mldxf.py.*{kook2_id}")))

        # ---- rerun passthrough on a v1 job -------------------------------
        # (v1 jobs live in the repo's test/*_out dirs; use the
        # container one — read-only, rerun must refuse it.)
        print("rerun passthrough (v1 job)", flush=True)
        v1_dir = REPO / "test" / "container_out"
        # The v1 dir is outside the jobs root, so the API cannot see
        # it by id; exercise the CLI error name through the API on a
        # v1 job dir copied under the jobs root instead.
        v1_copy = HOME / "jobs" / "20200102-000000-v1-container"
        if v1_copy.exists():
            shutil.rmtree(v1_copy)
        shutil.copytree(v1_dir, v1_copy)
        status, rerun_v1 = jreq("POST", "/api/jobs/20200102-000000-v1-container/rerun",
                                {}, timeout=60)
        check("rerun of a v1 job passes rerun_unavailable through",
              status == 400 and rerun_v1.get("error") == "rerun_unavailable",
              f"status={status} {str(rerun_v1)[:300]}")
        r = cli("rerun", str(v1_copy), "--json")
        cli_rerun = json.loads(r.stdout) if r.stdout.strip() else {}
        check("API rerun error matches the CLI rerun error",
              cli_rerun.get("error") == "rerun_unavailable"
              and rerun_v1.get("error") == cli_rerun.get("error"),
              r.stdout[:300] + r.stderr[-200:])

        # ---- rerun of the v2 parity job (reproduces in place) ----------
        print("rerun (v2 job)", flush=True)
        sig_before = dxf_signature(api_dir / dxf_name)
        status, rerun_v2 = jreq("POST", f"/api/jobs/{api_job_id}/rerun", {},
                                timeout=900)
        check("rerun of a v2 job succeeds through the API",
              status == 200 and rerun_v2.get("ok") is True,
              f"status={status} {str(rerun_v2)[:400]}")
        sig_after = dxf_signature(api_dir / dxf_name)
        check("rerun reproduces the same DXF geometry",
              sig_before == sig_after, f"{sig_before} vs {sig_after}")
        r = cli("job", str(api_dir), "--json")
        check("job still reads after rerun",
              r.returncode == 0
              and json.loads(r.stdout)["job"].get("job_version") == 2,
              r.stdout[:200] + r.stderr[-200:])
    finally:
        try:
            os.killpg(os.getpgid(server.pid), signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(server.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            server.wait(timeout=10)
        logf.close()

    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed", flush=True)
    for f in FAILURES:
        print(f"  FAILED: {f}", flush=True)
    return len(FAILURES)


if __name__ == "__main__":
    raise SystemExit(main())
