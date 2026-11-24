# mldxf-server (V2.5)

Bun local server + JSON API — a thin shell over the `mldxf` CLI
(V2_SCOPE.md §5). Dependency-free: Bun's built-in server only, no
npm packages.

## Run it

```sh
mldxf serve            # port 3000; opens the browser (best-effort)
mldxf serve --port 8080
start.bat              # Windows double-click launcher (same thing)
bun run server.ts --port 3000   # directly, from this dir
```

Localhost only (`127.0.0.1`), single user, no auth in V2.

## API (every endpoint maps 1:1 to a CLI command)

| Endpoint | CLI equivalent |
|---|---|
| `GET /api/health` | — (server status: service, CLI version, home, jobs root) |
| `POST /api/jobs` (multipart STEP in the `step` field, or JSON `{step_path, ...}`) | `mldxf plan` — returns `202 {job_id, job_dir, status: "running"}` immediately; the run proceeds in the background |
| `GET /api/jobs` | list of job dirs (id, created, status, plan summary) |
| `GET /api/jobs/:id` | `mldxf job --json` + server status |
| `GET /api/jobs/:id/status` | run status + streamed stderr progress lines so far |
| `GET /api/jobs/:id/events` | SSE stream of the CLI's stderr progress lines (a `status` event on connect, then replayed buffer, then live; `event: done` on finish) |
| `POST /api/jobs/:id/rerun` | `mldxf rerun --json` (faithful passthrough — a v1 job answers `rerun_unavailable`) |
| `POST /api/jobs/:id/cancel` | kills the CLI subprocess (whole process group on POSIX) and marks the job interrupted |
| `GET /api/jobs/:id/download/:file` | serves exactly the job's outputs — DXF, `manifest.txt`, `report.md`, `manifest.json`, or `zip` (whole job dir as a stored-entries zip, written in-process — no `zip` binary assumed) |
| `GET /api/tools`, `PUT /api/tools` | `mldxf tools list` / library edit |
| `GET /api/clamps`, `PUT /api/clamps` | `mldxf clamps list` / library edit |
| `GET /api/machine`, `PUT /api/machine` | `mldxf machine show` / profile edit |
| `GET /api/preferences`, `PUT /api/preferences` | preferences edit (see the gap note below) |

Plan options on `POST /api/jobs` (form fields or JSON keys):
`material`, `plan`, `auto`, `mode` (`full`/`check`/`dxf`/`manifest`),
`min_tool`, `only`. Everything else is the CLI's default.

## How it works

- The server spawns `mldxf` with argv arrays (never a shell
  string), reads its stdout JSON, returns it. It holds no pipeline
  state and computes nothing about a job: list summaries are fields
  read off the CLI's own `mldxf job --json` output.
- Jobs live under `<MLDXF_HOME>/jobs/`, one dir per job id
  (`YYYYMMDD-HHMMSS-<slug>`, same format as the CLI). On startup
  the server re-scans: a dir with `job.json` or `manifest.json` is
  complete; a dir with NEITHER is interrupted. The server never
  writes into a job dir except by invoking the CLI.
- An interrupted job is re-runnable from its inputs: the server
  retains each uploaded STEP under the OS temp dir
  (`$TMPDIR/mldxf-server/uploads/<job-id>/<original-filename>`,
  indexed in `server-state.json` there — never in a job dir).
  The upload keeps its ORIGINAL filename: the DXF name, the
  report title and `manifest.txt`'s `# dxf:` line all come from
  the STEP's stem, so renaming the upload would make the API
  job's outputs differ from a CLI run on the same file (the
  parity test caught exactly this). `POST
  /api/jobs/:id/rerun` on an interrupted job with retained inputs
  re-plans from those inputs into a NEW job dir (new id); on any
  other job it passes `mldxf rerun` through verbatim.
  A run killed before the CLI even creates its outdir (still in
  the solid-count probe) leaves no dir at all — the startup scan
  merges such runs in from the retained-inputs index as
  interrupted, so they still list and are still re-runnable.
- Library edits are validate-then-save: the candidate is written
  to a temp home, validated by the real CLI (`mldxf <lib> validate
  --json` with `MLDXF_HOME` pointed at the temp home), and only
  then moved into place (temp sibling + rename), bumping the
  file's `version` integer (current + 1, whatever the client
  submitted). An invalid save is refused with the CLI's named
  error and the file on disk is unchanged.
- Runs are async with no timeout shorter than the run
  (`idleTimeout: 0` + SSE heartbeats). Cancel kills the CLI's
  process group on POSIX (spawned under `setsid`, so the v1
  pipeline child dies too) and `taskkill /PID /T /F` on Windows.

## Known gaps (filed, not worked around)

- **Rerun is a synchronous passthrough.** `POST
  /api/jobs/:id/rerun` waits for `mldxf rerun` to finish and then
  returns its JSON, so a long rerun holds the HTTP request open
  for the run's duration (the server itself imposes no timeout).
  New job creation is async (`202` + progress stream) because a
  run starts from an upload; rerun replays a finished job in
  place and returns its result directly. If the UI (V2.7/V2.8)
  wants a polled rerun, that is a small follow-up: run the same
  `mldxf rerun` in the background run registry and return `202`.
- **No `mldxf preferences` subcommand exists in the V2.1 CLI**,
  so `GET/PUT /api/preferences` validate through the CLI's own
  validator module (`mldxf_config.load_preferences`, run as a
  subprocess against the temp home) instead of a CLI subcommand.
  Preferences also has no `version` key in its model (adding one
  would fail validation as an unknown key), so a preferences save
  bumps no version. A `mldxf preferences show|validate`
  subcommand is CLI work, not server work.

## Verification

`python3 server/verify_v25.py` — starts the server on a test port
against a throwaway `MLDXF_HOME`, checks library CRUD + invalid
refusal, API/CLI parity on the real container STEP (manifest
compare + DXF canonical entity+layer signature), interrupted-job
marking across a restart, cancel of a Kookabus run (subprocess
dead, job interrupted), rerun passthrough on a v1 job, and
downloads (including zip validity). See `server/verify_v25.log`
for the last run's output.
