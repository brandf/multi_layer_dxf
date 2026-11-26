#!/usr/bin/env python3
"""mldxf — one headless entry point over the multi_layer_dxf pipeline (V2.1).

A thin shell over the existing v1 scripts — step_to_vcarve.py,
multi_part.py, toolplan.py, layout.py, orient_search.py. No classifier
or planner code is rewritten here and none is re-implemented: every
pipeline step runs in the original script as a subprocess, so a job
produced through `mldxf plan` is byte-identical to one produced by
calling the v1 scripts directly. The existing scripts keep working
exactly as in v1.0.1.

Commands (V2_SCOPE.md §2.2):

    mldxf plan <step> -o <job-dir>   full pipeline (single- or
        multi-solid — the command inspects the STEP's solid count;
        the caller does not choose). V1 flags carried over: --parts,
        --mode, --only, --min-tool, --material, --plan, --auto.
        With no -o, the job goes under <MLDXF_HOME>/jobs/<job-id>
        (the settled §10 default: jobs live under the home dir).
    mldxf check <step>               classify only, write nothing
        for VCarve (same output contract as V1 --mode check).
    mldxf job <job-dir>              read-only inspect: plan, flags,
        post-processing steps, layout (reads the v1 manifest.json).
    mldxf rerun <job-dir>            reproduce a job — needs the V2.2
        job model (job.json with embedded inputs + config snapshot);
        v1 jobs fail with a named error (V2_SCOPE.md §8 Q10). A job
        that had workholding guides replays them from the guides'
        recorded provenance (V2.9); a rerun never silently drops
        guides it cannot replay — it fails with a named error.
    mldxf guides <job-dir>           workholding guides (V2.9): a
        post-step on a finished job — slot-based clamp placement
        from the live machine/clamp libraries. Plan never runs
        guides and never fails for placeholder T-track; guides
        refuse placeholders with a named error instead.
    mldxf toolpaths <job-dir>        in-house TypeScript toolpath
        generation (V3.1): a post-step on a finished v2 job —
        writes the toolpaths section into job.json and bumps
        job_version to 3. Plan never generates toolpaths; a job
        without toolpaths is still a complete V2 job. The merged
        job is validated (V3.2, ts/validate_job.ts) before it is
        published — an invalid merge fails instead of shipping.
    mldxf validate-job <job-dir>     validate a job dir's job.json
        against the v3 schema (docs-v3/job_model_v3.md) via the
        TypeScript validator ts/validate_job.ts. Exit 0 when the
        job is a valid v2/v3 job; a named error otherwise.
    mldxf geometry <job-dir>         layer geometry for the 3D view
        (V3.3): per-layer DXF loops as sampled points + each
        layer's Z depths, via ts/geometry.ts — the data behind
        GET /api/jobs/:id/geometry. Reads job.json + the job's
        root DXF; writes nothing.
    mldxf build-view3d [--force]     build the 3D view bundle
        (V3.3, ts/view3d/build.ts): three.js vendored locally into
        server/public/vendor/view3d.js. The bundle is a build
        artifact, not checked in; `mldxf serve` builds it when it
        is missing or stale.
    mldxf gcode <job-dir> [--post <post-id>]   G-code export (V3.6):
        native Masso (mm/inch) / GRBL posts; the file is parsed
        back and re-simulated, and the `gcode` entry records the
        round-trip verdict (verified, or UNVERIFIED + exit 1).
    mldxf gcode --verify <job-dir> [--post <post-id>]
        re-verify the recorded .nc (V3.8): the file as it sits on
        disk against the current toolpaths — entry? file? sha?
        round-trip? — syncing the `verified` stamp to the observed
        result; exit 1 with a named error when it no longer verifies.
    mldxf sim --verify <job-dir>     headless sim verification
        (V3.4): dexel sim of the toolpaths against the intended
        geometry; writes the `sim` section into job.json +
        manifest.json on PASS, fails with `sim_mismatch` (exit 1)
        and writes nothing on a mismatch. On PASS it also writes
        the V3.5 delta log (sim/delta.bin) + the checkpoint index
        into the `sim` section.
    mldxf sim --seek <job-dir> --move N | --time T
        headless seek (V3.5): rewind the simmed stock to a move
        index or cut time and report the stock state there;
        read-only (never writes job.json).
    mldxf machine show | validate    print / validate machine.json.
    mldxf tools list | validate      print / validate tools.json.
    mldxf clamps list | validate     print / validate clamps.json.
    mldxf preferences show | validate
                                      print / validate preferences.json.
    mldxf serve [--port N]           start the Bun web server (V2.5)
        — spawns `bun run server.ts`, waits for the port to answer,
        then opens the browser (best-effort).
    mldxf init                       copy the shipped *-example.json
        files into the resolved home dir and print the paths.

JSON contract (V2_SCOPE.md §2.3): with --json, exactly one JSON object
on stdout and nothing else; human-readable progress goes to stderr.
Success is {"ok": true, "job": {...}} for the job commands (plan,
check, job, rerun) and {"ok": true, <payload>} for the library/init
commands; failure is {"ok": false, "error": "<named error>",
"message": "<human-readable detail>"}. Exit codes: 0 success; 1 user
error (bad input, bad config, fit-or-error — a part that cannot be cut
fails with a named error and writes no job dir, as in V1); 2 internal
error (a traceback — a bug, not a user mistake).

Every command accepts --json and --config <path>. A missing --config
file is a hard error, exit 1 (the V1 rule, unchanged). No silent
defaults anywhere: a missing home dir is an error naming the exact
`mldxf init` command, not a silent creation of defaults.

Home resolution (V2_SCOPE.md §4.1 + §8 Q8): MLDXF_HOME, else
%APPDATA%\\multi_layer_dxf on Windows, else ~/.config/multi_layer_dxf
— never the current working directory. See mldxf_config.py (V2.3),
which owns the library model and validation; this file only drives it.

Jobs, tools, and the settled §10 defaults are configuration, not
hardcoded: jobs default under <MLDXF_HOME>/jobs/ (Q2), the tool
inventory is advisory, never constraining (Q3 — the CLI never
hard-fails on an unowned tool), T-track placeholders refuse the
guides (Q1 — `mldxf guides` is the V2.9 post-step; `mldxf plan`
never runs guides and never fails for placeholder T-track), and
the 2D layout preview is a V2.8 UI rendering of data the CLI
already emits (Q4).
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))

VERSION = (REPO_ROOT / "VERSION").read_text().strip() \
    if (REPO_ROOT / "VERSION").exists() else "unknown"

# The pipeline runs under the repo venv (build123d + ezdxf live there);
# this CLI itself is stdlib-only, so any python3 can run it.
_PIPELINE_PYTHON = None


def pipeline_python():
    """The python that runs the v1 scripts: .venv/bin/python (POSIX)
    or .venv\\Scripts\\python.exe (Windows) when present, else the
    interpreter running this CLI."""
    global _PIPELINE_PYTHON
    if _PIPELINE_PYTHON is None:
        if sys.platform.startswith("win"):
            cand = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
        else:
            cand = REPO_ROOT / ".venv" / "bin" / "python"
        _PIPELINE_PYTHON = str(cand) if cand.is_file() else sys.executable
    return _PIPELINE_PYTHON


def pipeline_python_available():
    """True when a venv python exists next to this CLI (the setup the
    V1 scripts need). Without it the pipeline cannot run at all."""
    if sys.platform.startswith("win"):
        cand = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    else:
        cand = REPO_ROOT / ".venv" / "bin" / "python"
    return cand.is_file()


def bun_executable():
    """The Bun runtime for the V3 TypeScript generator: $BUN when
    set, else `bun` on PATH. Returns the path or None."""
    env = os.environ.get("BUN")
    if env:
        return env
    return shutil.which("bun")


# ---------------------------------------------------------------- errors

class CliError(Exception):
    """A named, user-facing failure. `name` is the machine-readable
    error name (the JSON contract's "error"); `exit_code` is 1 for a
    user error and 2 for an internal error (a bug)."""

    def __init__(self, name, message, exit_code=1):
        super().__init__(message)
        self.name = name
        self.message = message
        self.exit_code = exit_code


class _JsonArgumentParser(argparse.ArgumentParser):
    """argparse errors are usage errors (exit 1), not internal errors
    (argparse's default exit code is 2, which the JSON contract
    reserves for tracebacks)."""

    def error(self, message):
        if "--json" in sys.argv:
            emit_json({"ok": False, "error": "usage_error",
                       "message": message})
        else:
            self.print_usage(sys.stderr)
            print(f"ERROR: usage_error: {message}", file=sys.stderr)
        raise SystemExit(1)


# ---------------------------------------------------------------- output

def progress(message):
    """Human-readable progress — always stderr, never stdout, so
    --json output stays exactly one JSON object."""
    print(message, file=sys.stderr)


def emit_json(obj):
    """Write exactly one JSON object to stdout and nothing else."""
    print(json.dumps(obj))
    sys.stdout.flush()


def emit_success(payload):
    """Success envelope: {"ok": true, ...payload}."""
    emit_json({"ok": True, **payload})


def fail(name, message, exit_code=1):
    raise CliError(name, message, exit_code)


# ---------------------------------------------------------------- config

def require_config_file(config_path):
    """Every command accepts --config; a missing file is a hard error,
    exit 1 (the V1 rule, unchanged). Returns the Path or None."""
    if config_path is None:
        return None
    path = Path(config_path)
    if not path.is_file():
        fail("config_file_not_found",
             f"config file not found: {path}")
    return path


def load_config_module():
    """mldxf_config (V2.3) — imported lazily so --help / --version
    work even if the module is absent."""
    try:
        import mldxf_config as cfg
    except ImportError as e:
        fail("internal_error",
             f"mldxf_config.py (V2.3) is missing from the repo: {e} — "
             "the machine/tools/clamps commands need it",
             exit_code=2)
    return cfg


def config_error_name(exc):
    """Map a mldxf_config.ConfigError to a CLI error name. A missing
    file/home (the message names `mldxf init`) is home_not_initialized;
    anything else is config_error."""
    text = str(exc)
    if "mldxf init" in text:
        return "home_not_initialized"
    return "config_error"


# ---------------------------------------------------------------- STEP probing

_SOLID_COUNT_PROBE = (
    "import sys\n"
    "from build123d import import_step\n"
    "obj = import_step(sys.argv[1])\n"
    "try:\n"
    "    solids = obj.solids()\n"
    "except Exception:\n"
    "    solids = [obj]\n"
    "print(len(solids))\n"
)


def count_solids(step_path):
    """Inspect the STEP's solid count with the same call the v1 scripts
    use (build123d import_step + .solids()). Costs one build123d
    import (~15 s) — accepted: the count decides the pipeline path and
    must agree with what the scripts themselves see. A STEP that
    cannot be imported at all is a user error (bad input)."""
    if not pipeline_python_available():
        fail("python_env_missing",
             "no .venv python next to mldxf.py — run setup_windows.bat "
             "(Windows) or create .venv and `pip install build123d ezdxf` "
             "before running the pipeline")
    result = subprocess.run(
        [pipeline_python(), "-c", _SOLID_COUNT_PROBE, str(step_path)],
        capture_output=True, text=True)
    if result.returncode != 0:
        detail = _last_lines(result.stderr, 2)
        fail("step_unreadable",
             f"cannot read STEP {step_path}: {detail}")
    try:
        return int(result.stdout.strip())
    except ValueError:
        fail("internal_error",
             f"solid-count probe returned {result.stdout!r} for {step_path}",
             exit_code=2)


def _last_lines(text, n):
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return " | ".join(lines[-n:]) if lines else "(no output)"


# ---------------------------------------------------------------- child runs

_FIT_PATTERNS = (
    "does not fit", "no orientation fits", "does not fit material",
    "height", "PACKING", "cannot fit", "no orientation",
)


def run_pipeline(argv, step_path):
    """Run one of the v1 scripts as a subprocess and forward all of its
    output to our stderr as progress (stdout stays clean for --json).
    Returns the CompletedProcess."""
    progress(f"running: {' '.join(argv[1:])}")
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.stdout:
        for line in result.stdout.rstrip("\n").split("\n"):
            progress(line)
    if result.stderr:
        for line in result.stderr.rstrip("\n").split("\n"):
            progress(line)
    return result


def child_error(result, what):
    """Map a failed v1-script run onto the CLI contract. A traceback is
    an internal error (exit 2 — a bug). An ERROR: line is a user error
    (exit 1): fit/packing/orientation failures are fit_error, anything
    else is plan_failed. The child's exit code is not trusted for the
    distinction — v1 returns 2 for a bad material spec (a user error)
    and 1 for an unhandled exception, the opposite of this contract."""
    stderr = result.stderr or ""
    if "Traceback (most recent call last)" in stderr:
        fail("internal_error",
             f"{what} failed with a traceback (a bug, not a user mistake): "
             f"{_last_lines(stderr, 3)}",
             exit_code=2)
    error_lines = [ln for ln in stderr.splitlines()
                   if ln.startswith("ERROR:")]
    if error_lines:
        message = " ".join(ln[len("ERROR:"):].strip()
                           for ln in error_lines)
        name = ("fit_error" if any(p in message for p in _FIT_PATTERNS)
                else "plan_failed")
        fail(name, message)
    fail("plan_failed",
         f"{what} failed (exit {result.returncode}) with no ERROR line: "
         f"{_last_lines(stderr, 3)}")


def plan_child_argv(script, step_path, outdir, args):
    """argv for a v1 script run: the flags `mldxf plan` carries over
    from V1 (scope §2.2), passed through unchanged."""
    argv = [pipeline_python(), str(REPO_ROOT / script), str(step_path),
            "-o", str(outdir), "--mode", args.mode]
    if getattr(args, "only", None):
        argv += ["--only", args.only]
    if getattr(args, "min_tool", 0.0):
        argv += ["--min-tool", str(args.min_tool)]
    if getattr(args, "material", None):
        argv += ["--material", args.material]
    if getattr(args, "plan", None):
        argv += ["--plan", args.plan]
    if getattr(args, "config", None):
        argv += ["--config", str(args.config)]
    return argv


# ---------------------------------------------------------------- v2 job model

def _sha256_file(path):
    """sha256 hex of a file's bytes."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canonical_json_bytes(obj):
    """Canonical JSON bytes: sorted keys, 2-space indent, trailing
    newline. job.json, manifest.json (its byte-identical copy) and
    inputs/config.json are all written in this form."""
    return (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode("utf-8")


_MOTION_KEYS = ("motion_time_s", "motion_by_tool", "motion_by_operation")


def _toolpaths_identity_bytes(section):
    """Canonical bytes of a toolpaths section minus the derived
    motion fields (V3.14). Motion is a deterministic function of
    the moves, so it carries no identity of its own: the rerun
    comparison guards the moves, and a pre-V3.14 job (no motion
    recorded) must still rerun clean against a regenerated section
    that carries it."""
    stripped = {k: v for k, v in (section or {}).items()
                if k not in _MOTION_KEYS}
    return _canonical_json_bytes(stripped)


def _now_iso():
    """ISO-8601 timestamp with local offset (created_at). Excluded
    from the rerun byte-identity check (V2_SCOPE.md §8 Q4)."""
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _make_temp_sibling(outdir):
    """A fresh temporary sibling dir for an atomic job write
    (V2_SCOPE.md §8 Q5): same parent as the final dir, so the rename
    is on one filesystem. The parent is created if needed."""
    parent = outdir.parent
    parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f".{outdir.name}.tmp-",
                                 dir=str(parent)))


def _fixup_outdir_paths(tmpdir, old, new):
    """Replace the temp outdir path with the final outdir path in
    every file under tmpdir. The v1 scripts record the outdir in
    per-part manifests (parts/<name>/manifest.json: source_step is
    the exported per-part STEP under the outdir), so a temp-dir run
    would otherwise leave stale temp paths in the finished job.
    Top-level manifest.json / report.md / manifest.txt / DXF carry
    no outdir path (verified: only per-part manifests do), so the
    replacement is a no-op everywhere else. Returns the files changed."""
    old_b, new_b = str(old).encode("utf-8"), str(new).encode("utf-8")
    if old_b == new_b:
        return []
    changed = []
    for path in sorted(p for p in Path(tmpdir).rglob("*") if p.is_file()):
        data = path.read_bytes()
        if old_b in data:
            path.write_bytes(data.replace(old_b, new_b))
            changed.append(str(path))
    return changed


def _assert_no_path(tmpdir, needle):
    """Guard: no file under tmpdir may still contain `needle` (the
    temp path) — a missed embedding would ship a job pointing at a
    deleted temp dir. Fails as an internal error (a bug)."""
    hits = []
    needle_b = str(needle).encode("utf-8")
    for path in sorted(p for p in Path(tmpdir).rglob("*") if p.is_file()):
        if needle_b in path.read_bytes():
            hits.append(str(path))
    if hits:
        fail("internal_error",
             "temp outdir path still present in " + ", ".join(hits) +
             " after fixup — refusing to publish the job",
             exit_code=2)


def _swap_into_place(tmpdir, outdir):
    """Atomically replace outdir with tmpdir (same parent, so the
    rename is atomic): move any existing outdir aside first, rename
    tmpdir in, then delete the backup. A failure mid-swap restores
    the old dir; a failed run never touches the old dir at all."""
    outdir = Path(outdir)
    tmpdir = Path(tmpdir)
    if outdir.exists():
        parent = outdir.parent
        backup = Path(tempfile.mkdtemp(
            prefix=f".{outdir.name}.backup-", dir=str(parent)))
        backup.rmdir()
        outdir.rename(backup)
        try:
            tmpdir.rename(outdir)
        except OSError:
            backup.rename(outdir)
            raise
        shutil.rmtree(backup, ignore_errors=True)
    else:
        tmpdir.rename(outdir)


def _append_path_flags(argv, path_kind, args):
    """The flags that depend on the pipeline path: --auto becomes
    --auto-orient (single) or --auto (multi); --parts is multi-only
    (noted and ignored for a single-solid STEP, as in V2.1)."""
    if path_kind == "single":
        if getattr(args, "parts", None):
            progress("note: --parts is a multi-part option; ignored for "
                     "a single-solid STEP")
        if args.auto:
            argv += ["--auto-orient"]
    else:
        if getattr(args, "parts", None):
            argv += ["--parts", str(args.parts)]
        if args.auto:
            argv += ["--auto"]
    return argv


def _snapshot_libraries():
    """Best-effort snapshot of the four home library files
    (V2_SCOPE.md §3.3): each entry carries its version where the
    file has one (machine/tools/clamps; preferences has none), the
    sha256 of the file bytes, and the validated contents. Returns
    (libraries dict, home Path or None). A missing/invalid home
    never fails a plan — the V2.2 pipeline does not read the
    libraries — but the absence is recorded explicitly in the
    snapshot, never silently defaulted."""
    libraries = {}
    try:
        import mldxf_config as cfg
    except ImportError as e:
        detail = f"mldxf_config.py is missing from the repo: {e}"
        for key in ("machine", "tools", "clamps", "preferences"):
            libraries[key] = {"status": "unavailable", "detail": detail}
        return libraries, None
    try:
        home = cfg.resolve_home()
    except Exception as e:
        detail = f"could not resolve the library home: {e}"
        for key in ("machine", "tools", "clamps", "preferences"):
            libraries[key] = {"status": "unavailable", "detail": detail}
        return libraries, None
    for key, loader_name, filename in (
            ("machine", "load_machine", "machine.json"),
            ("tools", "load_tools", "tools.json"),
            ("clamps", "load_clamps", "clamps.json"),
            ("preferences", "load_preferences", "preferences.json")):
        path = home / filename
        try:
            raw = path.read_bytes()
        except OSError:
            libraries[key] = {
                "status": "unavailable",
                "detail": f"{filename} not found in {home} — "
                          "run 'mldxf init' to create it from the "
                          "shipped examples"}
            continue
        entry = {"sha256": hashlib.sha256(raw).hexdigest()}
        try:
            data = getattr(cfg, loader_name)(home)
        except Exception as e:
            entry["status"] = "invalid"
            entry["detail"] = str(e)
            libraries[key] = entry
            continue
        entry["status"] = "loaded"
        entry["version"] = data.get("version") \
            if isinstance(data, dict) else None
        entry["contents"] = data
        libraries[key] = entry
    return libraries, home


def _validate_config_z_zero(contents, source):
    """Fail-fast check for one key of a --config file: ``vcarve.z_zero``
    must be "top" or "bottom" when present (mirrors mldxf_config's
    rule for the same key). The --config file is otherwise
    unvalidated at plan time, so this is the only guard before the
    child runs — _effective_z_zero calls it again at snapshot time
    for the value that is actually recorded."""
    if not isinstance(contents, dict):
        return
    vc = contents.get("vcarve")
    if not isinstance(vc, dict) or "z_zero" not in vc:
        return
    value = vc["z_zero"]
    if value not in ("top", "bottom"):
        fail("config_error",
             f"{source}: vcarve: 'z_zero' must be 'top' or "
             f"'bottom', got {value!r}")


def _effective_z_zero(config_contents, libraries):
    """The job's Z-zero (docs-v3/z_zero.md): the --config file's
    ``vcarve.z_zero`` wins, else the home preferences.json
    ``vcarve.z_zero``, else "top". Returns (value, source).
    A bad value in preferences.json never reaches here:
    load_preferences validates it when the snapshot loads the
    libraries, so that file fails the run first."""
    for contents, source in (
            (config_contents, "config file"),
            ((libraries.get("preferences") or {}).get("contents")
             if (libraries.get("preferences") or {}).get("status") == "loaded"
             else None, "home preferences")):
        if not isinstance(contents, dict):
            continue
        vc = contents.get("vcarve")
        if not isinstance(vc, dict) or "z_zero" not in vc:
            continue
        _validate_config_z_zero(contents, source)
        return vc["z_zero"], source
    return "top", "default"


def _build_config_snapshot(args, step_path, path_kind):
    """The resolved config for a plan run (V2_SCOPE.md §3.3): the
    CLI flags that affect the run, the --config file (path, sha256,
    contents) when one was given, and the four home library files
    (each with version / hash / contents) — plus the precedence
    order they were resolved in. The v1 scripts do not read
    preferences.json for anything EXCEPT the Z-zero fallback (see
    _effective_z_zero): it is recorded under libraries for
    provenance, and the snapshot says so rather than implying it
    affected the run. Returns (snapshot, machine_profile)."""
    libraries, home = _snapshot_libraries()
    config_file = None
    if getattr(args, "config", None):
        cpath = Path(args.config)
        raw = cpath.read_bytes()
        config_file = {"path": str(cpath),
                       "sha256": hashlib.sha256(raw).hexdigest(),
                       "contents": json.loads(raw)}
    parts = None
    if path_kind == "multi" and getattr(args, "parts", None):
        parts = Path(args.parts).name
    z_zero, z_zero_source = _effective_z_zero(
        config_file["contents"] if config_file else None, libraries)
    snapshot = {
        "precedence": ["code defaults (step_to_vcarve.py / toolplan.py)",
                       "config file (--config)",
                       "CLI flags"],
        "z_zero": z_zero,
        "z_zero_source": z_zero_source,
        "cli_flags": {
            "mode": args.mode,
            "only": args.only or "",
            "min_tool": args.min_tool,
            "material": args.material,
            "plan": args.plan or "",
            "auto": bool(args.auto),
            "parts": parts,
            "path": path_kind,
        },
        "config_file": config_file,
        "home": str(home) if home is not None else None,
        "libraries": libraries,
        "notes": ["preferences.json is recorded for provenance and "
                  "supplies the Z-zero fallback (docs-v3/z_zero.md); "
                  "nothing else in it affects the run — the run's "
                  "effective config is code defaults + the --config "
                  "file + CLI flags."],
    }
    machine_entry = libraries.get("machine") or {}
    machine_profile = None
    if machine_entry.get("status") == "loaded":
        machine_profile = machine_entry["contents"]
    return snapshot, machine_profile


def _owned_tool_ids(config_snapshot):
    """(owned_ids, inventory_recorded, tools_status) from a config
    snapshot's tools entry (V2.4, V2_SCOPE.md §4.4): the ids in the
    *snapshotted* tools.json, never the live file — so a rerun
    reproduces the same flags even after the live inventory
    changes. inventory_recorded is False when the snapshot holds no
    loaded, non-empty tools inventory (empty file, missing file, or
    invalid file): every tool then shows owned: false and the plan
    is exactly as in V1."""
    libraries = None
    if isinstance(config_snapshot, dict):
        libraries = config_snapshot.get("libraries")
    tools_entry = (libraries or {}).get("tools") or {}
    status = tools_entry.get("status")
    if status != "loaded":
        return set(), False, status
    contents = tools_entry.get("contents") or {}
    entries = contents.get("tools") or []
    ids = {e.get("id") for e in entries
           if isinstance(e, dict) and e.get("id")}
    return ids, bool(ids), "loaded"


def _annotate_owned(job, owned_ids):
    """Add owned: true/false (a JSON boolean) to every tool entry in
    every plan of the job: tool_plan.plans (all of them, not just
    Plan A) and per-part plans if the manifest carries any
    (parts[].tool_plan). A tool id absent from the inventory is
    owned: false. Ranking and times are untouched — this is display
    data only (§4.4). Returns the number of tools annotated."""
    def annotate_plan(plan):
        n = 0
        if not isinstance(plan, dict):
            return 0
        for tool in plan.get("tools") or []:
            if isinstance(tool, dict):
                tool["owned"] = tool.get("id") in owned_ids
                n += 1
        return n
    total = 0
    tool_plan = job.get("tool_plan") or {}
    for plan in tool_plan.get("plans") or []:
        total += annotate_plan(plan)
    for part in job.get("parts") or []:
        if not isinstance(part, dict):
            continue
        ptp = part.get("tool_plan")
        if isinstance(ptp, dict):
            if isinstance(ptp.get("plans"), list):
                for plan in ptp["plans"]:
                    total += annotate_plan(plan)
            elif isinstance(ptp.get("tools"), list):
                total += annotate_plan(ptp)
    return total


def _inventory_report_lines(job, inventory_recorded, tools_status):
    """The inventory section appended to report.md during assembly
    (§4.4). Derived from the snapshot only, so it is rerun-stable.
    With an inventory recorded, each plan lists its tools
    owned-first and marks not-owned tools explicitly; with no
    inventory recorded, it says so plainly instead of alarming
    about every tool."""
    lines = ["", "## Tool inventory (advisory — never constraining)", ""]
    tool_plan = job.get("tool_plan") or {}
    plans = tool_plan.get("plans") or []
    if not inventory_recorded:
        if tools_status == "loaded":
            reason = ("No tool inventory recorded yet "
                      "(tools.json is empty)")
        elif tools_status == "invalid":
            reason = ("The tool inventory in this job's config "
                      "snapshot could not be read (tools.json is "
                      "invalid)")
        else:
            reason = ("No tool inventory was available when this job "
                      "was planned (tools.json missing or unreadable)")
        lines += [
            f"{reason}, so ownership is unknown for every tool — all "
            "tools show owned: false in job.json and the plan is "
            "exactly as in V1 (ranking and times unchanged).",
            "",
            "Record the tools you own (MLDXF_HOME/tools.json, or the "
            "Tools tab in the web UI) and re-run to see owned vs "
            "not-owned here.",
        ]
        return lines
    lines += [
        "Tools are shown owned-first in each plan; a tool marked "
        "\"not in your inventory — check before you cut\" is flagged, "
        "never dropped and never a failure — the plan still stands.",
        "",
    ]
    for plan in plans:
        tools = plan.get("tools") or []
        ordered = sorted(tools, key=lambda t: not t.get("owned", False))
        rendered = []
        for t in ordered:
            name = t.get("name", t.get("id", "?"))
            if t.get("owned"):
                rendered.append(f"{name} (owned)")
            else:
                rendered.append(f"{name} (not in your inventory — "
                                "check before you cut)")
        minutes = plan.get("total_seconds", 0) / 60.0
        lines.append(f"- Plan {plan.get('id', '?')}: "
                     f"{'; '.join(rendered)} — {len(tools)} tool(s), "
                     f"{plan.get('tool_changes', 0)} change(s), "
                     f"{minutes:.1f} min")
    if plans:
        lines.append("")
    return lines


def _inventory_state(manifest):
    """'unknown' | 'empty' | 'recorded' — whether the manifest
    carries owned info and whether an inventory was recorded behind
    it. A v1 job has no owned field at all ('unknown': show no owned
    info, as the UI contract requires). A v2 job always carries
    owned; the snapshot says whether an inventory was recorded —
    with an empty/missing inventory every tool is owned: false and
    the display says so once instead of flagging every tool."""
    tool_plan = manifest.get("tool_plan") or {}
    has_owned = any("owned" in t
                    for p in tool_plan.get("plans") or []
                    for t in p.get("tools") or []
                    if isinstance(t, dict))
    if not has_owned:
        return "unknown"
    snapshot = manifest.get("config_snapshot")
    if isinstance(snapshot, dict):
        _, recorded, _ = _owned_tool_ids(snapshot)
        return "recorded" if recorded else "empty"
    # No snapshot to consult (a hand-built job.json): any owned tool
    # proves an inventory was recorded.
    any_owned = any(t.get("owned")
                    for p in tool_plan.get("plans") or []
                    for t in p.get("tools") or []
                    if isinstance(t, dict))
    return "recorded" if any_owned else "empty"


def _display_tools(plan):
    """(text, n_unowned) — a plan's tools for human display: owned
    first (stable — original relative order kept inside each group),
    owned marked "(owned)", not-owned marked "(not in your inventory
    — check before you cut)". Callers check _inventory_state first:
    with no owned info, or no inventory recorded, tools are shown
    plainly in plan order instead."""
    tools = plan.get("tools") or []
    ordered = sorted(tools, key=lambda t: not t.get("owned", False))
    parts = []
    n_unowned = 0
    for t in ordered:
        name = t.get("name", t.get("id", "?"))
        if t.get("owned"):
            parts.append(f"{name} (owned)")
        else:
            parts.append(f"{name} (not in your inventory — check "
                         "before you cut)")
            n_unowned += 1
    return " + ".join(parts), n_unowned


def _collect_outputs(tmpdir):
    """outputs (§3.3): every file the job wrote, each with a sha256,
    sorted by relative path. job.json and the top-level
    manifest.json are excluded: manifest.json is a byte-identical
    copy of job.json, so its hash equals job.json's hash, which
    cannot list itself."""
    tmpdir = Path(tmpdir)
    entries = []
    for path in sorted(p for p in tmpdir.rglob("*") if p.is_file()):
        rel = path.relative_to(tmpdir).as_posix()
        if rel in ("job.json", "manifest.json"):
            continue
        entries.append({"file": rel, "sha256": _sha256_file(path)})
    return entries


def _assemble_job(tmpdir, *, job_id, source_step, source_step_sha256,
                  inputs_embedded, config_snapshot, machine_profile,
                  step_source, parts_source):
    """Turn a finished child run in tmpdir into a v2 job: write
    inputs/ (embedded STEP unless --no-embed, parts.json when one
    was used, config.json = the snapshot), then job.json (the v1
    manifest's keys unchanged, plus the §3.3 v2 fields) and
    manifest.json as a byte-identical copy of it. Returns the job
    dict (without job_dir/path — the caller adds those)."""
    tmpdir = Path(tmpdir)
    manifest = json.loads((tmpdir / "manifest.json").read_text())
    job = dict(manifest)
    job.update({
        "job_version": 2,
        "job_id": job_id,
        "cli_version": VERSION,
        "created_at": _now_iso(),
        "source_step": source_step,
        "source_step_sha256": source_step_sha256,
        "inputs_embedded": inputs_embedded,
        "config_snapshot": config_snapshot,
        "machine_profile": machine_profile,
        # The job's Z-zero (docs-v3/z_zero.md): resolved by
        # _build_config_snapshot from the --config file, else the
        # home preferences, else "top". The view, the posts, and
        # the verify path all read this one field; a job without
        # it predates the setting and reads as "top".
        "z_zero": config_snapshot.get("z_zero", "top"),
        # V2.9 (workholding guides): null until `mldxf guides` runs
        # as a post-step on the finished job. `cmd_rerun` replays
        # guides from the recorded provenance when the old job had
        # them; `mldxf plan` never runs guides and never fails for
        # placeholder T-track.
        "workholding": None,
    })
    inputs_dir = tmpdir / "inputs"
    inputs_dir.mkdir(exist_ok=True)
    if inputs_embedded and step_source is not None:
        shutil.copyfile(step_source, inputs_dir / "input.step")
    if parts_source is not None:
        shutil.copyfile(parts_source, inputs_dir / "parts.json")
    (inputs_dir / "config.json").write_bytes(
        _canonical_json_bytes(config_snapshot))
    # V2.4 (§4.4): annotate every plan's tools with owned: true/false
    # from the snapshotted inventory (never the live file — a rerun
    # replays the stored snapshot, so the flags reproduce), then
    # append the inventory section to the report the child wrote.
    # Both happen before _collect_outputs, so the recorded report.md
    # hash matches the file as shipped.
    owned_ids, inventory_recorded, tools_status = \
        _owned_tool_ids(config_snapshot)
    _annotate_owned(job, owned_ids)
    report_path = tmpdir / "report.md"
    if report_path.is_file():
        text = report_path.read_text()
        if text and not text.endswith("\n"):
            text += "\n"
        section = _inventory_report_lines(job, inventory_recorded,
                                          tools_status)
        report_path.write_text(text + "\n".join(section) + "\n")
    job["outputs"] = _collect_outputs(tmpdir)
    blob = _canonical_json_bytes(job)
    (tmpdir / "job.json").write_bytes(blob)
    (tmpdir / "manifest.json").write_bytes(blob)
    return job


def _rerun_fixup_target(job_dir):
    """The outdir string the original run recorded, recovered from
    a per-part manifest's source_step (<outdir>/parts/<name>.step),
    so a rerun invoked with a different path form (relative vs
    absolute) still reproduces the recorded paths byte-for-byte.
    Falls back to the job dir as given."""
    parts_dir = Path(job_dir) / "parts"
    if parts_dir.is_dir():
        for man_path in sorted(parts_dir.glob("*/manifest.json")):
            try:
                data = json.loads(man_path.read_text())
                src = data.get("source_step")
                if src:
                    return str(Path(src).parent.parent)
            except (OSError, ValueError):
                continue
    return str(job_dir)


# ---------------------------------------------------------------- plan/check parsing

_CHECK_RE = re.compile(
    r"layers would be: (\d+), holes: (\d+), pockets: (\d+), flags: (\d+)")
_COUNTS_RE = re.compile(
    r"layers: (\d+), holes: (\d+), pockets: (\d+), flags: (\d+)")


def parse_check_output(stdout):
    """Parse V1 --mode check output into per-part summaries. The
    single-part script prints one "layers would be:" line; the
    multi-part script prints one per part, each under a
    "--- P01 (...) ---" header. Returns a list of part dicts."""
    parts = []
    current = {"label": None, "layers": 0, "holes": 0, "pockets": 0,
               "flags": 0, "flag_text": []}
    for line in (stdout or "").splitlines():
        if line.startswith("--- ") and line.rstrip().endswith("---"):
            if current["label"] is not None or current["layers"]:
                parts.append(current)
            label = line.strip("- ").split(" (")[0].strip()
            current = {"label": label, "layers": 0, "holes": 0,
                       "pockets": 0, "flags": 0, "flag_text": []}
            continue
        m = _CHECK_RE.search(line)
        if m:
            current["layers"], current["holes"], current["pockets"], \
                current["flags"] = (int(v) for v in m.groups())
            continue
        if line.strip().startswith("FLAG:"):
            current["flag_text"].append(line.strip()[len("FLAG:"):].strip())
    if current["label"] is not None or current["layers"] or parts:
        parts.append(current)
    return parts


def check_job_object(step_path, path_kind, parts):
    totals = {k: sum(p[k] for p in parts)
              for k in ("layers", "holes", "pockets", "flags")}
    return {
        "command": "check",
        "source_step": str(step_path),
        "path": path_kind,
        "parts": parts,
        "totals": totals,
    }


def summarize_plan_human(manifest, job_dir):
    """One-paragraph human summary of a finished plan."""
    n_parts = len(manifest.get("parts", [])) or 1
    n_layers = len(manifest.get("layers", []))
    n_flags = len(manifest.get("flags", []))
    lines = [f"wrote {job_dir}",
             f"{n_parts} part(s), {n_layers} layers, {n_flags} flags"]
    plan = plan_summary(manifest)
    if plan:
        lines.append(plan)
    return "\n".join(lines)


def plan_summary(manifest):
    """'Plan A: End Mill 1/8in + Drill 2.25 mm + End Mill 1/4in — 3 tools,
    2 changes, 7.0 min' — from the manifest's ranked tool plan.
    V2.4: when an inventory was recorded, the tools are shown
    owned-first and not-owned tools are marked explicitly ("not in
    your inventory — check before you cut"); with no owned info (v1
    job) or no inventory recorded, the string is exactly as in V1."""
    tool_plan = manifest.get("tool_plan") or {}
    plans = tool_plan.get("plans") or []
    if not plans:
        if tool_plan.get("error"):
            return f"tool plan: no plan — {tool_plan['error']}"
        return ""
    p = plans[0]
    if _inventory_state(manifest) == "recorded":
        tools, _ = _display_tools(p)
    else:
        tools = " + ".join(t.get("name", t.get("id", "?"))
                           for t in p.get("tools", []))
    minutes = p.get("total_seconds", 0) / 60.0
    return (f"Plan {p.get('id', 'A')}: {tools} — "
            f"{len(p.get('tools', []))} tools, "
            f"{p.get('tool_changes', 0)} changes, {minutes:.1f} min")


def post_process_steps(manifest):
    """Post-processing steps for `mldxf job`: the structured
    post_process list on a single-part manifest, or the POST-PROCESS
    flag lines on a multi-part manifest (which carries none
    structured — the flags are the record there)."""
    steps = []
    for entry in manifest.get("post_process") or []:
        steps.append(
            f"[{entry.get('method', '?')}] {entry.get('feature', '')} "
            f"{entry.get('params', '')} — {entry.get('step', '')}")
    for flag in manifest.get("flags") or []:
        if "POST-PROCESS" in flag:
            text = flag.split("] ", 1)[-1] if "] " in flag else flag
            steps.append(text)
    return steps


def _chosen_plan_for_toolpaths(job):
    """The plan the toolpaths were generated from (toolpaths.plan),
    falling back to the chosen plan, then plans[0]."""
    tp = job.get("toolpaths") or {}
    tool_plan = job.get("tool_plan") or {}
    plans = tool_plan.get("plans") or []
    if not plans:
        return None
    want = tp.get("plan") or tool_plan.get("chosen")
    for p in plans:
        if p.get("id") == want:
            return p
    return plans[0]


def _toolpaths_motion_lines(job, indent=""):
    """The estimate-vs-motion lines (V3.14), shared by `mldxf job`
    and report.md so both print the same words. [] when the job has
    no toolpaths; when the toolpaths predate V3.14 (no motion
    recorded) it says so instead of inventing a number."""
    tp = job.get("toolpaths")
    if tp is None:
        return []
    motion = tp.get("motion_time_s")
    if motion is None:
        return [f"{indent}motion time: not recorded — this job's "
                "toolpaths predate V3.14; re-run `mldxf toolpaths` "
                "to measure it"]
    lines = [f"{indent}motion time (measured from the toolpaths): "
             f"{motion:.1f} s ({motion / 60.0:.1f} min) — feed/plunge "
             "per move, arcs by true length, rapids at 50 mm/s"]
    by_tool = tp.get("motion_by_tool") or {}
    if by_tool:
        lines.append(f"{indent}  by tool: " + ", ".join(
            f"{t} {s:.1f} s" for t, s in sorted(by_tool.items())))
    plan = _chosen_plan_for_toolpaths(job)
    if plan is not None:
        cut = float(plan.get("cutting_seconds", 0))
        total = float(plan.get("total_seconds", 0))
        changes = int(plan.get("tool_changes", 0))
        change_s = float(plan.get("change_seconds", changes * 120.0))
        delta = motion - cut
        pct = (100.0 * delta / cut) if cut else 0.0
        if total:
            total_pct = 100.0 * (motion + change_s - total) / total
            lines.append(
                f"{indent}plan estimate (Plan {plan.get('id', '?')}): "
                f"{cut:.1f} s cutting, {total:.1f} s "
                f"({total / 60.0:.1f} min) with {changes} "
                f"change{'s' if changes != 1 else ''} — "
                f"motion is {delta:+.1f} s ({pct:+.1f}%) vs the "
                f"cutting estimate; motion + changes "
                f"{motion + change_s:.1f} s vs plan total "
                f"({total_pct:+.1f}%)")
        else:
            lines.append(
                f"{indent}plan estimate (Plan {plan.get('id', '?')}): "
                f"{cut:.1f} s cutting — motion is {delta:+.1f} s "
                f"({pct:+.1f}%) vs the estimate")
    lines.append(f"{indent}motion time is the toolpath clock, not a "
                 "machine measurement — the live cut settles what "
                 "the machine actually takes")
    return lines


def _toolpaths_report_section(job):
    """The report.md section (V3.14). [] when the job has no
    toolpaths — a v2 job's report gains no section."""
    lines = _toolpaths_motion_lines(job)
    if not lines:
        return []
    return ["", "## Toolpaths (V3.14)", ""] + lines + [""]


def _update_report_toolpaths(job_dir, job):
    """Replace-or-append the Toolpaths (V3.14) section in report.md
    (the guides' pattern: find the heading, cut to the next
    `## `, append) and refresh job["outputs"] hashes for the files
    this step changed. No-op when the job has no toolpaths or no
    report.md. Mutates job in place; the caller republishes
    job.json + manifest.json after calling this."""
    section = _toolpaths_report_section(job)
    if not section:
        return
    job_dir = Path(job_dir)
    report_path = job_dir / "report.md"
    if not report_path.is_file():
        return
    heading = "## Toolpaths (V3.14)"
    text = report_path.read_text()
    start = text.find(heading)
    if start != -1:
        rest = text[start + len(heading):]
        nxt = rest.find("\n## ")
        text = text[:start] + (rest[nxt + 1:] if nxt != -1 else "")
    if text and not text.endswith("\n"):
        text += "\n"
    report_path.write_text(text + "\n".join(section))
    entries = []
    for path in sorted(p for p in job_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(job_dir).as_posix()
        if rel in ("job.json", "manifest.json"):
            continue
        entries.append({"file": rel, "sha256": _sha256_file(path)})
    job["outputs"] = entries


def _format_workholding_human(workholding, indent=""):
    """Human-readable workholding lines: the recommendation, one
    line per clamp, alternatives, and the force-model note. Shared
    by `mldxf job` and `mldxf guides` so both print the same
    words as report.md carries."""
    lines = [f"{indent}workholding:"]
    rec = workholding.get("recommendation")
    if rec:
        lines.append(f"{indent}  {rec}")
    r = workholding.get("balance") or {}
    if r:
        lines.append(f"{indent}  {r.get('note', '')}")
        wc = r.get("worst_cut") or {}
        if wc:
            lines.append(
                f"{indent}    worst cut: {wc.get('force_n')} N at "
                f"({wc.get('x_mm')}, {wc.get('y_mm')}) on "
                f"{wc.get('layer')}")
    else:
        # Old jobs carry the edge-model restraint object; the
        # model is superseded, so say so rather than presenting
        # its verdict as current.
        ro = workholding.get("restraint") or {}
        if ro:
            lines.append(
                f"{indent}  restraint (old edge model — superseded; "
                f"re-run guides for the contact balance): "
                f"{ro.get('verdict')}")
    for c in workholding.get("clamps") or []:
        lines.append(
            f"{indent}  - {c.get('clamp_id')} ({c.get('method')}) at "
            f"({c.get('x_mm')}, {c.get('y_mm')}) on {c.get('slot')} — "
            f"{c.get('reason', '')}")
        fc = c.get("force_check") or {}
        if fc.get("note"):
            lines.append(f"{indent}    force check: {fc['note']}")
    for a in workholding.get("alternatives") or []:
        lines.append(f"{indent}  - alternative {a.get('method')}: "
                     f"{a.get('note', '')}")
    fm = workholding.get("force_model") or {}
    if fm.get("note"):
        lines.append(f"{indent}  force model: {fm['note']}")
    return lines


def _run_guides_subprocess(job_dir, machine, clamps_data, cli_version):
    """Run the V2.9 guides (mldxf_guides.py, venv python — it needs
    ezdxf) against a job dir in place. ``machine`` is the loaded
    machine dict, ``clamps_data`` the loaded {"version", "clamps"}
    dict. Returns the guides' parsed stdout JSON. A non-JSON
    stdout or a failed run maps onto the CLI contract (the guides'
    own named error passes through unchanged)."""
    if not pipeline_python_available():
        fail("python_env_missing",
             "no .venv python next to mldxf.py — the guides need "
             "ezdxf (run setup_windows.bat on Windows or create "
             ".venv and `pip install build123d ezdxf`)")
    inputs = {"machine": machine, "clamps": clamps_data,
              "cli_version": cli_version}
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="mldxf_guides_inputs_",
                                   suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(inputs, f)
        result = subprocess.run(
            [pipeline_python(), str(REPO_ROOT / "mldxf_guides.py"),
             str(job_dir), "--inputs", tmp, "--json"],
            capture_output=True, text=True)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "mldxf_guides produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok"):
        fail(body.get("error") or "guides_failed",
             body.get("message") or f"guides failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def cmd_guides(args):
    """`mldxf guides <job-dir>` (V2.9): a post-step on a finished
    v2 job — slot-based clamp placement from the live machine /
    clamp libraries. The plan is never touched (guides only read
    the job and write the GUIDE_CLAMP layer, the workholding
    section, and the report section). Placeholder T-track refuses
    here with the named error `t_track_placeholder`; `mldxf plan`
    never runs guides, so a plan with placeholders still succeeds.
    Re-running guides on a guided job recomputes from the current
    libraries (the guides step is idempotent)."""
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    if filename != "job.json" or manifest.get("job_version", 1) < 2:
        fail("guides_unavailable",
             f"{job_dir} is a v1 job (manifest.json only) — guides "
             "need the V2.2 job model (job.json with layout + tool "
             "plan + material). v1 jobs are read-only; re-run "
             "`mldxf plan` on the source STEP instead")
    cfg, machine = _load_library("load_machine")
    _cfg, clamps_data = _load_library("load_clamps")
    # Fast, named refusal before spawning: placeholder slots and
    # unmountable clamps fail here; the guides subprocess re-checks
    # the same conditions on the inputs it is handed, so a replay
    # with recorded inputs gets the same refusal.
    try:
        cfg.assert_real_t_track(machine)
        cfg.check_clamp_mountable(clamps_data, machine)
    except Exception as e:
        if e.__class__.__name__ == "ConfigError":
            text = str(e)
            if "placeholders" in text:
                fail("t_track_placeholder", text)
            fail("clamp_no_slot", text)
        raise
    _run_guides_subprocess(job_dir, machine, clamps_data, VERSION)
    job, _filename = _load_job_file(job_dir)
    job["job_dir"] = str(job_dir.resolve())
    job["job_version"] = manifest.get("job_version", 2)
    if args.json:
        emit_success({"job": job})
    else:
        wh = job.get("workholding") or {}
        print(f"guides for {job_dir}")
        print("\n".join(_format_workholding_human(wh)))
    return 0


def _run_validate_job_subprocess(job_dir=None, file=None):
    """Run the V3.2 job-model validator (ts/validate_job.ts, Bun)
    against a job dir (or a single job.json file). Returns the
    validator's parsed stdout JSON. A non-JSON stdout or a failed
    run maps onto the CLI contract (the validator's own named error
    passes through unchanged)."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.2 job "
             "validator needs it (https://bun.sh, or set $BUN to the "
             "Bun executable)")
    argv = [bun, str(REPO_ROOT / "ts" / "validate_job.ts")]
    if file is not None:
        argv += ["--file", str(file)]
    else:
        argv += [str(job_dir)]
    argv += ["--json"]
    result = subprocess.run(argv, capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/validate_job.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    return body


def cmd_validate_job(args):
    """`mldxf validate-job <job-dir>` (V3.2): validate the job
    dir's job.json against the v3 schema (docs-v3/job_model_v3.md)
    via the TypeScript validator. The validator is the executable
    form of the schema doc; this command is the CLI shell over it
    (the API reaches it 1:1 as GET /api/jobs/:id/validate, and
    `mldxf toolpaths` / `mldxf rerun` run it before publishing)."""
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    body = _run_validate_job_subprocess(job_dir=job_dir)
    if not body.get("ok"):
        fail(body.get("error") or "job_invalid",
             body.get("message") or f"{job_dir} failed validation",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    if args.json:
        emit_success({"job_version": body.get("job_version"),
                      "has_toolpaths": body.get("has_toolpaths"),
                      "checks": body.get("checks")})
    else:
        n = len(body.get("checks") or [])
        print(f"{job_dir} is a valid v{body.get('job_version')} job "
              f"({n} checks passed"
              f"{', has toolpaths' if body.get('has_toolpaths') else ', no toolpaths'})")
    return 0


def _run_geometry_subprocess(job_dir):
    """Run the V3.3 layer-geometry extractor (ts/geometry.ts, Bun)
    against a job dir. Returns the extractor's parsed stdout JSON
    (its `layers` + `bounds`). A non-JSON stdout or a failed run
    maps onto the CLI contract (the extractor's own named error
    passes through unchanged). The extractor never writes anything
    — it reads job.json + the job's root DXF."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.3 layer "
             "geometry extractor needs it (https://bun.sh, or set "
             "$BUN to the Bun executable)")
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "geometry.ts"),
         str(job_dir), "--json"],
        capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/geometry.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok"):
        fail(body.get("error") or "geometry_failed",
             body.get("message") or f"geometry failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def cmd_geometry(args):
    """`mldxf geometry <job-dir>` (V3.3): emit the job's layer
    geometry for the 3D view — one entry per job.json layer, with
    the DXF loops as sampled points and the layer's Z depths
    (cut top / cut bottom). Read-only: job.json and the DXF are
    never written. The API reaches this 1:1 as
    GET /api/jobs/:id/geometry."""
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    body = _run_geometry_subprocess(job_dir)
    if args.json:
        emit_success({"job_id": body.get("job_id"),
                      "dxf": body.get("dxf"),
                      "layers": body.get("layers"),
                      "bounds": body.get("bounds")})
    else:
        layers = body.get("layers") or []
        print(f"geometry for {job_dir} ({body.get('dxf')}, "
              f"{len(layers)} layers)")
        for layer in layers:
            print(f"  {layer.get('layer')} — Z {layer.get('z_top_mm')} "
                  f"-> {layer.get('z_bottom_mm')} mm, "
                  f"{layer.get('loop_count')} loop(s)")
    return 0


def _run_toolpaths_subprocess(job_dir):
    """Run the V3.1 toolpath generator (ts/toolpaths.ts, Bun) against
    a job dir. Returns the generator's parsed stdout JSON (its
    `toolpaths` section). A non-JSON stdout or a failed run maps onto
    the CLI contract (the generator's own named error passes through
    unchanged). The generator never writes job.json itself — the CLI
    merges the section in (cmd_toolpaths), so the file keeps its
    canonical form."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.1 toolpath "
             "generator needs it (https://bun.sh, or set $BUN to the "
             "Bun executable)")
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "toolpaths.ts"),
         str(job_dir), "--json"],
        capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/toolpaths.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok"):
        fail(body.get("error") or "toolpaths_failed",
             body.get("message") or f"toolpaths failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def _run_sim_verify_subprocess(job_dir):
    """Run the V3.4 headless sim verifier (ts/sim_verify.ts, Bun)
    against a job dir. Returns the verifier's parsed stdout JSON
    (its `sim` section plus the per-layer probe results and the
    global no-gouge scan). A non-JSON stdout or a failed run maps
    onto the CLI contract (the verifier's own named error passes
    through unchanged). The verifier never writes job.json itself —
    the CLI merges the `sim` section in (cmd_sim), so the file
    keeps its canonical form — and only on PASS."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.4 sim "
             "verifier needs it (https://bun.sh, or set $BUN to the "
             "Bun executable)")
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "sim_verify.ts"),
         str(job_dir)],
        capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/sim_verify.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok"):
        fail(body.get("error") or "sim_mismatch",
             body.get("message") or f"sim verification failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def cmd_toolpaths(args):
    """`mldxf toolpaths <job-dir>` (V3.1): generate in-house TypeScript
    toolpaths for a finished v2 job and write the `toolpaths` section
    into job.json, bumping job_version to 3 (presence of toolpaths IS
    the v3 marker; V3.2 formalises the rest of the v3 model). The
    plan is never touched and manifest.txt is never touched (frozen
    gadget contract). `mldxf plan` never generates toolpaths — a job
    without toolpaths is still a complete V2 job. Re-running
    toolpaths on a v3 job recomputes from the current plan + DXF
    (the step is idempotent and deterministic: same job + same config
    snapshot -> identical toolpaths). report.md gains the Toolpaths
    (V3.14) section (plan estimate vs toolpath motion time);
    re-running replaces the section, never duplicates it."""
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    if filename != "job.json" or manifest.get("job_version", 1) < 2:
        fail("toolpaths_unavailable",
             f"{job_dir} is a v1 job (manifest.json only) — toolpaths "
             "need the V2.2 job model (job.json with layout + tool "
             "plan + material). v1 jobs are read-only; re-run "
             "`mldxf plan` on the source STEP instead")
    body = _run_toolpaths_subprocess(job_dir)
    job, _filename = _load_job_file(job_dir)
    job["toolpaths"] = body["toolpaths"]
    job["job_version"] = 3
    # V3.14: the report carries the estimate-vs-motion lines, and
    # the outputs hashes refresh for the rewritten report.md —
    # before validation, so the validated bytes are the published
    # ones (the guides' pattern).
    _update_report_toolpaths(job_dir, job)
    blob = _canonical_json_bytes(job)
    # V3.2: validate the merged job BEFORE publishing it, and keep
    # manifest.json a byte-identical copy of job.json (the V2 rule
    # V3.1 broke — it wrote job.json only, leaving manifest.json
    # stale at v2 on every v3 job). The validator runs against the
    # merged bytes in a temp file; a failed validation means the
    # generator and the schema disagree, so the old job is left
    # untouched and the failure is an internal error (exit 2).
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="mldxf_toolpaths_validate_",
                                   suffix=".json")
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
        vbody = _run_validate_job_subprocess(file=tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not vbody.get("ok"):
        fail(vbody.get("error") or "toolpaths_invalid",
             "generated toolpaths failed job-model validation "
             f"(a generator/schema disagreement, not a user mistake): "
             f"{vbody.get('message') or 'no detail'}",
             exit_code=2)
    (job_dir / "job.json").write_bytes(blob)
    (job_dir / "manifest.json").write_bytes(blob)
    job, _filename = _load_job_file(job_dir)
    job["job_dir"] = str(job_dir.resolve())
    if args.json:
        emit_success({"job": job})
    else:
        tp = job.get("toolpaths") or {}
        stats = tp.get("stats") or {}
        print(f"toolpaths for {job_dir} (job_version 3, plan "
              f"{tp.get('plan', '?')})")
        print(f"  {stats.get('operations', '?')} operations, "
              f"{stats.get('moves', '?')} moves "
              f"({stats.get('rapid', '?')} rapid, "
              f"{stats.get('feed', '?')} feed, "
              f"{stats.get('arc', '?')} arc)")
        skipped = tp.get("skipped") or []
        if skipped:
            print(f"  {len(skipped)} skipped loop(s):")
            for s in skipped:
                print(f"    - {s.get('layer')}: {s.get('reason')}: "
                      f"{s.get('detail', '')}")
    return 0


def _refresh_toolpaths_motion(job_dir, job):
    """Recompute the derived motion fields from the toolpaths as they
    sit now (V3.14) and store them on the in-memory job. Motion is a
    deterministic function of the moves, so a hand edit to the moves
    leaves the recorded motion stale — and a stale record blocks any
    later publish that validates the job. The concrete case is the
    V3.8 `gcode --verify` stamp sync: toolpaths moved after posting
    must flip the stamp to verified:false, but the sync publish
    re-validates the job and dies with toolpaths_invalid on the
    stale motion instead (the moved toolpaths genuinely take a
    different time — e.g. shifting one feed endpoint collapses the
    following helical arc's sweep, 221.7 s -> 212.8 s on the
    reference container). Refreshing the derived record before
    publishing keeps the stamp sync (and a fresh post from edited
    toolpaths) publishable. When the moves themselves are broken,
    cuttime fails and the stale fields are left alone, so the
    validator still fails honestly. Read-only w.r.t. the job dir —
    cuttime never writes the job; the caller publishes or not."""
    tp = job.get("toolpaths")
    if not isinstance(tp, dict) or not tp.get("operations"):
        return
    bun = bun_executable()
    if not bun:
        return
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "cuttime.ts"), str(job_dir), "--json"],
        capture_output=True, text=True)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        return
    if not body.get("ok"):
        return
    if isinstance(body.get("motion_time_s"), (int, float)):
        tp["motion_time_s"] = body["motion_time_s"]
    if isinstance(body.get("motion_by_tool"), dict):
        tp["motion_by_tool"] = body["motion_by_tool"]
    if isinstance(body.get("motion_by_operation"), dict):
        tp["motion_by_operation"] = body["motion_by_operation"]


def _publish_job_validated(job_dir, job):
    """Validate a merged job (the V3.2 pattern) and publish it as
    job.json + manifest.json (byte-identical). A failed validation
    means the writer and the schema disagree, so the old job is
    left untouched and the failure is an internal error (exit 2)."""
    blob = _canonical_json_bytes(job)
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="mldxf_gcode_validate_",
                                   suffix=".json")
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
        vbody = _run_validate_job_subprocess(file=tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not vbody.get("ok"):
        fail(vbody.get("error") or "gcode_invalid",
             "job failed job-model validation "
             f"(a writer/schema disagreement, not a user "
             f"mistake): {vbody.get('message') or 'no detail'}",
             exit_code=2)
    (job_dir / "job.json").write_bytes(blob)
    (job_dir / "manifest.json").write_bytes(blob)


def _run_gcode_subprocess(job_dir, post_id):
    """Run the V3.6 G-code exporter (ts/gcode.ts, Bun) against a job
    dir with the named post. Returns the driver's parsed stdout
    JSON (its `gcode` entry, the round-trip numbers, the posted
    line/move counts). The driver writes the .nc file itself but
    never touches job.json — the CLI merges the entry in
    (cmd_gcode), so the file keeps its canonical form. A
    non-JSON stdout or a failed run maps onto the CLI contract
    (the driver's own named error passes through unchanged) —
    EXCEPT `gcode_unverified`: the body is returned, not failed,
    so cmd_gcode can record the unverified entry (the file is on
    disk for inspection) and fail only after publishing it."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.6 "
             "G-code exporter needs it (https://bun.sh, or set "
             "$BUN to the Bun executable)")
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "gcode.ts"),
         str(job_dir), "--post", post_id, "--json"],
        capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/gcode.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok") and body.get("error") != "gcode_unverified":
        fail(body.get("error") or "gcode_failed",
             body.get("message") or f"gcode failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def _run_gcode_verify_subprocess(job_dir, post_id):
    """Run the V3.8 re-verification driver (ts/gcode.ts --verify, Bun)
    against the recorded .nc for a post. Returns the driver's parsed
    stdout JSON (its `gcode` entry, the round-trip numbers, the
    on-disk sha256). The driver writes nothing. A non-JSON stdout or
    a failed run maps onto the CLI contract (the driver's own named
    error passes through unchanged) — EXCEPT `gcode_unverified` and
    `gcode_sha_mismatch`: those bodies are returned, not failed, so
    cmd_gcode can sync the recorded stamp to the observed result
    first (a stale verified:true must not survive a failed
    re-verification) and fail only after publishing the sync."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.8 "
             "G-code re-verifier needs it (https://bun.sh, or set "
             "$BUN to the Bun executable)")
    result = subprocess.run(
        [bun, str(REPO_ROOT / "ts" / "gcode.ts"),
         str(job_dir), "--post", post_id, "--verify", "--json"],
        capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/gcode.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok") and body.get("error") not in (
            "gcode_unverified", "gcode_sha_mismatch"):
        fail(body.get("error") or "gcode_failed",
             body.get("message") or f"gcode verify failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def _cmd_gcode_verify(args, job_dir, post_id):
    """`mldxf gcode --verify <job-dir> [--post <post-id>]` (V3.8):
    re-verify the recorded .nc for a post — the file as it sits on
    disk, against the toolpaths as they sit in job.json now. The
    recorded `verified` stamp is synced to the observed result
    (validated before publishing, manifest.json byte-identical)
    and the command exits 0 when the file verifies, 1 with the
    named error otherwise (`gcode_not_posted` / `gcode_file_missing`
    / `gcode_sha_mismatch` / `gcode_unverified`). A file that no
    longer verifies is never presented as ready to run: the stamp
    says so in job.json, and the UI shows UNVERIFIED. A sync that
    changes nothing writes nothing — a clean re-verification leaves
    the job bytes untouched (not even `generated_at`)."""
    body = _run_gcode_verify_subprocess(job_dir, post_id)
    entry = dict(body.get("gcode") or {})
    roundtrip = body.get("roundtrip") or {}
    observed = bool(body.get("ok")) and bool(entry.get("verified"))
    job, _filename = _load_job_file(job_dir)
    entries = job.get("gcode")
    if not isinstance(entries, list):
        entries = []
    recorded = next(
        (e for e in entries
         if isinstance(e, dict) and e.get("post_id") == post_id),
        None)
    if recorded is not None:
        changed = False
        if bool(recorded.get("verified")) != observed:
            recorded["verified"] = observed
            changed = True
        actual_sha = body.get("sha256")
        if (isinstance(actual_sha, str) and actual_sha
                and recorded.get("sha256") != actual_sha):
            recorded["sha256"] = actual_sha
            changed = True
            outputs = job.get("outputs")
            if isinstance(outputs, list):
                for o in outputs:
                    if (isinstance(o, dict)
                            and o.get("file") == recorded.get("file")):
                        o["sha256"] = actual_sha
        if changed:
            # V3.14: refresh the derived motion record from the
            # toolpaths as they sit now before the validating
            # publish — a hand edit to the moves stales the recorded
            # motion, and the stale record must not block the stamp
            # sync (a failed re-verification must flip the stamp to
            # verified:false, not die with toolpaths_invalid).
            _refresh_toolpaths_motion(job_dir, job)
            _publish_job_validated(job_dir, job)
    job, _filename = _load_job_file(job_dir)
    job["job_dir"] = str(job_dir.resolve())
    if observed:
        if args.json:
            emit_success({"job": job, "gcode": entry,
                          "roundtrip": roundtrip})
        else:
            print(f"gcode for {job_dir} (post {post_id}, verified)")
            print(f"  {entry.get('file')} — sha "
                  f"{str(entry.get('sha256', ''))[:12]}… matches the "
                  "recorded entry; round-trip: "
                  f"{roundtrip.get('mismatched', '?')} mismatched / "
                  f"{roundtrip.get('columns', '?')} columns after the "
                  "band test (largest cluster "
                  f"{roundtrip.get('maxCluster', '?')}, max diff "
                  f"{roundtrip.get('maxDiffMm', '?')} mm)")
        return 0
    # Refusal: in --json mode print nothing here — the error below
    # is the only stdout object, so a consumer (notably the server's
    # runCliJob, which parses stdout as one JSON object) reads the
    # named error cleanly; the synced entry is on disk
    # (`mldxf job --json` shows it, verified: false).
    if not args.json:
        print(f"gcode for {job_dir} (post {post_id}, "
              "UNVERIFIED — do not run)")
        print(f"  {entry.get('file')} — the recorded stamp is now "
              "unverified in job.json + manifest.json; the file is "
              "for inspection only")
    fail(body.get("error") or "gcode_unverified",
         body.get("message")
         or f"recorded G-code through {post_id} does NOT verify — "
         "the entry is recorded unverified in job.json + "
         "manifest.json; the file is for inspection only, never "
         "ready to run")


def _resolve_post_id(job, args):
    """Post selection (V3.6, hardened V3.8): `--post` > the job's
    `machine_profile.post_processor` > the home `machine.json`
    `post_processor` > the default `masso-mm`. A missing or
    unreadable machine.json falls through to the default — the
    post is a property of the job run, not of the library, so a
    missing library file never blocks posting. But a machine.json
    that EXISTS and fails validation (including an unknown
    post_processor) is a LOUD failure, never a silent fall-through:
    swallowing it here used to post the default while the operator
    believed their chosen post was in effect (V3.8). Only
    home_not_initialized (no home / no machine.json at all) falls
    through. An unknown name from --post or the job profile is
    refused downstream by the TS driver (`post_unknown`)."""
    flag = getattr(args, "post", None)
    if isinstance(flag, str) and flag:
        return flag
    profile = job.get("machine_profile")
    if isinstance(profile, dict):
        pp = profile.get("post_processor")
        if isinstance(pp, str) and pp:
            return pp
    try:
        _cfg, machine = _load_library("load_machine")
    except CliError as e:
        if e.name == "home_not_initialized":
            machine = None
        else:
            raise
    except Exception:
        machine = None
    if isinstance(machine, dict):
        pp = machine.get("post_processor")
        if isinstance(pp, str) and pp:
            return pp
    return "masso-mm"


def cmd_gcode(args):
    """`mldxf gcode <job-dir> [--post <post-id>]` (V3.6): G-code
    export through a native post-processor (ts/gcode.ts + ts/posts).
    The post is selected `--post` > the job's
    `machine_profile.post_processor` > the home `machine.json`
    `post_processor` > the default `masso-mm`; the effective post
    is recorded back into the job's `machine_profile` (when the
    profile is a dict). The driver posts, parses the file back,
    and re-simulates it through the V3.4 dexel engine; the
    resulting `gcode` entry (one per post run — a re-post replaces
    the same `post_id`'s entry) is merged into job.json +
    manifest.json (byte-identical, canonical form, validated
    before publishing — the cmd_toolpaths pattern), and the file
    is listed in `outputs`. On a round-trip mismatch the entry is
    still published — `verified: false`, downloadable for
    inspection — and the command then fails `gcode_unverified`
    (exit 1): an unverified file is never presented as ready to
    run. Limit, unknown-post, and tool failures write no file and
    no entry. Deterministic: re-posting the same job through the
    same post reproduces the same bytes and sha256 (the entry
    carries its own `generated_at`, so the job.json bytes change
    only in that timestamp). `mldxf rerun` rebuilds the job and
    drops the `gcode` section and files — re-post after a rerun.
    The plan is never touched and manifest.txt is never touched
    (frozen gadget contract). `--verify` (V3.8) re-verifies the
    recorded .nc instead of posting: entry, file, sha256, then the
    round-trip — syncing the recorded `verified` stamp to the
    observed result, exit 1 with a named error when it no longer
    verifies (see _cmd_gcode_verify)."""
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    if filename != "job.json" or manifest.get("job_version", 1) < 2:
        fail("toolpaths_unavailable",
             f"{job_dir} is a v1 job (manifest.json only) — G-code "
             "export needs the V2.2 job model (job.json with layout "
             "+ tool plan + material). v1 jobs are read-only; "
             "re-run `mldxf plan` on the source STEP instead")
    if not manifest.get("toolpaths"):
        fail("toolpaths_unavailable",
             f"{job_dir} has no toolpaths — G-code is posted from "
             "the toolpaths. Run `mldxf toolpaths` first")
    post_id = _resolve_post_id(manifest, args)
    if getattr(args, "verify", False):
        return _cmd_gcode_verify(args, job_dir, post_id)
    body = _run_gcode_subprocess(job_dir, post_id)
    entry = dict(body.get("gcode") or {})
    entry["generated_at"] = _now_iso()
    roundtrip = body.get("roundtrip") or {}
    posted = body.get("posted") or {}
    job, _filename = _load_job_file(job_dir)
    entries = job.get("gcode")
    if not isinstance(entries, list):
        entries = []
    entries = [e for e in entries
               if not (isinstance(e, dict)
                       and e.get("post_id") == entry.get("post_id"))]
    entries.append(entry)
    job["gcode"] = entries
    outputs = job.get("outputs")
    if not isinstance(outputs, list):
        outputs = []
    outputs = [o for o in outputs
               if not (isinstance(o, dict)
                       and o.get("file") == entry.get("file"))]
    outputs.append({"file": entry.get("file"),
                    "sha256": entry.get("sha256")})
    job["outputs"] = outputs
    profile = job.get("machine_profile")
    if isinstance(profile, dict):
        profile["post_processor"] = entry.get("post_id")
    # V3.2: validate the merged job BEFORE publishing it, and keep
    # manifest.json a byte-identical copy of job.json. A failed
    # validation means the exporter and the schema disagree, so
    # the old job is left untouched and the failure is an internal
    # error (exit 2). (The .nc file is already on disk; it is
    # simply not recorded — it is not listed in `outputs` and has
    # no `gcode` entry.) Refresh the derived motion record first
    # (V3.14): a hand edit to the moves stales the recorded motion,
    # and the stale record must not block recording a fresh post.
    _refresh_toolpaths_motion(job_dir, job)
    _publish_job_validated(job_dir, job)
    job, _filename = _load_job_file(job_dir)
    job["job_dir"] = str(job_dir.resolve())
    verified = bool(entry.get("verified"))
    stamp = "verified" if verified else "UNVERIFIED — do not run"
    if verified and args.json:
        emit_success({"job": job, "gcode": entry,
                      "roundtrip": roundtrip, "posted": posted})
    elif verified:
        print(f"gcode for {job_dir} (post {entry.get('post_id')}, "
              f"{stamp})")
        print(f"  {entry.get('file')} — "
              f"{posted.get('lines', '?')} lines, "
              f"{roundtrip.get('movesParsed', '?')} moves parsed "
              f"(sha {str(entry.get('sha256', ''))[:12]}…) — entry "
              "written to job.json + manifest.json")
        print(f"  round-trip: {roundtrip.get('mismatched', '?')} "
              f"mismatched / {roundtrip.get('columns', '?')} columns "
              f"after the band test (largest cluster "
              f"{roundtrip.get('maxCluster', '?')}, max diff "
              f"{roundtrip.get('maxDiffMm', '?')} mm, tolerance "
              f"{roundtrip.get('toleranceMm', '?')} mm)")
    else:
        # Unverified: the entry IS published (above), but the
        # command fails. In --json mode print nothing here — the
        # error below is the only stdout object, so a consumer
        # (notably the server's runCliJob, which parses stdout as
        # one JSON object) reads `gcode_unverified` cleanly; the
        # recorded entry is on disk (`mldxf job --json` shows it).
        # In human mode print the lines first, so the failure
        # still names the file and the numbers.
        if not args.json:
            print(f"gcode for {job_dir} (post "
                  f"{entry.get('post_id')}, {stamp})")
            print(f"  {entry.get('file')} — "
                  f"{posted.get('lines', '?')} lines, "
                  f"{roundtrip.get('movesParsed', '?')} moves parsed "
                  f"(sha {str(entry.get('sha256', ''))[:12]}…) — "
                  "entry written to job.json + manifest.json")
            print(f"  round-trip: "
                  f"{roundtrip.get('mismatched', '?')} mismatched / "
                  f"{roundtrip.get('columns', '?')} columns after "
                  f"the band test (largest cluster "
                  f"{roundtrip.get('maxCluster', '?')}, max diff "
                  f"{roundtrip.get('maxDiffMm', '?')} mm, tolerance "
                  f"{roundtrip.get('toleranceMm', '?')} mm)")
        fail("gcode_unverified",
             body.get("message")
             or f"posted G-code through {entry.get('post_id')} does "
             "NOT round-trip — the entry is recorded unverified in "
             "job.json + manifest.json; the file is for inspection "
             "only, never ready to run")
    return 0


def _run_sim_seek_subprocess(job_dir, move, time_s):
    """Run the V3.5 headless seek (ts/sim_seek_cli.ts, Bun) against a
    job dir. Returns the seek CLI's parsed stdout JSON (the stock
    state at the requested move/time). Read-only: the seek never
    writes job.json — a missing/stale delta log is rebuilt in memory
    (the CLI says so in `delta_log`). A non-JSON stdout or a failed
    run maps onto the CLI contract (the seek CLI's own named error
    passes through unchanged)."""
    bun = bun_executable()
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.5 sim "
             "seek needs it (https://bun.sh, or set $BUN to the "
             "Bun executable)")
    cmd = [bun, str(REPO_ROOT / "ts" / "sim_seek_cli.ts"),
           str(job_dir)]
    if move is not None:
        cmd += ["--move", str(move)]
    else:
        cmd += ["--time", str(time_s)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        fail("internal_error",
             "ts/sim_seek_cli.ts produced no JSON on stdout "
             f"(exit {result.returncode}): "
             f"{_last_lines(result.stderr, 2)}",
             exit_code=2)
    if not body.get("ok"):
        fail(body.get("error") or "sim_seek_failed",
             body.get("message") or f"sim seek failed for {job_dir}",
             exit_code=2 if body.get("error") == "internal_error" else 1)
    return body


def cmd_sim(args):
    """`mldxf sim --verify <job-dir>` (V3.4): headless cut-simulation
    verification (dexel sim of the job's toolpaths against the
    intended geometry, ts/sim_verify.ts). On PASS the `sim` section
    is merged into job.json and manifest.json (byte-identical,
    canonical form, validated before publishing — the cmd_toolpaths
    pattern). On FAIL the named error propagates, exit 1, and
    nothing is written — a failing verification never records a
    `sim` section. The plan is never touched and manifest.txt is
    never touched (frozen gadget contract).

    `mldxf sim --seek <job-dir> --move N | --time T` (V3.5):
    rewind/seek the stock to a move index or cut time, headlessly
    (ts/sim_seek_cli.ts), and report the stock state there. Read
    only — it never writes job.json."""
    require_config_file(args.config)
    if getattr(args, "seek", False):
        if getattr(args, "verify", False):
            fail("usage_error",
                 "`mldxf sim` takes exactly one of --verify / --seek")
        if (args.move is None) == (args.time is None):
            fail("usage_error",
                 "`mldxf sim --seek` needs exactly one of --move N "
                 "(move index) or --time T (cut seconds)")
        if args.move is not None and args.move < 0:
            fail("usage_error", "--move needs a non-negative integer")
        if args.time is not None and args.time < 0:
            fail("usage_error", "--time needs a non-negative number of seconds")
        job_dir = Path(args.job_dir)
        if not job_dir.is_dir():
            fail("job_not_found", f"job dir not found: {job_dir}")
        body = _run_sim_seek_subprocess(job_dir, args.move, args.time)
        if args.json:
            emit_success(body)
        else:
            stock = body.get("stock") or {}
            seek = body.get("seek") or {}
            print(f"sim seek for {job_dir}: move {body.get('move')} "
                  f"of {body.get('total_moves')} "
                  f"({body.get('time_s')} s of {body.get('total_seconds')} s cut time)")
            print(f"  delta log: {body.get('delta_log')} "
                  f"({body.get('delta_file') or 'rebuilt in memory — run `mldxf sim --verify` to write it'})")
            print(f"  stock: {stock.get('columns_lowered', '?')} columns lowered, "
                  f"min height {stock.get('min_height_mm', '?')} mm, "
                  f"volume removed {stock.get('volume_removed_mm3', '?')} mm3 "
                  f"({stock.get('volume_fraction', '?')} of the stock)")
            print(f"  seek took {seek.get('seek_ms', '?')} ms "
                  f"({seek.get('resimulated_moves', '?')} moves re-simulated, "
                  f"+{seek.get('applied_chunks', '?')} chunks, "
                  f"-{seek.get('reverted_chunks', '?')} chunks)")
        return 0
    if not getattr(args, "verify", False):
        fail("usage_error",
             "`mldxf sim` only runs as `mldxf sim --verify <job-dir>` "
             "(headless verification, V3.4) or `mldxf sim --seek "
             "<job-dir> --move N | --time T` (headless seek, V3.5)")
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    if filename != "job.json" or manifest.get("job_version", 1) < 2:
        fail("toolpaths_unavailable",
             f"{job_dir} is a v1 job (manifest.json only) — sim "
             "verification needs the V2.2 job model (job.json with "
             "layout + tool plan + material). v1 jobs are read-only; "
             "re-run `mldxf plan` on the source STEP instead")
    if not manifest.get("toolpaths"):
        fail("toolpaths_unavailable",
             f"{job_dir} has no toolpaths — the sim simulates the "
             "toolpaths. Run `mldxf toolpaths` first")
    body = _run_sim_verify_subprocess(job_dir)
    job, _filename = _load_job_file(job_dir)
    job["sim"] = body["sim"]
    blob = _canonical_json_bytes(job)
    # V3.2: validate the merged job BEFORE publishing it, and keep
    # manifest.json a byte-identical copy of job.json. The validator
    # runs against the merged bytes in a temp file; a failed
    # validation means the verifier and the schema disagree, so the
    # old job is left untouched and the failure is an internal error
    # (exit 2).
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="mldxf_sim_validate_",
                                   suffix=".json")
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
        vbody = _run_validate_job_subprocess(file=tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not vbody.get("ok"):
        fail(vbody.get("error") or "sim_invalid",
             "verified sim failed job-model validation "
             f"(a verifier/schema disagreement, not a user mistake): "
             f"{vbody.get('message') or 'no detail'}",
             exit_code=2)
    (job_dir / "job.json").write_bytes(blob)
    (job_dir / "manifest.json").write_bytes(blob)
    job, _filename = _load_job_file(job_dir)
    job["job_dir"] = str(job_dir.resolve())
    if args.json:
        emit_success({"job": job})
    else:
        sim = body.get("sim") or {}
        counts = body.get("counts") or {}
        timing = body.get("timing") or {}
        glob = body.get("global") or {}
        print(f"sim verified for {job_dir} (pitch "
              f"{sim.get('pitch_mm', '?')} mm"
              f"{', coarse' if sim.get('pitch_coarse') else ''}, "
              f"{counts.get('probes', '?')} probes, "
              f"{counts.get('failed_probes', '?')} failed, "
              f"{glob.get('gouge_columns', '?')} gouge columns)")
        print(f"  sim ran in {timing.get('sim_ms', '?')} ms "
              f"({timing.get('ratio_vs_plan', '?')}x real time); "
              "`sim` section written to job.json + manifest.json")
        seek = body.get("seek") or {}
        if seek:
            print(f"  delta log: {seek.get('file', '?')} — "
                  f"{seek.get('chunks', '?')} chunks, "
                  f"{seek.get('entries', '?')} entries, "
                  f"{seek.get('checkpoints', '?')} checkpoints, "
                  f"{seek.get('bytes', '?')} bytes")
    return 0


def format_job_human(manifest, job_dir):
    """Human-readable `mldxf job` output: plan, flags, post-processing
    steps, layout — from the manifest (v1) or job.json (v2)."""
    lines = [f"job: {job_dir}",
             f"source: {manifest.get('source_step', '?')} "
             f"(job_version {manifest.get('job_version', 1)})"]
    parts = manifest.get("parts") or []
    if parts:
        lines.append(f"parts ({len(parts)}):")
        for p in parts:
            pos = ""
            if p.get("x_mm") is not None:
                pos = f" at ({p['x_mm']:.1f}, {p['y_mm']:.1f})"
            lines.append(
                f"  - {p.get('name', '?')}: "
                f"{p.get('footprint_mm', '?')} mm, "
                f"{p.get('height_mm', '?')} mm tall{pos}, "
                f"{len(p.get('layers', []))} layers")
    else:
        stock = manifest.get("stock") or {}
        if stock:
            lines.append(
                f"stock: {stock.get('x_max', 0) - stock.get('x_min', 0):.1f} x "
                f"{stock.get('y_max', 0) - stock.get('y_min', 0):.1f} x "
                f"{stock.get('thickness', '?')} mm")
    lines.append(f"layers: {len(manifest.get('layers', []))}")
    layout = manifest.get("layout")
    if layout:
        lines.append("layout:")
        for entry in layout:
            lines.append(
                f"  - {entry.get('name', '?')}: "
                f"({entry.get('x_mm')}, {entry.get('y_mm')}) "
                f"{entry.get('w_mm')} x {entry.get('d_mm')} mm, "
                f"rotate_z {entry.get('rotate_z_deg')}")
    if manifest.get("material"):
        mat = manifest["material"]
        lines.append(f"material: {mat['x']:.1f} x {mat['y']:.1f} x "
                     f"{mat['thickness']:.1f} mm")
    elif manifest.get("suggested_material"):
        sug = manifest["suggested_material"]
        lines.append(f"suggested material: {sug['x']:.0f} x {sug['y']:.0f} x "
                     f"{sug['thickness']:.0f} mm")
    if manifest.get("registration_pins"):
        lines.append("registration pins: " + ", ".join(
            f"({p['x']:.1f}, {p['y']:.1f}) D{p['diameter_mm']:.0f}"
            for p in manifest["registration_pins"]))
    tool_plan = manifest.get("tool_plan") or {}
    state = _inventory_state(manifest)
    if state == "empty":
        lines.append("tool inventory: none recorded — ownership unknown; "
                     "plan shown as in V1")
    for p in tool_plan.get("plans") or []:
        if state == "recorded":
            tools, n_unowned = _display_tools(p)
        else:
            tools = ", ".join(t.get("name", t.get("id", "?"))
                              for t in p.get("tools", []))
            n_unowned = 0
        lines.append(f"  Plan {p.get('id')}: {tools} — "
                     f"{p.get('total_seconds', 0) / 60.0:.1f} min")
        if n_unowned:
            lines.append(f"    -> {n_unowned} tool(s) not in your "
                         "inventory — check before you cut (flagged, "
                         "not dropped)")
    steps = post_process_steps(manifest)
    tp = manifest.get("toolpaths")
    if tp is not None:
        # V3.2: the toolpaths summary in `mldxf job` — operations /
        # moves per operation, skipped loops shown, never hidden.
        stats = tp.get("stats") or {}
        lines.append(
            f"toolpaths (v3, plan {tp.get('plan', '?')}, clearance "
            f"{tp.get('clearance_z_mm', '?')} mm): "
            f"{stats.get('operations', '?')} operations, "
            f"{stats.get('moves', '?')} moves "
            f"({stats.get('rapid', '?')} rapid, "
            f"{stats.get('feed', '?')} feed, "
            f"{stats.get('arc', '?')} arc)")
        for op in tp.get("operations") or []:
            moves = op.get("moves") or []
            n_rapid = sum(1 for m in moves if m.get("t") == "rapid")
            n_feed = sum(1 for m in moves if m.get("t") == "feed")
            n_arc = sum(1 for m in moves if m.get("t") == "arc")
            lines.append(
                f"  - {op.get('operation', '?')} {op.get('layer', '?')} "
                f"({op.get('tool_id', '?')}, "
                f"{(op.get('pass') or {}).get('kind', '?')}"
                f"{' #' + str((op.get('pass') or {}).get('stepdown_index')) if (op.get('pass') or {}).get('stepdown_index') is not None else ''}): "
                f"{len(moves)} moves ({n_rapid} rapid, {n_feed} feed, "
                f"{n_arc} arc)")
        for s in tp.get("skipped") or []:
            lines.append(
                f"  - SKIPPED {s.get('layer', '?')} loop "
                f"{s.get('loop', '?')}: {s.get('reason', '?')}: "
                f"{s.get('detail', '')}")
        if not (tp.get("skipped") or []):
            lines.append("  - no loops skipped")
        # V3.14: estimate vs motion, same words as report.md.
        for line in _toolpaths_motion_lines(manifest, indent="  "):
            lines.append(line)
    gc = manifest.get("gcode")
    if isinstance(gc, list) and gc:
        lines.append(f"gcode ({len(gc)} run(s)):")
        for e in gc:
            stamp = "verified" if e.get("verified") \
                else "UNVERIFIED — do not run"
            lines.append(
                f"  - {e.get('post_id', '?')}: {e.get('file', '?')} "
                f"({stamp}, sha {str(e.get('sha256', ''))[:8]}…, "
                f"{e.get('generated_at', '?')})")
    lines.append(f"post-processing ({len(steps)} steps):")
    lines.extend(f"  - {s}" for s in steps) if steps else \
        lines.append("  - none — part is fully prismatic")
    wh = manifest.get("workholding")
    if wh is None:
        lines.append("workholding: no guides yet — run "
                     f"`mldxf guides {job_dir}`")
    elif isinstance(wh, dict):
        lines.extend(_format_workholding_human(wh, indent="  "))
    flags = manifest.get("flags") or []
    lines.append(f"flags ({len(flags)}):")
    lines.extend(f"  - {f}" for f in flags) if flags else \
        lines.append("  - none")
    return "\n".join(lines)


# ---------------------------------------------------------------- commands

def cmd_plan(args):
    require_config_file(args.config)
    # Fail fast on a bad --config z_zero (docs-v3/z_zero.md) —
    # the snapshot (and its validation) is built after the child
    # runs, so without this the run would spend minutes in the
    # child before refusing. An unparseable file is left for the
    # child to refuse as before; only a parsed bad value fails
    # here.
    if args.config:
        try:
            _validate_config_z_zero(
                json.loads(Path(args.config).read_text()), "--config file")
        except json.JSONDecodeError:
            pass
    step = Path(args.step)
    if not step.is_file():
        fail("step_file_not_found", f"STEP file not found: {step}")
    n_solids = count_solids(step)
    if n_solids == 0:
        fail("no_solids", f"no solids in STEP {step}")
    path_kind = "single" if n_solids == 1 else "multi"
    script = "step_to_vcarve.py" if n_solids == 1 else "multi_part.py"
    progress(f"{n_solids} solid(s) in STEP — {path_kind}-part path "
             f"({script})")

    if args.out:
        outdir = Path(args.out)
    else:
        # Settled §10 default (Q2): jobs live under <MLDXF_HOME>/jobs/.
        cfg = load_config_module()
        try:
            home = cfg.resolve_home()
        except Exception as e:  # ConfigError from the V2.3 module
            fail(config_error_name(e), str(e))
        if not home.is_dir():
            fail("home_not_initialized",
                 f"library home {home} does not exist — run `mldxf init` "
                 "to create it (jobs live under <MLDXF_HOME>/jobs/ by "
                 "default, so the home must exist first)")
        slug = re.sub(r"[^a-z0-9]+", "-", step.stem.lower()).strip("-")[:40]
        job_id = (datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                  + (f"-{slug}" if slug else ""))
        outdir = home / "jobs" / job_id

    # V2.2 (V2_SCOPE.md §8 Q5): the child runs into a temporary
    # sibling dir and the finished job is renamed into place, so a
    # crashed run never leaves a half-written job dir. The child
    # records the outdir path in per-part manifests, so the temp
    # path is fixed up to the final path before the rename.
    tmpdir = _make_temp_sibling(outdir)
    try:
        argv = plan_child_argv(script, step, tmpdir, args)
        argv = _append_path_flags(argv, path_kind, args)
        result = run_pipeline(argv, step)
        if result.returncode != 0:
            child_error(result, f"mldxf plan ({script})")

        if args.mode == "check":
            # --mode check writes no manifest/DXF; the subset comes from
            # the child's stdout, exactly like `mldxf check`. The temp
            # dir is deleted by the finally below; no job dir is created.
            job = check_job_object(step, path_kind,
                                   parse_check_output(result.stdout))
            job["job_dir"] = str(outdir.resolve()) \
                if outdir.exists() else str(outdir)
        elif (tmpdir / "manifest.json").is_file():
            snapshot, machine_profile = _build_config_snapshot(
                args, step, path_kind)
            _fixup_outdir_paths(tmpdir, tmpdir, outdir)
            job = _assemble_job(
                tmpdir, job_id=outdir.name, source_step=str(step),
                source_step_sha256=_sha256_file(step),
                inputs_embedded=not args.no_embed,
                config_snapshot=snapshot, machine_profile=machine_profile,
                step_source=step,
                parts_source=args.parts
                if path_kind == "multi" and args.parts else None)
            _assert_no_path(tmpdir, str(tmpdir))
            _swap_into_place(tmpdir, outdir)
            job["job_dir"] = str(outdir.resolve())
            job["path"] = path_kind
        else:
            # --mode dxf writes DXF + report, no manifest: no v2 job
            # model (there is no manifest to version). The files are
            # still swapped into place atomically.
            _fixup_outdir_paths(tmpdir, tmpdir, outdir)
            _assert_no_path(tmpdir, str(tmpdir))
            _swap_into_place(tmpdir, outdir)
            m = _COUNTS_RE.search(result.stdout or "")
            counts = (tuple(int(v) for v in m.groups())
                      if m else (0, 0, 0, 0))
            job = {"command": "plan", "source_step": str(step),
                   "path": path_kind, "mode": args.mode,
                   "job_dir": str(outdir.resolve()),
                   "layers": counts[0], "holes": counts[1],
                   "pockets": counts[2], "flags": counts[3],
                   "dxf": str(outdir / f"{step.stem}.dxf")}
    finally:
        # After a successful swap tmpdir no longer exists; after any
        # failure this removes the half-written temp dir. The finished
        # job dir (or the pre-existing one, on failure) is untouched.
        shutil.rmtree(tmpdir, ignore_errors=True)

    if args.json:
        emit_success({"job": job})
    else:
        if args.mode == "check":
            print(format_check_human(job))
        else:
            manifest_path = outdir / "manifest.json"
            if manifest_path.is_file():
                print(summarize_plan_human(job, outdir))
            else:
                print(f"wrote {outdir}\n"
                      f"{job['layers']} layers, {job['holes']} holes, "
                      f"{job['pockets']} pockets, {job['flags']} flags")
    return 0


def format_check_human(job):
    lines = [f"{job['source_step']}: {job['path']}-part classification"]
    for p in job["parts"]:
        label = p["label"] or "part"
        lines.append(f"  {label}: {p['layers']} layers, {p['holes']} holes, "
                     f"{p['pockets']} pockets, {p['flags']} flags")
        lines.extend(f"    FLAG: {f}" for f in p["flag_text"])
    t = job["totals"]
    lines.append(f"total: {t['layers']} layers, {t['holes']} holes, "
                 f"{t['pockets']} pockets, {t['flags']} flags")
    return "\n".join(lines)


def cmd_check(args):
    require_config_file(args.config)
    step = Path(args.step)
    if not step.is_file():
        fail("step_file_not_found", f"STEP file not found: {step}")
    n_solids = count_solids(step)
    if n_solids == 0:
        fail("no_solids", f"no solids in STEP {step}")
    path_kind = "single" if n_solids == 1 else "multi"
    script = "step_to_vcarve.py" if n_solids == 1 else "multi_part.py"
    progress(f"{n_solids} solid(s) in STEP — {path_kind}-part path "
             f"({script}), classify only")

    argv = plan_child_argv(script, step, "", args)
    if path_kind == "single":
        if args.auto:
            argv += ["--auto-orient"]
    else:
        if getattr(args, "parts", None):
            argv += ["--parts", str(args.parts)]
        if args.auto:
            argv += ["--auto"]
    # check writes into a scratch dir that is deleted afterwards:
    # V1 --mode check writes nothing for VCarve, and neither does this.
    tmpdir = Path(tempfile.mkdtemp(prefix="mldxf_check_"))
    try:
        argv[argv.index("-o") + 1] = str(tmpdir)
        result = run_pipeline(argv, step)
        if result.returncode != 0:
            child_error(result, f"mldxf check ({script})")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    job = check_job_object(step, path_kind,
                           parse_check_output(result.stdout))
    if args.json:
        emit_success({"job": job})
    else:
        print(format_check_human(job))
    return 0


def _load_job_file(job_dir):
    """Read a job dir's model: job.json (v2) when present, else
    manifest.json (v1). Returns (data, filename)."""
    for filename in ("job.json", "manifest.json"):
        path = job_dir / filename
        if path.is_file():
            try:
                return json.loads(path.read_text()), filename
            except json.JSONDecodeError as e:
                fail("job_invalid",
                     f"{path} is not valid JSON: {e}")
    fail("job_invalid",
         f"no manifest.json (v1) or job.json (v2) in {job_dir} — "
         "not a job dir")


def cmd_job(args):
    require_config_file(args.config)
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    job = dict(manifest)
    job["job_dir"] = str(job_dir.resolve())
    job["job_version"] = manifest.get("job_version", 1)
    job["manifest_file"] = filename
    if args.json:
        emit_success({"job": job})
    else:
        print(format_job_human(manifest, job_dir))
    return 0


def cmd_rerun(args):
    require_config_file(args.config)
    if getattr(args, "config", None) is not None:
        # The snapshot is authoritative: a --config here would
        # silently change the rerun's inputs, so it is refused.
        fail("rerun_config_override",
             "rerun replays the job's recorded config snapshot — "
             "--config is not accepted on rerun (the snapshot's "
             "config file is what the rerun uses)")
    job_dir = Path(args.job_dir)
    if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found: {job_dir}")
    manifest, filename = _load_job_file(job_dir)
    if filename != "job.json" or manifest.get("job_version", 1) < 2:
        # Every v1 job: no embedded inputs, no config snapshot (§8 Q10).
        fail("rerun_unavailable",
             f"{job_dir} is a v1 job (manifest.json only) — rerun needs the "
             "V2.2 job model (job.json with embedded inputs + config "
             "snapshot). v1 jobs are read-only; re-run `mldxf plan` on the "
             "source STEP instead")
    snapshot = manifest.get("config_snapshot")
    if not isinstance(snapshot, dict) \
            or not isinstance(snapshot.get("cli_flags"), dict):
        fail("job_invalid",
             f"{job_dir} is a v2 job but its job.json has no usable "
             "config snapshot — rerun cannot reproduce it")
    # V3.2: a job carrying toolpaths but not marked v3 is corrupt
    # (presence of toolpaths IS the v3 marker) — refuse before
    # touching the job dir rather than silently dropping them.
    if manifest.get("toolpaths") is not None \
            and manifest.get("job_version") != 3:
        fail("job_invalid",
             f"{job_dir} carries a toolpaths section but job_version "
             f"is {manifest.get('job_version')} — the section is "
             "corrupt (toolpaths present ⟺ job_version 3). Repair "
             "the version or regenerate with `mldxf toolpaths`")
    # Rerun + guides (V2.9, settled): a rerun REPRODUCES the
    # guides from the recorded provenance — guides are a pure
    # function of the job geometry plus the machine/clamp inputs
    # they ran against, and the provenance records exactly those
    # inputs, so the replay is deterministic. A job whose
    # workholding has no usable provenance cannot be replayed, and
    # the rerun fails here — before touching the job dir — rather
    # than silently producing a job that lost its guides (or one
    # that claims guides it does not have). A job with no guides
    # (workholding null) reruns without guides, as before.
    old_workholding = manifest.get("workholding")
    replay_inputs = None
    if isinstance(old_workholding, dict):
        prov = old_workholding.get("provenance")
        if not isinstance(prov, dict) \
                or not isinstance(prov.get("machine"), dict) \
                or not isinstance(prov.get("clamps"), list):
            fail("rerun_guides_unreplayable",
                 f"{job_dir} has workholding guides but job.json "
                 "records no usable guides provenance (machine + "
                 "clamp inputs) to replay them from — rerun refuses "
                 "to silently drop the guides. Re-run `mldxf "
                 "guides` on the rerun job instead, or restore a "
                 "job.json with provenance")
        replay_inputs = {
            "machine": prov["machine"],
            "clamps": {"version": prov.get("clamps_version"),
                       "clamps": prov["clamps"]},
        }
    if manifest.get("cli_version") and manifest["cli_version"] != VERSION:
        progress(f"warning: job was written by mldxf "
                 f"{manifest['cli_version']}, this CLI is {VERSION} — "
                 "rerunning with the current CLI; the new cli_version "
                 "is recorded in job.json")
    job_id = manifest.get("job_id") or job_dir.name
    source_step_recorded = manifest.get("source_step")
    if not source_step_recorded:
        fail("job_invalid",
             f"{job_dir}: job.json has no source_step — rerun cannot "
             "reproduce it")
    inputs_embedded = manifest.get("inputs_embedded", True)
    recorded_sha = manifest.get("source_step_sha256")
    if inputs_embedded:
        step_source = job_dir / "inputs" / "input.step"
        if not step_source.is_file():
            fail("rerun_inputs_missing",
                 f"{job_dir} records inputs_embedded=true but "
                 "inputs/input.step is missing — the embedded input "
                 "is gone, so rerun cannot reproduce the job")
    else:
        step_source = Path(source_step_recorded)
        if not step_source.is_file():
            fail("rerun_source_missing",
                 f"{job_dir} was planned with --no-embed and the "
                 "original STEP no longer exists at "
                 f"{source_step_recorded} — rerun needs that file")
    actual_sha = _sha256_file(step_source)
    if recorded_sha and actual_sha != recorded_sha:
        fail("rerun_inputs_changed",
             "the STEP rerun would use does not match the sha256 "
             f"recorded in job.json ({recorded_sha[:12]}... vs "
             f"{actual_sha[:12]}...) — the input changed since the "
             "job was planned; rerun refuses to reproduce a "
             "different job")
    cli_flags = snapshot["cli_flags"]
    path_kind = cli_flags.get("path")
    if path_kind not in ("single", "multi"):
        # Jobs written before the path was recorded (none exist
        # yet, but be forgiving): re-probe the STEP's solid count.
        n_solids = count_solids(step_source)
        path_kind = "single" if n_solids == 1 else "multi"
    script = "step_to_vcarve.py" if path_kind == "single" else "multi_part.py"
    progress(f"rerun {job_dir} — {path_kind}-part path ({script})")
    parts_source = job_dir / "inputs" / "parts.json"
    if not parts_source.is_file():
        parts_source = None
    rargs = SimpleNamespace(
        mode=cli_flags.get("mode", "full"),
        only=cli_flags.get("only", ""),
        min_tool=cli_flags.get("min_tool", 0.0),
        material=cli_flags.get("material"),
        plan=cli_flags.get("plan", ""),
        auto=bool(cli_flags.get("auto", False)),
        config=None, parts=parts_source)
    # The child must see the same stem the original run saw: the DXF
    # name, the report title and manifest.txt's "# dxf:" line all
    # come from args.step.stem. The embedded copy is
    # inputs/input.step, so materialize it under the original stem
    # in a scratch dir inside the temp outdir (deleted before the
    # rename) — and the job's recorded config file alongside it.
    tmpdir = _make_temp_sibling(job_dir)
    try:
        scratch = tmpdir / ".mldxf_scratch"
        scratch.mkdir()
        stem = Path(source_step_recorded).stem
        scratch_step = scratch / f"{stem}.step"
        shutil.copyfile(step_source, scratch_step)
        cfg_file = snapshot.get("config_file")
        if isinstance(cfg_file, dict) and cfg_file.get("contents") is not None:
            scratch_config = scratch / "config.json"
            scratch_config.write_bytes(
                _canonical_json_bytes(cfg_file["contents"]))
            rargs.config = scratch_config
        argv = plan_child_argv(script, scratch_step, tmpdir, rargs)
        argv = _append_path_flags(argv, path_kind, rargs)
        result = run_pipeline(argv, scratch_step)
        if result.returncode != 0:
            child_error(result, f"mldxf rerun ({script})")
        if not (tmpdir / "manifest.json").is_file():
            fail("job_invalid",
                 f"rerun of {job_dir} produced no manifest.json — the "
                 f"recorded mode was {cli_flags.get('mode')!r}; a job "
                 "with no manifest cannot be reproduced")
        shutil.rmtree(scratch, ignore_errors=True)
        _fixup_outdir_paths(tmpdir, tmpdir, _rerun_fixup_target(job_dir))
        job = _assemble_job(
            tmpdir, job_id=job_id, source_step=source_step_recorded,
            source_step_sha256=actual_sha,
            inputs_embedded=inputs_embedded,
            config_snapshot=snapshot,
            machine_profile=manifest.get("machine_profile"),
            step_source=step_source if inputs_embedded else None,
            parts_source=parts_source)
        if replay_inputs is not None:
            # Replay the guides inside the temp dir, BEFORE the
            # swap: if the replay fails, the old job dir is
            # untouched and the rerun fails loudly instead of
            # publishing a job that lost its guides. The replay
            # uses the recorded provenance inputs (not the live
            # home), so it reproduces the same clamps; the new
            # provenance records this CLI's version.
            _run_guides_subprocess(tmpdir, replay_inputs["machine"],
                                   replay_inputs["clamps"], VERSION)
            job = json.loads((tmpdir / "job.json").read_text())
        # V3.2 (job_model_v3.md §9): a v3 job round-trips its
        # toolpaths. Regenerate them from the replayed job (the
        # generator reads only the replayed plan + DXF + config
        # snapshot, all reproduced above) and require the
        # regenerated section to be identical to the old one on
        # the moves (V3.14: the comparison ignores the derived
        # motion fields, so a pre-V3.14 job reruns clean against
        # a regenerated section that carries them).
        old_toolpaths = manifest.get("toolpaths")
        if old_toolpaths is not None:
            tp_body = _run_toolpaths_subprocess(tmpdir)
            new_toolpaths = tp_body["toolpaths"]
            if _toolpaths_identity_bytes(new_toolpaths) != \
                    _toolpaths_identity_bytes(old_toolpaths):
                fail("rerun_toolpaths_mismatch",
                     f"rerun of {job_dir} regenerated different "
                     "toolpaths than the job carried — the generator "
                     "is deterministic, so the replayed job differs "
                     "from the original (plan, DXF, or config "
                     "snapshot changed). Refusing to publish; the "
                     "old job dir is untouched")
            job = json.loads((tmpdir / "job.json").read_text())
            job["toolpaths"] = new_toolpaths
            job["job_version"] = 3
            # V3.14: the replayed report gains the toolpaths
            # section, as `mldxf toolpaths` writes it.
            _update_report_toolpaths(tmpdir, job)
            blob = _canonical_json_bytes(job)
            (tmpdir / "job.json").write_bytes(blob)
            (tmpdir / "manifest.json").write_bytes(blob)
            vbody = _run_validate_job_subprocess(job_dir=tmpdir)
            if not vbody.get("ok"):
                fail(vbody.get("error") or "toolpaths_invalid",
                     "rerun's merged v3 job failed job-model "
                     f"validation: {vbody.get('message') or 'no detail'}",
                     exit_code=2)
            job = json.loads((tmpdir / "job.json").read_text())
        _assert_no_path(tmpdir, str(tmpdir))
        _swap_into_place(tmpdir, job_dir)
        job["job_dir"] = str(job_dir.resolve())
        job["path"] = path_kind
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    if args.json:
        emit_success({"job": job})
    else:
        print(summarize_plan_human(job, job_dir))
    return 0


def _library_home():
    cfg = load_config_module()
    try:
        return cfg.resolve_home()
    except Exception as e:
        fail(config_error_name(e), str(e))


def _load_library(loader_name):
    """Run one mldxf_config loader, mapping ConfigError onto the CLI
    contract. Returns (module, data)."""
    cfg = load_config_module()
    loader = getattr(cfg, loader_name)
    try:
        return cfg, loader(_library_home())
    except Exception as e:
        if e.__class__.__name__ == "ConfigError":
            fail(config_error_name(e), str(e))
        raise


def cmd_machine(args):
    require_config_file(args.config)
    cfg, data = _load_library("load_machine")
    if args.action == "show":
        if args.json:
            emit_success({"machine": data})
        else:
            bed = data.get("bed", {})
            slots = (data.get("t_track") or {}).get("slots", [])
            placeholder = (data.get("t_track") or {}).get("placeholder")
            lines = [
                f"machine: {data.get('id')} — {data.get('name')}",
                f"bed: {bed.get('width_mm')} x {bed.get('depth_mm')} mm",
                f"controller: {data.get('controller')} (informational in V2)",
                f"post processor: {data.get('post_processor') or 'not set (mldxf gcode defaults to masso-mm)'}",
                f"T-track: {len(slots)} slot(s), "
                f"width {(data.get('t_track') or {}).get('slot_width_mm')} mm"
                + (" — PLACEHOLDER, measure your bed before V2.9 guides"
                   if placeholder else ""),
                f"version: {data.get('version')}",
            ]
            if data.get("default_material") is not None:
                lines.append(f"default material: {data['default_material']}")
            print("\n".join(lines))
    else:  # validate
        if args.json:
            emit_success({"valid": True,
                          "machine": {"id": data.get("id"),
                                      "name": data.get("name"),
                                      "version": data.get("version")}})
        else:
            print(f"machine profile OK: {data.get('id')} "
                  f"({data.get('name')}) — bed "
                  f"{data['bed']['width_mm']} x {data['bed']['depth_mm']} mm, "
                  f"{len((data.get('t_track') or {}).get('slots', []))} T-track slot(s)")
    return 0


def cmd_tools(args):
    require_config_file(args.config)
    cfg, data = _load_library("load_tools")
    tools = data.get("tools", [])
    if args.action == "list":
        if args.json:
            emit_success({"tools": data})
        else:
            if not tools:
                print("no tools recorded yet — the planner behaves "
                      "exactly as in V1 (every tool shows unowned)")
            for t in tools:
                feeds = t.get("feeds")
                extra = f" — feeds overridden" if feeds else ""
                print(f"  {t['id']}: {t.get('kind')} {t.get('dia_mm')} mm "
                      f"({t.get('native_label')}){extra}")
                if t.get("notes"):
                    print(f"    {t['notes']}")
    else:  # validate
        if args.json:
            emit_success({"valid": True,
                          "tools": {"version": data.get("version"),
                                    "count": len(tools)}})
        else:
            print(f"tool inventory OK: {len(tools)} tool(s), "
                  f"version {data.get('version')}")
    return 0


def cmd_clamps(args):
    require_config_file(args.config)
    cfg, data = _load_library("load_clamps")
    clamps = data.get("clamps", [])
    if args.action == "list":
        if args.json:
            emit_success({"clamps": data})
        else:
            if not clamps:
                print("no clamps recorded yet")
            for c in clamps:
                print(f"  {c['id']}: {c.get('method')}, "
                      f"footprint {c.get('footprint_mm')} mm, "
                      f"keep-out {c.get('keep_out_mm')} mm, "
                      f"{'T-track' if c.get('t_track') else 'off-track'}, "
                      f"count {c.get('count')}")
                if c.get("notes"):
                    print(f"    {c['notes']}")
    else:  # validate
        if args.json:
            emit_success({"valid": True,
                          "clamps": {"version": data.get("version"),
                                     "count": len(clamps)}})
        else:
            print(f"clamp inventory OK: {len(clamps)} method(s), "
                  f"version {data.get('version')}")
    return 0


def cmd_preferences(args):
    """Show / validate preferences.json (V2.2 coordinator fix — the
    V2.5 API's GET/PUT /api/preferences had no CLI subcommand to map
    to). Preferences carry no `version` key (the model rejects
    unknown keys), so validate reports no version — a preferences
    save bumps no version, unlike the other libraries."""
    require_config_file(args.config)
    cfg, data = _load_library("load_preferences")
    if args.action == "show":
        if args.json:
            emit_success({"preferences": data})
        else:
            print("preferences:")
            for key in sorted(data):
                print(f"  {key}: {data[key]}")
    else:  # validate
        if args.json:
            emit_success({"valid": True,
                          "preferences": {"count": len(data)}})
        else:
            print(f"preferences OK: {len(data)} setting(s)")
    return 0


def _stop_server_proc(proc):
    """Stop a spawned `bun run` server and leave nothing behind.
    `bun run server.ts` spawns the real server as a child of the
    wrapper, so terminating the wrapper alone orphans the server
    (found by the wave-2 joint check: a SIGTERM'd `mldxf serve`
    left `bun run server.ts` listening on its port). On POSIX the
    server runs in its own process group (see cmd_serve) and the
    whole group gets SIGTERM, then SIGKILL after a grace period;
    on Windows the wrapper is terminated, then killed.

    Never call this from inside a signal handler: if the main
    thread is blocked in proc.wait() when the signal arrives, that
    wait holds Popen's non-reentrant _waitpid_lock, and the
    proc.wait() calls here deadlock on it. Signal handlers kill
    the process group directly and raise SystemExit instead (see
    cmd_serve's _handle_sigterm)."""
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        else:
            proc.terminate()
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        return proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except (ProcessLookupError, PermissionError, OSError):
            pass
        return proc.wait()


def _run_view3d_build(force=False):
    """Run the V3.3 view bundler (ts/view3d/build.ts, Bun). Returns
    (exit_code, body): body is the bundler's parsed stdout JSON on
    success, None when it produced no JSON. A missing Bun or a
    failed build is a CliError (the caller decides whether that is
    fatal — `mldxf serve` treats it as a warning and still starts
    the server, whose view then falls back)."""
    bun = bun_executable()
    if not bun:
        # Dev-VM fallback, same as cmd_serve: Bun lives outside
        # PATH here.
        for cand in ("/opt/hatch-image/bin/bun",):
            if Path(cand).is_file():
                bun = cand
                break
    if not bun:
        fail("bun_missing",
             "Bun is not installed or not on PATH — the V3.3 view "
             "bundler needs it (https://bun.sh, or set $BUN to the "
             "Bun executable)")
    argv = [bun, str(REPO_ROOT / "ts" / "view3d" / "build.ts"), "--json"]
    if force:
        argv.append("--force")
    result = subprocess.run(argv, capture_output=True, text=True)
    for line in (result.stderr or "").rstrip("\n").split("\n"):
        if line.strip():
            progress(line)
    try:
        body = json.loads((result.stdout or "").strip())
    except ValueError:
        body = None
    if result.returncode != 0:
        detail = (body or {}).get("message") if body else None
        fail((body or {}).get("error") or "view3d_build_failed",
             detail or f"ts/view3d/build.ts failed (exit "
             f"{result.returncode})",
             exit_code=2 if result.returncode == 2 else 1)
    return result.returncode, body


def cmd_build_view3d(args):
    """`mldxf build-view3d [--force]` (V3.3): bundle the 3D view
    entry (ts/view3d/entry.ts, three.js vendored locally) into
    server/public/vendor/view3d.js. The bundle is a build
    artifact, not checked in; a rebuild happens only when it is
    missing or stale (inputs newer than the bundle), unless
    --force. `mldxf serve` runs this before starting the server."""
    require_config_file(args.config)
    _code, body = _run_view3d_build(force=bool(getattr(args, "force", False)))
    if args.json:
        emit_success({"built": bool((body or {}).get("built")),
                      "bundle": (body or {}).get("bundle"),
                      "reason": (body or {}).get("reason")})
    else:
        if body and body.get("built"):
            print(f"view3d bundle built: {body.get('bundle')} "
                  f"({body.get('reason')})")
        else:
            print(f"view3d bundle up to date: "
                  f"{(body or {}).get('bundle') or 'server/public/vendor/view3d.js'}")
    return 0


def cmd_serve(args):
    """Start the Bun web server (V2.5): spawn `bun run server.ts`
    from the server dir, wait for the port to answer /api/health,
    then open the browser (best-effort — this VM has no browser,
    and a missing browser is never fatal). Runs in the foreground
    until Ctrl-C; stopping the CLI stops the server with it."""
    require_config_file(args.config)
    server_dir = REPO_ROOT / "server"
    server_ts = server_dir / "server.ts"
    if not server_ts.is_file():
        fail("server_not_built",
             "the Bun web server (V2.5) is not built — server.ts does "
             f"not exist under {server_dir}, so `mldxf serve` (port "
             f"{args.port}) cannot start it.")
    bun = os.environ.get("MLDXF_BUN") or shutil.which("bun")
    if not bun:
        # Dev-VM fallback: Bun lives outside PATH here.
        for cand in ("/opt/hatch-image/bin/bun",):
            if Path(cand).is_file():
                bun = cand
                break
    if not bun:
        fail("bun_not_found",
             "Bun is not installed or not on PATH — the V2.5 server "
             "needs Bun (https://bun.sh). Set MLDXF_BUN to the bun "
             "binary if it lives somewhere unusual.")
    # The 3D view bundle (V3.3) is a build artifact: build it when
    # it is missing or stale, before the server starts serving it.
    # Best-effort — a failed build never blocks the server: the
    # view falls back to the toolpath list and the CLI still works.
    try:
        _code, _body = _run_view3d_build()
    except CliError as e:
        progress(f"warning: 3D view bundle not built ({e.name}: "
                 f"{e.message}) — the view will fall back to the "
                 "toolpath list")
    port = args.port
    url = f"http://127.0.0.1:{port}"
    # If a server is already answering on this port, reuse it
    # instead of failing to bind — `mldxf serve` twice is the same
    # server, not an error.
    if _health_ok(url):
        progress(f"mldxf server already running at {url}")
        _open_browser(url)
        return 0
    env = dict(os.environ)
    env["PORT"] = str(port)
    try:
        proc = subprocess.Popen(
            [bun, "run", "server.ts", "--port", str(port)],
            cwd=str(server_dir), env=env,
            # Own process group on POSIX, so stopping the CLI can
            # take the `bun run` wrapper AND the server it spawns
            # (see _stop_server_proc).
            start_new_session=(os.name == "posix"))
    except OSError as e:
        fail("server_failed", f"could not start bun: {e}")
    # SIGTERM (e.g. a supervisor, or a test harness killing the CLI)
    # must stop the server too — the default SIGTERM handling kills
    # this process outright and orphans the Bun child. SIGINT keeps
    # its KeyboardInterrupt path below.
    #
    # The handler must NOT call proc.wait() or _stop_server_proc:
    # the main thread is blocked inside proc.wait() when the signal
    # arrives, and that wait holds Popen's non-reentrant
    # _waitpid_lock — a nested wait() deadlocks on it (found live:
    # the first version of this handler hung the parent in a futex
    # while the Bun child was already dead). The handler only kills
    # the process group; the SystemExit then unwinds out of the
    # outer proc.wait(), which releases the lock as it goes.
    _stopping = []

    def _handle_sigterm(signum, frame):
        if _stopping:
            return
        _stopping.append(signum)
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
        except (ProcessLookupError, PermissionError, OSError):
            pass
        raise SystemExit(128 + signum)

    _old_sigterm = None
    if os.name == "posix":
        _old_sigterm = signal.signal(signal.SIGTERM, _handle_sigterm)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                fail("server_failed",
                     f"bun exited (code {proc.returncode}) before the "
                     f"server answered on port {port} — run `bun run "
                     "server.ts` in the server dir to see the error")
            if _health_ok(url):
                break
            time.sleep(0.5)
        else:
            _stop_server_proc(proc)
            fail("server_failed",
                 f"the server did not answer {url}/api/health within "
                 "30 s — run `bun run server.ts` in the server dir to "
                 "see the error")
        progress(f"mldxf server running at {url} "
                 "(Ctrl-C to stop; stopping the CLI stops the server)")
        _open_browser(url)
        return proc.wait()
    except KeyboardInterrupt:
        progress("stopping the mldxf server...")
        _stop_server_proc(proc)
        return 0
    finally:
        if os.name == "posix" and _old_sigterm is not None:
            signal.signal(signal.SIGTERM, _old_sigterm)
        if proc.poll() is None:
            _stop_server_proc(proc)
    return 0


def _health_ok(url):
    """True when url + /api/health answers with the mldxf-server
    service name. Any failure (not up yet, wrong service) is False
    — never fatal, never loud."""
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(url + "/api/health",
                                    timeout=2) as resp:
            if resp.status != 200:
                return False
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("service") == "mldxf-server"
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return False


def _open_browser(url):
    """Best-effort browser open. A machine with no browser (this VM)
    is fine — the URL is printed either way, and a failure here is
    never fatal to the server."""
    try:
        import webbrowser
        if not webbrowser.open(url):
            progress(f"no browser opened automatically — open {url} "
                     "by hand")
    except Exception:
        progress(f"could not open a browser — open {url} by hand")



def cmd_init(args):
    require_config_file(args.config)
    cfg = load_config_module()
    try:
        home = cfg.resolve_home()
    except Exception as e:
        fail(config_error_name(e), str(e))
    try:
        cfg.init_home(home)
    except Exception as e:
        text = str(e)
        if e.__class__.__name__ == "ConfigError":
            if "refusing to overwrite" in text:
                fail("home_already_initialized", text)
            if "shipped example" in text and "missing" in text:
                fail("internal_error", text, exit_code=2)
            fail(config_error_name(e), text)
        raise
    files = {name: str(home / name) for name in
             ("machine.json", "tools.json", "clamps.json",
              "preferences.json")}
    if args.json:
        emit_success({"home": {"path": str(home), "files": files}})
    else:
        print(f"library home: {home}")
        for name, path in files.items():
            print(f"  {name}: {path}")
        print("Edit these files to match your machine, tools, and clamps — "
              "they live outside the repo, so a git pull never clobbers them.")
    return 0


# ---------------------------------------------------------------- parser

def build_parser():
    parser = _JsonArgumentParser(
        prog="mldxf",
        description="Headless CLI over the multi_layer_dxf pipeline (V2.1). "
                    "One entry point; the v1 scripts do the work.")
    parser.add_argument("--version", action="store_true",
                        help="print the CLI version (from VERSION) and exit")
    # --json / --config are per-command flags (scope §2.2); accepting
    # them before the subcommand too, so `mldxf --json plan ...` works.
    parser.add_argument("--json", dest="json_global", action="store_true",
                        help="emit exactly one JSON object on stdout")
    parser.add_argument("--config", dest="config_global", default=None,
                        help="JSON config file (missing file is a hard error)")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", dest="json", action="store_true",
                        default=argparse.SUPPRESS,
                        help="emit exactly one JSON object on stdout")
    common.add_argument("--config", dest="config", default=argparse.SUPPRESS,
                        help="JSON config file (missing file is a hard error)")

    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("plan", parents=[common],
                       help="full pipeline: classify, lay out, plan tools, "
                            "write the job dir")
    p.add_argument("step", help="STEP file (mm)")
    p.add_argument("-o", "--out", default=None,
                   help="job dir (default: <MLDXF_HOME>/jobs/<job-id>)")
    p.add_argument("--parts", type=Path, default=None,
                   help="JSON parts config (multi-part only)")
    p.add_argument("--mode", choices=["full", "check", "dxf", "manifest"],
                   default="full")
    p.add_argument("--only", default="",
                   help="comma list: drill,pocket,profile — only emit those")
    p.add_argument("--min-tool", type=float, default=0.0,
                   help="flag features smaller than this, mm")
    p.add_argument("--material", default=None,
                   help="material WxDxT mm, e.g. 150x100x10 (fit-or-error)")
    p.add_argument("--plan", default="",
                   help="which tool plan to write as manifest.txt (A/B/C)")
    p.add_argument("--auto", action="store_true",
                   help="auto-orient each part (orientation search)")
    p.add_argument("--no-embed", action="store_true",
                   help="do not copy the source STEP into inputs/ "
                        "(rerun then needs the original STEP path "
                        "to still exist)")

    p = sub.add_parser("check", parents=[common],
                       help="classify only, write nothing for VCarve")
    p.add_argument("step", help="STEP file (mm)")
    p.add_argument("--parts", type=Path, default=None)
    p.add_argument("--only", default="")
    p.add_argument("--min-tool", type=float, default=0.0)
    p.add_argument("--material", default=None)
    p.add_argument("--plan", default="")
    p.add_argument("--auto", action="store_true")
    p.add_argument("--mode", default="check", help=argparse.SUPPRESS)

    p = sub.add_parser("job", parents=[common],
                       help="read-only inspect of a job dir")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("rerun", parents=[common],
                       help="reproduce a job from its job.json "
                            "(needs the V2.2 job model)")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("guides", parents=[common],
                       help="workholding guides (V2.9): slot-based clamp "
                            "placement for a finished job (post-step; "
                            "plan never runs guides)")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("toolpaths", parents=[common],
                       help="toolpaths (V3.1): in-house TypeScript "
                            "toolpath generation for a finished job "
                            "(post-step; plan never generates toolpaths)")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("validate-job", parents=[common],
                       help="validate a job dir's job.json against the "
                            "v3 schema (V3.2, docs-v3/job_model_v3.md)")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("geometry", parents=[common],
                       help="layer geometry for the 3D view (V3.3): "
                            "per-layer DXF loops + Z depths, read-only")
    p.add_argument("job_dir", help="job directory")

    p = sub.add_parser("build-view3d", parents=[common],
                       help="build the 3D view bundle (V3.3) into "
                            "server/public/vendor/ when missing/stale")
    p.add_argument("--force", action="store_true",
                   help="rebuild even when the bundle is up to date")

    p = sub.add_parser("gcode", parents=[common],
                       help="G-code export (V3.6): post the "
                            "toolpaths through a native post; "
                            "round-trip verified, entry recorded")
    p.add_argument("job_dir", help="job directory")
    p.add_argument("--post", default=None,
                   help="post-processor id (masso-mm, masso-inch, "
                        "grbl, template) — overrides the job's "
                        "machine_profile.post_processor and the "
                        "home machine.json post_processor")
    p.add_argument("--verify", action="store_true",
                   help="re-verify the recorded .nc for the post "
                        "(V3.8): entry? file? sha? round-trip? — "
                        "syncs the verified stamp to the observed "
                        "result; exit 1 with a named error when it "
                        "no longer verifies")

    p = sub.add_parser("sim", parents=[common],
                       help="headless sim verification (V3.4): dexel "
                            "sim of the toolpaths vs the intended "
                            "geometry; writes the sim section on PASS; "
                            "--seek rewinds the stock to a move/time (V3.5)")
    p.add_argument("job_dir", help="job directory")
    p.add_argument("--verify", action="store_true",
                   help="run the headless verification (writes the sim "
                        "section + the delta log on PASS)")
    p.add_argument("--seek", action="store_true",
                   help="rewind/seek the stock to a move or cut time "
                        "(V3.5, headless — needs exactly one of --move / --time)")
    p.add_argument("--move", type=int, default=None,
                   help="move index to seek to (with --seek)")
    p.add_argument("--time", type=float, default=None,
                   help="cut time in seconds to seek to (with --seek)")

    p = sub.add_parser("machine", parents=[common],
                       help="machine profile: show | validate")
    p.add_argument("action", choices=["show", "validate"])

    p = sub.add_parser("tools", parents=[common],
                       help="tool inventory: list | validate")
    p.add_argument("action", choices=["list", "validate"])

    p = sub.add_parser("clamps", parents=[common],
                       help="clamp inventory: list | validate")
    p.add_argument("action", choices=["list", "validate"])

    p = sub.add_parser("preferences", parents=[common],
                       help="preferences: show | validate")
    p.add_argument("action", choices=["show", "validate"])

    p = sub.add_parser("serve", parents=[common],
                       help="start the Bun web server (V2.5)")
    p.add_argument("--port", type=int, default=3000)

    sub.add_parser("init", parents=[common],
                   help="copy the shipped example libraries into the home dir")

    return parser


def _merge_globals(args):
    """Fold the top-level --json/--config (before the subcommand) into
    the per-command values. Subcommand values win when present."""
    if not getattr(args, "json", False):
        args.json = bool(getattr(args, "json_global", False))
    if not getattr(args, "config", None):
        args.config = getattr(args, "config_global", None)
    # Defaults for flags the subparser may not define (SUPPRESS means
    # an absent flag leaves no attribute at all).
    args.json = bool(getattr(args, "json", False))
    args.config = getattr(args, "config", None)
    return args


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "version", False):
        print(f"mldxf {VERSION} (multi_layer_dxf CLI, V2.1)")
        return 0
    if not getattr(args, "command", None):
        parser.print_usage(sys.stderr)
        print("ERROR: usage_error: a command is required "
              "(plan, check, job, rerun, guides, toolpaths, "
              "validate-job, geometry, build-view3d, gcode, sim, machine, "
              "tools, clamps, preferences, serve, init)",
              file=sys.stderr)
        return 1
    args = _merge_globals(args)
    # The check subcommand has no --mode flag of its own.
    if args.command == "check":
        args.mode = "check"
    try:
        handler = {
            "plan": cmd_plan,
            "check": cmd_check,
            "job": cmd_job,
            "rerun": cmd_rerun,
            "guides": cmd_guides,
            "toolpaths": cmd_toolpaths,
            "validate-job": cmd_validate_job,
            "geometry": cmd_geometry,
            "build-view3d": cmd_build_view3d,
            "gcode": cmd_gcode,
            "sim": cmd_sim,
            "machine": cmd_machine,
            "tools": cmd_tools,
            "clamps": cmd_clamps,
            "preferences": cmd_preferences,
            "serve": cmd_serve,
            "init": cmd_init,
        }[args.command]
        return handler(args)
    except CliError as e:
        if args.json:
            emit_json({"ok": False, "error": e.name, "message": e.message})
        else:
            print(f"ERROR: {e.name}: {e.message}", file=sys.stderr)
        return e.exit_code
    except BrokenPipeError:
        return 1
    except Exception as e:  # a bug in this CLI — exit 2, traceback
        import traceback
        traceback.print_exc()
        if args.json:
            emit_json({"ok": False, "error": "internal_error",
                       "message": f"{type(e).__name__}: {e}"})
        else:
            print(f"ERROR: internal_error: {type(e).__name__}: {e}",
                  file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
