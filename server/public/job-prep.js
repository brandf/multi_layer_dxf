/**
 * job-prep.js — V2.7: web UI job prep tab (V2_SCOPE.md §5.3).
 *
 * ONE module, self-contained: no dependencies beyond fetch and
 * EventSource, no pipeline logic, no geometry, no toolpath math.
 * It displays what the server API (which is 1:1 with the `mldxf`
 * CLI) returns, and nothing else. The job dir on disk is the
 * source of truth; this tab caches nothing about a job beyond the
 * current view's state.
 *
 * Contract (set by the app shell, built in parallel): the shell
 * loads this file and calls `App.registerTab(window.MldxfJobPrep)`.
 * This module defines:
 *
 *   window.MldxfJobPrep = {
 *     id: 'job-prep',
 *     label: 'Job prep',
 *     render(el) { ... },        // shell calls this when the tab is shown
 *     openJob(jobId) { ... },    // show an existing job (used by the
 *                                // Jobs tab, V2.8, to open a job here)
 *   }
 *
 * `render(el, opts)` also accepts an optional second argument
 * `{ jobId }` to open that job instead of the blank form.
 *
 * API calls this module makes (exact shapes — the verification
 * harness replays them with curl):
 *
 *   POST /api/jobs            multipart, STEP in the `step` field
 *                             (+ option fields material/plan/mode/
 *                             only/min_tool/auto), or JSON
 *                             { step_path, material, plan, mode,
 *                             only, min_tool, auto } for a STEP
 *                             already on disk.
 *                             -> 202 { job: { job_id, job_dir,
 *                                status: "running" } }
 *   GET  /api/jobs/:id/events SSE: `event: status` on connect, then
 *                             replayed `data:` progress lines, then
 *                             live lines, then `event: done`.
 *   GET  /api/jobs/:id/status polled fallback when the SSE stream
 *                             fails: { status, progress[], job,
 *                             error }.
 *   GET  /api/jobs/:id       the finished job (== `mldxf job
 *                             --json`): plan, flags, post-processing
 *                             steps, workholding, outputs.
 *   POST /api/jobs/:id/cancel { } -> { status: "interrupted",
 *                             cancelled: true }.
 *   POST /api/jobs/:id/guides { } -> the finished job's
 *                             workholding recommendation (== `mldxf
 *                             guides --json`): clamps, alternatives,
 *                             force model. A refusal (placeholder
 *                             T-track, no clamps, v1 job) answers
 *                             with the CLI's named error, which the
 *                             tab shows as its error, never as an
 *                             empty result.
 *   GET  /api/jobs/:id/download/:file
 *                             plain <a> links: the DXF, manifest.txt,
 *                             report.md, and `zip` for the whole job.
 *
 * Display rules (from the scope, not invented here):
 *   - Plan tools: owned tools first, then not-owned, then tools
 *     whose owned status is unknown (a v1 job, or a job written
 *     before the inventory annotation existed, carries no `owned`
 *     field — show no owned info rather than guessing). Not-owned
 *     tools are marked explicitly "not in your inventory — check
 *     before you cut" (scope §4.4). Tool numbers are always shown,
 *     so the display order never hides the cut order.
 *   - Workholding (V2.9): a job with guides shows the CLI's
 *     recommendation — clamp type, slot, position, reason — plus
 *     alternatives and the force-model note, exactly as job.json
 *     records them. A job without guides says "no guides yet"
 *     honestly and offers to run them (v2 jobs only; a v1 job is
 *     read-only and gets no button). A guides refusal is the
 *     API's named error, shown as the tab's error — never a
 *     silent empty result, never an invented recommendation.
 *   - Post-processing steps are rendered exactly the way `mldxf
 *     job` derives them (mldxf.py `post_process_steps`): the
 *     structured `post_process` list, then the POST-PROCESS flag
 *     lines. That is formatting of CLI output, not pipeline logic.
 *   - No rerun button lives here: rerun belongs to the Jobs tab
 *     (V2.8). A v1 job is read-only — the tab says so and offers
 *     no rerun, because `POST .../rerun` on a v1 job answers
 *     `rerun_unavailable`.
 *   - Times are the CLI's own numbers: total_seconds / 60, one
 *     decimal — the same formatting as `mldxf plan_summary`.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) {
      if (typeof cls === 'string') n.className = cls;
      else if (typeof cls === 'object') {
        // Attrs object, app.js style: { class, text }.
        if (cls.class) n.className = cls.class;
        if (cls.text != null) n.textContent = cls.text;
      }
    }
    if (html != null) {
      if (Array.isArray(html)) {
        // An array of child nodes (or strings): append them, never
        // stringify them — innerHTML on a node array renders as
        // "[object HTMLTableCellElement]".
        html.forEach(function (c) {
          n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
      } else n.innerHTML = html;
    }
    return n;
  }

  function textEl(tag, cls, s) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = s == null ? '' : String(s);
    return n;
  }

  /** Minutes, one decimal — the CLI's plan_summary formatting. */
  function minutes(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return '?';
    return (seconds / 60).toFixed(1);
  }

  function mm(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '?';
    return String(Math.round(v * 100) / 100);
  }

  function toolLabel(t) {
    return t.name || t.id || '?';
  }

  /** File name only — never an absolute server path in the UI. */
  function basename(p) {
    var s = String(p == null ? '' : p);
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }

  /** "12.4 KB" — for download sizes. */
  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var v = n, u = -1;
    do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
    return (v >= 100 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[u];
  }

  /** Raw OCC enum names ("GeomAbs_SurfaceType.GeomAbs_BSplineSurface")
   * become human words ("B-spline surface"). Display transform only —
   * the flag data underneath is untouched. */
  var SURFACE_WORDS = {
    BSplineSurface: 'B-spline surface', BSplineCurve: 'B-spline curve',
    BezierSurface: 'Bézier surface', BezierCurve: 'Bézier curve',
    Plane: 'flat plane', Cylinder: 'cylinder', Cone: 'cone',
    Torus: 'torus', Sphere: 'sphere', Circle: 'circle',
    Line: 'straight line', SurfaceOfRevolution: 'surface of revolution',
    SurfaceOfExtrusion: 'extruded surface', OffsetSurface: 'offset surface',
  };
  function humanizeFlagText(s) {
    return String(s == null ? '' : s).replace(
      /GeomAbs_(?:SurfaceType|CurveType)\.GeomAbs_([A-Za-z0-9_]+)|GeomAbs_([A-Za-z0-9_]+)/g,
      function (m, named, bare) {
        var name = named || bare || '';
        if (SURFACE_WORDS[name]) return SURFACE_WORDS[name];
        return name.replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase() || m;
      });
  }

  /** A flag's short title in normal case: the text up to the first
   * " — ", with a leading "KEYWORD [method]:" prefix stripped to
   * the words after the colon, ALL-CAPS words lowercased (a lone
   * letter like Z stays capital). The detail is the rest after
   * the " — ". */
  function normalCase(s) {
    var lower = String(s == null ? '' : s).toLowerCase();
    var titled = lower.charAt(0).toUpperCase() + lower.slice(1);
    return titled.replace(/\bz\b/g, 'Z');
  }
  function flagTitle(text) {
    var first = String(text == null ? '' : text).split(' — ')[0];
    var colon = first.indexOf(': ');
    if (colon !== -1) first = first.slice(colon + 2);
    return normalCase(first);
  }
  function flagDetail(text) {
    var parts = String(text == null ? '' : text).split(' — ');
    if (parts.length < 2) return '';
    return parts.slice(1).join(' — ');
  }

  /** Group near-identical flags within one part group (round 9):
   * flags whose text differs only in numbers — coordinates, Z
   * ranges, counts — collapse to one row with a ×N count and a
   * <details> listing every variant in full, so no information is
   * lost while the wall of near-identical rows is gone. Returns
   * [{ text, count, variants }] in first-seen order; a lone flag
   * comes back unchanged (count 1, variants null). The template
   * keeps numbers that are the same in every variant (e.g. the
   * shared dia 2.25 and Z range) and replaces only the numbers
   * that differ with "…". Display transform only — the flag data
   * underneath is untouched. */
  function groupNearIdenticalFlags(items) {
    function tokens(s) {
      return String(s).split(/(\d+\.?\d*)/g);
    }
    var groups = [];
    items.forEach(function (text) {
      var t = tokens(text);
      // The key is the non-number segments in order: identical
      // iff the texts differ only in their numbers.
      var key = t.filter(function (seg, i) { return i % 2 === 0; }).join('');
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].key === key) { g = groups[i]; break; }
      }
      if (!g) { g = { key: key, items: [] }; groups.push(g); }
      g.items.push(text);
    });
    return groups.map(function (g) {
      if (g.items.length === 1) {
        return { text: g.items[0], count: 1, variants: null };
      }
      var first = tokens(g.items[0]);
      var tpl = first.map(function (tok, i) {
        if (i % 2 === 0) return tok;
        var same = g.items.every(function (it) { return tokens(it)[i] === tok; });
        return same ? tok : '…';
      }).join('');
      return { text: tpl, count: g.items.length, variants: g.items };
    });
  }

  /** Split a flag into its part (leading "[PART] ") and its text. */
  function parseFlag(flag) {
    var f = String(flag == null ? '' : flag);
    var m = /^\[([^\]]+)\]\s+/.exec(f);
    if (m) return { part: m[1], text: f.slice(m[0].length) };
    return { part: null, text: f };
  }

  /** Must-read-before-cutting, or informational. A flag is
   * must-read when something was not cut, needs a decision, needs
   * hand work after the cut, or changes the setup. */
  var MUST_READ_RE = /POST-PROCESS|POCKET ISLAND|HOLE NOT FROM TOP|NO PLAN|AMBIGUOUS|NON-PRISMATIC|TOOL PLAN|REGISTRATION PINS|DECISION NEEDED|ERROR|DOES NOT FIT|FAILED/i;
  function flagSeverity(text) {
    return MUST_READ_RE.test(text) ? 'must' : 'info';
  }

  /** Display order for a plan's tools: owned first, then not-owned,
   * then unknown (no `owned` field). Stable otherwise, by tool
   * number — the display order never hides the cut order, which
   * stays visible as the tool number on every row. */
  function ownedRank(t) {
    if (t.owned === true) return 0;
    if (t.owned === false) return 1;
    return 2;
  }

  function displayTools(tools) {
    return (tools || []).slice().sort(function (a, b) {
      var d = ownedRank(a) - ownedRank(b);
      if (d) return d;
      return (a.tool_number || 0) - (b.tool_number || 0);
    });
  }

  /** "Nov 24, 1:19 AM" — never a raw ISO timestamp. */
  function humanDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  /** The job's readable name: the STEP stem slug in the id
   * ("20261124-011624-real-container" -> "real-container"). */
  function jobStem(id) {
    var s = String(id || '');
    var m = /^\d{8}-\d{6}-(.+)$/.exec(s);
    return m ? m[1] : (s || 'job');
  }

  /** The plan options a v2 job was run with, read off the job's
   * own recorded provenance (config_snapshot.cli_flags — the CLI
   * flags the run was started with), in the form's shape
   * (material/plan/mode/only/min_tool/auto). Empty strings and a
   * zero min_tool mean "no value was given" and are omitted, so
   * the form falls back to its defaults for them. A job with no
   * recorded options (v1, or a hand-built job.json) returns null
   * — the caller keeps whatever options it already had. */
  function jobOptions(job) {
    var flags = job && job.config_snapshot && job.config_snapshot.cli_flags;
    if (!flags || typeof flags !== 'object') return null;
    var opts = {};
    if (typeof flags.material === 'string' && flags.material) opts.material = flags.material;
    if (typeof flags.plan === 'string' && flags.plan) opts.plan = flags.plan;
    if (typeof flags.mode === 'string' && flags.mode) opts.mode = flags.mode;
    if (typeof flags.only === 'string' && flags.only) opts.only = flags.only;
    if (typeof flags.min_tool === 'number' && isFinite(flags.min_tool) && flags.min_tool !== 0) {
      opts.min_tool = flags.min_tool;
    }
    if (typeof flags.auto === 'boolean') opts.auto = flags.auto;
    return opts;
  }

  /** Parse one grouped post-processing step into its method,
   * feature and action sentence: "[router_table] sculpted surface
   * … — Round over the outer edge …" -> method Router table,
   * feature "sculpted surface …", action "Round over …". Display
   * transform only — the step data underneath is untouched. */
  var POST_METHOD_WORDS = {
    router_table: 'Router table', hand_router: 'Hand router',
    drill_press: 'Drill press', cnc_3d: '3D CNC',
    decision_needed: 'Decision needed',
  };
  function parsePostStep(text) {
    var s = humanizeFlagText(text);
    var method = null;
    var m = /\[([a-z_]+)\]/.exec(s);
    if (m) method = m[1];
    s = s.replace(/^POST-PROCESS\s*/i, '')
      .replace(/^\[[^\]]+\]\s*:?\s*/, '')
      .replace(/^[A-Za-z_]+:\s*/, '');
    var parts = s.split(' — ');
    var head = parts[0] || '';
    var action = parts.length > 1 ? parts.slice(1).join(' — ') : head;
    var feature = parts.length > 1 ? head : '';
    return {
      method: method,
      methodLabel: method ? (POST_METHOD_WORDS[method] || method) : null,
      feature: feature, action: action,
    };
  }

  /** Post-processing steps, exactly as `mldxf job` derives them
   * (mldxf.py post_process_steps): the structured post_process
   * list, then the POST-PROCESS flag lines. Formatting of CLI
   * output only. One entry per distinct action: the same step
   * needed by several parts is listed once, with the parts it
   * applies to. Returns [{text, parts[]}] in first-seen order. */
  function postProcessStepsGrouped(job) {
    var groups = [];
    function add(text, part) {
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].text === text) {
          if (part && groups[i].parts.indexOf(part) === -1) groups[i].parts.push(part);
          return;
        }
      }
      groups.push({ text: text, parts: part ? [part] : [] });
    }
    var pp = job.post_process || [];
    for (var i = 0; i < pp.length; i++) {
      var e = pp[i] || {};
      var parts = [e.method ? '[' + e.method + ']' : '', e.feature || '',
        e.params || '', e.step ? '— ' + e.step : '']
        .filter(function (x) { return x; }).join(' ');
      add(parts, null);
    }
    var flags = job.flags || [];
    for (var j = 0; j < flags.length; j++) {
      var flag = flags[j];
      if (flag && flag.indexOf('POST-PROCESS') !== -1) {
        // Strip only a leading "[PART] " prefix (a part name, not
        // the "POST-PROCESS" keyword itself): the method label
        // "[router_table]" stays, so the step still names its method.
        var parsed = parseFlag(flag);
        var text = parsed.text;
        if (text.indexOf('POST-PROCESS') !== 0) {
          // No part prefix: the flag itself starts with POST-PROCESS.
          text = flag;
        }
        add(text, parsed.part);
      }
    }
    return groups;
  }

  /** Top-level downloadable outputs, from the job's own `outputs`
   * list (v2) or from the known v1 output names. Returns
   * { dxf, manifestTxt, reportMd, manifestJson } filenames (or
   * null when the job does not carry that file). The server serves
   * exactly these names — the UI never invents a download. */
  function downloadNames(job) {
    var names = { dxf: null, manifestTxt: null, reportMd: null, manifestJson: null };
    var outs = job.outputs || [];
    for (var i = 0; i < outs.length; i++) {
      var f = typeof outs[i] === 'string' ? outs[i] : (outs[i] && outs[i].file);
      if (!f || f.indexOf('/') !== -1) continue; // top-level files only
      if (/\.dxf$/i.test(f)) names.dxf = f;
      else if (f === 'manifest.txt') names.manifestTxt = f;
      else if (f === 'report.md') names.reportMd = f;
      else if (f === 'manifest.json') names.manifestJson = f;
    }
    if (!names.dxf && job.source_step) {
      // v1 job (no outputs list): the DXF is named after the STEP stem.
      var stem = String(job.source_step).split(/[\\/]/).pop().replace(/\.step$/i, '');
      if (stem) names.dxf = stem + '.dxf';
    }
    if (!names.manifestTxt) names.manifestTxt = 'manifest.txt';
    if (!names.reportMd) names.reportMd = 'report.md';
    return names;
  }

  // ---------------------------------------------------------------- state

  // Module-level: survives the shell re-calling render(el) when the
  // tab is re-selected, so an in-flight run is not lost.
  var state = {
    rootEl: null,
    jobId: null,
    status: null, // running | complete | failed | interrupted | null
    cancelled: false,
    job: null, // job object from GET /api/jobs/:id (or the status poll)
    jobError: null, // { error, message } for a failed run
    progress: [],
    sseFailed: false,
    lastError: null, // { error, message } for a failed start
    guidesError: null, // { error, message } for a refused guides run —
    // rendered inline in the Workholding section (where the button
    // was clicked) as well as in the tab-level banner, so the
    // refusal is visible without scrolling (round 7).
    selectedFile: null,
    lastOptions: null, // plan options of the most recent run (kept in the form)
    lastStepPath: '', // disk-path text of the most recent run
    currentRun: null, // { jobId, sse, pollTimer } while a run is followed
    runStarted: false, // a run has started in this session — the
    // progress block stays hidden until the first run (issue 19)
    runStartedAt: null, // Date.now() at beginRun, for elapsed time
    stageDoneAt: {}, // stage key -> Date.now() when the stage first
    // read done off the streamed log (for per-stage elapsed).
    finishedAt: null, // Date.now() when the run reached a terminal
    // status — the "finished in" readout freezes here (it used to
    // keep counting from runStartedAt on every re-render).
    elapsedTimer: null, // 1 s tick updating the elapsed readout
    formExpanded: false, // "Run again" re-opens the form after a
    // completed run collapsed it into a summary bar
    scrollToResult: false, // set when a run completes: the result
    // is scrolled into view on the next render
    restoreAttempted: false, // a reload-restore has been tried
    // once this page load (see render) — a failed restore leaves
    // the fresh form, not a retry loop
  };

  /** The last-run job id, kept in sessionStorage so a reload
   * restores the result (round 8): the same tab session only — a
   * new browser session starts from the fresh form, and a stale id
   * is forgotten silently (see loadJob's silent path). */
  var LAST_JOB_KEY = 'mldxf:lastJobId';
  function rememberLastJob(jobId) {
    try { if (window.sessionStorage) sessionStorage.setItem(LAST_JOB_KEY, jobId); } catch (e) { /* storage unavailable; the tab still works */ }
  }
  function forgetLastJob() {
    try { if (window.sessionStorage) sessionStorage.removeItem(LAST_JOB_KEY); } catch (e) { /* ignore */ }
  }
  function readLastJob() {
    try { return window.sessionStorage ? sessionStorage.getItem(LAST_JOB_KEY) : null; } catch (e) { return null; }
  }

  /** A restored id that no longer exists (another home, a wiped
   * job dir) is not an error to show — the fresh form is the
   * honest view, and the stale id is forgotten. */
  function resetAfterFailedRestore() {
    state.jobId = null;
    state.status = null;
    state.job = null;
    state.jobError = null;
    state.progress = [];
  }

  function stopElapsedTimer() {
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  }

  /** "0:42" / "12:05" from a start timestamp to an end timestamp
   * (default: now — live while running). */
  function elapsedText(endAt) {
    if (!state.runStartedAt) return '';
    var end = endAt || Date.now();
    var s = Math.max(0, Math.floor((end - state.runStartedAt) / 1000));
    var m = Math.floor(s / 60);
    return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60) + ' elapsed';
  }

  /** "finished in 0:05" — frozen at finishedAt, never re-derived
   * from Date.now(), so the readout stops the moment the run ends.
   * Round 9: the total is derived from the same stage stamps the
   * pills show — the pills' durations telescope to
   * lastStageDoneAt - runStartedAt, so when the last stage was
   * stamped after finishedAt the total uses the later stamp, and
   * the total can never read less than the stage times add up to.
   * With no stage ever stamped it falls back to finishedAt; with
   * no in-session timing at all (a reopened job) it is empty. */
  function finishedText() {
    if (!state.runStartedAt) return '';
    var end = state.finishedAt || 0;
    var last = lastStageDoneAt();
    if (last && last > end) end = last;
    if (!end) return '';
    return 'finished in ' + fmtDur(end - state.runStartedAt);
  }

  /** The latest stage stamp, or 0 when no stage was ever stamped. */
  function lastStageDoneAt() {
    var last = 0;
    for (var k in state.stageDoneAt) {
      if (state.stageDoneAt[k] > last) last = state.stageDoneAt[k];
    }
    return last;
  }

  /** "0:42" from a millisecond duration (stage elapsed times). */
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function updateElapsed() {
    var root = state.rootEl;
    if (!root) return;
    var e = root.querySelector('[data-role="elapsed"]');
    if (!e) return;
    if (state.status === 'running') e.textContent = elapsedText();
    else e.textContent = finishedText();
    // The 1 s tick also refreshes the percentage and the live
    // current-stage elapsed — a long run must read as progressing
    // between streamed lines, not only when a line arrives.
    var pct = root.querySelector('[data-role="progress-pct"]');
    if (pct) pct.textContent = progressPct() + '% of stages complete';
    var hl = root.querySelector('[data-role="stage-headline"]');
    if (hl) hl.textContent = currentStageHeadline();
    var stages = root.querySelector('[data-role="stage-list"]');
    if (stages) stages.innerHTML = stageItemsHtml();
  }

  function stopFollowing() {
    var run = state.currentRun;
    if (!run) return;
    if (run.sse) { try { run.sse.close(); } catch (e) { /* already closed */ } }
    if (run.pollTimer) clearInterval(run.pollTimer);
    state.currentRun = null;
    stopElapsedTimer();
  }

  // ---------------------------------------------------------------- API

  function apiErrorText(body, fallback) {
    if (body && body.error) {
      return body.error + (body.message ? ': ' + body.message : '');
    }
    return fallback || 'request failed';
  }

  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (b) {
        return { status: resp.status, body: b };
      });
    });
  }

  function getJson(path) {
    return fetch(path).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (b) {
        return { status: resp.status, body: b };
      });
    });
  }

  /** Human-readable text for an API error object {error, message}:
   * the message only — never the raw error code. The code (e.g.
   * "t_track_placeholder") is a machine identifier; the banner
   * used to render "t_track_placeholder: T-track slots are
   * placeholders — …", which reads as a leaked internal code.
   * The code stays in the error object (and in the banner's
   * data-error-code attribute) for anything machine-readable. */
  function humanErrorText(err) {
    if (!err) return 'request failed';
    var msg = err.message ? String(err.message) : '';
    if (msg) {
      // The message itself may already carry a "code: " prefix
      // (apiErrorText builds "error: message"): strip a leading
      // prefix that matches this error's own code.
      var code = err.error ? String(err.error) : '';
      if (code && msg.indexOf(code + ': ') === 0) msg = msg.slice(code.length + 2);
      return msg;
    }
    return code || 'request failed';
  }

  function errorBanner(err) {
    var div = el('div', 'jp-error', '');
    div.setAttribute('role', 'alert');
    if (err && err.error) div.setAttribute('data-error-code', String(err.error));
    div.textContent = humanErrorText(err);
    return div;
  }

  // ---------------------------------------------------------------- run control

  /** Read the plan options from the form (the §5.2 plan options).
   * Empty fields are omitted, so the server/CLI defaults apply. */
  function readOptions(form) {
    var q = function (name) {
      var n = form.querySelector('[name="' + name + '"]');
      return n ? n.value : '';
    };
    var opts = {};
    var material = (q('material') || '').trim();
    if (material) opts.material = material;
    var plan = (q('plan') || '').trim();
    if (plan) opts.plan = plan.toUpperCase();
    var mode = q('mode') || 'full';
    if (mode && mode !== 'full') opts.mode = mode;
    var only = (q('only') || '').trim();
    if (only) opts.only = only;
    var minTool = (q('min_tool') || '').trim();
    if (minTool !== '' && isFinite(Number(minTool))) opts.min_tool = Number(minTool);
    var auto = form.querySelector('[name="auto"]');
    if (auto && auto.checked) opts.auto = true;
    return opts;
  }

  function startRun(form, file) {
    var opts = readOptions(form);
    var diskPath = (form.querySelector('[name="step_path"]') || {}).value || '';
    diskPath = String(diskPath).trim();
    startRunWith(opts, file, diskPath);
  }

  /** Start a run from explicit inputs (no form needed): the form's
   * Run button reads the form and calls this; the completed-run
   * summary bar's "Run again" calls it with the last run's inputs
   * (round 10 — after a completed job, Run is the re-run action,
   * not a two-step "Run again, then Run" with the gating only
   * hinted at by a button label). */
  function startRunWith(opts, file, diskPath) {
    state.lastOptions = opts || {};
    state.lastStepPath = diskPath || '';
    state.lastError = null;
    state.jobError = null;

    var promise;
    if (file) {
      var fd = new FormData();
      fd.append('step', file);
      if (opts.material) fd.append('material', opts.material);
      if (opts.plan) fd.append('plan', opts.plan);
      if (opts.mode) fd.append('mode', opts.mode);
      if (opts.only) fd.append('only', opts.only);
      if (opts.min_tool != null) fd.append('min_tool', String(opts.min_tool));
      if (opts.auto) fd.append('auto', 'true');
      promise = fetch('/api/jobs', { method: 'POST', body: fd })
        .then(function (resp) {
          return resp.json().catch(function () { return {}; }).then(function (b) {
            return { status: resp.status, body: b };
          });
        });
    } else if (diskPath) {
      var body = { step_path: diskPath };
      if (opts.material) body.material = opts.material;
      if (opts.plan) body.plan = opts.plan;
      if (opts.mode) body.mode = opts.mode;
      if (opts.only) body.only = opts.only;
      if (opts.min_tool != null) body.min_tool = opts.min_tool;
      if (opts.auto) body.auto = true;
      promise = postJson('/api/jobs', body);
    } else {
      state.lastError = { error: 'no_step',
        message: 'Drop a STEP file or enter the path to a STEP already on disk.' };
      rerender();
      return;
    }

    promise.then(function (r) {
      if (r.status !== 202 || !r.body.ok || !r.body.job) {
        state.lastError = { error: (r.body && r.body.error) || 'start_failed',
          message: apiErrorText(r.body, 'Could not start the job (HTTP ' + r.status + ').') };
        rerender();
        return;
      }
      beginRun(r.body.job.job_id);
    }).catch(function (err) {
      state.lastError = { error: 'network_error', message: String(err && err.message || err) };
      rerender();
    });
  }

  function beginRun(jobId) {
    stopFollowing();
    state.jobId = jobId;
    rememberLastJob(jobId);
    state.status = 'running';
    state.cancelled = false;
    state.job = null;
    state.jobError = null;
    state.progress = [];
    state.sseFailed = false;
    state.runStarted = true;
    state.runStartedAt = Date.now();
    state.stageDoneAt = {};
    state.guidesError = null;
    state.finishedAt = null;
    state.formExpanded = false;
    stopElapsedTimer();
    state.elapsedTimer = setInterval(updateElapsed, 1000);
    rerender();
    // The form stays on screen and progress used to be appended
    // after it — below the fold at 1440x900, so a running job
    // looked idle and Cancel was unreachable without scrolling.
    // Bring the progress block (with Cancel) into view now.
    var prog = state.rootEl ? state.rootEl.querySelector('[data-role="progress"]') : null;
    if (prog && prog.scrollIntoView) prog.scrollIntoView({ block: 'start' });
    followRun(jobId);
  }

  /** Follow a run: SSE first, polled status as fallback. The
   * server replays the buffered progress lines on (re)connect
   * after the `status` event, so the log is reset on each status
   * event and refilled by the replay — a reconnect never
   * duplicates lines. */
  function followRun(jobId) {
    stopFollowing();
    var run = { jobId: jobId, sse: null, pollTimer: null };
    state.currentRun = run;

    function onTerminal(status, job, error) {
      stopFollowing();
      state.status = status;
      // Freeze the elapsed readout at the moment the run ends.
      if (!state.finishedAt) state.finishedAt = Date.now();
      // Update the readout now, not when the job reload lands:
      // loadJob's fetch is async, and until it returns the span
      // still shows the live "M:SS elapsed" text.
      updateElapsed();
      if (job) state.job = job;
      if (error) state.jobError = error;
      if (status === 'complete' || status === 'failed' || status === 'interrupted') {
        // The status payload may already carry the job; re-read
        // the job through GET /api/jobs/:id so the result view is
        // exactly what the CLI wrote (job.json), not the run record.
        loadJob(jobId);
      } else {
        rerender();
      }
    }

    function startPolling() {
      if (state.sseFailed) return;
      state.sseFailed = true;
      if (run.pollTimer) return;
      run.pollTimer = setInterval(function () {
        getJson('/api/jobs/' + encodeURIComponent(jobId) + '/status')
          .then(function (r) {
            if (!r.body || !r.body.ok) return;
            state.progress = r.body.progress || [];
            stageStates(); // stamp off the stream (see the SSE handler)
            state.status = r.body.status || state.status;
            state.cancelled = !!r.body.cancelled;
            if (r.body.status === 'running') { rerender(); return; }
            onTerminal(r.body.status, r.body.job || null, r.body.error || null);
          })
          .catch(function () { /* next poll retries */ });
      }, 2000);
    }

    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    var es = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events');
    run.sse = es;
    es.addEventListener('status', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        state.status = data.status || state.status;
      } catch (e) { /* keep previous status */ }
      // Replay follows: reset, the buffered lines refill the log.
      state.progress = [];
      rerender();
    });
    es.addEventListener('message', function (ev) {
      if (ev.data) state.progress.push(ev.data);
      // Stamp the stages off the stream even when this tab is not
      // showing (rerenderProgress is guarded on the current tab):
      // the stage pills' times are measured from arrival, and a
      // tab switch mid-run must not collapse them all to the
      // moment the user comes back.
      stageStates();
      rerenderProgress();
    });
    es.addEventListener('done', function (ev) {
      var status = 'complete';
      try { status = JSON.parse(ev.data).status || status; } catch (e) { /* default */ }
      try { es.close(); } catch (e) { /* already closed */ }
      onTerminal(status, null, null);
    });
    es.addEventListener('error', function () {
      if (es.readyState === EventSource.CLOSED) {
        try { es.close(); } catch (e) { /* already closed */ }
        run.sse = null;
        if (state.status === 'running') startPolling();
      }
    });
  }

  function loadJob(jobId, opts) {
    var silent = !!(opts && opts.silent);
    getJson('/api/jobs/' + encodeURIComponent(jobId))
      .then(function (r) {
        if (r.body && r.body.ok) {
          state.job = r.body.job || null;
          state.status = r.body.status || state.status;
          state.cancelled = !!r.body.cancelled;
          rememberLastJob(jobId);
          // The opened job's own recorded options become the
          // form's options (round 9): the summary bar and a
          // "Run again" both read the job that is on screen, not
          // the last run's form — a CLI-created job opened here
          // used to show the form's defaults ("auto") while its
          // result was a different, explicitly chosen plan. Only
          // an opened job (not a run followed live, whose form
          // already holds the run's own options) takes the disk
          // path from the job's recorded source STEP.
          if (state.job) {
            var recorded = jobOptions(state.job);
            if (recorded) state.lastOptions = recorded;
            if (!state.runStarted && state.job.source_step) {
              state.lastStepPath = state.job.source_step;
            }
          }
          // A run that just finished: scroll the result into view
          // on the next render, so it is not two screens below the
          // form. Opening an existing job (runStarted false) does
          // not scroll — the summary bar's "Jump to result" covers it.
          if (state.status === 'complete' && state.runStarted) state.scrollToResult = true;
          if (state.job && state.job.job_version == null) {
            // cmd_job fills job_version in; a missing value means v1.
            state.job.job_version = 1;
          }
          // The run log for a reopened job: the status endpoint
          // carries the run's streamed progress lines while the
          // server still holds the run record, so a job opened
          // from the Jobs tab (or after a tab switch) shows the
          // same run log as the result view that followed the run.
          // A job whose run the server no longer holds answers
          // progress: [] — the block then says so honestly (see
          // buildRunLog), rather than vanishing.
          getJson('/api/jobs/' + encodeURIComponent(jobId) + '/status')
            .then(function (s) {
              if (s.body && s.body.ok && Array.isArray(s.body.progress)) {
                state.progress = s.body.progress;
                rerender();
              }
            })
            .catch(function () { /* no retained log; the block says so */ });
        } else if (r.body && r.body.error) {
          // A silent (reload-restore) load that fails is a stale
          // id, not an error to banner — the fresh form is the
          // honest view (see resetAfterFailedRestore).
          if (silent) { forgetLastJob(); resetAfterFailedRestore(); }
          else state.lastError = { error: r.body.error, message: r.body.message || '' };
        }
        rerender();
      })
      .catch(function (err) {
        if (silent) { forgetLastJob(); resetAfterFailedRestore(); }
        else state.lastError = { error: 'network_error', message: String(err && err.message || err) };
        rerender();
      });
  }

  function cancelRun() {
    if (!state.jobId || state.status !== 'running') return;
    postJson('/api/jobs/' + encodeURIComponent(state.jobId) + '/cancel', {})
      .then(function (r) {
        if (r.body && r.body.ok) {
          state.status = r.body.status || 'interrupted';
          state.cancelled = true;
          if (!state.finishedAt) state.finishedAt = Date.now();
          updateElapsed();
        } else if (r.body && r.body.error) {
          state.lastError = { error: r.body.error, message: r.body.message || '' };
        }
        rerender();
      })
      .catch(function (err) {
        state.lastError = { error: 'network_error', message: String(err && err.message || err) };
        rerender();
      });
  }

  // ---------------------------------------------------------------- rendering

  function rerender() {
    if (!isCurrentTab()) return;
    if (state.rootEl) renderInto(state.rootEl);
  }

  /** True while the Job prep tab is the selected tab. A fetch that
   * lands after the user has arrowed away must not repaint the
   * shared #tab-main with this tab's content (round 9 — the same
   * unguarded pattern as the Jobs tab's loadList/loadJob). Without
   * a shell (the DOM harness loads this module standalone), render. */
  function isCurrentTab() {
    if (typeof window !== 'undefined' && window.App &&
        typeof window.App.isCurrentTab === 'function') {
      return window.App.isCurrentTab('job-prep');
    }
    return true;
  }

  /** Re-render only the progress list + status line during a run,
   * so the form (and a file the user just picked) is not rebuilt
   * under them on every streamed line. */
  function rerenderProgress() {
    if (!isCurrentTab()) return;
    var root = state.rootEl;
    if (!root) return;
    var list = root.querySelector('[data-role="progress-list"]');
    if (list) {
      list.innerHTML = state.progress.map(function (ln) {
        return '<li>' + esc(ln) + '</li>';
      }).join('');
    }
    var summary = root.querySelector('[data-role="run-log-summary"]');
    if (summary) {
      summary.textContent = 'Run log (' + state.progress.length +
        (state.progress.length === 1 ? ' line' : ' lines') + ')';
    }
    var stages = root.querySelector('[data-role="stage-list"]');
    if (stages) stages.innerHTML = stageItemsHtml();
    var fill = root.querySelector('[data-role="progress-fill"]');
    if (fill) fill.style.width = progressPct() + '%';
    var pct = root.querySelector('[data-role="progress-pct"]');
    if (pct) pct.textContent = progressPct() + '% of stages complete';
    var st = root.querySelector('[data-role="status-line"]');
    if (st) st.textContent = statusText();
    updateElapsed();
  }

  /** The four pipeline stages, read off the streamed log lines:
   * solids -> orientation -> layout -> plans. A stage is done when
   * a line matches it; while running, the first not-done stage is
   * current. The raw lines stay in state.progress (and in the
   * collapsed Run log) — this is a summary, not a replacement. */
  var RUN_STAGES = [
    { key: 'solids', label: 'Solids', re: /solid\(s\) in STEP|part\(s\) in STEP/i },
    { key: 'orientation', label: 'Orientation', re: /orient/i },
    { key: 'layout', label: 'Layout', re: /layout|suggested material|registration pins/i },
    { key: 'plans', label: 'Plans', re: /tool plan|profile tools|wrote .*\.dxf|parts: \d+.*layers:/i },
  ];

  function stageStates() {
    var done = {};
    state.progress.forEach(function (ln) {
      RUN_STAGES.forEach(function (s) { if (s.re.test(ln)) done[s.key] = true; });
    });
    // First sight of a done stage stamps it: the stage's elapsed
    // time is measured from the previous stage's stamp (or the run
    // start), so the durations are read off the stream, never
    // invented — a stage with no matching line yet has no time.
    var now = Date.now();
    RUN_STAGES.forEach(function (s) {
      if (done[s.key] && state.stageDoneAt[s.key] == null) state.stageDoneAt[s.key] = now;
    });
    var current = null;
    if (state.status === 'running') {
      for (var i = 0; i < RUN_STAGES.length; i++) {
        if (!done[RUN_STAGES[i].key]) { current = RUN_STAGES[i].key; break; }
      }
    }
    return RUN_STAGES.map(function (s, i) {
      return {
        key: s.key, label: s.label, n: i + 1,
        state: done[s.key] ? 'done' : (s.key === current ? 'current' : 'todo'),
      };
    });
  }

  /** Elapsed time for one stage pill: a done stage shows how long
   * it took (its stamp minus the previous stage's stamp, or the run
   * start); the current stage shows its live elapsed, ticking on
   * the 1 s timer. A stage with no stamp yet shows nothing. */
  function stageTimeText(states, i) {
    if (!state.runStartedAt) return '';
    var s = states[i];
    if (s.state === 'done') {
      var prev = i === 0 ? state.runStartedAt : state.stageDoneAt[states[i - 1].key];
      var doneAt = state.stageDoneAt[s.key];
      if (doneAt == null || prev == null) return '';
      return fmtDur(doneAt - prev);
    }
    if (s.state === 'current') {
      var since = i === 0 ? state.runStartedAt : state.stageDoneAt[states[i - 1].key];
      if (since == null) return '';
      return fmtDur(Date.now() - since);
    }
    return '';
  }

  /** The running headline: the current stage and how long it has
   * been running ("Orientation · 4:12 in stage"), read off the
   * streamed stage stamps — the same honest per-stage times the
   * stage pills show. Empty once the run is over. */
  function currentStageHeadline() {
    if (state.status !== 'running') return '';
    var states = stageStates();
    for (var i = 0; i < states.length; i++) {
      if (states[i].state === 'current') {
        var t = stageTimeText(states, i);
        return states[i].label + (t ? ' · ' + t + ' in stage' : ' · just started');
      }
    }
    return '';
  }

  function stageItemsHtml() {
    var states = stageStates();
    return states.map(function (s, i) {
      var mark = s.state === 'done' ? '✓' : String(s.n);
      var t = stageTimeText(states, i);
      return '<li class="stage-' + s.state + '">' +
        '<span class="stage-dot" aria-hidden="true">' + mark + '</span>' +
        esc(s.label) +
        (t ? ' <span class="stage-time">' + t + '</span>' : '') + '</li>';
    }).join('');
  }

  function statusText() {
    if (state.status === 'running') return 'Running…';
    if (state.status === 'complete') return 'Complete';
    if (state.status === 'failed') return 'Failed';
    if (state.status === 'interrupted') return 'Interrupted' + (state.cancelled ? ' (cancelled)' : '');
    return 'Idle';
  }

  /** Progress-bar fill: the share of the four pipeline stages done
   * (100% once the run is complete). */
  function progressPct() {
    if (state.status === 'complete') return 100;
    var done = stageStates().filter(function (s) { return s.state === 'done'; }).length;
    return Math.round((done / RUN_STAGES.length) * 100);
  }

  function renderInto(root) {
    state.rootEl = root;
    root.innerHTML = '';
    root.appendChild(el('h2', 'jp-title', 'Job prep'));
    root.appendChild(textEl('p', 'jp-intro',
      'Turn a STEP file into cut-ready plans: drop the file in, check ' +
      'the plan, then download the DXF and reports. Everything runs ' +
      'on this machine.'));

    if (state.lastError) {
      root.appendChild(errorBanner(state.lastError));
    }

    root.appendChild(buildForm());
    // The progress block appears only once a run has started —
    // a fresh form shows no "Progress: Idle" / "Run log (0 lines)".
    if (state.runStarted) root.appendChild(buildProgress());
    if (state.job) root.appendChild(buildResult(state.job));
    else if (state.status === 'failed' && state.jobError) {
      root.appendChild(errorBanner(state.jobError));
    } else if (state.status === 'interrupted') {
      root.appendChild(el('div', 'jp-note',
        'Run interrupted — the job was not completed. ' +
        'Start a new run from the same STEP to try again.'));
    }
    // A reopened job (opened from the Jobs tab, or after a tab
    // switch — runStarted is false, so there is no progress block
    // above) still gets its run-log block, the same record the
    // result view shows for a run followed live. It sits after the
    // result, like the progress block sits after the form.
    if (state.job && !state.runStarted) root.appendChild(buildRunLog());
    // A run that just completed: bring the result into view —
    // it used to sit ~two screens below the form.
    if (state.scrollToResult) {
      state.scrollToResult = false;
      var res = root.querySelector('.jp-result');
      if (res) res.scrollIntoView({ block: 'start' });
    }
  }

  /** Re-run with the same inputs as the job on screen (round 10):
   * the chosen file, or the disk path the job was run from, with
   * the job's own recorded options. With no step source left
   * (e.g. a restored job whose source STEP is gone), the form
   * opens instead with the instruction — never silence. */
  function rerunSameInput() {
    if (state.status === 'running') return;
    if (state.selectedFile) {
      startRunWith(state.lastOptions || {}, state.selectedFile, '');
    } else if (state.lastStepPath) {
      startRunWith(state.lastOptions || {}, null, state.lastStepPath);
    } else {
      state.formExpanded = true;
      state.lastError = { error: 'no_step',
        message: 'Drop a STEP file or enter the path to a STEP already on disk to run again.' };
      rerender();
    }
  }

  /** The completed run's form, collapsed to a one-line summary bar:
   * "real_container.step · 150x90x10 · Plan A · Run again". The
   * "Run again" button starts a new run with the same inputs
   * right away (round 10 — it used to only re-open the form, so
   * clicking Run after a completed job did nothing until a second
   * click); "Edit options" re-opens the full form for a run with
   * different options. The plan segment is the plan that was
   * actually chosen (round 9): the explicit plan letter when the
   * run was started with one, else the result's chosen plan —
   * never a bare "auto" while the result shows a specific plan. */
  function buildSummaryBar() {
    var bar = el('div', 'jp-summary-bar', '');
    bar.setAttribute('data-role', 'form-summary');
    var job = state.job || {};
    var lo = state.lastOptions || {};
    var src = basename(job.source_step || state.lastStepPath || '?');
    var mat = lo.material || '';
    if (!mat) {
      var m = job.suggested_material || job.material;
      if (m) mat = m.x + 'x' + m.y + 'x' + m.thickness;
    }
    var plan = lo.plan ? 'Plan ' + lo.plan
      : (job.tool_plan && job.tool_plan.chosen ? 'Plan ' + job.tool_plan.chosen : 'auto');
    bar.appendChild(textEl('span', 'jp-summary-text',
      src + ' · ' + (mat || 'no material set') + ' · ' + plan));
    var jump = document.createElement('a');
    jump.href = '#jp-result';
    jump.textContent = 'Jump to result ↓';
    bar.appendChild(jump);
    var again = el('button', 'primary', 'Run again');
    again.type = 'button';
    again.setAttribute('data-role', 'run-again');
    again.title = 'Start a new run with the same STEP file and options';
    again.addEventListener('click', rerunSameInput);
    bar.appendChild(again);
    var edit = el('button', '', 'Edit options');
    edit.type = 'button';
    edit.setAttribute('data-role', 'edit-options');
    edit.title = 'Re-open the form to run with different options';
    edit.addEventListener('click', function () {
      state.formExpanded = true;
      rerender();
    });
    bar.appendChild(edit);
    return bar;
  }

  function buildForm() {
    // A completed run collapses the form to its summary bar, so
    // the result is reachable without scrolling past the drop zone,
    // the disk-path field, and the options fieldset.
    if (state.job && state.status === 'complete' && !state.formExpanded) {
      return buildSummaryBar();
    }
    var form = el('form', 'jp-form', '');
    form.setAttribute('data-role', 'run-form');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      startRun(form, state.selectedFile);
    });

    var drop = el('div', 'jp-drop', '');
    drop.setAttribute('data-role', 'drop-zone');
    drop.setAttribute('tabindex', '0');
    // One line of copy; the file picker is a styled button on its
    // own line below. The native input is visually hidden (never
    // display:none, so CDP DOM.setFileInputFiles and the harness's
    // DataTransfer assignment still reach it) — its own "No file
    // chosen" label never shows next to the app's file name.
    drop.innerHTML =
      '<p><strong>Drop a STEP file here</strong></p>' +
      '<p><label class="jp-choose-btn">Choose a file' +
      '<input type="file" accept=".step,.stp" data-role="file-input" class="visually-hidden"></label></p>' +
      '<p data-role="file-name">' +
      (state.selectedFile ? esc(state.selectedFile.name) + ' (' + Math.round(state.selectedFile.size / 1024) + ' KB)' : esc(sourceLineText())) +
      '</p>';
    var fileInput = drop.querySelector('[data-role="file-input"]');
    // The selected-file line, with a Clear control: clearing resets
    // the file input and the displayed name, and re-disables Run
    // until a STEP is chosen again.
    function refreshFileName() {
      var nameEl = drop.querySelector('[data-role="file-name"]');
      if (!nameEl) return;
      nameEl.textContent = '';
      if (state.selectedFile) {
        nameEl.appendChild(document.createTextNode(
          state.selectedFile.name + ' (' + Math.round(state.selectedFile.size / 1024) + ' KB)'));
        var clear = el('button', 'jp-clear', 'Clear');
        clear.type = 'button';
        clear.setAttribute('data-role', 'clear-file');
        clear.addEventListener('click', function () {
          state.selectedFile = null;
          if (fileInput) fileInput.value = '';
          refreshFileName();
          updateRunState(form);
        });
        nameEl.appendChild(clear);
      } else {
        // No file chosen: name the retained disk path when there
        // is one (round 11 — after cancelling a disk-path run this
        // line used to read "No file chosen yet" while the path
        // sat in the field below, so the source looked forgotten).
        nameEl.textContent = sourceLineText();
      }
    }
    refreshFileName();
    fileInput.addEventListener('change', function () {
      state.selectedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      refreshFileName();
      updateRunState(form);
    });
    drop.addEventListener('dragover', function (ev) { ev.preventDefault(); drop.classList.add('jp-drop-over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('jp-drop-over'); });
    drop.addEventListener('drop', function (ev) {
      ev.preventDefault();
      drop.classList.remove('jp-drop-over');
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) {
        state.selectedFile = files[0];
        if (fileInput) { try { fileInput.files = files; } catch (e) { /* assignment may be refused; state holds the file */ } }
        refreshFileName();
        updateRunState(form);
      }
    });
    form.appendChild(drop);

    var disk = el('div', 'jp-disk', '');
    var lo = state.lastOptions || {};
    disk.innerHTML =
      '<label>Or a STEP already on disk<br>' +
      '<input type="text" name="step_path" placeholder="/path/to/part.step" size="48" value="' + esc(state.lastStepPath) + '"></label>' +
      '<p class="jp-hint">Either the dropped file or the disk path is used — the file wins if both are given.</p>';
    var diskInput = disk.querySelector('[name="step_path"]');
    diskInput.addEventListener('input', function () { updateRunState(form); });
    form.appendChild(disk);

    // Plan options as a two-column grid: labels in one column,
    // controls aligned to a common left edge in the second — the
    // old inline labels left ragged, inconsistent widths.
    var opts = el('fieldset', 'jp-options', '');
    opts.appendChild(el('legend', '', 'Plan options'));
    var optsGrid = el('div', 'jp-options-grid', '');
    function optRow(labelText, control) {
      var row = el('div', 'jp-opt-row', '');
      var lab = document.createElement('label');
      lab.textContent = labelText;
      row.appendChild(lab);
      row.appendChild(control);
      optsGrid.appendChild(row);
      return row;
    }
    function optInput(tag, attrs) {
      var n = document.createElement(tag);
      for (var k in attrs) {
        if (k === 'text') n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
      return n;
    }
    var matInput = optInput('input', { type: 'text', name: 'material', placeholder: '150x90x10', size: '12', value: lo.material || '' });
    optRow('Material', matInput);
    var planSel = optInput('select', { name: 'plan' });
    planSel.innerHTML = '<option value="">auto (fastest)</option>' +
      '<option value="A"' + (lo.plan === 'A' ? ' selected' : '') + '>A</option>' +
      '<option value="B"' + (lo.plan === 'B' ? ' selected' : '') + '>B</option>' +
      '<option value="C"' + (lo.plan === 'C' ? ' selected' : '') + '>C</option>';
    optRow('Plan', planSel);
    var modeSel = optInput('select', { name: 'mode' });
    modeSel.innerHTML = '<option value="full"' + ((lo.mode || 'full') === 'full' ? ' selected' : '') + '>full</option>' +
      '<option value="check"' + (lo.mode === 'check' ? ' selected' : '') + '>check</option>' +
      '<option value="dxf"' + (lo.mode === 'dxf' ? ' selected' : '') + '>dxf</option>' +
      '<option value="manifest"' + (lo.mode === 'manifest' ? ' selected' : '') + '>manifest</option>';
    optRow('Mode', modeSel);
    var minToolInput = optInput('input', { type: 'number', name: 'min_tool', step: '0.01', min: '0', placeholder: 'no minimum', value: lo.min_tool != null ? String(lo.min_tool) : '' });
    optRow('Min. tool (mm)', minToolInput);
    var onlyInput = optInput('input', { type: 'text', name: 'only', placeholder: 'part name', size: '12', value: lo.only || '' });
    optRow('Only', onlyInput);
    var autoInput = optInput('input', { type: 'checkbox', name: 'auto' });
    if ((state.lastOptions ? lo.auto : true)) autoInput.checked = true;
    var autoRow = el('div', 'jp-opt-row jp-opt-check', '');
    autoRow.appendChild(autoInput);
    var autoLab = document.createElement('label');
    autoLab.textContent = 'Auto-orient (orientation search)';
    autoRow.appendChild(autoLab);
    optsGrid.appendChild(autoRow);
    opts.appendChild(optsGrid);
    form.appendChild(opts);

    // The Run row sticks to the bottom of the viewport while the
    // form scrolls (see style.css): at 1440x900 the button used to
    // sit under the Plan options fieldset, below the fold, so the
    // first screen was a tall form with no action visible. The
    // options stay where they are — only the action is reachable
    // without scrolling.
    var runBar = el('div', 'jp-run-bar', '');
    runBar.setAttribute('data-role', 'run-bar');
    var runBtn = el('button', 'jp-run primary', 'Run');
    runBtn.type = 'submit';
    runBtn.disabled = state.status === 'running' || !hasStepSource(form);
    runBar.appendChild(runBtn);
    var runHint = textEl('span', 'jp-run-hint', runHintText(form));
    runHint.setAttribute('data-role', 'run-hint');
    if (state.status === 'running') runHint.style.display = 'none';
    runBar.appendChild(runHint);
    form.appendChild(runBar);
    if (state.status === 'running') {
      form.appendChild(textEl('span', 'jp-hint', ' A run is already in progress — cancel it below to start another.'));
      // Run-state discipline: every form control is disabled while
      // a run is in flight, not just the Run button — the file,
      // material, plan and mode fields used to stay editable
      // mid-run. (The Cancel button lives in the progress section,
      // outside this form, so it stays live.)
      form.querySelectorAll('input, select, textarea, button').forEach(function (c) {
        c.disabled = true;
      });
    }
    return form;
  }

  /** Run stays disabled until a STEP source is present (a chosen
   * file, or a non-blank disk path). */
  function hasStepSource(form) {
    if (state.selectedFile) return true;
    var disk = form.querySelector('[name="step_path"]');
    return !!(disk && String(disk.value).trim());
  }

  function updateRunState(form) {
    var btn = form.querySelector('.jp-run');
    var hint = form.querySelector('[data-role="run-hint"]');
    if (!btn) return;
    var enabled = state.status !== 'running' && hasStepSource(form);
    btn.disabled = !enabled;
    if (hint) {
      // The hint never goes stale: with a valid input it names the
      // chosen input ("Ready to run: real_container.step"); without
      // one it is the instruction. While a run is in flight the
      // "already in progress" line covers it instead.
      if (state.status === 'running') hint.style.display = 'none';
      else {
        hint.style.display = '';
        hint.textContent = runHintText(form);
      }
    }
  }

  /** The Run hint's text: the chosen input once one is valid, the
   * instruction until then. Never the file's full server path —
   * the file name (or the disk path's file name) is enough. */
  function runHintText(form) {
    if (state.selectedFile) return 'Ready to run: ' + state.selectedFile.name;
    var disk = form.querySelector('[name="step_path"]');
    var p = disk ? String(disk.value).trim() : '';
    if (p) return 'Ready to run: ' + basename(p);
    return 'Choose a STEP file or enter a disk path to run.';
  }

  function buildProgress() {
    var box = el('section', 'jp-progress', '');
    box.setAttribute('data-role', 'progress');
    // Once the run is over the block stops being sticky: a stuck
    // block keeps its flow slot reserved below the collapsed form,
    // which read as ~200 px of dead space between the summary bar
    // and "Progress: Complete" when scrolling back up. While a run
    // is in flight it stays sticky (progress + Cancel visible).
    if (state.status !== 'running') box.classList.add('jp-progress-done');
    var head = el('div', 'jp-progress-head', '');
    head.appendChild(textEl('strong', '', 'Progress: '));
    var st = textEl('span', '', statusText());
    st.setAttribute('data-role', 'status-line');
    head.appendChild(st);
    // Round 10 — the head is separate labelled pieces, split by
    // separators, not one run-on line: "Progress: Running… ·
    // Orientation · 0:01 in stage · 25% of stages complete ·
    // 0:01 elapsed · job …". The percent names what it is a
    // percent of (the four pipeline stages), so it no longer reads
    // as overall progress sitting near 0% through a long stage.
    function sep() {
      var s = textEl('span', 'jp-progress-sep', '·');
      s.setAttribute('aria-hidden', 'true');
      return s;
    }
    if (state.status === 'running') {
      // The current stage + its live elapsed is the headline: the
      // percent is only the share of the four stages done, so it
      // sat at 0%/25% for the whole 7-minute Orientation stage and
      // the run read as hung. The stage time ticks every second
      // (updateElapsed) and is measured off the stream, never
      // invented — the percent stays as secondary text.
      head.appendChild(sep());
      var hl = textEl('span', 'jp-stage-headline', currentStageHeadline());
      hl.setAttribute('data-role', 'stage-headline');
      head.appendChild(hl);
      head.appendChild(sep());
      var pct = textEl('span', 'jp-pct', progressPct() + '% of stages complete');
      pct.setAttribute('data-role', 'progress-pct');
      head.appendChild(pct);
    }
    // "Progress: Complete" on its own, with the finished time in
    // the elapsed span next to it — the percent is not repeated
    // once the run is over ("Complete 100% of stages complete").
    // A reopened job has no in-session timing (no runStartedAt),
    // so the elapsed piece — separator included — is omitted
    // rather than rendered as a dangling "·".
    var elapsedValue = state.status === 'running' ? elapsedText() : finishedText();
    if (elapsedValue) {
      head.appendChild(sep());
      var elapsed = textEl('span', 'jp-elapsed', elapsedValue);
      elapsed.setAttribute('data-role', 'elapsed');
      head.appendChild(elapsed);
    }
    if (state.jobId) {
      head.appendChild(sep());
      head.appendChild(textEl('span', 'jp-hint', 'job ' + state.jobId));
    }
    box.appendChild(head);
    // Stage summary: the four pipeline stages at a glance. The raw
    // log lives collapsed underneath (issue: it used to dominate the
    // page as a ~30-line numbered list with absolute server paths).
    var stages = el('ol', 'stages', stageItemsHtml());
    stages.setAttribute('data-role', 'stage-list');
    stages.setAttribute('aria-label', 'Pipeline stages');
    box.appendChild(stages);
    // Thin progress bar under the stage pills, plus a pulsing
    // current pill (see style.css): a long run reads as alive.
    var bar = el('div', 'jp-progress-bar', '');
    bar.setAttribute('data-role', 'progress-bar');
    var fill = el('div', 'jp-progress-fill', '');
    fill.setAttribute('data-role', 'progress-fill');
    fill.style.width = progressPct() + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    var details = el('details', 'run-log', '');
    var summary = el('summary', '', 'Run log (' + state.progress.length +
      (state.progress.length === 1 ? ' line' : ' lines') + ')');
    summary.setAttribute('data-role', 'run-log-summary');
    details.appendChild(summary);
    var list = el('ol', 'jp-progress-list', state.progress.map(function (ln) {
      return '<li>' + esc(ln) + '</li>';
    }).join(''));
    list.setAttribute('data-role', 'progress-list');
    details.appendChild(list);
    box.appendChild(details);
    if (state.status === 'running') {
      var cancel = el('button', 'jp-cancel', 'Cancel run');
      cancel.type = 'button';
      cancel.addEventListener('click', cancelRun);
      box.appendChild(cancel);
      box.appendChild(textEl('span', 'jp-hint', ' Cancelling kills the CLI run and marks the job interrupted.'));
    }
    if (state.sseFailed && state.status === 'running') {
      box.appendChild(textEl('p', 'jp-hint', 'Live progress stream unavailable — polling status every 2 s.'));
    }
    return box;
  }

  /** The run log for a reopened job (see loadJob): the same
   * collapsed "Run log (N lines)" record the progress block shows
   * for a run followed live, with the job's status line — so a job
   * opened from the Jobs tab is not missing the progress record
   * the result view shows. When the server no longer holds the
   * run, the block stays and says so honestly instead of vanishing. */
  function buildRunLog() {
    var box = el('section', 'jp-run-log', '');
    box.setAttribute('data-role', 'run-log');
    box.appendChild(textEl('strong', '', 'Run log: '));
    box.appendChild(textEl('span', '', statusText()));
    if (!state.progress.length) {
      box.appendChild(textEl('p', 'jp-hint', 'No run log was captured for this job.'));
      return box;
    }
    var details = el('details', 'run-log', '');
    var summary = el('summary', '', 'Run log (' + state.progress.length +
      (state.progress.length === 1 ? ' line' : ' lines') + ')');
    summary.setAttribute('data-role', 'run-log-summary');
    details.appendChild(summary);
    var list = el('ol', 'jp-progress-list', state.progress.map(function (ln) {
      return '<li>' + esc(ln) + '</li>';
    }).join(''));
    list.setAttribute('data-role', 'progress-list');
    details.appendChild(list);
    box.appendChild(details);
    return box;
  }

  /** The drop zone's source line when no file is chosen: the disk
   * path the last run used, if one was given — after cancelling a
   * disk-path run the form used to read "No file chosen yet" even
   * though the disk path was still in the field below it, so the
   * source looked forgotten. The full path stays in the disk-path
   * field; this line names the file it points at. */
  function sourceLineText() {
    if (state.lastStepPath) {
      return 'Using disk path: ' + basename(state.lastStepPath) + ' — no file chosen.';
    }
    return 'No file chosen yet.';
  }

  /** The 2D layout preview for the result view (round 11): the
   * SAME preview the Jobs detail renders, through the Jobs tab's
   * own buildLayoutPreview — the drawing and caption stay
   * identical, because they are the same code path on the same
   * job object. Rendered inline here because the layout is a
   * primary pre-cut check, and it used to be reachable only via
   * Jobs → Open. Two adaptations for this tab: the preview's Run
   * guides button is rewired to this tab's own runGuides (the
   * Jobs module's button would reload the Jobs tab's state, not
   * this result), and any stale Jobs-tab guides error inside the
   * preview is dropped (it belongs to that tab, not this view).
   * When the Jobs module is not loaded (the DOM harness loads
   * job-prep.js standalone), the fallback is a prominent
   * "View layout →" link that opens the job's detail instead. */
  function buildResultPreview(job) {
    if (window.MldxfJobs && typeof window.MldxfJobs.buildLayoutPreview === 'function') {
      var box = window.MldxfJobs.buildLayoutPreview(job);
      var stale = box.querySelector('[data-role="guides-error"]');
      if (stale) stale.remove();
      var gbtn = box.querySelector('[data-role="run-guides"]');
      if (gbtn) {
        var repl = gbtn.cloneNode(true);
        repl.textContent = 'Run guides';
        repl.disabled = false;
        gbtn.parentNode.replaceChild(repl, gbtn);
        repl.addEventListener('click', runGuides);
      }
      return box;
    }
    var linkBox = el('div', 'jp-preview-link', '');
    var viewBtn = el('button', 'primary', 'View layout →');
    viewBtn.type = 'button';
    viewBtn.setAttribute('data-role', 'view-layout');
    viewBtn.addEventListener('click', function () {
      var id = job.job_id || state.jobId;
      if (window.MldxfJobs && typeof window.MldxfJobs.openJob === 'function') {
        window.MldxfJobs.openJob(id);
      }
      if (window.App && typeof window.App.showTab === 'function') window.App.showTab('jobs');
    });
    linkBox.appendChild(viewBtn);
    linkBox.appendChild(textEl('span', 'jp-hint',
      ' The 2D layout preview lives on the job’s detail page.'));
    return linkBox;
  }

  function buildResult(job) {
    var sec = el('section', 'jp-result', '');
    sec.setAttribute('id', 'jp-result');
    var version = job.job_version == null ? 1 : job.job_version;
    // The readable name leads; the machine id sits in muted small
    // text beneath it, and the date reads in local human form —
    // no raw ISO timestamp, no job-version metadata here (that
    // lives in the About dialog).
    sec.appendChild(el('h3', '', 'Result — ' + esc(jobStem(job.job_id || state.jobId || 'job'))));
    var metaLine = el('p', 'jp-hint', '');
    metaLine.appendChild(document.createTextNode(
      'Source: ' + basename(job.source_step || '?') +
      (job.created_at ? ' · ' + humanDate(job.created_at) : '')));
    var idLine = el('p', 'jp-hint', '');
    idLine.appendChild(document.createTextNode('Job id: ' + (job.job_id || state.jobId || '—')));
    sec.appendChild(metaLine);
    sec.appendChild(idLine);

    if (version < 2) {
      sec.appendChild(el('div', 'jp-note',
        'This is a v1 job — read-only. It has no embedded inputs or config snapshot, ' +
        'so it cannot be re-run from here; re-run <code>mldxf plan</code> on the source STEP for a new job.'));
    }

    // Round 11 — the 2D layout preview, inline in the result view
    // itself: the layout is a primary pre-cut check, and it used
    // to be reachable only via Jobs → Open. It sits above the plan
    // tables, and is the same preview the Jobs detail renders.
    sec.appendChild(buildResultPreview(job));

    // Check-mode jobs carry no tool plan — show the check summary.
    if (job.command === 'check') {
      sec.appendChild(buildCheckSummary(job));
      return sec;
    }

    var toolPlan = job.tool_plan || {};
    var plans = toolPlan.plans || [];
    if (!plans.length) {
      sec.appendChild(el('div', 'jp-note',
        toolPlan.error ? 'No tool plan: ' + esc(toolPlan.error)
          : 'This job has no tool plan (mode ' + esc(job.mode || '?') + ' writes no plan).'));
    } else {
      sec.appendChild(buildPlans(job, toolPlan, plans));
    }

    sec.appendChild(buildSummary(job));
    sec.appendChild(buildFlags(job));
    sec.appendChild(buildPostProcess(job));
    sec.appendChild(buildWorkholding(job));
    sec.appendChild(buildDownloads(job));
    return sec;
  }

  function buildCheckSummary(job) {
    var box = el('div', 'jp-check', '');
    box.appendChild(el('h4', '', 'Check complete — no job was written (check mode classifies only).'));
    var totals = job.totals || {};
    box.appendChild(textEl('p', '', 'Parts: ' + (job.parts ? job.parts.length : 0) +
      ' · layers: ' + (totals.layers != null ? totals.layers : '?') +
      ' · holes: ' + (totals.holes != null ? totals.holes : '?') +
      ' · pockets: ' + (totals.pockets != null ? totals.pockets : '?') +
      ' · flags: ' + (totals.flags != null ? totals.flags : '?')));
    return box;
  }

  function buildSummary(job) {
    var box = el('div', 'jp-summary', '');
    box.appendChild(el('h4', '', 'Job'));
    // A 4-up stat strip, not four undifferentiated text lines.
    // The exact harness substrings survive as the stat values.
    var strip = el('div', 'stat-strip', '');
    function stat(label, value) {
      var s = el('div', 'stat', '');
      s.appendChild(textEl('span', 'stat-label', label));
      s.appendChild(textEl('span', 'stat-value', value));
      strip.appendChild(s);
    }
    var parts = job.parts || [];
    stat('Parts (' + parts.length + ')', parts.length ? parts.map(function (p) {
      var fp = p.footprint_mm ? mm(p.footprint_mm[0]) + ' × ' + mm(p.footprint_mm[1]) + ' mm' : '';
      return (p.name || '?') + (fp ? ' ' + fp : '');
    }).join('; ') : '—');
    stat('Layers', String(job.layers ? job.layers.length : 0));
    var matVal = '—';
    if (job.material) {
      matVal = 'Material: ' + mm(job.material.x) + ' × ' + mm(job.material.y) + ' × ' + mm(job.material.thickness) + ' mm';
    } else if (job.suggested_material) {
      var s = job.suggested_material;
      matVal = 'Suggested material: ' + s.x + ' × ' + s.y + ' × ' + s.thickness + ' mm';
    }
    stat('Material', matVal);
    stat('Cut order', job.cut_order && job.cut_order.length ? job.cut_order.join(' → ') : '—');
    box.appendChild(strip);
    return box;
  }

  function buildPlans(job, toolPlan, plans) {
    var box = el('div', 'jp-plans', '');
    box.appendChild(el('h4', '', 'Tool plan'));
    var chosen = toolPlan.chosen || (plans[0] && plans[0].id);
    plans.forEach(function (plan) {
      var isChosen = plan.id === chosen;
      var pbox = el('article', 'jp-plan plan-card' + (isChosen ? ' plan-chosen' : ''), '');
      var head = el('div', 'plan-head', '');
      head.appendChild(el('h5', '',
        esc('Plan ' + (plan.id || '?') + (isChosen ? ' (chosen — fastest estimate)' : ''))));
      if (isChosen) head.appendChild(el('span', 'badge badge-chosen', 'Chosen'));
      pbox.appendChild(head);
      var total = el('div', 'plan-total', '');
      total.appendChild(document.createTextNode(minutes(plan.total_seconds) + ' '));
      total.appendChild(el('small', '', 'min total'));
      pbox.appendChild(total);
      var meta = (plan.tools ? plan.tools.length : 0) + ' tools · ' +
        (plan.tool_changes != null ? plan.tool_changes : '?') + ' changes';
      if (plan.cutting_seconds != null && plan.change_seconds != null) {
        meta += ' · cutting ' + minutes(plan.cutting_seconds) + ' + changes ' + minutes(plan.change_seconds);
      }
      pbox.appendChild(textEl('p', 'plan-meta', meta));
      var tools = displayTools(plan.tools || []);
      var anyNotOwned = tools.some(function (t) { return t.owned === false; });
      var anyUnknown = tools.some(function (t) { return t.owned !== true && t.owned !== false; });
      if (anyNotOwned) {
        pbox.appendChild(el('div', 'jp-warn plan-warn',
          'This plan needs a tool that is not in your inventory — check before you cut.'));
      }
      var table = el('table', 'plan-tools', '');
      table.appendChild(el('tr', {}, [
        el('th', { text: '#' }), el('th', { text: 'Tool' }),
        el('th', { class: 'num', text: 'Ø (mm)' }),
        el('th', { class: 'num', text: 'Feed (mm/s)' }),
        el('th', { text: 'In your inventory' }),
      ]));
      tools.forEach(function (t) {
        var row = document.createElement('tr');
        function cell(text, cls, label) {
          var td = document.createElement('td');
          if (cls) td.className = cls;
          if (label) td.setAttribute('data-label', label);
          td.textContent = text;
          return td;
        }
        row.appendChild(cell(t.tool_number != null ? 'T' + t.tool_number : '—', '', '#'));
        var toolCell = document.createElement('td');
        toolCell.setAttribute('data-label', 'Tool');
        toolCell.appendChild(textEl('strong', '', toolLabel(t)));
        if (t.id) toolCell.appendChild(textEl('span', 'jp-hint', ' ' + t.id));
        if (t.kind) toolCell.appendChild(textEl('span', 'jp-hint', ' · ' + t.kind));
        row.appendChild(toolCell);
        row.appendChild(cell(t.dia_mm != null ? mm(t.dia_mm) : '—', 'num', 'Ø (mm)'));
        row.appendChild(cell(t.feed_mm_s != null ? String(t.feed_mm_s) : '—', 'num', 'Feed (mm/s)'));
        var ownedCell = document.createElement('td');
        ownedCell.setAttribute('data-label', 'In your inventory');
        if (t.owned === true) {
          ownedCell.appendChild(textEl('span', 'badge badge-owned', '✓ owned'));
        } else if (t.owned === false) {
          ownedCell.appendChild(textEl('span', 'badge badge-not-owned',
            'not in your inventory — check before you cut'));
        } else {
          // owned === undefined: no badge, no guess (v1 job or
          // pre-inventory job) — the absence is the honest display.
          ownedCell.appendChild(textEl('span', 'muted', '—'));
        }
        row.appendChild(ownedCell);
        table.appendChild(row);
      });
      // The table scrolls horizontally instead of wrapping a tool
      // cell mid-phrase at narrow widths (see style.css).
      var tableWrap = el('div', 'plan-table-scroll', '');
      tableWrap.appendChild(table);
      pbox.appendChild(tableWrap);
      if (anyUnknown) {
        pbox.appendChild(textEl('p', 'jp-hint',
          'No inventory info for ' + (job.job_version == null || job.job_version < 2 ? 'this v1 job' : 'this job') +
          ' — owned/not-owned is not recorded for it.'));
      }
      var warns = plan.dependency_warnings || [];
      if (warns.length) {
        pbox.appendChild(el('div', 'jp-warn plan-warn', 'Dependency warnings: ' + esc(warns.join('; '))));
      }
      box.appendChild(pbox);
    });
    return box;
  }

  function buildFlags(job) {
    var box = el('div', 'jp-flags', '');
    var flags = job.flags || [];
    box.appendChild(el('h4', '', 'Flags (' + flags.length + ') — read before cutting'));
    if (!flags.length) {
      box.appendChild(textEl('p', '', 'None.'));
      return box;
    }
    // Group by part (leading "[PART] "), in first-seen order; flags
    // with no part go under "General". Enum names become human
    // words; severity is styled, never dropped. Display transform
    // only — the flag data is unchanged.
    var groups = [];
    var byPart = {};
    flags.forEach(function (f) {
      var parsed = parseFlag(f);
      var key = parsed.part || 'General';
      if (!byPart[key]) {
        byPart[key] = { part: key, items: [] };
        groups.push(byPart[key]);
      }
      byPart[key].items.push(humanizeFlagText(parsed.text));
    });
    groups.forEach(function (g) {
      var gbox = el('div', 'flag-group', '');
      gbox.appendChild(el('h5', '', esc(g.part)));
      var list = el('ul', 'flag-list', '');
      // One link to the Post-processing section per flag group —
      // it used to repeat on every POST-PROCESS flag in the group.
      var postLinkUsed = false;
      groupNearIdenticalFlags(g.items).forEach(function (cluster) {
        var text = cluster.text;
        var li = document.createElement('li');
        var sev = flagSeverity(text);
        li.appendChild(textEl('span',
          'badge ' + (sev === 'must' ? 'badge-must' : 'badge-info'),
          sev === 'must' ? 'Must read' : 'Info'));
        if (cluster.count > 1) {
          li.appendChild(textEl('span', 'badge flag-count', '×' + cluster.count));
        }
        // Title in normal case + one detail line — not an unbroken
        // all-caps paragraph. A POST-PROCESS flag's body is the
        // Post-processing section itself, so the first one in the
        // group links there instead of repeating the step verbatim;
        // later ones in the same group show their own detail. A
        // grouped (×N) row keeps its own detail plus the full
        // variants below, so the link never hides a variant.
        var body = el('div', 'flag-text', '');
        body.appendChild(textEl('strong', 'flag-title', flagTitle(text)));
        if (/POST-PROCESS/i.test(text) && !postLinkUsed && cluster.count === 1) {
          postLinkUsed = true;
          var link = document.createElement('a');
          link.href = '#jp-post';
          link.textContent = 'See the Post-processing section below';
          body.appendChild(link);
        } else {
          // Round 11 — the detail is collapsible behind the
          // one-line title, so the flags scan as summaries before
          // a cut and the full detail is one click away. The title
          // stays visible (and in the text) with the details closed.
          var detail = flagDetail(text);
          if (detail) {
            var det = el('details', 'flag-detail-toggle', '');
            det.appendChild(el('summary', '', 'Details'));
            det.appendChild(textEl('span', 'flag-detail', detail));
            body.appendChild(det);
          }
        }
        if (cluster.variants) {
          var variants = el('details', 'flag-variants', '');
          var summary = el('summary', '', 'Show all ' + cluster.count + ' occurrences');
          variants.appendChild(summary);
          cluster.variants.forEach(function (v) {
            variants.appendChild(textEl('div', 'flag-variant', v));
          });
          body.appendChild(variants);
        }
        li.appendChild(body);
        list.appendChild(li);
      });
      gbox.appendChild(list);
      box.appendChild(gbox);
    });
    return box;
  }

  function buildPostProcess(job) {
    var box = el('div', 'jp-post', '');
    box.setAttribute('id', 'jp-post');
    var steps = postProcessStepsGrouped(job);
    box.appendChild(el('h4', '', 'Post-processing (' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + ')'));
    if (!steps.length) {
      box.appendChild(textEl('p', '', 'None — part is fully prismatic.'));
      return box;
    }
    // One step card per step — a method badge, the action as a
    // sentence, and the part ids as chips — not a raw log line.
    steps.forEach(function (s) {
      var parsed = parsePostStep(s.text);
      var card = el('div', 'post-step', '');
      if (parsed.methodLabel) {
        card.appendChild(textEl('span', 'badge badge-info', parsed.methodLabel));
      }
      var body = el('div', '', '');
      body.appendChild(textEl('p', 'post-step-action', parsed.action));
      if (parsed.feature) {
        body.appendChild(textEl('p', 'post-step-feature', parsed.feature));
      }
      if (s.parts.length) {
        var chips = el('div', 'post-step-parts', '');
        s.parts.forEach(function (part) {
          chips.appendChild(textEl('span', 'chip', part));
        });
        body.appendChild(chips);
      }
      card.appendChild(body);
      box.appendChild(card);
    });
    return box;
  }

  /** Run the workholding guides for the job on screen (V2.9):
   * POST /api/jobs/:id/guides, then reload the job so the
   * recommendation renders from job.json on disk. A refusal
   * (placeholder T-track, no clamps, v1 job) lands ONLY in
   * state.guidesError, which buildWorkholding renders inline
   * under the Workholding section — the round-7 version also set
   * state.lastError, so the same refusal showed twice (top banner
   * + Workholding section). The tab-level banner is for run/start
   * failures, not for a refusal at the point of action. */
  var guidesRunning = false;

  function runGuides() {
    if (!state.jobId || guidesRunning) return;
    guidesRunning = true;
    state.lastError = null;
    state.guidesError = null;
    rerender();
    postJson('/api/jobs/' + encodeURIComponent(state.jobId) + '/guides', {})
      .then(function (r) {
        guidesRunning = false;
        if (r.body && r.body.ok) {
          state.guidesError = null;
          loadJob(state.jobId);
        } else if (r.body && r.body.error) {
          state.guidesError = { error: r.body.error, message: r.body.message || '' };
          rerender();
          scrollGuidesErrorIntoView();
        } else {
          state.guidesError = { error: 'guides_failed', message: 'guides returned no result' };
          rerender();
          scrollGuidesErrorIntoView();
        }
      })
      .catch(function (err) {
        guidesRunning = false;
        state.guidesError = { error: 'network_error', message: String(err && err.message || err) };
        rerender();
        scrollGuidesErrorIntoView();
      });
  }

  /** Bring the inline guides refusal into view (block: 'nearest'
   * moves the page only when the error is off-screen — the section
   * is usually already in view, since the user just clicked there). */
  function scrollGuidesErrorIntoView() {
    var root = state.rootEl;
    if (!root) return;
    var n = root.querySelector('[data-role="guides-error"]');
    if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
  }

  /** The inline guides refusal for the Workholding section: the
   * same human-readable banner as the tab-level one (same error
   * object, same data-error-code), rendered where the button is.
   * The refusal names a file ("replace the placeholder slots in
   * machine.json") instead of the UI path — for the refusals the
   * Clamps & machine tab fixes (placeholder slots, no clamps, an
   * unmountable clamp), a button to that tab sits in the banner,
   * at the point of action. The message itself is the CLI's,
   * left unchanged. */
  function guidesErrorEl() {
    if (!state.guidesError) return null;
    var b = errorBanner(state.guidesError);
    b.setAttribute('data-role', 'guides-error');
    // Round 11 — the message and the action are separate blocks:
    // the button used to sit inline mid-sentence, reading as part
    // of the sentence. The message is its own line; the button is
    // on its own line below it, in its own wrapper. (The button
    // was already display:block here via .jp-guides-link; the
    // wrapper makes the own-line structure explicit and shared
    // with the Jobs tab's identical error, which was inline.)
    var msg = el('span', 'guides-error-msg', '');
    msg.textContent = b.textContent;
    b.textContent = '';
    b.appendChild(msg);
    var code = state.guidesError.error;
    if (code === 't_track_placeholder' || code === 'guides_no_clamps' || code === 'clamp_no_slot') {
      var wrap = el('div', 'guides-error-action', '');
      var go = el('button', 'jp-guides-link', 'Open Clamps & machine');
      go.type = 'button';
      go.setAttribute('data-role', 'guides-open-clamps');
      go.addEventListener('click', function () {
        if (window.App && typeof window.App.showTab === 'function') window.App.showTab('clamps-machine');
      });
      wrap.appendChild(go);
      b.appendChild(wrap);
    }
    return b;
  }

  function buildWorkholding(job) {
    var box = el('div', 'jp-workholding', '');
    box.appendChild(el('h4', '', 'Workholding'));
    var wh = job.workholding;
    if (wh == null) {
      // No guides for this job yet — say so honestly, never invent
      // one. A v2 job can run the guides from here; a v1 job is
      // read-only (guides need the V2.2 job model).
      if (job.job_version != null && job.job_version < 2) {
        box.appendChild(textEl('p', '',
          'No guides for this job — it is a v1 job, and workholding guides need a V2 job. ' +
          'Place clamps by hand and keep them clear of every cut.'));
        var ge1 = guidesErrorEl();
        if (ge1) box.appendChild(ge1);
        return box;
      }
      box.appendChild(textEl('p', '',
        'No guides yet for this job — no clamp recommendation has been computed. ' +
        'Place clamps by hand and keep them clear of every cut, or run the guides.'));
      var btn = el('button', 'jp-guides', guidesRunning ? 'Running guides…' : 'Run guides');
      btn.type = 'button';
      btn.disabled = guidesRunning;
      btn.addEventListener('click', runGuides);
      box.appendChild(btn);
      var ge2 = guidesErrorEl();
      if (ge2) box.appendChild(ge2);
      return box;
    }
    if (typeof wh === 'string') {
      box.appendChild(textEl('p', '', wh));
      return box;
    }
    var rec = wh.recommendation || wh.summary;
    var clamps = wh.clamps || wh.positions || [];
    var fm = wh.force_model || {};
    if (clamps.length) {
      // One summary line, then a compact table — the recommendation
      // paragraph, the per-clamp bullets and the force note used to
      // state the same facts three times over.
      var ids = [];
      clamps.forEach(function (c) {
        var id = c.clamp_id || c.method || 'clamp';
        if (ids.indexOf(id) === -1) ids.push(id);
      });
      var summary = clamps.length + ' clamp' + (clamps.length === 1 ? '' : 's') +
        ' (' + ids.join(', ') + ')' +
        (fm.worst_force_n != null ? ' — worst estimated cut force ' + fm.worst_force_n + ' N' : '');
      box.appendChild(textEl('p', 'jp-wh-summary', summary));
      // The force check is computed once per clamp; when every
      // clamp carries the same check it is one summary line above
      // the table, not the identical text repeated in every row —
      // the column stays only when the values differ per clamp.
      function forceText(c) {
        var fc = c.force_check || {};
        if (fc.status === 'holds' && fc.hold_force_n != null && fc.worst_force_n != null) {
          return 'Holds — ' + fc.hold_force_n + ' N vs ' + fc.worst_force_n + ' N est.';
        }
        if (fc.status === 'insufficient' && fc.hold_force_n != null && fc.worst_force_n != null) {
          return 'Too weak — ' + fc.hold_force_n + ' N vs ' + fc.worst_force_n + ' N est.';
        }
        if (fc.note) return fc.note;
        return 'Unknown — verify by hand';
      }
      var forceTexts = clamps.map(forceText);
      var forceSame = forceTexts.every(function (t) { return t === forceTexts[0]; });
      if (forceSame) {
        box.appendChild(textEl('p', 'jp-wh-summary',
          'Force check (same for all clamps): ' + forceTexts[0]));
      }
      var table = el('table', 'wh-table', '');
      var headerCells = [
        el('th', { text: 'Clamp' }), el('th', { text: 'Position' }),
        el('th', { text: 'Slot' }), el('th', { text: 'Supports' }),
      ];
      if (!forceSame) headerCells.push(el('th', { text: 'Force check' }));
      table.appendChild(el('tr', {}, headerCells));
      clamps.forEach(function (c, ci) {
        var row = document.createElement('tr');
        function cell(text, cls, label) {
          var td = document.createElement('td');
          if (cls) td.className = cls;
          if (label) td.setAttribute('data-label', label);
          td.textContent = text;
          return td;
        }
        row.appendChild(cell(c.clamp_id || c.method || 'clamp', '', 'Clamp'));
        row.appendChild(cell(c.x_mm != null && c.y_mm != null
          ? '(' + mm(c.x_mm) + ', ' + mm(c.y_mm) + ')' : '—', '', 'Position'));
        row.appendChild(cell(c.slot || '—', '', 'Slot'));
        var supports = c.reason ? String(c.reason).split(' — ')[0] : '—';
        row.appendChild(cell(supports, '', 'Supports'));
        if (!forceSame) row.appendChild(cell(forceTexts[ci], '', 'Force check'));
        table.appendChild(row);
      });
      // The table scrolls horizontally at narrow widths instead of
      // crushing its columns to one word per line.
      var tableWrap = el('div', 'table-scroll', '');
      tableWrap.appendChild(table);
      box.appendChild(tableWrap);
    } else if (rec) {
      box.appendChild(textEl('p', '', rec));
    } else {
      box.appendChild(textEl('p', '', 'No clamp positions recorded for this job.'));
    }
    var alts = wh.alternatives || [];
    if (alts.length) {
      box.appendChild(textEl('p', '', 'Alternatives for areas the slots cannot reach (same keep-out rules, place by hand):'));
      var alist = el('ul', '', '');
      alts.forEach(function (a) {
        alist.appendChild(textEl('li', '',
          (a.clamp_id || a.method || 'alternative') + (a.note ? ' — ' + a.note : '')));
      });
      box.appendChild(alist);
    }
    if (fm.note) {
      // Two lines, not the 8-line physics paragraph — the full
      // estimate lives behind a disclosure.
      box.appendChild(textEl('p', 'jp-force-note',
        'Force model: first-order estimate only — not a validated physics model. ' +
        'Verify holding force by hand before cutting.'));
      var details = el('details', 'jp-force-details', '');
      details.appendChild(el('summary', '', 'How the force is estimated'));
      details.appendChild(textEl('p', '', fm.note));
      if (fm.formula) details.appendChild(textEl('p', '', fm.formula));
      if (fm.worst_force_n != null) {
        details.appendChild(textEl('p', '', 'Worst estimated force: ' + fm.worst_force_n + ' N' +
          (fm.worst_layer ? ' (' + fm.worst_layer + ')' : '') + '.'));
      }
      box.appendChild(details);
    }
    if (job.job_version == null || job.job_version >= 2) {
      var re = el('button', 'jp-guides', guidesRunning ? 'Running guides…' : 'Re-run guides');
      re.type = 'button';
      re.disabled = guidesRunning;
      re.addEventListener('click', runGuides);
      box.appendChild(re);
    }
    var ge3 = guidesErrorEl();
    if (ge3) box.appendChild(ge3);
    return box;
  }

  function buildDownloads(job) {
    var box = el('div', 'jp-downloads', '');
    box.appendChild(el('h4', '', 'Downloads'));
    var id = job.job_id || state.jobId;
    var names = downloadNames(job);
    box.appendChild(textEl('p', 'jp-hint', 'Served exactly from this job’s outputs on disk.'));
    var list = el('ul', 'download-list', '');
    function link(file, label) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'jp-download download-btn';
      a.href = '/api/jobs/' + encodeURIComponent(id) + '/download/' + encodeURIComponent(file);
      a.setAttribute('download', file);
      var labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      var sizeSpan = document.createElement('span');
      sizeSpan.className = 'download-size';
      a.appendChild(labelSpan);
      a.appendChild(sizeSpan);
      li.appendChild(a);
      // Fill in the file size from the download response headers
      // (best effort — a canned or stale job answers 404 and the
      // link simply shows no size; the href never changes).
      fetch(a.href).then(function (resp) {
        var len = resp.headers && resp.headers.get
          ? resp.headers.get('content-length') : null;
        if (resp.ok && len) sizeSpan.textContent = formatBytes(Number(len));
        if (resp.body && resp.body.cancel) {
          try { resp.body.cancel(); } catch (e) { /* already consumed */ }
        }
      }).catch(function () { /* no size */ });
      return li;
    }
    if (names.dxf) list.appendChild(link(names.dxf, 'Download DXF (' + names.dxf + ')'));
    if (names.manifestTxt) list.appendChild(link(names.manifestTxt, 'Download manifest.txt'));
    if (names.reportMd) list.appendChild(link(names.reportMd, 'Download report.md'));
    if (names.manifestJson) list.appendChild(link(names.manifestJson, 'Download manifest.json'));
    list.appendChild(link('zip', 'Download whole job (.zip)'));
    box.appendChild(list);
    return box;
  }

  // ---------------------------------------------------------------- public API

  function render(el, opts) {
    if (!el) throw new Error('MldxfJobPrep.render needs a container element');
    if (opts && opts.jobId && opts.jobId !== state.jobId) {
      // Opening an existing job (e.g. from the Jobs tab): load it
      // and show it; the form stays available for a new run.
      state.jobId = opts.jobId;
      state.status = null;
      state.job = null;
      state.jobError = null;
      state.progress = [];
      state.runStarted = false;
      state.runStartedAt = null;
      state.stageDoneAt = {};
      state.finishedAt = null;
      state.lastError = null;
      state.guidesError = null;
      renderInto(el);
      loadJob(opts.jobId);
      return;
    }
    // Reload restore (round 8): a fresh render with no job in
    // state re-opens the last-run job from this tab session, so a
    // reload does not lose the result — the Jobs tab is no longer
    // the only way back to it. Once per page load: a failed
    // restore (stale id) leaves the fresh form, not a retry loop,
    // and a new browser session starts from the fresh form.
    if (!state.jobId && !state.restoreAttempted) {
      state.restoreAttempted = true;
      var last = readLastJob();
      if (last) {
        renderInto(el);
        openJob(last, { silent: true });
        return;
      }
    }
    renderInto(el);
  }

  /** Open an existing job in this tab (V2.8 Jobs tab calls this).
   * Loads GET /api/jobs/:id and displays it — v1 jobs read-only,
   * no rerun offered. If the tab is currently rendered, the view
   * updates in place; otherwise the job is loaded into state and
   * shown at the next render. `opts.silent` (reload-restore only)
   * swallows a failed load instead of bannering it. */
  function openJob(jobId, opts) {
    if (!jobId) return;
    stopFollowing();
    state.jobId = jobId;
    state.status = null;
    state.job = null;
    state.jobError = null;
    state.progress = [];
    state.runStarted = false;
    state.runStartedAt = null;
    state.stageDoneAt = {};
    state.finishedAt = null;
    state.lastError = null;
    state.guidesError = null;
    // Only paint when this tab is selected (see rerender): openJob
    // is called from the Jobs tab just before showTab('job-prep')
    // switches to it, and the show itself renders — painting here
    // first would clobber the tab the user is still on.
    if (state.rootEl && isCurrentTab()) renderInto(state.rootEl);
    loadJob(jobId, opts);
  }

  window.MldxfJobPrep = {
    id: 'job-prep',
    label: 'Job prep',
    render: render,
    openJob: openJob,
    // Exposed for the verification harness only (not part of the
    // shell contract): the live run state.
    _state: state,
  };
})();
