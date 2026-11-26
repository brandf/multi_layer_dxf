#!/usr/bin/env python3
"""V2.4 verification — inventory-aware plan display (V2_SCOPE.md §4.4).

Runs the real container STEP (test/real_container.step) through
`mldxf plan` against throwaway MLDXF_HOMEs and checks:

  1. test inventory (EM6.35 owned; EM3.17, D2.25 not owned): job.json
     carries owned booleans on every plan's tools (Plan A EM3.17 /
     D2.25 false, EM6.35 true), `mldxf job` shows owned first with
     the not-owned warning, report.md carries the inventory section.
  2. empty inventory: Plan A is exactly the no-inventory numbers
     (3 tools / 7.7 min / 464.1 s — V3.14 cut-time feedback; V1's
     were 7.0 min / 418.8 s), all tools owned:false, no ranking
     change — job.json's v1 keys (owned stripped), manifest.txt,
     report.md (inventory section stripped) and the DXF (canonical
     signature) all match a fresh direct-v1 run; the report says
     plainly that no inventory is recorded instead of alarming
     about every tool.
  3. rerun: after the live tools.json is changed to own everything,
     `mldxf rerun` on the test-inventory job keeps the same owned
     flags and the same report inventory section (snapshot-derived).
  4. a plan needing an unowned tool is flagged, never dropped, never
     failed (rc 0, complete job dir).
  5. a v1 job (no owned field) shows no owned info in `mldxf job`.

Usage: python3 verify_v24.py [--workdir DIR]
Work (homes + job dirs) goes under DIR (default /tmp/v24-<timestamp>);
the path is printed so the evidence survives the run. Exit code is
the number of failed checks (0 = all green). Stdlib only; the CLI
runs the pipeline under the repo venv itself. No git push, no
release, nothing leaves the local machine.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent
VENV_PY = str(REPO / ".venv" / "bin" / "python")
CLI = [sys.executable, str(REPO / "mldxf.py")]
STEP = "test/real_container.step"
PASSES = []
FAILURES = []


def check(label, cond, detail=""):
    if cond:
        PASSES.append(label)
        print(f"  PASS {label}", flush=True)
    else:
        FAILURES.append(f"{label} :: {detail}")
        print(f"  FAIL {label} :: {detail}", flush=True)


def run(argv, cwd=REPO, env=None):
    r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                       env=env)
    return r.returncode, r.stdout, r.stderr


def cli(home, *args):
    env = dict(os.environ)
    env["MLDXF_HOME"] = str(home)
    return run(CLI + list(args), env=env)


def load_json(path):
    return json.loads(Path(path).read_text())


def plan_a(job):
    return job["tool_plan"]["plans"][0]


def owned_flags(plan):
    return [(t["id"], t.get("owned")) for t in plan["tools"]]


def strip_owned(obj):
    """Deep copy of a manifest with every tool entry's 'owned' key
    removed, so a v2 job's v1 keys compare against a direct v1 run."""
    if isinstance(obj, dict):
        return {k: strip_owned(v) for k, v in obj.items()
                if k != "owned"}
    if isinstance(obj, list):
        return [strip_owned(v) for v in obj]
    return obj


V2_KEYS = {"job_version", "job_id", "cli_version", "created_at",
           "source_step_sha256", "inputs_embedded", "config_snapshot",
           "machine_profile", "workholding", "outputs",
           # Nov 26, 2026 (Z-zero): the job's Z-zero, recorded by
           # plan — a v2-era key, not a v1 manifest key.
           "z_zero"}


def v1_keys(job):
    return {k: strip_owned(v) for k, v in job.items() if k not in V2_KEYS}


def dxf_signature(dxf_path):
    rc, so, _ = run([VENV_PY, str(REPO / "mldxf_dxf.py"), str(dxf_path)])
    assert rc == 0, so
    return so.strip()


def make_home(home, tools_entries):
    home = Path(home)
    rc, so, se = cli(home, "init")
    assert rc == 0, f"mldxf init failed: {se}"
    tools = {"version": 1, "tools": tools_entries}
    (home / "tools.json").write_text(json.dumps(tools, indent=2) + "\n")
    rc, so, se = cli(home, "tools", "validate")
    assert rc == 0, f"tools validate failed: {se}"
    return home


EM635 = {"id": "EM6.35", "kind": "endmill", "dia_mm": 6.35,
         "native_label": "1/4in"}
EM317 = {"id": "EM3.17", "kind": "endmill", "dia_mm": 3.175,
         "native_label": "1/8in"}
D225 = {"id": "D2.25", "kind": "drill", "dia_mm": 2.25,
        "native_label": "2.25 mm"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=None)
    args = ap.parse_args()
    work = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(
        prefix="v24-verify-",
        dir="/tmp")) / "work"
    work.mkdir(parents=True, exist_ok=True)
    print(f"workdir: {work}", flush=True)

    # --- 1. test inventory: only EM6.35 owned -------------------------
    home_test = make_home(work / "home_test", [EM635])
    job_test = work / "job_test"
    t0 = datetime.datetime.now()
    rc, so_plan, se = cli(home_test, "plan", STEP, "-o", str(job_test),
                          "--auto")
    print(f"plan (test inventory) rc={rc} "
          f"in {(datetime.datetime.now() - t0).total_seconds():.0f}s",
          flush=True)
    check("T1 plan exits 0 despite unowned tools (flagged, not failed)",
          rc == 0, se[-500:])
    job = load_json(job_test / "job.json")
    pa = plan_a(job)
    check("T1 Plan A is EM3.17 + D2.25 + EM6.35, 3 tools, 2 changes, "
          "7.7 min",
          [t["id"] for t in pa["tools"]] == ["EM3.17", "D2.25", "EM6.35"]
          and len(pa["tools"]) == 3 and pa["tool_changes"] == 2
          and abs(pa["total_seconds"] / 60.0 - 7.7) < 0.05,
          json.dumps(owned_flags(pa)))
    check("T1 Plan A owned flags EM3.17 False, D2.25 False, EM6.35 True",
          owned_flags(pa) == [("EM3.17", False), ("D2.25", False),
                              ("EM6.35", True)],
          json.dumps(owned_flags(pa)))
    all_tools = [t for p in job["tool_plan"]["plans"]
                 for t in p["tools"]]
    check("T1 every tool in every plan carries a JSON boolean owned",
          all_tools and all(isinstance(t.get("owned"), bool)
                            for t in all_tools),
          f"{len(all_tools)} tools")
    check("T1 ranking untouched: Plan A 464.1 s, B 8.7 min, C 12.7 min",
          abs(pa["total_seconds"] - 464.1) < 0.01
          and abs(job["tool_plan"]["plans"][1]["total_seconds"] / 60.0
                  - 8.7) < 0.05
          and abs(job["tool_plan"]["plans"][2]["total_seconds"] / 60.0
                  - 12.7) < 0.05,
          [round(p["total_seconds"] / 60.0, 1)
           for p in job["tool_plan"]["plans"]])
    rc, so, se = cli(home_test, "job", str(job_test))
    plan_a_line = [ln for ln in so.splitlines()
                   if ln.strip().startswith("Plan A:")]
    check("T1 `mldxf job` shows owned first in Plan A",
          plan_a_line and plan_a_line[0].index("End Mill 1/4in")
          < plan_a_line[0].index("End Mill 1/8in"),
          plan_a_line)
    check("T1 `mldxf job` marks not-owned tools explicitly",
          "not in your inventory — check before you cut" in so, so[:400])
    check("T1 `mldxf job` flags unowned tools without dropping the plan",
          "flagged, not dropped" in so, so[:400])
    rc, so, se = cli(home_test, "job", "--json", str(job_test))
    jjob = json.loads(so)["job"] if rc == 0 else {}
    check("T1 `mldxf job --json` carries owned booleans (UI contract)",
          rc == 0 and owned_flags(plan_a(jjob)) ==
          [("EM3.17", False), ("D2.25", False), ("EM6.35", True)],
          so[:300])
    report = (job_test / "report.md").read_text()
    check("T1 report.md carries the inventory section",
          "## Tool inventory (advisory — never constraining)" in report,
          report[-800:])
    check("T1 report section shows owned first + the warning",
          "End Mill 1/4in (owned)" in report
          and "not in your inventory — check before you cut" in report,
          report[-800:])
    check("T1 plan summary (plan stdout) shows owned first + warning",
          "Plan A: End Mill 1/4in (owned) + End Mill 1/8in (not in "
          "your inventory — check before you cut) + Drill 2.25 mm "
          "(not in your inventory — check before you cut) — 3 tools, "
          "2 changes, 7.7 min" in so_plan, so_plan)

    # --- 2. empty inventory: exactly V1 -------------------------------
    home_empty = make_home(work / "home_empty", [])
    job_empty = work / "job_empty"
    t0 = datetime.datetime.now()
    rc, so, se = cli(home_empty, "plan", STEP, "-o", str(job_empty),
                     "--auto")
    print(f"plan (empty inventory) rc={rc} "
          f"in {(datetime.datetime.now() - t0).total_seconds():.0f}s",
          flush=True)
    check("T2 empty-inventory plan exits 0", rc == 0, se[-500:])
    job_e = load_json(job_empty / "job.json")
    pa_e = plan_a(job_e)
    check("T2 Plan A matches the no-inventory numbers: 3 tools / 7.7 min / 464.1 s",
          [t["id"] for t in pa_e["tools"]] ==
          ["EM3.17", "D2.25", "EM6.35"]
          and abs(pa_e["total_seconds"] - 464.1) < 0.01,
          json.dumps(owned_flags(pa_e)))
    check("T2 all tools owned:false with empty inventory",
          all(t.get("owned") is False for p in job_e["tool_plan"]["plans"]
              for t in p["tools"]),
          json.dumps([owned_flags(p)
                      for p in job_e["tool_plan"]["plans"]]))
    check("T2 plan summary is exactly the V1 string",
          "Plan A: End Mill 1/8in + Drill 2.25 mm + End Mill 1/4in — "
          "3 tools, 2 changes, 7.7 min" in so, so)
    report_e = (job_empty / "report.md").read_text()
    check("T2 report says plainly no inventory is recorded",
          "No tool inventory recorded yet (tools.json is empty)" in
          report_e, report_e[-800:])
    check("T2 report does not alarm about every tool",
          report_e.count("not in your inventory") == 0,
          f"count={report_e.count('not in your inventory')}")
    rc, so, se = cli(home_empty, "job", str(job_empty))
    check("T2 `mldxf job` says none recorded, does not flag each tool",
          "tool inventory: none recorded" in so
          and "not in your inventory" not in so, so)

    # --- 2b. direct-v1 parity for the empty-inventory job -------------
    direct = work / "direct_v1"
    t0 = datetime.datetime.now()
    rc, so, se = run([VENV_PY, str(REPO / "multi_part.py"), STEP,
                      "-o", str(direct), "--auto"])
    print(f"direct v1 run rc={rc} "
          f"in {(datetime.datetime.now() - t0).total_seconds():.0f}s",
          flush=True)
    check("T2b direct v1 run exits 0", rc == 0, se[-500:])
    direct_m = load_json(direct / "manifest.json")
    check("T2b job.json v1 keys equal direct v1 manifest (owned "
          "stripped)",
          v1_keys(job_e) == strip_owned(direct_m),
          "keys differ: " + ", ".join(
              sorted(set(v1_keys(job_e)) ^ set(strip_owned(direct_m)))) +
          " / value diffs: " + ", ".join(
              k for k in v1_keys(job_e)
              if k in strip_owned(direct_m)
              and v1_keys(job_e)[k] != strip_owned(direct_m)[k]))
    check("T2b manifest.txt byte-identical to direct v1",
          (job_empty / "manifest.txt").read_bytes() ==
          (direct / "manifest.txt").read_bytes())
    stripped = report_e.split("\n## Tool inventory (advisory")[0]
    check("T2b report.md equals direct v1 once the inventory section "
          "is stripped",
          stripped.encode() == (direct / "report.md").read_bytes(),
          f"len {len(stripped)} vs "
          f"{len((direct / 'report.md').read_bytes())}")
    check("T2b DXF canonical signature equals direct v1",
          dxf_signature(job_empty / "real_container.dxf") ==
          dxf_signature(direct / "real_container.dxf"))

    # --- 3. rerun: snapshot-derived flags survive a live change -------
    flags_before = [owned_flags(p) for p in job["tool_plan"]["plans"]]
    section_before = report.split(
        "## Tool inventory (advisory")[1]
    (home_test / "tools.json").write_text(json.dumps(
        {"version": 2, "tools": [EM635, EM317, D225]}, indent=2) + "\n")
    rc, so, se = cli(home_test, "tools", "validate")
    check("T3 live inventory changed to own everything (setup)",
          rc == 0, se)
    t0 = datetime.datetime.now()
    rc, so, se = cli(home_test, "rerun", str(job_test))
    print(f"rerun rc={rc} "
          f"in {(datetime.datetime.now() - t0).total_seconds():.0f}s",
          flush=True)
    check("T3 rerun exits 0", rc == 0, se[-500:])
    job_r = load_json(job_test / "job.json")
    check("T3 rerun keeps the same owned flags after the live "
          "inventory changed",
          [owned_flags(p) for p in job_r["tool_plan"]["plans"]] ==
          flags_before,
          json.dumps([owned_flags(p)
                      for p in job_r["tool_plan"]["plans"]]))
    report_r = (job_test / "report.md").read_text()
    check("T3 rerun report inventory section is unchanged",
          report_r.split("## Tool inventory (advisory")[1] ==
          section_before)
    check("T3 rerun Plan A still 464.1 s (ranking untouched)",
          abs(plan_a(job_r)["total_seconds"] - 464.1) < 0.01)

    # --- 4/5. unowned plan stands; v1 job shows no owned info --------
    check("T4 job dir complete despite unowned tools",
          all((job_test / f).exists() for f in
              ("job.json", "manifest.json", "manifest.txt", "report.md",
               "real_container.dxf")))
    rc, so, se = cli(home_test, "job", str(REPO / "test" /
                                           "real_container_out"))
    check("T5 v1 job shows no owned info in `mldxf job`",
          rc == 0 and "owned" not in so
          and "not in your inventory" not in so, so[:400])

    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed "
          f"(workdir: {work})")
    for f in FAILURES:
        print(f"  FAILED: {f}")
    return len(FAILURES)


if __name__ == "__main__":
    raise SystemExit(main())
