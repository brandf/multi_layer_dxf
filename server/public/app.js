/* mldxf web UI (V2.6) — libraries + machine setup.
 *
 * Plain HTML + vanilla JS, no build step, no external resources.
 * The UI talks to the server API only (V2_SCOPE.md §5.2/§5.4): it
 * displays API output and never computes anything about a job.
 * Every library save is validate-then-save through the API — the
 * server bumps the file version, and an invalid save is refused
 * with the API's named error while the file on disk stays unchanged.
 *
 * Tab registry: a later worker (V2.7 job prep) plugs its tab in
 * with App.registerTab({id, label, render(el)}); render(el) is
 * called with the tab's container element whenever the tab is shown.
 * The shell renders the nav from the registered tabs.
 */
"use strict";

const App = (() => {
  const tabs = [];
  let currentId = null;
  const navEl = document.getElementById("tab-nav");
  const mainEl = document.getElementById("tab-main");
  mainEl.setAttribute("role", "tabpanel");

  function registerTab(tab) {
    if (!tab || typeof tab.id !== "string" || !tab.id ||
        typeof tab.label !== "string" || !tab.label ||
        typeof tab.render !== "function") {
      throw new Error("registerTab needs {id, label, render(el)}");
    }
    if (tabs.some((t) => t.id === tab.id)) {
      throw new Error(`tab already registered: ${tab.id}`);
    }
    tabs.push(tab);
    renderNav();
    if (currentId === null) showTab(tab.id);
  }

  function renderNav() {
    navEl.setAttribute("role", "tablist");
    navEl.replaceChildren();
    tabs.forEach((tab, i) => {
      const b = document.createElement("button");
      b.type = "button";
      // One consistent inline-SVG icon per tab (stroke, currentColor).
      const icon = TAB_ICONS[tab.id];
      if (icon) {
        const span = document.createElement("span");
        span.className = "tab-icon";
        span.setAttribute("aria-hidden", "true");
        span.innerHTML = icon;
        b.appendChild(span);
      }
      b.appendChild(document.createTextNode(tab.label));
      // Tablist pattern: roving tabindex (the selected tab is the
      // tab stop) + ArrowLeft/ArrowRight/Home/End move between tabs.
      b.setAttribute("role", "tab");
      b.id = `tab-${tab.id}`;
      b.setAttribute("aria-selected", tab.id === currentId ? "true" : "false");
      b.setAttribute("tabindex", tab.id === currentId ? "0" : "-1");
      b.addEventListener("click", () => showTab(tab.id));
      b.addEventListener("keydown", (ev) => {
        let next = null;
        if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (ev.key === "Home") next = tabs[0];
        else if (ev.key === "End") next = tabs[tabs.length - 1];
        if (!next) return;
        ev.preventDefault();
        showTab(next.id);
        const btn = navEl.querySelector(`[role="tab"][aria-selected="true"]`);
        if (btn) btn.focus();
      });
      navEl.appendChild(b);
    });
    updateTabScrollCue();
  }

  // Round 10 — the narrow tab bar's scroll cue (style.css): a
  // chevron pinned over the bar's right edge while more tabs lie
  // that way. The cue lives in the header, not the nav, so the
  // nav's fade mask cannot fade it out with the tabs; it is
  // positioned over the nav (top/height in px) and shown by
  // .has-more-right on the header. The scroll listener keeps it
  // honest as the bar is scrolled; resize re-checks after a
  // viewport change. At wide widths the cue is display: none.
  let cueEl = null;
  let cueWired = false;
  function updateTabScrollCue() {
    const header = navEl.parentElement;
    if (!header) return;
    // Round 11 — at narrow widths the tab bar wraps to two rows,
    // so there is no horizontal scroll left to cue: never show the
    // chevron there, whatever the bar's scrollWidth says.
    if (window.matchMedia && window.matchMedia("(max-width: 560px)").matches) {
      header.classList.remove("has-more-right");
      return;
    }
    if (!cueEl) {
      cueEl = document.createElement("span");
      cueEl.className = "tab-scroll-cue";
      cueEl.setAttribute("aria-hidden", "true");
      cueEl.textContent = "›";
      header.appendChild(cueEl);
    }
    cueEl.style.top = `${navEl.offsetTop}px`;
    cueEl.style.height = `${navEl.offsetHeight}px`;
    // More tabs lie to the right while over 8 px of scrollable
    // bar remains: scrollIntoView(nearest) can stop a few px
    // short of the absolute end with the last tab already fully
    // visible, and the cue must not linger for that sliver.
    const remaining = navEl.scrollWidth - navEl.clientWidth - navEl.scrollLeft;
    const moreRight = navEl.scrollWidth > navEl.clientWidth + 1 && remaining > 8;
    header.classList.toggle("has-more-right", moreRight);
    if (!cueWired) {
      cueWired = true;
      navEl.addEventListener("scroll", updateTabScrollCue, { passive: true });
      window.addEventListener("resize", updateTabScrollCue);
    }
  }

  function showTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    currentId = id;
    renderNav();
    mainEl.setAttribute("aria-labelledby", `tab-${id}`);
    mainEl.replaceChildren();
    tab.render(mainEl);
    // At narrow widths the tab bar scrolls: bring the selected tab
    // into view, so a tab reached by arrow keys or programmatically
    // is never selected-but-off-screen (round 9).
    const btn = navEl.querySelector(`[role="tab"][aria-selected="true"]`);
    if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    // The selected tab scrolling into view can change the bar's
    // scroll position — re-check the scroll cue after it.
    updateTabScrollCue();
  }

  // Round 9: an async re-render (a fetch landing, a poll tick) may
  // only repaint the shared #tab-main while its own tab is still
  // selected — a load that lands after the user arrowed away used
  // to clobber the new tab's content with the old tab's. Tabs ask
  // App.isCurrentTab(their id) before re-rendering; render(el)
  // itself is synchronous at show time and needs no check.
  function currentTab() {
    return currentId;
  }

  function isCurrentTab(id) {
    return currentId === id;
  }

  return { tabs, registerTab, showTab, currentTab, isCurrentTab };
})();

// One inline-SVG icon per tab: same 16×16 stroke style, currentColor.
const TAB_ICONS = {
  "job-prep":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 1.5h4l3 3v10h-7z"/><path d="M8.5 1.5v3h3"/><path d="M6.5 8h3M6.5 10.5h3"/></svg>',
  jobs:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r="0.9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="12" r="0.9" fill="currentColor" stroke="none"/></svg>',
  tools:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.9 1.8a3.4 3.4 0 0 0-4.3 4.3L2.4 10.3a1.6 1.6 0 0 0 2.3 2.3l4.2-4.2a3.4 3.4 0 0 0 4.3-4.3l-2.4 2.4-2.1-.5-.5-2.1z"/></svg>',
  "clamps-machine":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="12" height="8" rx="1"/><path d="M4.5 7h7M4.5 9.5h7"/></svg>',
  preferences:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.8" fill="var(--surface)"/><circle cx="10" cy="11" r="1.8" fill="var(--surface)"/></svg>',
};
window.App = App;

// The native in-house post-processors (V3.6/V3.8) — the ids `mldxf
// gcode` accepts. The AUTHORITY is the TS registry
// (ts/posts/index.ts POSTS); this list mirrors it for the two
// dropdowns that choose a post (Preferences + machine profile).
// A post added to the registry needs adding here too — the V3.8
// verify_v28 checks assert the dropdowns offer exactly these ids.
/** @type {{id: string, label: string}[]} */
const NATIVE_POSTS = [
  { id: "masso-mm", label: "Onefinity Masso (mm)" },
  { id: "masso-inch", label: "Onefinity Masso (inch)" },
  { id: "grbl", label: "GRBL (generic hobby)" },
  { id: "template", label: "Template (example post)" },
];
/** Label for a post id (the id itself for an unknown value). */
function postLabel(id) {
  const found = NATIVE_POSTS.find((p) => p.id === id);
  return found ? found.label : id;
}

// ---------------------------------------------------------------- helpers

/** Call the server API. Throws an Error carrying the API's named
 * error and message (e.g. "config_error: ...") on failure. */
async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(path, init);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    const name = data.error || `http_${resp.status}`;
    const msg = data.message || resp.statusText || "request failed";
    throw new Error(`${name}: ${msg}`);
  }
  return data;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const c of children) {
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

/** "5 tools" / "1 tool" — proper singular/plural, never "5 tool(s)". */
function countText(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function msgBox(kind) {
  return el("div", { class: `msg ${kind || ""}`, role: "status" });
}

/** Set a message box's text (empty string clears it). */
function say(box, kind, text) {
  box.className = `msg ${kind || ""}`;
  box.textContent = text || "";
}

function numInput(value) {
  const input = el("input", { type: "number", step: "any" });
  if (value !== undefined && value !== null) input.value = String(value);
  return input;
}

function textInput(value) {
  const input = el("input", { type: "text" });
  if (value !== undefined && value !== null) input.value = String(value);
  return input;
}

function checkInput(checked) {
  const input = el("input", { type: "checkbox" });
  input.checked = Boolean(checked);
  return input;
}

function labeled(labelText, input, hint, desc) {
  const wrap = el("div");
  const label = el("label", { text: labelText });
  if (hint) label.appendChild(el("span", { class: "hint", text: ` — ${hint}` }));
  wrap.appendChild(label);
  wrap.appendChild(input);
  // Examples and long explanations live under the label as hint
  // text — never inside the label itself, where they force it to
  // wrap to 2–3 lines in the 3-column grid.
  if (desc) wrap.appendChild(el("p", { class: "field-desc", text: desc }));
  return wrap;
}

function parseNum(input, { required = false, integer = false } = {}) {
  const raw = input.value.trim();
  if (raw === "") {
    if (required) throw new Error(`"${input.name || "field"}" is required`);
    return undefined;
  }
  const v = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(v)) throw new Error(`"${input.name || "field"}" is not a number: ${raw}`);
  return v;
}

/** Tool id for a diameter in mm, e.g. 6.35 -> "EM6.35". The
 * pipeline's ids round the diameter to 4 decimals first
 * (toolplan.py: round(dia, 4), then f"{dia:.2f}"): 0.375 in is
 * 9.525 mm -> EM9.53, not EM9.52 — a bare toFixed(2) on the raw
 * float (9.524999...) rounds the wrong way, so the standard-sizes
 * list could never match the EM9.53 the inventory holds. */
function toolIdForDia(diaMm, prefix) {
  const rounded = Number(diaMm.toFixed(4));
  return `${prefix}${rounded.toFixed(2)}`;
}

/** Parse a manifest tool id ("EM6.35" / "D2.25") into {prefix, dia}. */
function parseToolId(id) {
  const m = /^(EM|D)(\d+\.\d+)$/.exec((id || "").trim());
  return m ? { prefix: m[1], dia: parseFloat(m[2]) } : null;
}

/** A feeds override as human words, not a code dump: "feed 30 mm/s ·
 * plunge 10 · spindle 20,000 rpm". Unknown keys fall back to key=value. */
function formatFeedsParts(feeds) {
  if (!feeds) return [];
  const parts = [];
  const labels = {
    feed_mm_s: (v) => `feed ${v} mm/s`,
    plunge_mm_s: (v) => `plunge ${v}`,
    spindle_rpm: (v) => `spindle ${Number(v).toLocaleString("en-US")} rpm`,
    stepdown_mm: (v) => `stepdown ${v} mm`,
    stepover_pct: (v) => `stepover ${v}%`,
  };
  for (const [k, v] of Object.entries(feeds)) {
    parts.push(labels[k] ? labels[k](v) : `${k}=${v}`);
  }
  return parts;
}
function formatFeeds(feeds) {
  if (!feeds) return "planner defaults";
  const parts = formatFeedsParts(feeds);
  return parts.length ? parts.join(" · ") : "planner defaults";
}

/** A <code> element for an id like "test-tt-clamp": the whole id
 * stays on one line (code.clamp-id is no-wrap) — a break after a
 * hyphen reads as two ids ("test-tt / -clamp"), so no <wbr> is
 * inserted; the Id column is wide enough instead. */
function codeWithHyphenBreaks(text) {
  const code = el("code", { class: "clamp-id" });
  code.textContent = String(text || "");
  return code;
}

// ---------------------------------------------------------------- Tools tab

function renderToolsTab(container) {
  container.appendChild(el("h2", { text: "Tools" }));
  container.appendChild(el("p", {
    class: "muted",
    text: "The tools you actually own. The planner still recommends " +
      "from its standard sizes, and a plan flags any tool you do not " +
      "own so you can check before you cut — the inventory never " +
      "changes the plan itself.",
  }));
  const box = msgBox();
  container.appendChild(box);
  const body = el("div", { text: "Loading…" });
  container.appendChild(body);

  let doc = null;      // {version, tools:[...]} from GET /api/tools
  let prefs = null;    // preferences, for the standard sizes
  let editingId = null;

  async function load() {
    const [t, p] = await Promise.all([api("GET", "/api/tools"), api("GET", "/api/preferences")]);
    doc = t.tools;
    prefs = p.preferences;
    editingId = null;
    draw();
  }

  async function save(nextTools, what) {
    say(box, "", "Saving…");
    try {
      const saved = await api("PUT", "/api/tools", { version: doc.version, tools: nextTools });
      doc = saved.tools;
      editingId = null;
      say(box, "ok", `${what} saved — tools.json is now version ${doc.version}.`);
      draw();
    } catch (e) {
      // Refused by the API: the file on disk is unchanged. Re-read
      // so the UI shows the saved state, not the rejected edit.
      say(box, "err", `Not saved — the API refused it:\n${e.message}`);
      try { doc = (await api("GET", "/api/tools")).tools; } catch { /* keep stale doc */ }
      editingId = null;
      draw();
    }
  }

  function standardSizes() {
    const tp = (prefs && prefs.toolplan) || {};
    const out = [];
    for (const inch of tp.standard_endmills_in || []) {
      out.push({ label: `${inch}in`, diaMm: inch * 25.4, id: toolIdForDia(inch * 25.4, "EM") });
    }
    for (const mm of tp.standard_endmills_mm || []) {
      out.push({ label: `${mm} mm`, diaMm: mm, id: toolIdForDia(mm, "EM") });
    }
    return out;
  }

  function draw() {
    body.replaceChildren();
    // File/version metadata lives in the About dialog (footer),
    // not as UI copy — only the count stays here.
    body.appendChild(el("p", {
      class: "version",
      text: `${countText(doc.tools.length, "tool", "tools")} recorded.`,
    }));

    // Standard sizes owned?
    const sizes = standardSizes();
    if (sizes.length) {
      body.appendChild(el("h3", { text: "Standard sizes owned" }));
      const table = el("table");
      table.appendChild(el("tr", {}, [
        el("th", { text: "Standard size" }), el("th", { text: "Tool id" }),
        el("th", { text: "Owned?" }),
      ]));
      for (const s of sizes) {
        const owned = doc.tools.some((t) => t.id === s.id);
        const ownedCell = el("td");
        ownedCell.appendChild(el("span", {
          class: owned ? "badge badge-owned" : "badge badge-not-owned",
          text: owned ? "✓ owned" : "not owned",
        }));
        const row = el("tr", {}, [
          el("td", { text: s.label }),
          el("td", {}, [el("code", { text: s.id })]),
          ownedCell,
        ]);
        table.appendChild(row);
      }
      body.appendChild(table);
      body.appendChild(el("p", {
        class: "muted",
        text: "A plan that needs a tool you do not own is flagged, not " +
          "dropped — the inventory is advisory in V2.",
      }));
    }

    // Inventory table
    body.appendChild(el("h3", { text: "Inventory" }));
    if (!doc.tools.length) {
      body.appendChild(el("p", { class: "muted", text: "No tools recorded yet." }));
    } else {
      const table = el("table", { class: "inventory-table" });
      const thead = document.createElement("thead");
      thead.appendChild(el("tr", {}, [
        el("th", { text: "Id" }), el("th", { text: "Kind" }),
        el("th", { class: "num", text: "Dia (mm)" }),
        el("th", { text: "Native label" }), el("th", { text: "Feeds override" }),
        el("th", { text: "Notes" }), el("th", { text: "Actions" }),
      ]));
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      for (const t of doc.tools) {
        // The feeds override breaks only between segments (m9):
        // each "feed 30 mm/s" segment is a no-wrap span, so the
        // cell never wraps mid-phrase ("feed 30" / "mm/s").
        // separator lives INSIDE the following segment's span
        // ("· plunge 10"), not as a text node between spans — in
        // the narrow card layout each segment is its own line
        // (see style.css) and a bare "·" text node would take a
        // line of its own. Wide rendering is unchanged.
        const feedsParts = formatFeedsParts(t.feeds);
        const feedsCell = el("td", { "data-label": "Feeds override" });
        if (!feedsParts.length) feedsCell.textContent = "planner defaults";
        else feedsParts.forEach((p, i) => {
          feedsCell.appendChild(el("span", { class: "feeds-seg", text: (i ? " · " : "") + p }));
        });
        // The note sits behind a "Notes" toggle, collapsed by
        // default at every width: one line per row, the full note
        // one click away. Showing the paragraph in full ballooned
        // rows to ~180 px; hiding it outright lost content.
        // data-label feeds the narrow-width card layout (see style.css).
        const notesCell = el("td", { class: "notes-cell", "data-label": "Notes" });
        const noteDetails = el("details", { class: "note-toggle" });
        noteDetails.appendChild(el("summary", { text: "Notes" }));
        noteDetails.appendChild(el("span", { text: t.notes || "" }));
        notesCell.appendChild(noteDetails);
        const row = el("tr", {}, [
          el("td", { "data-label": "Id" }, [el("code", { text: t.id })]),
          el("td", { text: t.kind, "data-label": "Kind" }),
          el("td", { class: "num", text: String(t.dia_mm), "data-label": "Dia (mm)" }),
          el("td", { text: t.native_label, "data-label": "Native label" }),
          feedsCell,
          notesCell,
        ]);
        const actions = el("td", { class: "actions-cell", "data-label": "" });
        const editBtn = el("button", { type: "button", text: "Edit" });
        editBtn.addEventListener("click", () => { editingId = t.id; draw(); });
        const delBtn = el("button", { type: "button", class: "danger", text: "Remove" });
        delBtn.addEventListener("click", () => {
          if (window.confirm(`Remove tool ${t.id} from the inventory?`)) {
            void save(doc.tools.filter((x) => x.id !== t.id), `Removed ${t.id}`);
          }
        });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);
        tbody.appendChild(row);
      }
      body.appendChild(table);
    }

    // Add / edit form
    const editing = editingId ? doc.tools.find((t) => t.id === editingId) : null;
    const fs = el("fieldset");
    fs.appendChild(el("legend", { text: editing ? `Edit tool ${editing.id}` : "Add a tool" }));
    const grid = el("div", { class: "form-grid" });
    const idInput = textInput(editing ? editing.id : "");
    idInput.name = "id";
    const kindSelect = el("select", { name: "kind" });
    for (const k of ["endmill", "drill"]) {
      const opt = el("option", { value: k, text: k });
      if (editing && editing.kind === k) opt.selected = true;
      kindSelect.appendChild(opt);
    }
    const diaInput = numInput(editing ? editing.dia_mm : undefined);
    diaInput.name = "dia_mm";
    const labelInput = textInput(editing ? editing.native_label : "");
    labelInput.name = "native_label";
    const notesInput = textInput(editing ? editing.notes || "" : "");
    // The id is the diameter (EM6.35 is 6.35 mm): typing an id fills
    // in the diameter and kind, so the form stays consistent.
    idInput.addEventListener("input", () => {
      const parsed = parseToolId(idInput.value);
      if (!parsed) return;
      diaInput.value = String(parsed.dia);
      kindSelect.value = parsed.prefix === "EM" ? "endmill" : "drill";
    });
    grid.appendChild(labeled("Tool id", idInput, null, "e.g. EM6.35, D2.25 — the id is the diameter"));
    grid.appendChild(labeled("Kind", kindSelect, null, "Follows from the id prefix"));
    grid.appendChild(labeled("Diameter (mm)", diaInput, null, "Filled in from the id"));
    grid.appendChild(labeled("Native label", labelInput, null, "e.g. 1/4in or 2.25 mm — must agree with the diameter"));
    grid.appendChild(labeled("Notes", notesInput));
    fs.appendChild(grid);

    const feedsFs = el("fieldset");
    feedsFs.appendChild(el("legend", { text: "Feeds override (optional)" }));
    const feedsGrid = el("div", { class: "form-grid" });
    const feedInputs = {};
    for (const [key, label, hint] of [
      ["feed_mm_s", "Feed", "mm/s"], ["plunge_mm_s", "Plunge", "mm/s"],
      ["spindle_rpm", "Spindle speed", "rpm"],
      ["stepdown_mm", "Stepdown", "mm"], ["stepover_pct", "Stepover", "%"],
    ]) {
      const input = numInput(editing && editing.feeds ? editing.feeds[key] : undefined);
      input.name = key;
      feedInputs[key] = input;
      feedsGrid.appendChild(labeled(label, input, hint));
    }
    feedsFs.appendChild(feedsGrid);
    fs.appendChild(feedsFs);

    const saveBtn = el("button", {
      type: "button", class: "primary",
      text: editing ? "Save changes" : "Add tool",
    });
    saveBtn.addEventListener("click", () => {
      let entry;
      try {
        const id = idInput.value.trim();
        if (!id) throw new Error('"id" is required');
        const parsed = parseToolId(id);
        if (!parsed) throw new Error(`tool id ${JSON.stringify(id)} is not a manifest tool id — expected 'EM<dia>' or 'D<dia>', e.g. EM6.35, D2.25`);
        const dia = parseNum(diaInput, { required: true });
        const label = labelInput.value.trim();
        if (!label) throw new Error('"native_label" is required');
        entry = {
          id,
          kind: kindSelect.value,
          dia_mm: dia,
          native_label: label,
        };
        const feeds = {};
        for (const [key, input] of Object.entries(feedInputs)) {
          const v = parseNum(input, { integer: key === "spindle_rpm" });
          if (v !== undefined) feeds[key] = v;
        }
        if (Object.keys(feeds).length) entry.feeds = feeds;
        const notes = notesInput.value.trim();
        if (notes) entry.notes = notes;
      } catch (e) {
        say(box, "err", e.message);
        return;
      }
      const next = doc.tools.filter((t) => t.id !== entry.id);
      if (editing && editing.id !== entry.id) {
        // Renamed: the old id goes away with the edit.
        const idx = doc.tools.findIndex((t) => t.id === editing.id);
        if (idx >= 0) next.splice(idx, 1);
      }
      next.push(entry);
      next.sort((a, b) => (a.id < b.id ? -1 : 1));
      void save(next, editing ? `Updated ${entry.id}` : `Added ${entry.id}`);
    });
    fs.appendChild(saveBtn);
    if (editing) {
      const cancelBtn = el("button", { type: "button", text: "Cancel" });
      cancelBtn.addEventListener("click", () => { editingId = null; draw(); });
      fs.appendChild(cancelBtn);
    }
    body.appendChild(fs);
  }

  load().catch((e) => {
    body.replaceChildren();
    say(box, "err", `Could not load the tool inventory:\n${e.message}`);
  });
}

// ---------------------------------------------------------------- Clamps & machine tab

function renderClampsMachineTab(container) {
  container.appendChild(el("h2", { text: "Clamps & machine" }));
  container.appendChild(el("p", {
    class: "muted",
    text: "The clamps you own and the machine they mount on, including " +
      "your T-track slots. The guides use these to suggest where each " +
      "clamp goes — measure your slots first; placeholder slots cannot " +
      "be used.",
  }));
  const box = msgBox();
  container.appendChild(box);
  const body = el("div", { text: "Loading…" });
  container.appendChild(body);

  let machine = null;   // working copy of machine.json
  let clampsDoc = null; // {version, clamps:[...]} from GET /api/clamps
  let editingClampId = null;

  async function load() {
    const [m, c] = await Promise.all([api("GET", "/api/machine"), api("GET", "/api/clamps")]);
    machine = structuredClone(m.machine);
    clampsDoc = c.clamps;
    editingClampId = null;
    draw();
  }

  function machineSaveError(e) {
    say(box, "err", `Machine profile not saved — the API refused it:\n${e.message}`);
  }

  async function saveMachine() {
    say(box, "", "Saving machine profile…");
    try {
      const saved = await api("PUT", "/api/machine", machine);
      machine = structuredClone(saved.machine);
      say(box, "ok", `Machine profile saved — machine.json is now version ${machine.version}.`);
      draw();
    } catch (e) {
      machineSaveError(e);
      try { machine = structuredClone((await api("GET", "/api/machine")).machine); } catch { /* keep */ }
      draw();
    }
  }

  async function saveClamps(nextClamps, what) {
    say(box, "", "Saving…");
    try {
      const saved = await api("PUT", "/api/clamps", { version: clampsDoc.version, clamps: nextClamps });
      clampsDoc = saved.clamps;
      editingClampId = null;
      say(box, "ok", `${what} saved — clamps.json is now version ${clampsDoc.version}.`);
      draw();
    } catch (e) {
      say(box, "err", `Not saved — the API refused it:\n${e.message}`);
      try { clampsDoc = (await api("GET", "/api/clamps")).clamps; } catch { /* keep */ }
      editingClampId = null;
      draw();
    }
  }

  /** Normalize a slot to only its own axis's keys (the validator
   * rejects extra keys). */
  function normalizeSlot(slot) {
    if (slot.axis === "x") {
      return {
        axis: "x", at_y_mm: slot.at_y_mm, from_x_mm: slot.from_x_mm, to_x_mm: slot.to_x_mm,
        ...(slot.placeholder ? { placeholder: true } : {}),
        ...(slot.comment ? { comment: slot.comment } : {}),
      };
    }
    return {
      axis: "y", at_x_mm: slot.at_x_mm, from_y_mm: slot.from_y_mm, to_y_mm: slot.to_y_mm,
      ...(slot.placeholder ? { placeholder: true } : {}),
      ...(slot.comment ? { comment: slot.comment } : {}),
    };
  }

  function draw() {
    body.replaceChildren();
    // File/version metadata lives in the About dialog (footer),
    // not as UI copy — only the count stays here.
    body.appendChild(el("p", {
      class: "version",
      // The count is the physical clamps, not the inventory rows:
      // a fresh home has 5 clamp-type rows with Count 0 each, so
      // "5 clamps recorded" contradicted the table it sat above.
      // The row count is the number of types; the total is the
      // sum of the Count column.
      text: `${countText(clampsDoc.clamps.length, "clamp type", "clamp types")} recorded — ` +
        `${countText(clampsDoc.clamps.reduce((n, c) => n + (c.count || 0), 0), "clamp", "clamps")} in total.`,
    }));

    // ---- Machine profile ----
    body.appendChild(el("h3", { text: "Machine profile" }));
    const mfs = el("fieldset");
    mfs.appendChild(el("legend", { text: "Machine" }));
    const mgrid = el("div", { class: "form-grid" });
    const idInput = textInput(machine.id);
    const nameInput = textInput(machine.name);
    const bedW = numInput(machine.bed.width_mm); bedW.name = "width_mm";
    const bedD = numInput(machine.bed.depth_mm); bedD.name = "depth_mm";
    const controllerInput = textInput(machine.controller);
    const materialInput = textInput(
      typeof machine.default_material === "string" ? machine.default_material : "");
    // V3.8: the machine profile names the post — a real selection
    // over the native posts, not free text. Read at save time like
    // the other machine fields below; an empty choice stores null
    // (no selection — `mldxf gcode` then uses its default).
    const postSel = el("select");
    postSel.setAttribute("data-role", "machine-post");
    for (const [value, label] of [["", "Not set — default (masso-mm)"], ...NATIVE_POSTS.map((p) => [p.id, p.label])]) {
      const opt = el("option", { value, text: label });
      if ((machine.post_processor || "") === value) opt.selected = true;
      postSel.appendChild(opt);
    }
    mgrid.appendChild(labeled("Machine id", idInput));
    mgrid.appendChild(labeled("Name", nameInput));
    mgrid.appendChild(labeled("Bed width (mm)", bedW));
    mgrid.appendChild(labeled("Bed depth (mm)", bedD));
    mgrid.appendChild(labeled("Controller", controllerInput, "informational in V2"));
    mgrid.appendChild(labeled("Default material", materialInput, null, "Sheet size, WxDxT in mm — blank for none"));
    mgrid.appendChild(labeled("Post processor", postSel, null, "The in-house post this machine uses is `mldxf gcode` — unless a job or --post says otherwise"));
    mfs.appendChild(mgrid);
    body.appendChild(mfs);

    // ---- T-track ----
    body.appendChild(el("h3", { text: "T-track layout" }));
    const tt = machine.t_track || { slot_width_mm: 8, slots: [] };
    const anyPlaceholder = tt.placeholder === true ||
      (tt.slots || []).some((s) => s.placeholder === true);
    if (anyPlaceholder) {
      body.appendChild(el("div", {
        class: "placeholder-note",
        text: "PLACEHOLDER — these slot positions are NOT measurements. " +
          "Measure your bed and replace them with the real values (and " +
          "clear the placeholder flags). Until then the workholding " +
          "guides refuse to run with them.",
      }));
    }
    const tfs = el("fieldset");
    tfs.appendChild(el("legend", { text: "T-track slots (a simple list — no drawing editor in V2)" }));
    const tgrid = el("div", { class: "form-grid" });
    const slotWidthInput = numInput(tt.slot_width_mm); slotWidthInput.name = "slot_width_mm";
    const ttPlaceholder = checkInput(tt.placeholder === true);
    // A textarea, not a single-line input: the comment is long
    // ("TEST FIXTURE — NOT A MEASUREMENT…") and a one-line input
    // clips it no matter how wide the field is. It spans the whole
    // grid row (field-span-all) and wraps, so the value reads in full.
    const ttComment = document.createElement("textarea");
    ttComment.className = "field-wide";
    ttComment.rows = 2;
    ttComment.value = tt.comment || "";
    tgrid.appendChild(labeled("Slot width (mm)", slotWidthInput));
    // Checkbox first, then its label, on one line — the label used
    // to wrap with the checkbox floating below the text.
    const phWrap = el("div", { class: "field-bool" });
    phWrap.appendChild(ttPlaceholder);
    phWrap.appendChild(el("label", { text: "Placeholder layout" }));
    phWrap.appendChild(el("p", { class: "field-desc", text: "Clear once the slots are measured." }));
    tgrid.appendChild(phWrap);
    // The comment is long ("TEST FIXTURE — NOT A MEASUREMENT…") —
    // it spans the whole grid row so it reads in full.
    const ttCommentWrap = labeled("Layout comment", ttComment);
    ttCommentWrap.classList.add("field-span-all");
    tgrid.appendChild(ttCommentWrap);
    tfs.appendChild(tgrid);

    // One compact table for all slots — the per-slot cards (a
    // bordered box with 6 fields + Remove each) made the page
    // ~3,000 px tall from repetition alone.
    const slotsTable = el("table", { class: "slots-table" });
    slotsTable.appendChild(el("tr", {}, [
      el("th", { text: "Axis" }), el("th", { class: "num", text: "At (mm)" }),
      el("th", { class: "num", text: "From (mm)" }), el("th", { class: "num", text: "To (mm)" }),
      el("th", { text: "Placeholder" }), el("th", { text: "Comment" }),
      el("th", { text: "Remove" }),
    ]));
    if (!(tt.slots || []).length) {
      tfs.appendChild(el("p", {
        class: "muted",
        text: "No slots yet — add one below.",
      }));
    }
    (tt.slots || []).forEach((slot, i) => {
      const row = el("tr", { "data-slot-row": String(i) });
      // Round 14 (M2) — every cell carries its header as
      // data-label, so the narrow card layout can label each row
      // (see style.css); the Remove cell carries an empty label
      // so no label doubles the button.
      const axisCell = el("td", { "data-label": "Axis" });
      const axisSel = el("select");
      for (const a of ["x", "y"]) {
        const opt = el("option", { value: a, text: a });
        if (slot.axis === a) opt.selected = true;
        axisSel.appendChild(opt);
      }
      axisSel.addEventListener("change", () => {
        // Switching axis converts the slot to the other key set.
        const at = slot.axis === "x" ? slot.at_y_mm : slot.at_x_mm;
        const from = slot.axis === "x" ? slot.from_x_mm : slot.from_y_mm;
        const to = slot.axis === "x" ? slot.to_x_mm : slot.to_y_mm;
        const next = axisSel.value === "x"
          ? { axis: "x", at_y_mm: at, from_x_mm: from, to_x_mm: to }
          : { axis: "y", at_x_mm: at, from_y_mm: from, to_y_mm: to };
        if (slot.placeholder) next.placeholder = true;
        if (slot.comment) next.comment = slot.comment;
        machine.t_track.slots[i] = normalizeSlot(next);
        draw();
      });
      axisSel.title = "Slot axis — x runs along X (fixed Y), y runs along Y (fixed X)";
      axisCell.appendChild(axisSel);
      row.appendChild(axisCell);
      const atInput = numInput(slot.axis === "x" ? slot.at_y_mm : slot.at_x_mm);
      atInput.name = "slot position";
      atInput.title = slot.axis === "x" ? "Fixed Y of the slot centreline (mm)" : "Fixed X of the slot centreline (mm)";
      const fromInput = numInput(slot.axis === "x" ? slot.from_x_mm : slot.from_y_mm);
      fromInput.name = "slot from";
      const toInput = numInput(slot.axis === "x" ? slot.to_x_mm : slot.to_y_mm);
      toInput.name = "slot to";
      const phInput = checkInput(slot.placeholder === true);
      // Round 14 (m6) — a single-row textarea that expands on
      // focus: the comment is long ("PLACEHOLDER — not a
      // measurement…") and a one-line input truncates it with no
      // way to read the rest, but a 3-row textarea made every
      // slots row very tall even when empty. One row tall at
      // rest (see style.css: it grows to 5 rows on focus, wraps,
      // and the title carries the full text on hover).
      const commentInput = document.createElement("textarea");
      commentInput.rows = 1;
      commentInput.value = slot.comment || "";
      commentInput.title = slot.comment || "";
      const saveSlot = () => {
        try {
          const at = parseNum(atInput, { required: true });
          const from = parseNum(fromInput, { required: true });
          const to = parseNum(toInput, { required: true });
          const next = slot.axis === "x"
            ? { axis: "x", at_y_mm: at, from_x_mm: from, to_x_mm: to }
            : { axis: "y", at_x_mm: at, from_y_mm: from, to_y_mm: to };
          if (phInput.checked) next.placeholder = true;
          const comment = commentInput.value.trim();
          if (comment) next.comment = comment;
          machine.t_track.slots[i] = normalizeSlot(next);
        } catch (e) {
          say(box, "err", e.message);
        }
      };
      for (const inp of [atInput, fromInput, toInput, phInput, commentInput]) {
        inp.addEventListener("change", saveSlot);
      }
      const atCell = el("td", { class: "num", "data-label": "At (mm)" }); atCell.appendChild(atInput); row.appendChild(atCell);
      const fromCell = el("td", { class: "num", "data-label": "From (mm)" }); fromCell.appendChild(fromInput); row.appendChild(fromCell);
      const toCell = el("td", { class: "num", "data-label": "To (mm)" }); toCell.appendChild(toInput); row.appendChild(toCell);
      const phCell = el("td", { "data-label": "Placeholder" }); phCell.appendChild(phInput); row.appendChild(phCell);
      const commentCell = el("td", { "data-label": "Comment" }); commentCell.appendChild(commentInput); row.appendChild(commentCell);
      const delCell = el("td", { "data-label": "" });
      const delBtn = el("button", { type: "button", class: "danger", text: "Remove" });
      delBtn.addEventListener("click", () => {
        machine.t_track.slots.splice(i, 1);
        draw();
      });
      delCell.appendChild(delBtn);
      row.appendChild(delCell);
      slotsTable.appendChild(row);
    });
    tfs.appendChild(slotsTable);
    const addSlotBtn = el("button", {
      type: "button", text: "Add slot",
    });
    addSlotBtn.addEventListener("click", () => {
      const width = machine.bed.width_mm;
      machine.t_track.slots.push(normalizeSlot({
        axis: "x", at_y_mm: 0, from_x_mm: 0, to_x_mm: width,
      }));
      draw();
    });
    tfs.appendChild(addSlotBtn);
    body.appendChild(tfs);

    const saveMachineBtn = el("button", {
      type: "button", class: "primary", text: "Save machine profile + T-track",
    });
    saveMachineBtn.addEventListener("click", () => {
      try {
        // Re-read the slot rows from the DOM first: a value typed
        // but not yet blurred has not fired its change listener, so
        // machine.t_track.slots may not hold it yet.
        [...slotsTable.querySelectorAll("[data-slot-row]")].forEach((row, i) => {
          const sel = row.querySelector("select");
          const nums = [...row.querySelectorAll('input[type="number"]')];
          const ph = row.querySelector('input[type="checkbox"]');
          const commentEl = row.querySelector('textarea, input[type="text"]');
          const axis = sel.value;
          const [at, from, to] = nums.map((n) => parseNum(n, { required: true }));
          const next = axis === "x"
            ? { axis: "x", at_y_mm: at, from_x_mm: from, to_x_mm: to }
            : { axis: "y", at_x_mm: at, from_y_mm: from, to_y_mm: to };
          if (ph.checked) next.placeholder = true;
          const comment = commentEl.value.trim();
          if (comment) next.comment = comment;
          machine.t_track.slots[i] = normalizeSlot(next);
        });
        const id = idInput.value.trim();
        const name = nameInput.value.trim();
        const controller = controllerInput.value.trim();
        if (!id) throw new Error('"id" is required');
        if (!name) throw new Error('"name" is required');
        if (!controller) throw new Error('"controller" is required');
        const width = parseNum(bedW, { required: true });
        const depth = parseNum(bedD, { required: true });
        const slotWidth = parseNum(slotWidthInput, { required: true });
        machine.id = id;
        machine.name = name;
        machine.controller = controller;
        machine.post_processor = postSel.value || null;
        machine.bed = { width_mm: width, depth_mm: depth };
        const material = materialInput.value.trim();
        machine.default_material = material || null;
        machine.t_track.slot_width_mm = slotWidth;
        machine.t_track.placeholder = ttPlaceholder.checked;
        const comment = ttComment.value.trim();
        if (comment) machine.t_track.comment = comment;
        else delete machine.t_track.comment;
        machine.t_track.slots = (machine.t_track.slots || []).map(normalizeSlot);
      } catch (e) {
        say(box, "err", e.message);
        return;
      }
      void saveMachine();
    });
    body.appendChild(saveMachineBtn);
    body.appendChild(el("p", {
      class: "muted",
      text: "A slot outside the bed, or two slots on the same axis " +
        "overlapping, is refused by the API and the file is left unchanged.",
    }));

    // ---- Clamps ----
    body.appendChild(el("h3", { text: "Clamp inventory" }));
    body.appendChild(el("p", {
      class: "muted",
      text: "Only the workholding methods you actually have. A " +
        "T-track clamp needs a real (non-placeholder) slot to mount in — " +
        "checked at guide time, not here.",
    }));
    if (!clampsDoc.clamps.length) {
      body.appendChild(el("p", { class: "muted", text: "No clamps recorded yet." }));
    } else {
      const table = el("table", { class: "clamps-table" });
      table.appendChild(el("tr", {}, [
        el("th", { text: "Id" }), el("th", { text: "Method" }),
        el("th", { text: "Footprint (mm)" }), el("th", { class: "num", text: "Keep-out (mm)" }),
        el("th", { class: "num", text: "Hold force (N)" }),
        el("th", { text: "T-track?" }), el("th", { class: "num", text: "Count" }),
        el("th", { text: "Notes" }), el("th", { text: "Actions" }),
      ]));
      for (const c of clampsDoc.clamps) {
        // The note sits behind a "Notes" toggle, collapsed by
        // default — the same component as the Tools inventory:
        // showing the full TEMPLATE paragraph in every row
        // ballooned rows to ~350 px, mostly empty.
        const notesCell = el("td", { class: "notes-cell", "data-label": "Notes" });
        const noteDetails = el("details", { class: "note-toggle" });
        noteDetails.appendChild(el("summary", { text: "Notes" }));
        noteDetails.appendChild(el("span", { text: c.notes || "" }));
        notesCell.appendChild(noteDetails);
        // Round 14 (M2) — every cell carries its header as
        // data-label, so the narrow card layout can label each row
        // (see style.css); the Actions cell carries an empty label
        // so no label doubles the buttons.
        const row = el("tr", {}, [
          el("td", { "data-label": "Id" }, [codeWithHyphenBreaks(c.id)]),
          el("td", { text: c.method, "data-label": "Method" }),
          el("td", { text: `${c.footprint_mm[0]} × ${c.footprint_mm[1]}`, "data-label": "Footprint (mm)" }),
          el("td", { class: "num", text: String(c.keep_out_mm), "data-label": "Keep-out (mm)" }),
          el("td", { class: "num", text: c.hold_force_n !== undefined ? String(c.hold_force_n) : "—", "data-label": "Hold force (N)" }),
          el("td", { text: c.t_track ? "yes" : "no", "data-label": "T-track?" }),
          el("td", { class: "num", text: String(c.count), "data-label": "Count" }),
          notesCell,
        ]);
        const actions = el("td", { class: "actions-cell", "data-label": "" });
        const editBtn = el("button", { type: "button", text: "Edit" });
        editBtn.addEventListener("click", () => { editingClampId = c.id; draw(); });
        const delBtn = el("button", { type: "button", class: "danger", text: "Remove" });
        delBtn.addEventListener("click", () => {
          if (window.confirm(`Remove clamp ${c.id} from the inventory?`)) {
            void saveClamps(clampsDoc.clamps.filter((x) => x.id !== c.id), `Removed ${c.id}`);
          }
        });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);
        table.appendChild(row);
      }
      body.appendChild(table);
    }

    const editing = editingClampId
      ? clampsDoc.clamps.find((c) => c.id === editingClampId) : null;
    const cfs = el("fieldset");
    cfs.appendChild(el("legend", { text: editing ? `Edit clamp ${editing.id}` : "Add a clamp" }));
    const cgrid = el("div", { class: "form-grid" });
    const cId = textInput(editing ? editing.id : ""); cId.name = "id";
    const methodSel = el("select");
    for (const m of ["t_track_clamp", "tape", "glue", "screw", "pin", "vise"]) {
      const opt = el("option", { value: m, text: m });
      if (editing && editing.method === m) opt.selected = true;
      methodSel.appendChild(opt);
    }
    const fpW = numInput(editing ? editing.footprint_mm[0] : undefined); fpW.name = "footprint_w";
    const fpD = numInput(editing ? editing.footprint_mm[1] : undefined); fpD.name = "footprint_d";
    const keepOut = numInput(editing ? editing.keep_out_mm : undefined); keepOut.name = "keep_out_mm";
    const holdForce = numInput(editing ? editing.hold_force_n : undefined); holdForce.name = "hold_force_n";
    const tTrack = checkInput(editing ? editing.t_track : false);
    const count = numInput(editing ? editing.count : 0); count.name = "count";
    const cNotes = textInput(editing ? editing.notes || "" : "");
    cNotes.className = "field-wide";
    // A T-track clamp mounts in a slot by definition.
    methodSel.addEventListener("change", () => {
      if (methodSel.value === "t_track_clamp") tTrack.checked = true;
    });
    cgrid.appendChild(labeled("Clamp id", cId));
    cgrid.appendChild(labeled("Method", methodSel));
    cgrid.appendChild(labeled("Width (mm)", fpW, null, "Footprint width — along the slot"));
    cgrid.appendChild(labeled("Depth (mm)", fpD, null, "Footprint depth — across the slot"));
    cgrid.appendChild(labeled("Keep-out (mm)", keepOut, null, "Clearance the tool keeps from the clamp"));
    cgrid.appendChild(labeled("Hold force (N)", holdForce, null, "Optional — blank means unknown"));
    cgrid.appendChild(labeled("T-track mount", tTrack, null, "Mounts in a T-track slot"));
    cgrid.appendChild(labeled("Count", count));
    cgrid.appendChild(labeled("Notes", cNotes));
    cfs.appendChild(cgrid);
    const cSave = el("button", {
      type: "button", class: "primary",
      text: editing ? "Save changes" : "Add clamp",
    });
    cSave.addEventListener("click", () => {
      let entry;
      try {
        const id = cId.value.trim();
        if (!id) throw new Error('"id" is required');
        const w = parseNum(fpW, { required: true });
        const d = parseNum(fpD, { required: true });
        const ko = parseNum(keepOut, { required: true });
        const ct = parseNum(count, { required: true, integer: true });
        entry = {
          id,
          method: methodSel.value,
          footprint_mm: [w, d],
          keep_out_mm: ko,
          t_track: tTrack.checked,
          count: ct,
        };
        const hf = parseNum(holdForce);
        if (hf !== undefined) entry.hold_force_n = hf;
        const notes = cNotes.value.trim();
        if (notes) entry.notes = notes;
      } catch (e) {
        say(box, "err", e.message);
        return;
      }
      const next = clampsDoc.clamps.filter((c) => c.id !== entry.id);
      if (editing && editing.id !== entry.id) {
        const idx = clampsDoc.clamps.findIndex((c) => c.id === editing.id);
        if (idx >= 0) next.splice(idx, 1);
      }
      next.push(entry);
      next.sort((a, b) => (a.id < b.id ? -1 : 1));
      void saveClamps(next, editing ? `Updated ${entry.id}` : `Added ${entry.id}`);
    });
    cfs.appendChild(cSave);
    if (editing) {
      const cancelBtn = el("button", { type: "button", text: "Cancel" });
      cancelBtn.addEventListener("click", () => { editingClampId = null; draw(); });
      cfs.appendChild(cancelBtn);
    }
    body.appendChild(cfs);
  }

  load().catch((e) => {
    body.replaceChildren();
    say(box, "err", `Could not load the machine profile / clamp inventory:\n${e.message}`);
  });
}

// ---------------------------------------------------------------- Preferences tab

function renderPreferencesTab(container) {
  container.appendChild(el("h2", { text: "Preferences" }));
  container.appendChild(el("p", {
    class: "muted",
    text: "The defaults the planner uses — margins, feeds, tabs, and " +
      "penalties. Change a value and save; new jobs pick it up.",
  }));
  const box = msgBox();
  container.appendChild(box);
  // Sticky save bar + jump links: ~30 fields in one unbroken scroll
  // with the only Save at the very bottom meant the save was always
  // off-screen. The bar's Save clicks the real Save at the bottom
  // (same handler, same validation), so there is exactly one save
  // path; the jump links go to the section anchors below.
  const saveBar = el("div", { class: "prefs-savebar" });
  const barSave = el("button", { type: "button", class: "primary", text: "Save preferences" });
  barSave.addEventListener("click", () => {
    const bottom = body.querySelector('[data-role="save-prefs"]');
    if (bottom) bottom.click();
  });
  saveBar.appendChild(barSave);
  const jumpNav = el("nav", { class: "prefs-jump", "aria-label": "Preference sections" });
  jumpNav.appendChild(el("span", { class: "prefs-jump-label", text: "Jump to:" }));
  for (const [id, label] of [
    ["prefs-general", "General"], ["prefs-toolplan", "Toolplan"],
    ["prefs-tabs", "Tabs"], ["prefs-vcarve", "VCarve"],
    ["prefs-penalties", "Orientation penalties"],
    ["prefs-overrides", "Post-processing overrides"],
  ]) {
    const link = el("a", { href: `#${id}`, text: label });
    link.addEventListener("click", () => {
      const target = document.getElementById(id);
      if (target && "open" in target) target.open = true;
    });
    jumpNav.appendChild(link);
  }
  saveBar.appendChild(jumpNav);
  container.appendChild(saveBar);
  const body = el("div", { text: "Loading…" });
  container.appendChild(body);

  let prefs = null; // working copy, deep-cloned from GET
  const bound = []; // {get()} — each returns a setter fn applied on save

  function field(parent, { label, kind, get, set, hint, options, disabled, desc, wide, sentinel }) {
    const wrap = el("div");
    if (disabled) wrap.classList.add("field-fixed");
    let input;
    if (kind === "bool") {
      input = checkInput(get());
      input.addEventListener("change", () => set(input.checked));
    } else if (kind === "select") {
      input = el("select");
      for (const o of options) {
        // An option is a bare string (value == label) or a
        // [value, label] pair (the V3.8 post dropdown shows labels
        // and stores ids).
        const value = Array.isArray(o) ? o[0] : o;
        const label = Array.isArray(o) ? o[1] : o;
        const opt = el("option", { value, text: label });
        if (get() === value) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener("change", () => set(input.value));
    } else if (kind === "numlist") {
      input = textInput((get() || []).join(", "));
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        if (!raw) { set([]); return; }
        const vals = raw.split(",").map((s) => Number.parseFloat(s.trim()));
        if (vals.some((v) => !Number.isFinite(v) || v <= 0)) {
          throw new Error(`"${label}" must be a comma-separated list of positive numbers`);
        }
        set(vals);
      });
    } else if (kind === "int" || kind === "num") {
      input = numInput(get());
      input.addEventListener("change", () => {
        // A value the file already carries cannot be blanked away —
        // blank means "omit the key", which only makes sense for a
        // key the file does not have.
        const required = get() !== undefined && get() !== null;
        const v = parseNum(input, { integer: kind === "int", required });
        set(v);
      });
    } else if (kind === "nullable-num") {
      input = numInput(get());
      input.addEventListener("change", () => {
        const v = parseNum(input);
        set(v === undefined ? null : v);
      });
    } else { // text / nullable-text
      input = textInput(get() ?? "");
      input.addEventListener("change", () => {
        const v = input.value.trim();
        set(kind === "nullable-text" ? (v || null) : v);
      });
    }
    // Record the input so a save re-reads it even if no change event
    // fired (e.g. the user typed and clicked Save without blurring).
    if (disabled) input.disabled = true;
    if (kind === "bool") wrap.classList.add("field-bool");
    // A stored CHANGE_ME sentinel is a placeholder, not a value:
    // render the field empty with the sentinel as its placeholder.
    // An empty field always stores the sentinel back — only a typed
    // value replaces it — so the round-trip works from any state,
    // not just when the sentinel was stored at render time.
    if (sentinel && kind === "text") {
      if (get() === sentinel) {
        input.value = "";
        input.placeholder = sentinel;
      }
      input.addEventListener("change", () => {
        if (!input.value.trim()) set(sentinel);
      });
    }
    if (wide) {
      input.classList.add("field-wide");
      wrap.classList.add("field-span-all");
    }
    bound.push(() => input.dispatchEvent(new Event("change")));
    const lab = el("label", { text: label });
    if (disabled) lab.appendChild(el("span", { class: "tag-fixed", text: "(fixed in V2)" }));
    if (hint) lab.appendChild(el("span", { class: "hint", text: ` — ${hint}` }));
    wrap.appendChild(lab);
    wrap.appendChild(input);
    if (desc) wrap.appendChild(el("p", { class: "field-desc", text: desc }));
    parent.appendChild(wrap);
    return input;
  }

  // A <summary> with a one-line summary of the section's current
  // values — the line reads even while the section is closed, so
  // the first screen says what each section holds.
  function summaryWithLine(title, line) {
    const s = el("summary", { text: title });
    if (line) s.appendChild(el("span", { class: "prefs-summary-line", text: line }));
    return s;
  }

  // Every section lives behind its own disclosure, closed by
  // default — ~30 fields in one undifferentiated scroll buried the
  // sections. The jump links open the section they point at.
  // General opens by default, so the first screen is not a wall of
  // closed accordions that says nothing.
  function section(title, id, summaryLine) {
    const details = el("details", { class: "prefs-section" });
    if (id) details.id = id;
    if (id === "prefs-general") details.open = true;
    details.appendChild(summaryWithLine(title, summaryLine));
    const grid = el("div", { class: "form-grid" });
    details.appendChild(grid);
    body.appendChild(details);
    return grid;
  }

  function draw() {
    body.replaceChildren();
    bound.length = 0;
    const p = prefs;
    const tp = p.toolplan || (p.toolplan = {});
    const pens = p.orientation_penalties || (p.orientation_penalties = {});
    const tabs = tp.tabs || (tp.tabs = {});
    const vc = p.vcarve || (p.vcarve = {});
    // Z-zero reads as "top" when the home never set it (the
    // default in docs-v3/z_zero.md) — the select and the section
    // summary must show the effective value, never undefined.
    if (vc.z_zero !== "top" && vc.z_zero !== "bottom") vc.z_zero = "top";

    let grid = section("General", "prefs-general",
      `Clamp margin ${p.clamp_margin_mm} mm · min web ${p.web_min_mm} mm · ` +
      `smallest tool ${p.min_tool_mm} mm · two-sided ${p.two_sided ? "on" : "off"}`);
    field(grid, { label: "Clamp margin (mm)", kind: "num", get: () => p.clamp_margin_mm, set: (v) => { p.clamp_margin_mm = v; }, desc: "V1 default 20 mm. Clearance kept free around the sheet edge so clamps have somewhere to sit." });
    field(grid, { label: "Minimum web (mm)", kind: "num", get: () => p.web_min_mm, set: (v) => { p.web_min_mm = v; }, desc: "V1 default 5 mm. Narrowest strip of material left between two cutouts." });
    field(grid, { label: "Smallest tool (mm)", kind: "num", get: () => p.min_tool_mm, set: (v) => { p.min_tool_mm = v; }, desc: "The planner never picks an endmill smaller than this." });
    field(grid, { label: "Largest drill (mm)", kind: "num", get: () => p.max_drill_mm,
      // Blank = omit the key: the validator rejects max_drill_mm: null
      // (unlike the toolplan feed overrides, which accept null).
      set: (v) => { if (v === undefined) delete p.max_drill_mm; else p.max_drill_mm = v; },
      desc: "Blank = no cap. Holes wider than this are pocketed with an endmill instead of drilled." });
    field(grid, { label: "Registration pin diameter (mm)", kind: "num", get: () => p.pin_diameter_mm, set: (v) => { p.pin_diameter_mm = v; }, desc: "Diameter of the pins that register the sheet for two-sided work." });
    field(grid, { label: "Pin clearance (mm)", kind: "num", get: () => p.pin_clearance_mm, set: (v) => { p.pin_clearance_mm = v; }, desc: "Extra room around each registration pin." });
    field(grid, { label: "Tolerance (mm)", kind: "num", get: () => p.tol_mm, set: (v) => { p.tol_mm = v; }, desc: "How close is close enough when the pipeline compares measurements." });
    field(grid, { label: "Orientation tie-break (minutes)", kind: "num", get: () => p.orientation_tie_minutes, set: (v) => { p.orientation_tie_minutes = v; }, desc: "If two orientations finish within this many minutes, the simpler one wins." });
    field(grid, { label: "Two-sided cutting", kind: "bool", get: () => p.two_sided, set: (v) => { p.two_sided = v; }, desc: "Cut both faces of the sheet. Off in V2 — two-sided work is a separate feature." });
    field(grid, { label: "Units", kind: "text", get: () => p.units || "mm", set: () => {}, disabled: true, desc: "Every dimension in this app is in millimetres." });
    field(grid, { label: "Default material", kind: "nullable-text", get: () => p.material, set: (v) => { p.material = v; }, desc: "Sheet size, WxDxT in mm, used when a job does not name one. Blank = none." });
    field(grid, { label: "Inventory mode", kind: "text", get: () => p.inventory_mode || "advisory", set: () => {}, disabled: true, desc: "The tool inventory warns about tools you do not own; it never changes the plan." });

    // "only" — which operations to run, or all of them.
    const onlyDetails = el("details", { class: "prefs-section" });
    onlyDetails.id = "prefs-only";
    onlyDetails.appendChild(summaryWithLine("Only (blank = run all operations)",
      (p.only && p.only.length) ? `Running only: ${p.only.join(", ")}` : "Running all operations"));
    onlyDetails.appendChild(el("p", {
      class: "muted",
      text: "Tick the operations to run; leave all unticked to run everything.",
    }));
    const onlyGrid = el("div", { class: "form-grid" });
    const onlyChecks = {};
    for (const [op, what] of [["drill", "holes"], ["pocket", "shallow cutouts"], ["profile", "outer outlines"]]) {
      const input = checkInput((p.only || []).includes(op));
      onlyChecks[op] = input;
      // Checkbox beside its label on one line, not below it.
      const row = el("div", { class: "field-bool" });
      row.appendChild(input);
      const lab = el("label", { text: op });
      lab.appendChild(el("span", { class: "hint", text: ` — ${what}` }));
      row.appendChild(lab);
      onlyGrid.appendChild(row);
    }
    bound.push(() => {
      const chosen = Object.entries(onlyChecks).filter(([, i]) => i.checked).map(([op]) => op);
      p.only = chosen.length ? chosen : null;
    });
    onlyDetails.appendChild(onlyGrid);
    body.appendChild(onlyDetails);

    // stock size
    const stockDetails = el("details", { class: "prefs-section" });
    stockDetails.id = "prefs-stock";
    stockDetails.appendChild(summaryWithLine("Stock size (mm) — blank = no fixed stock",
      p.stock_size_mm ? `Fixed stock ${p.stock_size_mm.join(" × ")} mm` : "No fixed stock"));
    stockDetails.appendChild(el("p", {
      class: "muted",
      text: "All three dimensions, or none — a half-filled stock size is refused.",
    }));
    const stockGrid = el("div", { class: "form-grid" });
    const stockInputs = ["W", "D", "T"].map((axis, i) => {
      const input = numInput(p.stock_size_mm ? p.stock_size_mm[i] : undefined);
      stockGrid.appendChild(labeled(`Stock ${axis} (mm)`, input));
      return input;
    });
    bound.push(() => {
      const vals = stockInputs.map((input) => parseNum(input));
      const filled = vals.filter((v) => v !== undefined).length;
      if (filled > 0 && filled < 3) {
        throw new Error("stock size needs all three of W, D, T — or none of them");
      }
      p.stock_size_mm = filled === 3 ? vals : null;
    });
    stockDetails.appendChild(stockGrid);
    body.appendChild(stockDetails);

    // Orientation penalties, collapsed: the advanced knobs that steer
    // the orientation search. Each is extra minutes added to an
    // orientation's estimated time when it needs the thing named — a
    // higher penalty steers the planner away, 0 means no preference.
    const penDetails = el("details", { class: "prefs-advanced" });
    penDetails.id = "prefs-penalties";
    const penSet = Object.values(pens).filter((v) => typeof v === "number" && v !== 0).length;
    penDetails.appendChild(summaryWithLine("Orientation penalties (advanced)",
      penSet ? `${penSet} ${penSet === 1 ? "penalty" : "penalties"} set (non-zero)` : "All penalties zero — no preference"));
    penDetails.appendChild(el("p", {
      class: "muted",
      text: "Extra minutes added to an orientation's estimated time when it needs the thing named. " +
        "A higher penalty steers the planner away; 0 means no preference.",
    }));
    grid = el("div", { class: "form-grid" });
    penDetails.appendChild(grid);
    body.appendChild(penDetails);
    for (const [key, label, desc] of [
      ["flip", "Flipping the part", "The part must be turned over to cut this side."],
      ["hole_not_from_top", "Hole not from the top", "A hole opens on a face that is not the top."],
      ["no_plan", "No plan found", "No tool plan could be priced for this orientation."],
      ["pocket_not_from_top", "Pocket not from the top", "A pocket opens on a face that is not the top."],
      ["post_cnc_3d", "Needs 3D CNC finishing", "A sculpted surface needs 3D CNC work after the cut."],
      ["post_decision_needed", "Needs a decision first", "The planner could not decide how to finish a feature."],
      ["post_drill_press", "Needs a drill press", "A hole must be finished on the drill press."],
      ["post_hand_router", "Needs a hand router", "An edge must be finished with the hand router."],
      ["post_router_table", "Needs a router table", "An edge must be finished on the router table."],
    ]) {
      field(grid, { label, kind: "num", get: () => pens[key], set: (v) => { pens[key] = v; }, desc });
    }

    // A blank feed/plunge is "not set", never a bare unit with no
    // value ("Feed default mm/s" read as a setting that exists).
    grid = section("Toolplan", "prefs-toolplan",
      `${tp.feed_mm_s != null ? `Feed ${tp.feed_mm_s} mm/s` : "Feed not set"} · ` +
      `${tp.plunge_mm_s != null ? `plunge ${tp.plunge_mm_s} mm/s` : "plunge not set"} · ` +
      `spindle ${tp.spindle_rpm} rpm · ${tp.max_plans} plans compared`);
    field(grid, { label: "Cutting feed (mm/s)", kind: "nullable-num", get: () => tp.feed_mm_s, set: (v) => { tp.feed_mm_s = v; }, desc: "Blank = planner default. How fast the tool moves while cutting." });
    field(grid, { label: "Plunge feed (mm/s)", kind: "nullable-num", get: () => tp.plunge_mm_s, set: (v) => { tp.plunge_mm_s = v; }, desc: "Blank = planner default. How fast the tool moves down into the material." });
    field(grid, { label: "Spindle speed (rpm)", kind: "int", get: () => tp.spindle_rpm, set: (v) => { tp.spindle_rpm = v; }, desc: "Revolutions per minute while cutting." });
    field(grid, { label: "Stepdown (mm)", kind: "num", get: () => tp.stepdown_mm, set: (v) => { tp.stepdown_mm = v; }, desc: "How deep each cutting pass goes." });
    field(grid, { label: "Stepover (%)", kind: "num", get: () => tp.stepover_pct, set: (v) => { tp.stepover_pct = v; }, desc: "How far the tool moves sideways between passes, as a share of its diameter." });
    field(grid, { label: "Finish allowance (mm)", kind: "num", get: () => tp.finish_allowance_mm, set: (v) => { tp.finish_allowance_mm = v; }, desc: "Material left behind for the final finishing pass." });
    field(grid, { label: "Finish corners", kind: "bool", get: () => tp.finish_corners, set: (v) => { tp.finish_corners = v; }, desc: "Add a finishing pass around sharp internal corners." });
    field(grid, { label: "Largest corner radius (mm)", kind: "nullable-num", get: () => tp.max_corner_radius_mm, set: (v) => { tp.max_corner_radius_mm = v; }, desc: "Blank = no cap. Corners rounder than this are cut with a bigger tool." });
    field(grid, { label: "Plans to compare", kind: "int", get: () => tp.max_plans, set: (v) => { tp.max_plans = v; }, desc: "How many tool plans the planner prices up before picking the fastest." });
    field(grid, { label: "Tool change time (seconds)", kind: "num", get: () => tp.tool_change_seconds, set: (v) => { tp.tool_change_seconds = v; }, desc: "Seconds charged for each tool change when pricing a plan." });
    field(grid, { label: "Largest endmill (share of part)", kind: "num", get: () => tp.max_endmill_ratio, set: (v) => { tp.max_endmill_ratio = v; }, desc: "The biggest endmill allowed, as a fraction of the part's smallest footprint side." });
    field(grid, { label: "Largest endmill (minimum size)", kind: "num", get: () => tp.max_endmill_floor_mm, set: (v) => { tp.max_endmill_floor_mm = v; }, desc: "The size cap above never goes below this diameter." });
    field(grid, { label: "Standard endmills (inches)", kind: "numlist", get: () => tp.standard_endmills_in, set: (v) => { tp.standard_endmills_in = v; }, wide: true, desc: "Inch sizes the planner may recommend, largest first. E.g. 0.5, 0.375, 0.25." });
    field(grid, { label: "Standard endmills (mm)", kind: "numlist", get: () => tp.standard_endmills_mm, set: (v) => { tp.standard_endmills_mm = v; }, wide: true, desc: "Millimetre sizes the planner may recommend, largest first. E.g. 1.0, 0.8, 0.5." });

    grid = section("Tabs (toolpath tabs holding parts in the sheet)", "prefs-tabs",
      `${tabs.enabled ? "On" : "Off"} · ${tabs.count} tabs per part · ${tabs.length_mm} mm long · ${tabs.thickness_mm} mm thick`);
    field(grid, { label: "Holding tabs on", kind: "bool", get: () => tabs.enabled, set: (v) => { tabs.enabled = v; }, desc: "Leave small tabs of material so parts stay in the sheet while cutting." });
    field(grid, { label: "Tabs per part", kind: "int", get: () => tabs.count, set: (v) => { tabs.count = v; }, desc: "How many holding tabs each part gets." });
    field(grid, { label: "Tab length (mm)", kind: "num", get: () => tabs.length_mm, set: (v) => { tabs.length_mm = v; }, desc: "How long each holding tab is along the cut." });
    field(grid, { label: "Tab thickness (mm)", kind: "num", get: () => tabs.thickness_mm, set: (v) => { tabs.thickness_mm = v; }, desc: "How thick each holding tab is — the uncut material left behind." });

    // V3.8: the post processor is a real selection, not free text.
    // The stored value is a native post id (masso-mm, masso-inch,
    // grbl, template); a stored CHANGE_ME sentinel or a legacy
    // VCarve post name matches no option, so the select shows
    // "Not set" until a real post is chosen — never the placeholder
    // token. Saving a chosen post also sets the machine profile's
    // post processor (machine.json): the server mirrors it on PUT
    // /api/preferences, so the choice is what `mldxf gcode`
    // actually posts with. (A legacy VCarve name stored here is
    // replaced by "" on the next save — it was informational only,
    // nothing reads it as code; see docs-v3/post_config.md.)
    const pp = vc.post_processor;
    const ppKnown = NATIVE_POSTS.some((p) => p.id === pp);
    const ppText = ppKnown ? postLabel(pp) : "not set — pick a post";
    grid = section("VCarve", "prefs-vcarve",
      `Mode ${vc.gadget_mode} · Z zero ${vc.z_zero} · post processor ${ppText}`);
    field(grid, { label: "Gadget mode", kind: "select", options: ["full", "check", "dxf", "manifest"], get: () => vc.gadget_mode, set: (v) => { vc.gadget_mode = v; }, desc: "What the VCarve gadget does: build everything, check only, write the DXF, or write the manifest." });
    field(grid, { label: "Material thickness from the STEP", kind: "bool", get: () => vc.material_thickness_from_step, set: (v) => { vc.material_thickness_from_step = v; }, desc: "Take the sheet thickness from the part instead of the material setting." });
    field(grid, { label: "Post processor", kind: "select", options: [["", "Not set — pick a post"], ...NATIVE_POSTS.map((p) => [p.id, p.label])], get: () => vc.post_processor, set: (v) => { vc.post_processor = v; }, wide: true, desc: "The in-house post-processor that turns toolpaths into G-code for your controller. Choosing one also sets the machine profile's post processor (machine.json) — `mldxf gcode` uses it unless a job or --post says otherwise." });
    field(grid, { label: "Z zero", kind: "select", options: ["top", "bottom"], get: () => vc.z_zero, set: (v) => { vc.z_zero = v; }, desc: "Where zero height is: the top of the sheet or the bottom. New jobs use this unless a --config file sets vcarve.z_zero (the config file wins); a job records its own Z-zero, so changing this never moves an existing job's zero." });

    // post_method_overrides — layer name -> post method.
    const ovDetails = el("details", { class: "prefs-section" });
    ovDetails.id = "prefs-overrides";
    const ovCount = Object.keys(p.post_method_overrides || {}).length;
    ovDetails.appendChild(summaryWithLine("Post-processing method overrides (layer → method)",
      ovCount ? `${ovCount} override${ovCount === 1 ? "" : "s"}` : "No overrides"));
    ovDetails.appendChild(el("p", {
      class: "muted",
      text: "Override the post-processing method for a named layer. " +
        "Blank value rows are dropped on save.",
    }));
    const ovWrap = el("div");
    const overrides = p.post_method_overrides || {};
    const ovRows = [];
    function ovRow(key, value) {
      const row = el("div", { class: "form-grid" });
      const keyInput = textInput(key);
      const valSel = el("select");
      for (const m of ["cnc_3d", "router_table", "hand_router", "drill_press", "decision_needed"]) {
        const opt = el("option", { value: m, text: m });
        if (value === m) opt.selected = true;
        valSel.appendChild(opt);
      }
      const delBtn = el("button", { type: "button", class: "danger", text: "Remove" });
      delBtn.addEventListener("click", () => {
        const idx = ovRows.indexOf(row);
        if (idx >= 0) ovRows.splice(idx, 1);
        row.remove();
      });
      row.appendChild(labeled("Layer", keyInput));
      row.appendChild(labeled("Method", valSel));
      row.appendChild(delBtn);
      ovRows.push(row);
      return row;
    }
    for (const [k, v] of Object.entries(overrides)) ovWrap.appendChild(ovRow(k, v));
    const ovAdd = el("button", { type: "button", text: "Add override" });
    ovAdd.addEventListener("click", () => ovWrap.appendChild(ovRow("", "router_table")));
    bound.push(() => {
      const next = {};
      for (const row of ovRows) {
        const inputs = row.querySelectorAll("input");
        const sel = row.querySelector("select");
        const key = inputs[0].value.trim();
        if (key) next[key] = sel.value;
      }
      p.post_method_overrides = next;
    });
    ovDetails.appendChild(ovWrap);
    ovDetails.appendChild(ovAdd);
    body.appendChild(ovDetails);

    const saveBtn = el("button", { type: "button", class: "primary", text: "Save preferences", "data-role": "save-prefs" });
    saveBtn.addEventListener("click", async () => {
      say(box, "", "Saving…");
      try {
        for (const apply of bound) apply();
      } catch (e) {
        // A form-side problem (bad number, partial stock size) — the
        // API was never called, so nothing was refused and nothing
        // needs re-reading.
        say(box, "err", e.message);
        return;
      }
      try {
        // "units" and "inventory_mode" are displayed read-only: keep
        // whatever the server sent (the setters above are no-ops).
        const saved = await api("PUT", "/api/preferences", prefs);
        prefs = structuredClone(saved.preferences);
        say(box, "ok", "Preferences saved.");
        draw();
      } catch (e) {
        say(box, "err", `Not saved — the API refused it:\n${e.message}`);
        try { prefs = structuredClone((await api("GET", "/api/preferences")).preferences); } catch { /* keep */ }
        draw();
      }
    });
    body.appendChild(saveBtn);
    body.appendChild(el("p", {
      class: "muted",
      text: "If a value isn't valid, nothing is saved — the message " +
        "says which value to fix.",
    }));
    // About lives in the footer dialog now (see the shell, below) —
    // it is no longer stranded at the bottom of this tab.
  }

  api("GET", "/api/preferences").then((data) => {
    prefs = structuredClone(data.preferences);
    draw();
  }).catch((e) => {
    body.replaceChildren();
    say(box, "err", `Could not load preferences:\n${e.message}`);
  });
}

// ---------------------------------------------------------------- register the tabs

App.registerTab(window.MldxfJobPrep);
App.registerTab(window.MldxfJobs);
App.registerTab({ id: "tools", label: "Tools", render: renderToolsTab });
App.registerTab({ id: "clamps-machine", label: "Clamps & machine", render: renderClampsMachineTab });
App.registerTab({ id: "preferences", label: "Preferences", render: renderPreferencesTab });

// The footer's "About this app" link opens a dialog (same content
// on every tab — the footer is shell-level, not tab-level). The
// dialog carries the file/version metadata the tabs no longer show.
async function openAboutDialog() {
  const dialog = document.getElementById("about-dialog");
  const list = document.getElementById("about-versions");
  if (!dialog || !list) return;
  list.replaceChildren();
  const rows = [];
  try {
    const [t, m, c] = await Promise.all([
      api("GET", "/api/tools"), api("GET", "/api/machine"), api("GET", "/api/clamps"),
    ]);
    rows.push(["Tools", `tools.json version ${t.tools.version} — ${countText(t.tools.tools.length, "tool", "tools")} recorded.`]);
    rows.push(["Machine", `machine.json version ${m.machine.version}.`]);
    rows.push(["Clamps", `clamps.json version ${c.clamps.version} — ${countText(c.clamps.clamps.length, "clamp", "clamps")} recorded.`]);
  } catch (e) {
    rows.push(["Library versions", "Unavailable — the API did not answer."]);
  }
  for (const [term, def] of rows) {
    list.appendChild(el("dt", { text: term }));
    list.appendChild(el("dd", { text: def }));
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
document.getElementById("about-link").addEventListener("click", (ev) => {
  ev.preventDefault();
  void openAboutDialog();
});
