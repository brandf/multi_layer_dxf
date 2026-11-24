/**
 * jobs.js — V2.8: web UI Jobs tab (V2_SCOPE.md §5.3).
 *
 * List of past jobs (newest first) with plan summary and status;
 * open a job to see its detail, rerun a v2 job, download its
 * outputs; and a 2D SVG top view of the layout.
 *
 * ONE module, self-contained: no dependencies beyond fetch, no
 * pipeline logic, no geometry, no toolpath math. It displays what
 * the server API (which is 1:1 with the `mldxf` CLI) returns, and
 * nothing else. The job dir on disk is the source of truth; this
 * tab caches nothing about a job beyond the current view's state.
 *
 * Contract (set by the app shell): the shell loads this file and
 * calls `App.registerTab(window.MldxfJobs)`. This module defines:
 *
 *   window.MldxfJobs = {
 *     id: 'jobs',
 *     label: 'Jobs',
 *     render(el) { ... },        // shell calls this when the tab is shown
 *     openJob(jobId) { ... },    // show one job's detail
 *   }
 *
 * API calls this module makes (exact shapes):
 *
 *   GET  /api/jobs            -> { jobs: [{ id, created, status,
 *                             job_version, summary: { parts, layers,
 *                             flags, plan: { id, tools[], tool_changes,
 *                             total_seconds, minutes } } | null,
 *                             can_rerun_from_inputs? }] } — newest first.
 *   GET  /api/jobs/:id       -> { job, status, cancelled,
 *                             can_rerun_from_inputs } (== `mldxf job
 *                             --json` plus the run status).
 *   GET  /api/jobs/:id/status polled while a rerun-from-inputs is
 *                             in flight: { status, progress[], job,
 *                             error }.
 *   POST /api/jobs/:id/rerun -> 200 { job } when the CLI replays
 *                             the job in place (synchronous
 *                             passthrough), or 202 { rerun_from_inputs:
 *                             true, job: { job_id, status: "running" } }
 *                             for an interrupted job re-planned from
 *                             retained inputs into a NEW job dir.
 *                             A v1 job answers 400 rerun_unavailable.
 *   POST /api/jobs/:id/guides { } -> the finished job's
 *                             workholding recommendation (== `mldxf
 *                             guides --json`), run inline from the
 *                             detail's "No guides yet" callout with
 *                             the refusal rendered inline there —
 *                             the same endpoint Job prep uses.
 *   GET  /api/jobs/:id/download/:file
 *                             plain <a> links: the DXF, manifest.txt,
 *                             report.md, and `zip` for the whole job.
 *
 * Display rules (from the scope, not invented here):
 *   - A v1 job (job_version 1, or no job_version on a job that has
 *     one) is read-only: no rerun button anywhere, and the detail
 *     says so honestly — rerun needs the embedded inputs + config
 *     snapshot that v1 jobs do not have (scope §8 Q10). The API
 *     already answers rerun_unavailable for them.
 *   - Plan tools: owned tools first, then not-owned, then tools
 *     whose owned status is unknown (a v1 job carries no `owned`
 *     field — show no owned info rather than guessing). Not-owned
 *     tools are marked explicitly "not in your inventory — check
 *     before you cut" (scope §4.4). Tool numbers are always shown,
 *     so the display order never hides the cut order.
 *   - Workholding is null until V2.9: say "not yet available in
 *     V2" honestly; never invent a recommendation. When a job does
 *     carry workholding (V2.9+), its clamps render in the preview
 *     and in the workholding section.
 *   - The 2D preview renders `layout` + `workholding` only (scope
 *     §5.3): sheet outline from `material` / `suggested_material`,
 *     clamp-margin boundary from `clamp_margin_mm`, parts as the
 *     layout's own rectangles at their layout positions, clamp
 *     positions as markers. job.json carries no per-part outline
 *     shape, so parts render as their layout rectangles (w_mm ×
 *     d_mm) — drawing a circle would invent geometry the CLI did
 *     not emit. No 3D, no mesh, no WebGL, no toolpath preview.
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

  /** "Nov 23, 2:10 PM" — never a raw ISO timestamp with milliseconds. */
  function humanDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
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

  /** Parse one grouped post-processing step into its method,
   * feature and action sentence — see job-prep.js parsePostStep
   * (same display transform, duplicated: the two tabs are
   * self-contained modules). */
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

  /** Top-level downloadable outputs, from the job's own `outputs`
   * list (v2) or from the known v1 output names. Returns
   * { dxf, manifestTxt, reportMd } filenames (or null when the job
   * does not carry that file). The server serves exactly these
   * names — the UI never invents a download. */
  function downloadNames(job) {
    var names = { dxf: null, manifestTxt: null, reportMd: null };
    var outs = job.outputs || [];
    for (var i = 0; i < outs.length; i++) {
      var f = typeof outs[i] === 'string' ? outs[i] : (outs[i] && outs[i].file);
      if (!f || f.indexOf('/') !== -1) continue; // top-level files only
      if (/\.dxf$/i.test(f)) names.dxf = f;
      else if (f === 'manifest.txt') names.manifestTxt = f;
      else if (f === 'report.md') names.reportMd = f;
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

  function getJson(path) {
    return fetch(path).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (b) {
        return { status: resp.status, body: b };
      });
    });
  }

  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (b) {
        return { status: resp.status, body: b };
      });
    });
  }

  function apiErrorText(body, fallback) {
    if (body && body.error) {
      return body.error + (body.message ? ': ' + body.message : '');
    }
    return fallback || 'request failed';
  }

  /** Human-readable text for an API error object {error, message}:
   * the message only — never the raw error code (same rule as
   * job-prep.js humanErrorText: the code stays machine-readable
   * in the banner's data-error-code attribute). */
  function humanErrorText(err) {
    if (!err) return 'request failed';
    var msg = err.message ? String(err.message) : '';
    if (msg) {
      var code = err.error ? String(err.error) : '';
      if (code && msg.indexOf(code + ': ') === 0) msg = msg.slice(code.length + 2);
      return msg;
    }
    return err.error ? String(err.error) : 'request failed';
  }

  /** The inline guides refusal for the "No guides yet" callout:
   * the human-readable message plus, for the refusals the Clamps
   * & machine tab fixes (placeholder slots, no clamps, an
   * unmountable clamp), a button to that tab at the point of
   * action — the same shape as Job prep's inline refusal. */
  function guidesErrorEl() {
    if (!state.guidesError) return null;
    var div = el('div', 'jobs-error', '');
    div.setAttribute('role', 'alert');
    div.setAttribute('data-role', 'guides-error');
    if (state.guidesError.error) {
      div.setAttribute('data-error-code', String(state.guidesError.error));
    }
    // Round 11 — the message and the action are separate blocks:
    // the button used to sit inline mid-sentence ("…with your real
    // measurements [Open Clamps & machine]"), reading as part of
    // the sentence. The message is its own line; the button is on
    // its own line below it, in its own wrapper.
    var msg = el('span', 'guides-error-msg', '');
    msg.textContent = humanErrorText(state.guidesError);
    div.appendChild(msg);
    var code = state.guidesError.error;
    if (code === 't_track_placeholder' || code === 'guides_no_clamps' || code === 'clamp_no_slot') {
      var wrap = el('div', 'guides-error-action', '');
      var go = el('button', 'jobs-guides-link', 'Open Clamps & machine');
      go.type = 'button';
      go.setAttribute('data-role', 'guides-open-clamps');
      go.addEventListener('click', function () {
        if (window.App && typeof window.App.showTab === 'function') window.App.showTab('clamps-machine');
      });
      wrap.appendChild(go);
      div.appendChild(wrap);
    }
    return div;
  }

  /** Run the workholding guides for the job on screen, inline
   * from the detail (round 10): POST /api/jobs/:id/guides, then
   * reload the job so the recommendation renders from job.json
   * on disk. A refusal lands ONLY in state.guidesError, rendered
   * inline in the callout where the button was clicked — never
   * as a silent empty result, never as a navigation away. */
  function runGuides(jobId) {
    if (!jobId || state.guidesRunning) return;
    state.guidesRunning = true;
    state.guidesError = null;
    rerender();
    postJson('/api/jobs/' + encodeURIComponent(jobId) + '/guides', {})
      .then(function (r) {
        state.guidesRunning = false;
        if (r.body && r.body.ok) {
          state.guidesError = null;
          loadJob(jobId);
        } else if (r.body && r.body.error) {
          state.guidesError = { error: r.body.error, message: r.body.message || '' };
          rerender();
        } else {
          state.guidesError = { error: 'guides_failed', message: 'guides returned no result' };
          rerender();
        }
      })
      .catch(function (err) {
        state.guidesRunning = false;
        state.guidesError = { error: 'network_error', message: String(err && err.message || err) };
        rerender();
      });
  }

  function versionOf(jobOrEntry) {
    var v = jobOrEntry && jobOrEntry.job_version;
    return (typeof v === 'number') ? v : 1;
  }

  function statusText(status, cancelled) {
    if (status === 'running') return 'Running…';
    if (status === 'complete') return 'Complete';
    if (status === 'failed') return 'Failed';
    if (status === 'interrupted') return 'Interrupted' + (cancelled ? ' (cancelled)' : '');
    if (status === 'invalid') return 'Invalid (job file unreadable)';
    return status || '?';
  }

  /** The job's readable name: the STEP stem slug in the id
   * ("20261124-120000-real-container" -> "real-container"). The
   * list API carries no source filename, and the slug is the id's
   * own record of it — the full id sits beneath it in the list. */
  function jobStem(id) {
    var s = String(id || '');
    var m = /^\d{8}-\d{6}-(.+)$/.exec(s);
    return m ? m[1] : (s || 'job');
  }

  /** One-line plan summary for a list entry, from the server's own
   * summary (fields read off the CLI's job object — no computation
   * here). Returns { tools, facts }: two lines, not one run-on
   * sentence. */
  function listPlanSummary(entry) {
    var s = entry.summary;
    if (!s) return { tools: '—', facts: '' };
    var toolsLine, factsLine;
    if (s.plan) {
      toolsLine = 'Plan ' + (s.plan.id || 'A') + ': ' +
        (s.plan.tools || []).join(' + ') + ' — ' +
        (s.plan.tools || []).length + ' tool(s), ' +
        (s.plan.tool_changes != null ? s.plan.tool_changes : '?') +
        ' change(s), ' + (s.plan.minutes != null ? s.plan.minutes : '?') + ' min';
    } else {
      toolsLine = 'No tool plan';
    }
    factsLine = s.parts + ' part(s) · ' + s.layers + ' layers' +
      (s.flags ? ' · ' + s.flags + ' flag(s)' : '');
    return { tools: toolsLine, facts: factsLine };
  }

  // ---------------------------------------------------------------- state

  // Module-level: survives the shell re-calling render(el) when the
  // tab is re-selected.
  var state = {
    rootEl: null,
    view: 'list', // 'list' | 'detail'
    jobs: null, // list from GET /api/jobs
    listError: null,
    selectedId: null,
    job: null, // job object from GET /api/jobs/:id
    detailStatus: null,
    detailCancelled: false,
    canRerunFromInputs: false,
    jobError: null, // { error, message } for a failed detail load
    rerunState: null, // null | 'running' | 'done' | 'error'
    rerunMsg: '',
    rerunPollTimer: null,
    guidesRunning: false, // a guides run from the detail is in flight
    guidesError: null, // { error, message } for a refused guides run —
    // rendered inline in the "No guides yet" callout, where the
    // button was clicked (round 10 — the button used to navigate
    // to Job prep, where the user had to click Run guides again)
    notice: '', // one-line notice shown above the list (e.g. rerun done)
  };

  function stopRerunPoll() {
    if (state.rerunPollTimer) {
      clearInterval(state.rerunPollTimer);
      state.rerunPollTimer = null;
    }
  }

  function rerender() {
    if (!isCurrentTab()) return;
    if (state.rootEl) renderInto(state.rootEl);
  }

  /** True while the Jobs tab is the selected tab. A fetch that
   * lands after the user has arrowed away must not repaint the
   * shared #tab-main with this tab's content (round 9 — the
   * stale Jobs list used to clobber the Job prep tab). Without a
   * shell (the DOM harness loads this module standalone), render. */
  function isCurrentTab() {
    if (typeof window !== 'undefined' && window.App &&
        typeof window.App.isCurrentTab === 'function') {
      return window.App.isCurrentTab('jobs');
    }
    return true;
  }

  // ---------------------------------------------------------------- API

  function loadList() {
    state.listError = null;
    getJson('/api/jobs').then(function (r) {
      if (r.body && r.body.ok && Array.isArray(r.body.jobs)) {
        state.jobs = r.body.jobs;
      } else {
        state.listError = {
          error: (r.body && r.body.error) || 'list_failed',
          message: apiErrorText(r.body, 'Could not list jobs (HTTP ' + r.status + ').'),
        };
        state.jobs = [];
      }
      rerender();
    }).catch(function (err) {
      state.listError = { error: 'network_error', message: String(err && err.message || err) };
      state.jobs = [];
      rerender();
    });
  }

  function loadJob(jobId) {
    state.jobError = null;
    getJson('/api/jobs/' + encodeURIComponent(jobId)).then(function (r) {
      if (r.body && r.body.ok) {
        state.job = r.body.job || null;
        state.detailStatus = r.body.status || null;
        state.detailCancelled = !!r.body.cancelled;
        state.canRerunFromInputs = !!r.body.can_rerun_from_inputs;
        if (state.job && state.job.job_version == null) state.job.job_version = 1;
      } else {
        state.jobError = {
          error: (r.body && r.body.error) || 'job_failed',
          message: apiErrorText(r.body, 'Could not load job ' + jobId + ' (HTTP ' + r.status + ').'),
        };
        state.job = null;
        state.detailStatus = null;
      }
      rerender();
    }).catch(function (err) {
      state.jobError = { error: 'network_error', message: String(err && err.message || err) };
      state.job = null;
      rerender();
    });
  }

  /** Rerun a job (v2, or an interrupted job with retained inputs).
   * The API answers 200 with the replayed job when the CLI replays
   * it in place, or 202 with a NEW job id when it re-plans from
   * retained inputs. `after` runs once the rerun has finished (or
   * failed) so the caller can refresh its view. */
  function doRerun(jobId, after) {
    stopRerunPoll();
    state.rerunState = 'running';
    state.rerunMsg = 'Rerunning ' + jobId + '… (the CLI replays the job from its embedded inputs and config snapshot; this takes as long as the original run.)';
    rerender();
    postJson('/api/jobs/' + encodeURIComponent(jobId) + '/rerun', {}).then(function (r) {
      if (r.body && r.body.ok && r.body.rerun_from_inputs) {
        // New job dir, new id: follow it until it finishes.
        var newId = r.body.job && r.body.job.job_id;
        state.rerunMsg = 'Rerun started as a new job ' + newId + ' (re-planned from the retained inputs)…';
        rerender();
        if (!newId) {
          state.rerunState = 'error';
          state.rerunMsg = 'Rerun started but the server named no new job id.';
          rerender();
          if (after) after(null);
          return;
        }
        state.selectedId = newId;
        state.view = 'detail';
        state.job = null;
        state.detailStatus = 'running';
        pollRerun(newId, after);
        return;
      }
      if (r.body && r.body.ok) {
        state.rerunState = 'done';
        var created = r.body.job && r.body.job.created_at;
        state.rerunMsg = 'Rerun complete — the job was reproduced in place' +
          (created ? ' (created ' + humanDate(created) + ')' : '') + '.';
        rerender();
        if (after) after(jobId);
        return;
      }
      state.rerunState = 'error';
      state.rerunMsg = 'Rerun failed: ' + apiErrorText(r.body, 'HTTP ' + r.status);
      rerender();
      if (after) after(null);
    }).catch(function (err) {
      state.rerunState = 'error';
      state.rerunMsg = 'Rerun failed: network_error: ' + String(err && err.message || err);
      rerender();
      if (after) after(null);
    });
  }

  /** Poll GET /api/jobs/:id/status until a rerun-from-inputs job
   * finishes, then load the finished job. */
  function pollRerun(jobId, after) {
    stopRerunPoll();
    state.rerunPollTimer = setInterval(function () {
      getJson('/api/jobs/' + encodeURIComponent(jobId) + '/status').then(function (r) {
        if (!r.body || !r.body.ok) return;
        state.detailStatus = r.body.status || state.detailStatus;
        if (r.body.status === 'running') { rerender(); return; }
        stopRerunPoll();
        if (r.body.status === 'complete') {
          state.rerunState = 'done';
          state.rerunMsg = 'Rerun complete — new job ' + jobId + ' finished.';
        } else {
          state.rerunState = 'error';
          state.rerunMsg = 'Rerun failed: ' + statusText(r.body.status, r.body.cancelled) +
            (r.body.error && r.body.error.message ? ': ' + r.body.error.message : '');
        }
        loadJob(jobId);
        if (after) after(jobId);
      }).catch(function () { /* next poll retries */ });
    }, 2000);
  }

  // ---------------------------------------------------------------- 2D layout preview

  var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var k in attrs) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  /** Sheet size in mm, from `material` (an explicit material was
   * given) or `suggested_material` (the CLI's suggestion). Falls
   * back to the layout bounding box plus the clamp margin on each
   * side, so a job with no recorded sheet size still previews —
   * the fallback is display sizing only, and the caption says so. */
  function sheetSize(job) {
    var m = job.material || job.suggested_material;
    if (m && isFinite(m.x) && isFinite(m.y) && m.x > 0 && m.y > 0) {
      return { w: m.x, h: m.y, source: job.material ? 'material' : 'suggested material' };
    }
    var layout = job.layout || [];
    var margin = finiteMargin(job);
    var maxX = 0, maxY = 0;
    for (var i = 0; i < layout.length; i++) {
      var e = layout[i] || {};
      if (isFinite(e.x_mm) && isFinite(e.w_mm)) maxX = Math.max(maxX, e.x_mm + e.w_mm);
      if (isFinite(e.y_mm) && isFinite(e.d_mm)) maxY = Math.max(maxY, e.y_mm + e.d_mm);
    }
    if (maxX <= 0 || maxY <= 0) return null;
    var pad = isFinite(margin) ? margin : 0;
    return { w: maxX + pad, h: maxY + pad, source: 'layout bounding box (no sheet size recorded)' };
  }

  function finiteMargin(job) {
    var m = job.clamp_margin_mm;
    return (typeof m === 'number' && isFinite(m) && m >= 0) ? m : null;
  }

  /** Clamp entries from a job's workholding section (V2.9 shape:
   * { clamps: [{ clamp_id, method, slot, x_mm, y_mm, reason }] },
   * accepting `positions` as the list key too). Returns [] when the
   * job carries no workholding — null until V2.9. */
  function workholdingClamps(job) {
    var wh = job.workholding;
    if (!wh || typeof wh !== 'object') return [];
    var list = wh.clamps || wh.positions || [];
    return Array.isArray(list) ? list : [];
  }

  /** The 2D SVG top view: sheet outline, clamp-margin boundary,
   * parts as the layout's own rectangles at their layout positions,
   * clamp positions as markers. Coordinates are job millimetres,
   * origin bottom-left (sheet coords); the SVG flips Y so the top
   * view reads with +Y up. Every drawn element carries its job
   * coordinates as data attributes, so the preview is checkable
   * against job.json. */
  function buildLayoutPreview(job) {
    var box = el('div', 'jobs-preview', '');
    box.appendChild(el('h4', '', '2D layout preview — top view'));
    var layout = job.layout || [];
    var size = sheetSize(job);
    if (!layout.length) {
      box.appendChild(textEl('p', '', 'This job has no layout to preview.'));
      return box;
    }
    if (!size) {
      box.appendChild(textEl('p', '', 'No sheet size and no usable layout extent — nothing to draw.'));
      return box;
    }
    var W = size.w, H = size.h;
    var PAD = 6; // mm of breathing room around the sheet, for labels
    var margin = finiteMargin(job);
    var svg = svgEl('svg', {
      'data-role': 'layout-preview',
      viewBox: '0 0 ' + (W + 2 * PAD) + ' ' + (H + 2 * PAD),
      role: 'img',
      'aria-label': 'Top view of the ' + W + ' by ' + H + ' mm sheet with ' + layout.length + ' part(s)',
    });
    svg.setAttribute('class', 'jobs-svg');
    // Sheet coords (origin bottom-left) -> SVG coords (origin
    // top-left): sx = PAD + x, sy = PAD + (H - y).
    function sx(x) { return PAD + x; }
    function syTop(y, d) { return PAD + (H - (y + d)); }

    // Sheet outline.
    svg.appendChild(svgEl('rect', {
      'data-role': 'sheet', 'data-w': String(W), 'data-h': String(H),
      x: String(PAD), y: String(PAD), width: String(W), height: String(H),
      'class': 'jobs-sheet',
    }));
    // Clamp-margin band (shaded inset region, drawn BEFORE the
    // parts): the margin is a band of sheet, not a second frame —
    // a stroked rectangle coincides with the part edges (parts sit
    // at the margin) and reads as a frame around them. The band is
    // one even-odd path: the sheet rect with the usable area cut
    // out, so only the margin strip is shaded.
    // usableRect: the usable area's geometry, kept for the
    // re-draw over the parts below (round 7).
    var usableRect = null;
    if (margin !== null && 2 * margin < W && 2 * margin < H) {
      var ix = sx(margin), iy = PAD + margin,
        iw = W - 2 * margin, ih = H - 2 * margin;
      usableRect = { x: ix, y: iy, w: iw, h: ih };
      svg.appendChild(svgEl('path', {
        'data-role': 'margin-boundary', 'data-margin': String(margin),
        d: 'M ' + PAD + ' ' + PAD + ' h ' + W + ' v ' + H + ' h ' + (-W) + ' Z ' +
           'M ' + ix + ' ' + iy + ' h ' + iw + ' v ' + ih + ' h ' + (-iw) + ' Z',
        'fill-rule': 'evenodd',
        'class': 'jobs-margin',
      }));
      // The usable area's own boundary stroke, so the margin band
      // is not just a pale wash against the sheet (it is also in
      // the legend below the drawing).
      svg.appendChild(svgEl('rect', {
        'data-role': 'usable-area', 'data-margin': String(margin),
        x: String(ix), y: String(iy), width: String(iw), height: String(ih),
        'class': 'jobs-margin-boundary',
      }));
    }
    // Parts: the layout's own rectangles, at their layout positions.
    layout.forEach(function (entry) {
      var e = entry || {};
      if (!isFinite(e.x_mm) || !isFinite(e.y_mm) ||
          !isFinite(e.w_mm) || !isFinite(e.d_mm)) return;
      var cx = sx(e.x_mm + e.w_mm / 2);
      var cy = syTop(e.y_mm, e.d_mm) + e.d_mm / 2;
      var g = svgEl('g', { 'data-role': 'part-group' });
      var rect = svgEl('rect', {
        'data-role': 'part',
        'data-part': e.name || '',
        'data-x': String(e.x_mm), 'data-y': String(e.y_mm),
        'data-w': String(e.w_mm), 'data-d': String(e.d_mm),
        x: String(sx(e.x_mm)), y: String(syTop(e.y_mm, e.d_mm)),
        width: String(e.w_mm), height: String(e.d_mm),
        'class': 'jobs-part',
      });
      if (e.rotate_z_deg) {
        // Sheet +Z rotation reads counter-clockwise on screen
        // (SVG Y grows down), so negate the angle about the part centre.
        rect.setAttribute('transform',
          'rotate(' + (-e.rotate_z_deg) + ' ' + cx + ' ' + cy + ')');
      }
      g.appendChild(rect);
      var label = svgEl('text', {
        x: String(cx), y: String(cy),
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'class': 'jobs-part-label',
      });
      label.textContent = e.name || '';
      g.appendChild(label);
      var dims = svgEl('text', {
        x: String(cx), y: String(cy + 9),
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'class': 'jobs-part-dims',
      });
      dims.textContent = mm(e.w_mm) + ' × ' + mm(e.d_mm);
      g.appendChild(dims);
      svg.appendChild(g);
    });
    // Clamp markers, when the job carries workholding (V2.9+).
    var clamps = workholdingClamps(job);
    clamps.forEach(function (c, i) {
      var entry = c || {};
      if (!isFinite(entry.x_mm) || !isFinite(entry.y_mm)) return;
      var id = entry.clamp_id || entry.method || ('clamp ' + (i + 1));
      var g = svgEl('g', {
        'data-role': 'clamp',
        'data-clamp': id,
        'data-x': String(entry.x_mm), 'data-y': String(entry.y_mm),
      });
      // A true to-scale rectangle: the clamp's own footprint, long
      // side along its slot, centred on its position — never a
      // diamond, and the label sits inside the rectangle (squeezed
      // to fit) with the readable form in the legend below the
      // drawing, never floating in the margin above the sheet.
      var fp = (entry.footprint_mm && isFinite(entry.footprint_mm[0]) &&
        isFinite(entry.footprint_mm[1])) ? entry.footprint_mm : [20, 12];
      var axis = entry.slot_axis;
      if (!axis && typeof entry.slot === 'string') {
        var sm = /^\s*([xy])-axis/.exec(entry.slot) || /^\s*([xy])@/.exec(entry.slot);
        if (sm) axis = sm[1];
      }
      var cw = axis === 'y' ? fp[1] : fp[0];
      var cd = axis === 'y' ? fp[0] : fp[1];
      var cx = sx(entry.x_mm), cy = PAD + (H - entry.y_mm);
      // Round 10 — a 0.5 mm visual inset (≈1 px at 390 px wide):
      // a clamp whose edge coincides with the sheet edge (y 78–90
      // on a 90 mm sheet) used to sit flush with the sheet border
      // and read as straddling it, even with the border re-drawn
      // over it. The inset is paint only — the clamp's true
      // position and footprint stay exact in data-x/data-y (on
      // the group) and data-w/data-d (on the rect).
      var INSET = 0.5;
      var rect = svgEl('rect', {
        x: String(cx - cw / 2 + INSET), y: String(cy - cd / 2 + INSET),
        width: String(cw - 2 * INSET), height: String(cd - 2 * INSET),
        'data-role': 'clamp-rect',
        'data-w': String(cw), 'data-d': String(cd),
        'class': 'jobs-clamp',
      });
      g.appendChild(rect);
      var label = svgEl('text', {
        x: String(cx), y: String(cy),
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'class': 'jobs-clamp-label',
      });
      label.setAttribute('textLength', String(Math.max(cw - 2 * INSET - 2, 1)));
      label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      label.textContent = id;
      g.appendChild(label);
      svg.appendChild(g);
    });
    // Re-draw the usable-area boundary over the parts (and the
    // clamps): a part whose edge coincides with the boundary
    // (parts sit at the margin) used to hide the 1px stroke behind
    // its opaque fill, so the boundary vanished along the parts'
    // top edges. Part positions and footprints are unchanged —
    // this is paint order only, the same pattern as the sheet
    // border re-draw below.
    if (usableRect) {
      svg.appendChild(svgEl('rect', {
        'data-role': 'usable-area-top',
        'data-margin': String(margin),
        x: String(usableRect.x), y: String(usableRect.y),
        width: String(usableRect.w), height: String(usableRect.h),
        'class': 'jobs-margin-boundary',
      }));
    }
    // Re-draw the sheet border over the clamp rects: a clamp whose
    // top edge coincides with the sheet edge (y 78–90 on a 90 mm
    // sheet) reads as fully inside the sheet, not straddling the
    // border. Clamp positions and footprints are unchanged — this
    // is paint order only.
    svg.appendChild(svgEl('rect', {
      'data-role': 'sheet-border-top',
      x: String(PAD), y: String(PAD), width: String(W), height: String(H),
      'class': 'jobs-sheet-top',
    }));
    // Axis labels (mm from the bottom-left origin) INSIDE the
    // sheet frame, with tick marks on the sheet edges — they used
    // to sit outside the SVG frame, in the padding. The scale bar
    // moves to the bottom centre so the "150" label owns the
    // bottom-right corner.
    function axisLabel(x, y, anchor, text) {
      var t = svgEl('text', {
        x: String(x), y: String(y), 'text-anchor': anchor,
        'dominant-baseline': 'middle', 'class': 'jobs-axis',
      });
      t.textContent = text;
      svg.appendChild(t);
    }
    function axisTick(x1, y1, x2, y2) {
      svg.appendChild(svgEl('line', {
        x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2),
        'class': 'jobs-axis-tick',
      }));
    }
    axisTick(PAD, PAD, PAD, PAD + 3);
    axisLabel(PAD + 3, PAD + 5, 'start', mm(H));
    axisTick(PAD, PAD + H - 3, PAD, PAD + H);
    axisLabel(PAD + 3, PAD + H - 4, 'start', '0');
    axisTick(PAD + W - 3, PAD + H, PAD + W, PAD + H);
    axisLabel(PAD + W - 3, PAD + H - 4, 'end', mm(W));
    var barLen = Math.min(20, W - 2);
    var barX0 = PAD + (W - barLen) / 2, barY = PAD + H - 3;
    svg.appendChild(svgEl('line', {
      x1: String(barX0), y1: String(barY), x2: String(barX0 + barLen), y2: String(barY),
      'class': 'jobs-scalebar',
    }));
    svg.appendChild(svgEl('line', {
      x1: String(barX0), y1: String(barY - 1.5), x2: String(barX0), y2: String(barY + 1.5),
      'class': 'jobs-scalebar',
    }));
    svg.appendChild(svgEl('line', {
      x1: String(barX0 + barLen), y1: String(barY - 1.5),
      x2: String(barX0 + barLen), y2: String(barY + 1.5),
      'class': 'jobs-scalebar',
    }));
    var barLabel = svgEl('text', {
      x: String(barX0 + barLen / 2), y: String(barY - 3.5),
      'text-anchor': 'middle', 'class': 'jobs-scalebar-label',
    });
    barLabel.textContent = barLen + ' mm';
    svg.appendChild(barLabel);
    box.appendChild(svg);

    // Caption: the numbers behind the drawing, as text. Part
    // positions and clamp coordinates live in the tables below —
    // the drawing carries them, so no prose paragraph restates them.
    var caption = 'Sheet ' + mm(W) + ' × ' + mm(H) + ' mm (' + size.source + ')' +
      (margin !== null ? ' · clamp margin ' + mm(margin) + ' mm (shaded band)'
        : ' · clamp margin not recorded for this job') +
      ' · origin bottom-left, mm · scale bar ' + barLen + ' mm (bottom centre)' +
      ' (parts shown as bounding rectangles).';
    box.appendChild(textEl('p', 'jobs-caption', caption));
    // Legend: the drawing's colors at a glance (margin band /
    // usable area / part / clamp).
    var legend = el('div', 'jobs-legend', '');
    [['sw-margin', 'Margin band'], ['sw-usable', 'Usable-area outline'], ['sw-part', 'Part'], ['sw-clamp', 'Clamp']].forEach(function (item) {
      var lspan = el('span', '', '');
      lspan.appendChild(el('span', 'legend-swatch ' + item[0], ''));
      lspan.appendChild(document.createTextNode(item[1]));
      legend.appendChild(lspan);
    });
    box.appendChild(legend);
    if (job.workholding == null) {
      // Empty state: a proper callout with a Run guides button, not
      // a third line of small caption text. Round 10 — the button
      // runs the guides inline here (POST /api/jobs/:id/guides,
      // the same endpoint Job prep uses), with the refusal or the
      // reloaded recommendation rendered in place; it no longer
      // navigates to Job prep, where the user had to click Run
      // guides a second time. A v1 job is read-only and gets no
      // button (guides need the V2 job model).
      var callout = el('div', 'jobs-note', '');
      var jobIdForGuides = job.job_id || state.selectedId;
      if (versionOf(job) < 2) {
        callout.appendChild(textEl('span', '',
          'No guides yet for this job — it is a v1 job, and workholding guides need a V2 job. ' +
          'Place clamps by hand and keep them clear of every cut.'));
      } else {
        callout.appendChild(textEl('span', '',
          'No guides yet for this job — no clamp positions have been computed. '));
        var guidesBtn = el('button', '', state.guidesRunning ? 'Running guides…' : 'Run guides');
        guidesBtn.type = 'button';
        guidesBtn.disabled = state.guidesRunning;
        guidesBtn.setAttribute('data-role', 'run-guides');
        guidesBtn.addEventListener('click', function () {
          runGuides(jobIdForGuides);
        });
        callout.appendChild(guidesBtn);
        var ge = guidesErrorEl();
        if (ge) callout.appendChild(ge);
      }
      box.appendChild(callout);
    } else {
      // Caption derived from the SAME workholding object the SVG
      // renders from (workholdingClamps): the drawn clamp rects and
      // this line can never disagree — a job with clamps used to
      // print "No clamp positions recorded" here while drawing two
      // red clamp rects above it. The agreement is checked below:
      // the caption names exactly the clamps drawn.
      var drawn = workholdingClamps(job);
      var drawnWithCoords = drawn.filter(function (c) {
        return c && isFinite(c.x_mm) && isFinite(c.y_mm);
      });
      var drawnIds = drawnWithCoords.map(function (c) {
        return c.clamp_id || c.method || 'clamp';
      });
      if (drawnWithCoords.length) {
        box.appendChild(textEl('p', 'jobs-caption',
          drawnWithCoords.length + ' clamp' + (drawnWithCoords.length === 1 ? '' : 's') +
          ' shown (' + drawnIds.join(', ') + ') — positions in the Workholding section below.'));
      } else if (job.workholding.recommendation || job.workholding.summary) {
        box.appendChild(textEl('p', 'jobs-caption',
          String(job.workholding.recommendation || job.workholding.summary)));
      } else {
        box.appendChild(textEl('p', 'jobs-caption', 'No clamp positions recorded for this job.'));
      }
      // Agreement check (caption vs drawing): the caption above
      // must name the number of clamp rects the SVG drew. A
      // mismatch means the caption and the drawing were derived
      // from different data — fail loudly in the console rather
      // than showing a contradictory preview.
      var drawnRects = svg.querySelectorAll('[data-role="clamp-rect"]').length;
      if (drawnRects !== drawnWithCoords.length) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('jobs preview: caption/drawing mismatch — ' +
            drawnRects + ' clamp rect(s) drawn but ' +
            drawnWithCoords.length + ' clamp position(s) in workholding');
        }
      }
    }
    return box;
  }

  // ---------------------------------------------------------------- rendering

  function rerenderDetailOnly() {
    rerender();
  }

  function renderInto(root) {
    state.rootEl = root;
    root.innerHTML = '';
    root.appendChild(el('h2', 'jobs-title', 'Jobs'));
    if (state.view === 'detail') renderDetail(root);
    else renderList(root);
  }

  function renderList(root) {
    root.appendChild(textEl('p', 'jobs-intro',
      'Every job you have run from this home, newest first. Open one ' +
      'to review its plan and layout, download its files, or run it again.'));
    root.appendChild(textEl('p', 'jobs-hint',
      'Only jobs from this home are listed — jobs from other homes never appear here.'));
    if (state.notice) {
      root.appendChild(el('div', 'jobs-notice', esc(state.notice)));
    }
    if (state.listError) {
      root.appendChild(el('div', 'jobs-error',
        '<strong>' + esc(state.listError.error) + ':</strong> ' + esc(state.listError.message || '')));
    }
    var refresh = el('button', '', 'Refresh list');
    refresh.type = 'button';
    refresh.addEventListener('click', function () {
      state.notice = '';
      loadList();
    });
    root.appendChild(refresh);

    var jobs = state.jobs;
    if (jobs === null) {
      root.appendChild(textEl('p', '', 'Loading…'));
      return;
    }
    if (!jobs.length) {
      root.appendChild(el('div', 'jobs-empty',
        'No jobs yet in this home — run one from the Job prep tab.'));
      return;
    }
    var table = el('table', 'jobs-table', '');
    var headRow = document.createElement('tr');
    // No Version column: file/version metadata lives in the About
    // dialog, and the API still carries job_version.
    ['Job', 'Status', 'Plan summary', 'Actions'].forEach(function (t) {
      var th = document.createElement('th');
      th.textContent = t;
      headRow.appendChild(th);
    });
    table.appendChild(headRow);
    jobs.forEach(function (entry) {
      var version = entry.job_version;
      var row = document.createElement('tr');
      function cell(text) {
        var td = document.createElement('td');
        td.textContent = text;
        return td;
      }
      // Primary cell: the job name + date, with the full id in
      // muted small text beneath it — never a truncated id.
      var idCell = document.createElement('td');
      idCell.className = 'job-cell';
      var nameLine = document.createElement('div');
      nameLine.appendChild(textEl('span', 'job-name', jobStem(entry.id)));
      nameLine.appendChild(document.createTextNode(' · '));
      nameLine.appendChild(textEl('span', 'job-date', humanDate(entry.created)));
      idCell.appendChild(nameLine);
      var idLine = document.createElement('div');
      idLine.className = 'job-id-full';
      var idCode = document.createElement('code');
      idCode.textContent = entry.id;
      idCode.title = entry.id;
      idLine.appendChild(idCode);
      idCell.appendChild(idLine);
      row.appendChild(idCell);
      var statusCell = document.createElement('td');
      statusCell.appendChild(textEl('span',
        'badge status-badge st-' + (entry.status || 'unknown'),
        statusText(entry.status, entry.cancelled)));
      row.appendChild(statusCell);
      // Plan summary as two lines: the tools line, then the facts
      // line — not one run-on sentence.
      var planCell = document.createElement('td');
      var planSummary = listPlanSummary(entry);
      planCell.appendChild(textEl('div', 'plan-tools-line', planSummary.tools));
      if (planSummary.facts) {
        planCell.appendChild(textEl('div', 'plan-facts-line', planSummary.facts));
      }
      row.appendChild(planCell);
      var actions = document.createElement('td');
      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.textContent = 'Open';
      openBtn.setAttribute('data-role', 'open-job');
      openBtn.setAttribute('data-job-id', entry.id);
      openBtn.addEventListener('click', function () { openJob(entry.id); });
      actions.appendChild(openBtn);
      if (version === 2 || entry.can_rerun_from_inputs) {
        var rerunBtn = document.createElement('button');
        rerunBtn.type = 'button';
        rerunBtn.textContent = 'Rerun';
        rerunBtn.setAttribute('data-role', 'rerun-job');
        rerunBtn.setAttribute('data-job-id', entry.id);
        rerunBtn.disabled = entry.status === 'running' || state.rerunState === 'running';
        rerunBtn.addEventListener('click', function () {
          state.notice = '';
          doRerun(entry.id, function (doneId) {
            if (doneId && state.view === 'list') {
              state.notice = 'Rerun complete for ' + doneId + '.';
              loadList();
            } else if (doneId) {
              loadList();
            } else {
              loadList();
            }
          });
        });
        actions.appendChild(rerunBtn);
      } else if (version === 1) {
        actions.appendChild(textEl('span', 'jobs-readonly', 'v1 — read-only, no rerun'));
      }
      row.appendChild(actions);
      table.appendChild(row);
    });
    root.appendChild(table);
    root.appendChild(textEl('p', 'jobs-hint',
      'Older (v1) jobs can’t be re-run from here — run the original ' +
      'STEP again from the Job prep tab.'));
  }

  function renderDetail(root) {
    var id = state.selectedId;
    var back = el('button', '', '← Back to jobs');
    back.type = 'button';
    back.setAttribute('data-role', 'back-to-jobs');
    back.addEventListener('click', function () {
      stopRerunPoll();
      state.view = 'list';
      state.selectedId = null;
      state.job = null;
      state.rerunState = null;
      state.rerunMsg = '';
      loadList();
    });
    root.appendChild(back);

    if (state.jobError) {
      root.appendChild(el('div', 'jobs-error',
        '<strong>' + esc(state.jobError.error) + ':</strong> ' + esc(state.jobError.message || '')));
      return;
    }
    var job = state.job;
    if (!job) {
      root.appendChild(el('h3', '', 'Job — ' + id));
      root.appendChild(textEl('p', '', 'Status: ' + statusText(state.detailStatus, state.detailCancelled)));
      if (state.detailStatus === 'interrupted' && state.canRerunFromInputs) {
        root.appendChild(textEl('p', '',
          'This run was interrupted before it wrote a job, but its inputs ' +
          'were retained — it can be re-run from them into a new job.'));
        var retry = el('button', 'primary', 'Re-run from retained inputs');
        retry.type = 'button';
        retry.setAttribute('data-role', 'rerun-job');
        retry.setAttribute('data-job-id', id);
        retry.addEventListener('click', function () {
          doRerun(id, function () { loadList(); });
        });
        root.appendChild(retry);
      } else if (state.detailStatus === 'interrupted') {
        root.appendChild(textEl('p', '',
          'This run was interrupted and its inputs were not retained — ' +
          'start a new run from the Job prep tab.'));
      } else {
        root.appendChild(textEl('p', '', 'Loading…'));
      }
      if (state.rerunState) root.appendChild(rerunBox());
      return;
    }

    var version = versionOf(job);
    // The readable name leads; the machine id sits in muted small
    // text beneath it, and the date reads in local human form —
    // no raw ISO timestamp, no job-version metadata here (that
    // lives in the About dialog).
    root.appendChild(el('h3', '', 'Job — ' + jobStem(job.job_id || id)));
    var metaLine = el('p', 'jobs-hint', '');
    metaLine.appendChild(document.createTextNode(
      'Source: ' + basename(job.source_step || '?') +
      (job.created_at ? ' · ' + humanDate(job.created_at) : '') +
      ' · status '));
    metaLine.appendChild(textEl('span',
      'badge status-badge st-' + (state.detailStatus || 'unknown'),
      statusText(state.detailStatus, state.detailCancelled)));
    root.appendChild(metaLine);
    var idLine = el('p', 'jobs-hint', '');
    idLine.appendChild(document.createTextNode('Job id: ' + (job.job_id || id)));
    root.appendChild(idLine);
    if (version < 2) {
      root.appendChild(el('div', 'jobs-note',
        'This is a v1 job — read-only. It has no embedded inputs or config snapshot, ' +
        'so it cannot be re-run from here; re-run <code>mldxf plan</code> on the source STEP for a new job.'));
    }

    // Actions: rerun (v2 only), open in Job prep.
    var actions = el('div', 'jobs-actions', '');
    if (version >= 2) {
      var rerunBtn = el('button', 'primary', 'Rerun this job');
      rerunBtn.type = 'button';
      rerunBtn.setAttribute('data-role', 'rerun-job');
      rerunBtn.setAttribute('data-job-id', job.job_id || id);
      rerunBtn.disabled = state.rerunState === 'running' || state.detailStatus === 'running';
      rerunBtn.addEventListener('click', function () {
        doRerun(job.job_id || id, function (doneId) {
          if (doneId) loadJob(doneId);
        });
      });
      actions.appendChild(rerunBtn);
    }
    if (window.MldxfJobPrep && typeof window.MldxfJobPrep.openJob === 'function' &&
        window.App && typeof window.App.showTab === 'function') {
      var prepBtn = el('button', '', 'Open in Job prep');
      prepBtn.type = 'button';
      prepBtn.setAttribute('data-role', 'open-in-job-prep');
      prepBtn.addEventListener('click', function () {
        window.MldxfJobPrep.openJob(job.job_id || id);
        window.App.showTab('job-prep');
      });
      actions.appendChild(prepBtn);
    }
    root.appendChild(actions);
    if (state.rerunState) root.appendChild(rerunBox());

    root.appendChild(buildLayoutPreview(job));
    if (job.command === 'check') {
      root.appendChild(buildCheckSummary(job));
    } else {
      var toolPlan = job.tool_plan || {};
      var plans = toolPlan.plans || [];
      if (!plans.length) {
        root.appendChild(el('div', 'jobs-note',
          toolPlan.error ? 'No tool plan: ' + esc(toolPlan.error)
            : 'This job has no tool plan (mode ' + esc(job.mode || '?') + ' writes no plan).'));
      } else {
        root.appendChild(buildPlans(job, toolPlan, plans));
      }
      root.appendChild(buildSummary(job));
      root.appendChild(buildFlags(job));
      root.appendChild(buildPostProcess(job));
      root.appendChild(buildWorkholding(job));
    }
    root.appendChild(buildDownloads(job));
  }

  function rerunBox() {
    var cls = state.rerunState === 'error' ? 'jobs-error'
      : state.rerunState === 'done' ? 'jobs-ok' : 'jobs-note';
    var box = el('div', cls, '');
    box.setAttribute('data-role', 'rerun-status');
    box.textContent = state.rerunMsg;
    return box;
  }

  function buildCheckSummary(job) {
    var box = el('div', 'jobs-check', '');
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
    var box = el('div', 'jobs-summary', '');
    box.appendChild(el('h4', '', 'Job'));
    // A 4-up stat strip, not four undifferentiated text lines —
    // the same shared shape as job prep.
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
    var box = el('div', 'jobs-plans', '');
    box.appendChild(el('h4', '', 'Tool plan'));
    var chosen = toolPlan.chosen || (plans[0] && plans[0].id);
    plans.forEach(function (plan) {
      var isChosen = plan.id === chosen;
      var pbox = el('article', 'jobs-plan plan-card' + (isChosen ? ' plan-chosen' : ''), '');
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
        pbox.appendChild(el('div', 'jobs-warn plan-warn',
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
        if (t.id) toolCell.appendChild(textEl('span', 'jobs-hint', ' ' + t.id));
        if (t.kind) toolCell.appendChild(textEl('span', 'jobs-hint', ' · ' + t.kind));
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
        pbox.appendChild(textEl('p', 'jobs-hint',
          'No inventory info for ' + (versionOf(job) < 2 ? 'this v1 job' : 'this job') +
          ' — owned/not-owned is not recorded for it.'));
      }
      var warns = plan.dependency_warnings || [];
      if (warns.length) {
        pbox.appendChild(el('div', 'jobs-warn plan-warn', 'Dependency warnings: ' + esc(warns.join('; '))));
      }
      box.appendChild(pbox);
    });
    return box;
  }

  function buildFlags(job) {
    var box = el('div', 'jobs-flags', '');
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
          link.href = '#jobs-post';
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
    var box = el('div', 'jobs-post', '');
    box.setAttribute('id', 'jobs-post');
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

  function buildWorkholding(job) {
    var box = el('div', 'jobs-workholding', '');
    box.appendChild(el('h4', '', 'Workholding'));
    var wh = job.workholding;
    if (wh == null) {
      // No guides computed for this job yet — say so honestly, never invent one.
      // The Run guides button lives in the preview callout above;
      // a v1 job has no button there (guides need a V2 job).
      if (versionOf(job) < 2) {
        box.appendChild(textEl('p', '',
          'No guides yet for this job — it is a v1 job, and workholding guides need a V2 job. ' +
          'Place clamps by hand and keep them clear of every cut.'));
      } else {
        box.appendChild(textEl('p', '',
          'No guides yet for this job — no clamp recommendation has been computed. ' +
          'Place clamps by hand and keep them clear of every cut, or run the guides from the Run guides button above.'));
      }
      return box;
    }
    if (typeof wh === 'string') {
      box.appendChild(textEl('p', '', wh));
      return box;
    }
    var rec = wh.recommendation || wh.summary;
    var clamps = workholdingClamps(job);
    var fm = wh.force_model || {};
    if (clamps.length) {
      // One summary line, then a compact table — the recommendation
      // paragraph and the per-clamp bullets used to state the same
      // facts twice (a third time in the preview caption).
      var ids = [];
      clamps.forEach(function (c) {
        var id = c.clamp_id || c.method || 'clamp';
        if (ids.indexOf(id) === -1) ids.push(id);
      });
      var summary = clamps.length + ' clamp' + (clamps.length === 1 ? '' : 's') +
        ' (' + ids.join(', ') + ')' +
        (fm.worst_force_n != null ? ' — worst estimated cut force ' + fm.worst_force_n + ' N' : '');
      box.appendChild(textEl('p', 'jobs-wh-summary', summary));
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
        box.appendChild(textEl('p', 'jobs-wh-summary',
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
    if (fm.note) {
      box.appendChild(textEl('p', 'jobs-force-note',
        'Force model: first-order estimate only — not a validated physics model. ' +
        'Verify holding force by hand before cutting.'));
      var details = el('details', 'jobs-force-details', '');
      details.appendChild(el('summary', '', 'How the force is estimated'));
      details.appendChild(textEl('p', '', fm.note));
      if (fm.formula) details.appendChild(textEl('p', '', fm.formula));
      if (fm.worst_force_n != null) {
        details.appendChild(textEl('p', '', 'Worst estimated force: ' + fm.worst_force_n + ' N' +
          (fm.worst_layer ? ' (' + fm.worst_layer + ')' : '') + '.'));
      }
      box.appendChild(details);
    }
    return box;
  }

  function buildDownloads(job) {
    var box = el('div', 'jobs-downloads', '');
    box.appendChild(el('h4', '', 'Downloads'));
    var id = job.job_id || state.selectedId;
    var names = downloadNames(job);
    box.appendChild(textEl('p', 'jobs-hint', 'Served exactly from this job’s outputs on disk.'));
    var list = el('ul', 'download-list', '');
    function link(file, label) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'jobs-download download-btn';
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
    list.appendChild(link('zip', 'Download whole job (.zip)'));
    box.appendChild(list);
    return box;
  }

  // ---------------------------------------------------------------- public API

  function render(el, opts) {
    if (!el) throw new Error('MldxfJobs.render needs a container element');
    if (opts && opts.jobId) {
      openJob(opts.jobId);
      return;
    }
    if (state.view === 'detail' && state.selectedId) {
      renderInto(el);
      if (state.job === null && !state.jobError) loadJob(state.selectedId);
      return;
    }
    state.view = 'list';
    renderInto(el);
    // Always re-read the list when the tab is shown: the cached
    // list goes stale the moment a run completes in the Job prep
    // tab, and a completed job would not appear until a manual
    // Refresh. The fetch re-renders when it lands; the cached
    // rows stay visible meanwhile.
    loadList();
  }

  /** Open one job's detail view. Loads GET /api/jobs/:id and
   * displays it — v1 jobs read-only, no rerun offered. */
  function openJob(jobId) {
    if (!jobId) return;
    stopRerunPoll();
    state.view = 'detail';
    state.selectedId = jobId;
    state.job = null;
    state.jobError = null;
    state.detailStatus = null;
    state.detailCancelled = false;
    state.canRerunFromInputs = false;
    state.rerunState = null;
    state.rerunMsg = '';
    state.guidesRunning = false;
    state.guidesError = null;
    // Only paint when this tab is selected (see rerender): openJob
    // is also called just before showTab('jobs') switches to it,
    // and the show itself renders — painting here first would
    // clobber the tab the user is still on.
    if (state.rootEl && isCurrentTab()) renderInto(state.rootEl);
    loadJob(jobId);
  }

  window.MldxfJobs = {
    id: 'jobs',
    label: 'Jobs',
    render: render,
    openJob: openJob,
    // The 2D layout preview builder, shared with the Job prep tab
    // (round 11): the result view renders the same preview through
    // this same function, so the drawing and caption stay identical
    // to the detail view. It reads only the job object (plus the
    // module's guides state for its callout); Job prep rewires the
    // callout's Run guides button to its own runGuides after
    // building, so the button acts in the tab it is shown in.
    buildLayoutPreview: buildLayoutPreview,
    // Exposed for the verification harness only (not part of the
    // shell contract): the live view state.
    _state: state,
  };
})();
