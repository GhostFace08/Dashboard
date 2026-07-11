/**
 * settings.js — Unified MCP Dashboard
 *
 * BUGS FIXED vs previous version:
 *  1. Double save listener — btn-save now wired once with direct call to saveSettings
 *  2. buildApmConf() — inputs now have data-tool-base/data-tool-ep attributes; selectors fixed
 *  3. buildCategoryJson() — reads from JS state (generalCats), not broken DOM class
 *  4. buildMcpConf() — aiKeywords variable used directly (was using broken window._aiKeywords)
 *  5. activeSegValue() — reads data-val not dataset.value (seg-btn uses data-val)
 *  6. buildConfIni() — all input IDs aligned with settings.html (log-max-size, dash-refresh, etc.)
 *  7. Toggle IDs — all toggleOn() calls match settings.html IDs exactly
 *  8. Monitoring panels — base/endpoint inputs given data-tool-base / data-tool-ep attributes
 *  9. Field Mapping section — new section: loads mapping.json, editable per-tool, saved on save
 * 10. saveSettings() — uses API.saveSettings() (single POST), falls back to putConfig() per file
 * 11. Validation — URL, numeric range, duplicate mapping field checks before save
 * 12. Loads configs from backend on init and populates form fields
 *
 * DEPENDENCIES: config.js → api.js → common.js must load first.
 */

(function (global) {
  "use strict";

  if (!global.CFG)   { console.error("[settings] CFG missing"); return; }
  if (!global.API)   { console.error("[settings] API missing"); return; }
  if (!global.Utils) { console.error("[settings] Utils missing"); return; }

  /* ═══════════════════════════════════════════════════════════════════════════
     0. NAV CONFIG
  ═══════════════════════════════════════════════════════════════════════════ */

  const NAV = [
    { id: "general",             label: "General",             icon: "settings",          desc: "Application & logging" },
    { id: "monitoring",          label: "Monitoring Services", icon: "activity",          desc: "Dynatrace, OpManager, HEAL, AppDynamics" },
    { id: "dashboard",           label: "Dashboard",           icon: "layout-dashboard",  desc: "Defaults, alerts, display" },
    { id: "issueCategorization", label: "Issue Categorization",icon: "tag",               desc: "Keyword-based categories" },
    { id: "fieldMapping",        label: "Field Mapping",       icon: "git-merge",         desc: "APM field → dashboard column mapping" },
    { id: "ai",                  label: "AI & Models",         icon: "brain",             desc: "Local LLM & intent detection" },
    { id: "rag",                 label: "Retrieval (RAG)",     icon: "database",          desc: "Vector store & documents" },
    { id: "search",              label: "Search & Ranking",    icon: "sliders-horizontal",desc: "Embeddings, hybrid, re-ranker" },
    { id: "performance",         label: "Performance",         icon: "cpu",               desc: "GPU & resources" },
    { id: "advanced",            label: "Advanced",            icon: "wrench",            desc: "Prompt templates & paths" },
  ];

  /* ═══════════════════════════════════════════════════════════════════════════
     1. STATE
  ═══════════════════════════════════════════════════════════════════════════ */

  let activeSection    = "monitoring";
  let dirty            = false;
  let activeMonitorTab = "all";
  let activeCatTab     = "all";
  let activeMapTab     = CFG.TOOLS[0]?.id || "dynatrace";

  // ── Category state ──────────────────────────────────────────────────────
  const DEFAULT_CATS = [
    { id: "ic-1", name: "Availability",      keywords: ["down", "outage", "unreachable"] },
    { id: "ic-2", name: "Performance",       keywords: ["slow", "latency", "timeout"]    },
    { id: "ic-3", name: "Infrastructure",    keywords: ["cpu", "memory", "disk", "pod"]  },
    { id: "ic-4", name: "Application Error", keywords: ["exception", "error", "5xx"]     },
    { id: "ic-5", name: "Security",          keywords: ["unauthorized", "jwt", "intrusion"] },
  ];
  function cloneCats(cats) { return cats.map(c => ({ ...c, keywords: [...c.keywords] })); }

  let generalCats = cloneCats(DEFAULT_CATS);
  const toolCats     = {};
  const toolUnlocked = {};
  CFG.TOOLS.forEach(t => {
    toolCats[t.id]     = cloneCats(DEFAULT_CATS);
    toolUnlocked[t.id] = false;
  });
  const kwInputBuffer = {};
  const kwWarnings    = {};

  // ── Field Mapping state — one object per tool matching mapping.json shape ─
  // Canonical fields that every tool must map.
  const CANONICAL_FIELDS = [
    { key: "issueId",          label: "Issue ID"          },
    { key: "title",            label: "Title"             },
    { key: "application",      label: "Application"       },
    { key: "affectedEntities", label: "Affected Entities" },
    { key: "severity",         label: "Severity"          },
    { key: "category",         label: "Category"          },
    { key: "status",           label: "Status"            },
    { key: "startTime",        label: "Start Time"        },
    { key: "endTime",          label: "End Time"          },
    { key: "description",      label: "Description"       },
  ];

  // Deep-clone default mapping from CFG so edits don't mutate the frozen config
  let currentMapping = {};
  CFG.TOOLS.forEach(t => {
    currentMapping[t.id] = { ...(CFG.DEFAULT_MAPPING[t.id] || {}) };
  });

  // ── AI keywords ─────────────────────────────────────────────────────────
  let aiKeywords = [...(CFG.SETTINGS_DEFAULTS.keywords || [])];

  /* ═══════════════════════════════════════════════════════════════════════════
     2. HELPERS
  ═══════════════════════════════════════════════════════════════════════════ */

  const $   = id => document.getElementById(id);
  const esc = Utils.escapeHtml;

  function markDirty() { dirty = true; updateFooter(); }

  function updateFooter() {
    const unsaved = $("unsaved-badge");
    const saved   = $("saved-badge");
    if (!unsaved || !saved) return;
    unsaved.classList.toggle("hidden", !dirty);
    saved.style.display = dirty ? "none" : "";
  }

  function refreshIcons() { Utils.refreshIcons(); }

  /** Read the active data-val from a segmented control */
  function activeSegValue(segId) {
    const el = $(segId);
    if (!el) return null;
    return el.querySelector(".seg-btn.active")?.dataset.val ?? null;  // FIX: was dataset.value
  }

  /** Read a toggle's on/off state */
  function toggleOn(id) {
    const el = $(id);
    return el ? el.dataset.on === "true" : false;
  }

  /** Read an input/select value with fallback */
  function val(id, fallback = "") {
    return $(id)?.value ?? fallback;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3. LEFT NAV
  ═══════════════════════════════════════════════════════════════════════════ */

  function renderNav(filter) {
    const list = $("nav-list");
    if (!list) return;
    const lower = (filter || "").toLowerCase();
    const visible = NAV.filter(n =>
      !lower || n.label.toLowerCase().includes(lower) || n.desc.toLowerCase().includes(lower)
    );
    list.innerHTML = visible.map(n => `
      <button class="snav-item${n.id === activeSection ? " active" : ""}" data-nav="${n.id}">
        <i data-lucide="${n.icon}"></i>
        <div class="min-w-0">
          <p class="snav-item-label">${esc(n.label)}</p>
          <p class="snav-item-desc">${esc(n.desc)}</p>
        </div>
      </button>
    `).join("");
    list.querySelectorAll(".snav-item").forEach(btn =>
      btn.addEventListener("click", () => switchSection(btn.dataset.nav))
    );
    refreshIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     4. SECTION SWITCHING
  ═══════════════════════════════════════════════════════════════════════════ */

  function switchSection(id) {
    activeSection = id;
    document.querySelectorAll(".settings-section").forEach(s => {
      s.classList.remove("active");
      s.classList.add("hidden");
    });
    const target = $(`sec-${id}`);
    if (target) { target.classList.remove("hidden"); target.classList.add("active"); }
    const titleEl = $("section-title");
    const nav     = NAV.find(n => n.id === id);
    if (titleEl && nav) titleEl.textContent = nav.label;
    renderNav();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     5. MONITORING SECTION
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildMonitoringSection() {
    const tabsEl   = $("monitor-tabs");
    const panelAll = $("monitor-panel-all");
    if (!tabsEl || !panelAll) return;

    const toolTabsHTML = CFG.TOOLS.map(t =>
      `<button class="tab" data-monitor-tab="${t.id}">${esc(t.name)}</button>`
    ).join("");
    tabsEl.innerHTML = `<button class="tab active" data-monitor-tab="all">All Services</button>${toolTabsHTML}`;

    const SVC = CFG.SERVICE_DEFAULTS || {};
    panelAll.innerHTML = CFG.TOOLS.map(t => {
      const def       = SVC[t.id] || {};
      const statusCls = t.status === "online" ? "connected" : t.status === "degraded" ? "warning" : "error";
      const label     = t.status === "online" ? "Connected" : t.status === "degraded" ? "Degraded" : "Error";
      return `
        <div class="monitor-summary-card" data-tool="${t.id}">
          <div class="monitor-summary-head">
            <div class="monitor-summary-left">
              <div class="monitor-tool-badge" style="background:${t.color}22;color:${t.color}">${esc(t.shortName)}</div>
              <div class="min-w-0">
                <p class="monitor-tool-name">${esc(t.name)}</p>
                <p class="monitor-tool-desc">${esc(t.description)}</p>
              </div>
            </div>
            <div class="monitor-summary-right">
              <span class="monitor-sync-label">Last Sync: ${esc(def.lastSync || "—")}</span>
              <span class="status-badge ${statusCls}"><span class="dot"></span>${label}</span>
              <div class="monitor-enable-test-row">
                <label class="monitor-inline-toggle">
                  <button class="toggle-switch on" data-on="true" data-tool-toggle="${t.id}"><span class="toggle-thumb"></span></button>
                  <span class="monitor-inline-label">Enable</span>
                </label>
                <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px">
                  <i data-lucide="plug" style="width:12px;height:12px"></i> Test
                </button>
              </div>
            </div>
          </div>
          <div class="scard-body grid-2" style="padding:16px">
            <label class="sfield">
              <span class="sfield-label">Base URL</span>
              <input type="text" class="input input-mono" data-tool-base="${t.id}" value="${esc(def.baseUrl || "")}" />
            </label>
            <label class="sfield">
              <span class="sfield-label">API Endpoint</span>
              <input type="text" class="input input-mono" data-tool-ep="${t.id}" value="${esc(def.endpoint || "")}" />
            </label>
            <label class="sfield">
              <span class="sfield-label">Request Timeout (s)</span>
              <input type="number" class="input input-mono" data-tool-timeout="${t.id}" value="30" />
            </label>
            <div class="sfield">
              <span class="sfield-label">Connection Status</span>
              <div class="flex items-center gap-2 mt-1">
                <span class="status-badge ${statusCls}"><span class="dot"></span>${label}</span>
                <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px"><i data-lucide="plug" style="width:12px;height:12px"></i> Test Connection</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Per-tool detailed panels
    const sec = $("sec-monitoring");
    CFG.TOOLS.forEach(t => {
      const def = SVC[t.id] || {};
      const existing = $(`monitor-panel-${t.id}`);
      if (existing) existing.remove();

      const panel = document.createElement("div");
      panel.id        = `monitor-panel-${t.id}`;
      panel.className = "monitor-panel";
      panel.innerHTML = `
        <div class="monitor-tool-header">
          <div class="monitor-tool-badge" style="width:32px;height:32px;background:${t.color}22;color:${t.color};font-size:11px">${esc(t.shortName)}</div>
          <div>
            <p style="font-family:var(--font-sans);font-size:14px;font-weight:600;color:var(--foreground)">${esc(t.name)}</p>
            <p style="font-family:var(--font-sans);font-size:11px;color:var(--muted-foreground)">${esc(t.description)}</p>
          </div>
        </div>

        <div class="collection-mode-wrap">
          <p class="sfield-label">Collection Mode</p>
          <div class="segmented" data-seg="mode-${t.id}">
            <button class="seg-btn active" data-val="periodic">Periodic (default)</button>
            <button class="seg-btn" data-val="live">Live</button>
          </div>
          <div class="banner banner-info">
            <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
            <span class="banner-text">Collection Mode controls how data is retrieved. It does <strong>not</strong> affect dashboard refresh interval or client-side polling.</span>
          </div>
        </div>

        <div class="scard">
          <div class="scard-head"><h3 class="scard-title">Basic Configuration</h3><p class="scard-desc">Connection parameters for this monitoring platform.</p></div>
          <div class="scard-body grid-2">
            <label class="sfield">
              <span class="sfield-label">Base URL</span>
              <input type="text" class="input input-mono" data-tool-base="${t.id}" value="${esc(def.baseUrl || "")}" />
            </label>
            <label class="sfield">
              <span class="sfield-label">API Endpoint</span>
              <input type="text" class="input input-mono" data-tool-ep="${t.id}" value="${esc(def.endpoint || "")}" />
            </label>
            <label class="sfield">
              <span class="sfield-label">Request Timeout (s)</span>
              <input type="number" class="input input-mono" data-tool-timeout="${t.id}" value="30" />
            </label>
            <div class="sfield">
              <span class="sfield-label">Connection Status</span>
              <div class="monitor-inline-status-row">
                <span class="status-badge connected"><span class="dot"></span>Connected</span>
                <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px"><i data-lucide="plug" style="width:12px;height:12px"></i> Test Connection</button>
                <label class="monitor-inline-toggle" style="margin-left:auto">
                  <button class="toggle-switch on" data-on="true" data-tool-toggle="${t.id}"><span class="toggle-thumb"></span></button>
                  <span class="monitor-inline-label">Enable</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="scard live-auth-card" id="live-auth-${t.id}" data-live-active="false">
          <div class="scard-head"><h3 class="scard-title">Live Authentication</h3><p class="scard-desc">Credentials used while Collection Mode is set to Live.</p></div>
          <div class="scard-body grid-2">
            <label class="sfield"><span class="sfield-label">Authentication Type</span>
              <select class="select"><option value="bearer" selected>Bearer Token</option><option value="basic">Basic Auth</option><option value="oauth2">OAuth 2.0</option></select>
            </label>
            <label class="sfield"><span class="sfield-label">API Key</span><input type="text" class="input input-mono" placeholder="dt0c01.XXXXXX" /></label>
            <label class="sfield"><span class="sfield-label">API Secret / Token</span><input type="password" class="input input-mono" placeholder="••••••••••••" /></label>
            <label class="sfield"><span class="sfield-label">Token Expiry (s)</span><input type="number" class="input input-mono" value="3600" /></label>
            <label class="sfield"><span class="sfield-label">Refresh Token</span><input type="text" class="input input-mono" placeholder="optional" /></label>
          </div>
        </div>
      `;
      sec.appendChild(panel);

      // Wire collection mode segmented control
      const seg = panel.querySelector(`[data-seg="mode-${t.id}"]`);
      if (seg) {
        seg.querySelectorAll(".seg-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            seg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const liveAuth = $(`live-auth-${t.id}`);
            // CHANGE 4d: toggle data-live-active instead of display show/hide
            // Card is always visible; opacity + pointer-events controlled by CSS
            if (liveAuth) {
              liveAuth.dataset.liveActive = btn.dataset.val === "live" ? "true" : "false";
            }
            markDirty();
          });
        });
      }
    });

    // Wire monitor tabs
    tabsEl.addEventListener("click", e => {
      const btn = e.target.closest("[data-monitor-tab]");
      if (!btn) return;
      activeMonitorTab = btn.dataset.monitorTab;
      tabsEl.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      panelAll.classList.toggle("active", activeMonitorTab === "all");
      CFG.TOOLS.forEach(t => {
        const p = $(`monitor-panel-${t.id}`);
        if (p) p.classList.toggle("active", activeMonitorTab === t.id);
      });
      refreshIcons();
    });

    sec.querySelectorAll(".toggle-switch").forEach(wireToggle);
    refreshIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6. ISSUE CATEGORIZATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildCatTabs() {
    const tabsEl = $("cat-tabs");
    if (!tabsEl) return;
    const toolTabsHTML = CFG.TOOLS.map(t => {
      const unlocked = toolUnlocked[t.id];
      return `<button class="tab${activeCatTab === t.id ? " active" : ""}" data-cat-tab="${t.id}">
        ${esc(t.name)}
        <i data-lucide="${unlocked ? "unlock" : "lock"}" style="width:12px;height:12px;margin-left:4px;color:${unlocked ? "#e5534b" : "var(--muted-foreground)"}"></i>
      </button>`;
    }).join("");
    tabsEl.innerHTML = `<button class="tab${activeCatTab === "all" ? " active" : ""}" data-cat-tab="all">General</button>${toolTabsHTML}`;
    tabsEl.querySelectorAll("[data-cat-tab]").forEach(btn =>
      btn.addEventListener("click", () => switchCatTab(btn.dataset.catTab))
    );
    refreshIcons();
  }

  function switchCatTab(tabId) {
    activeCatTab = tabId;
    buildCatTabs();
    updateCatCreateCard();
    renderLockBar();
    renderCatList();
  }

  function updateCatCreateCard() {
    const title = $("cat-create-title");
    const desc  = $("cat-create-desc");
    if (!title || !desc) return;
    if (activeCatTab === "all") {
      title.textContent = "Create Category";
      desc.textContent  = "Add a new general category. You can add keywords to it below.";
    } else {
      const isLocked = !toolUnlocked[activeCatTab];
      const tool     = CFG.TOOL_MAP[activeCatTab];
      title.textContent = "Create Category";
      desc.textContent  = isLocked
        ? `Locked — click "Overwrite Default" above to enable editing for ${tool?.name || activeCatTab}.`
        : `Add a category specific to ${tool?.name || activeCatTab}. You can add keywords to it below.`;
    }
  }

  function renderLockBar() {
    const bar = $("cat-lock-bar");
    if (!bar) return;
    if (activeCatTab === "all") { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const tool     = CFG.TOOL_MAP[activeCatTab] || {};
    const unlocked = toolUnlocked[activeCatTab];
    bar.innerHTML = `
      <div class="cat-lock-info">
        <div class="cat-lock-icon ${unlocked ? "unlocked" : "locked"}">
          <i data-lucide="${unlocked ? "unlock" : "lock"}" style="width:14px;height:14px"></i>
        </div>
        <div>
          <p class="cat-lock-title">${unlocked ? "Customize Mode Active" : "Locked"}</p>
          <p class="cat-lock-desc">${unlocked
            ? 'Categories below are editable. Click "Overwrite Default" again to lock.'
            : `Click "Overwrite Default" to start customizing ${esc(tool.name || activeCatTab)}'s categories.`}</p>
        </div>
      </div>
      <div class="cat-lock-btns">
        <button id="btn-overwrite" class="btn ${unlocked ? "btn-destructive" : "btn-outline-primary"}">Overwrite Default</button>
        <button id="btn-restore-cat" class="btn btn-ghost">Restore to Default</button>
      </div>
    `;
    $("btn-overwrite").addEventListener("click", () => {
      const tool = activeCatTab;
      toolUnlocked[tool] = !toolUnlocked[tool];
      if (toolUnlocked[tool]) toolCats[tool] = cloneCats(generalCats);
      markDirty();
      buildCatTabs(); renderLockBar(); renderCatList(); updateCatCreateCard();
    });
    $("btn-restore-cat").addEventListener("click", () => {
      toolCats[activeCatTab]     = cloneCats(DEFAULT_CATS);
      toolUnlocked[activeCatTab] = false;
      markDirty();
      buildCatTabs(); renderLockBar(); renderCatList(); updateCatCreateCard();
    });
    refreshIcons();
  }

  function getActiveCats() {
    return activeCatTab === "all" ? generalCats : toolCats[activeCatTab];
  }

  function isLocked() {
    return activeCatTab !== "all" && !toolUnlocked[activeCatTab];
  }

  function renderCatList() {
    const list = $("cat-list");
    if (!list) return;
    const cats   = getActiveCats();
    const locked = isLocked();

    if (!cats || cats.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:12px">No categories yet.</p>`;
      return;
    }

    list.innerHTML = cats.map(c => {
      const inputVal = kwInputBuffer[c.id] || "";
      const warning  = kwWarnings[c.id]    || "";
      return `
        <div class="cat-card${locked ? " disabled" : ""}" data-cat-id="${c.id}">
          <div class="cat-card-head">
            <h3 class="cat-card-title" data-rename-title="${c.id}">${esc(c.name)}</h3>
            <div class="cat-card-actions">
              <span class="cat-kw-count">${c.keywords.length} keywords</span>
              <button class="btn-icon btn-rename" data-cat="${c.id}" title="Rename">
                <i data-lucide="edit-3" style="width:12px;height:12px"></i>
              </button>
              <button class="btn-icon btn-delete-cat" data-cat="${c.id}" style="border-color:rgba(229,83,75,.4);background:rgba(229,83,75,.1);color:#e5534b" title="Delete">
                <i data-lucide="trash-2" style="width:12px;height:12px"></i>
              </button>
            </div>
          </div>
          <div class="cat-card-body">
            <div class="flex flex-wrap gap-1">
              ${c.keywords.length === 0
                ? `<span class="text-muted" style="font-size:11px">No keywords yet.</span>`
                : c.keywords.map(k => `
                    <span class="kw-chip">
                      ${esc(k)}
                      <button class="kw-remove btn-remove-kw" data-cat="${c.id}" data-kw="${esc(k)}" aria-label="Remove ${esc(k)}">
                        <i data-lucide="x" style="width:10px;height:10px"></i>
                      </button>
                    </span>`).join("")}
            </div>
            <div class="flex gap-2">
              <input type="text" class="input input-mono kw-input" data-cat="${c.id}" placeholder="Add keyword…" value="${esc(inputVal)}" style="max-width:240px" />
              <button class="btn btn-ghost btn-add-kw" data-cat="${c.id}" style="font-size:11px">
                <i data-lucide="plus" style="width:13px;height:13px"></i> Add
              </button>
            </div>
            ${warning ? `<div class="banner banner-warn"><i data-lucide="alert-circle" style="width:16px;height:16px;flex-shrink:0"></i><span class="banner-text">${esc(warning)}</span></div>` : ""}
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".btn-rename").forEach(btn => {
      btn.addEventListener("click", () => {
        if (isLocked()) return;
        const cat  = getActiveCats().find(c => c.id === btn.dataset.cat);
        if (!cat) return;
        const next = window.prompt("Rename category", cat.name);
        if (next && next.trim()) { cat.name = next.trim(); markDirty(); renderCatList(); }
      });
    });

    list.querySelectorAll(".btn-delete-cat").forEach(btn => {
      btn.addEventListener("click", () => {
        if (isLocked()) return;
        const cats = getActiveCats();
        const idx  = cats.findIndex(c => c.id === btn.dataset.cat);
        if (idx !== -1) { cats.splice(idx, 1); markDirty(); renderCatList(); }
      });
    });

    list.querySelectorAll(".btn-remove-kw").forEach(btn => {
      btn.addEventListener("click", () => {
        if (isLocked()) return;
        const cat = getActiveCats().find(c => c.id === btn.dataset.cat);
        if (cat) { cat.keywords = cat.keywords.filter(k => k !== btn.dataset.kw); markDirty(); renderCatList(); }
      });
    });

    list.querySelectorAll(".kw-input").forEach(input => {
      input.addEventListener("input",   e => { kwInputBuffer[input.dataset.cat] = e.target.value; });
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(input.dataset.cat); } });
    });

    list.querySelectorAll(".btn-add-kw").forEach(btn =>
      btn.addEventListener("click", () => addKeyword(btn.dataset.cat))
    );

    refreshIcons();
  }

  function addKeyword(catId) {
    if (isLocked()) return;
    const raw = (kwInputBuffer[catId] || "").trim();
    if (!raw) return;
    const cats  = getActiveCats();
    const owner = cats.find(c => c.id !== catId && c.keywords.some(k => k.toLowerCase() === raw.toLowerCase()));
    if (owner) {
      kwWarnings[catId] = `"${raw}" already belongs to "${owner.name}". Duplicate keywords cause ambiguous categorization.`;
      renderCatList(); return;
    }
    const cat = cats.find(c => c.id === catId);
    if (!cat) return;
    cat.keywords.push(raw);
    kwInputBuffer[catId] = "";
    kwWarnings[catId]    = "";
    markDirty(); renderCatList();
  }

  function addNewCategory() {
    const input = $("new-cat-name");
    if (!input || isLocked()) return;
    const name = input.value.trim();
    if (!name) return;
    // Duplicate name check
    if (getActiveCats().some(c => c.name.toLowerCase() === name.toLowerCase())) {
      alert(`Category "${name}" already exists.`); return;
    }
    getActiveCats().push({ id: `ic-${Date.now()}`, name, keywords: [] });
    input.value = "";
    markDirty(); renderCatList();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     7. FIELD MAPPING SECTION  (NEW)
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildMappingSection() {
    const tabsEl = $("map-tabs");
    if (!tabsEl) return;
    tabsEl.innerHTML = CFG.TOOLS.map(t =>
      `<button class="tab${activeMapTab === t.id ? " active" : ""}" data-map-tab="${t.id}">${esc(t.name)}</button>`
    ).join("");
    tabsEl.querySelectorAll("[data-map-tab]").forEach(btn =>
      btn.addEventListener("click", () => {
        activeMapTab = btn.dataset.mapTab;
        tabsEl.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderMappingPanel();
      })
    );
    renderMappingPanel();
  }

  function renderMappingPanel() {
    const panel = $("map-panel");
    if (!panel) return;
    const tool    = CFG.TOOL_MAP[activeMapTab] || {};
    const mapping = currentMapping[activeMapTab] || {};

    panel.innerHTML = `
      <div class="scard">
        <div class="scard-head">
          <div class="monitor-tool-badge" style="width:28px;height:28px;background:${tool.color}22;color:${tool.color};font-size:10px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:600">${esc(tool.shortName || "")}</div>
          <div>
            <h3 class="scard-title">${esc(tool.name || activeMapTab)} Field Mapping</h3>
            <p class="scard-desc">Map raw API field names from ${esc(tool.name || activeMapTab)} to the canonical dashboard columns. Use dot notation for flat keys (e.g. <code>event.name</code>) or array index syntax (e.g. <code>names[0]</code>).</p>
          </div>
        </div>
        <div class="scard-body">
          <div class="banner banner-info mb-3">
            <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
            <span class="banner-text">Leave a field blank or <code>null</code> if the tool does not provide that data. Changes are written to <code>mapping.json</code> on Save.</span>
          </div>
          <div class="grid-2">
            ${CANONICAL_FIELDS.map(f => `
              <label class="sfield">
                <span class="sfield-label">${esc(f.label)}</span>
                <span class="sfield-hint" style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)">canonical: <strong>${f.key}</strong></span>
                <input
                  type="text"
                  class="input input-mono"
                  id="map-${activeMapTab}-${f.key}"
                  data-map-tool="${activeMapTab}"
                  data-map-field="${f.key}"
                  value="${esc(mapping[f.key] ?? "")}"
                  placeholder="raw field name or null"
                />
              </label>
            `).join("")}
          </div>
          <div class="flex gap-2 mt-3">
            <button class="btn btn-ghost" id="btn-map-reset-${activeMapTab}" style="font-size:11px">
              <i data-lucide="rotate-ccw" style="width:12px;height:12px"></i> Reset to Default
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire input changes → update currentMapping state
    panel.querySelectorAll("[data-map-tool]").forEach(input => {
      input.addEventListener("input", () => {
        const toolId = input.dataset.mapTool;
        const field  = input.dataset.mapField;
        const v      = input.value.trim();
        currentMapping[toolId][field] = v === "" || v.toLowerCase() === "null" ? null : v;
        markDirty();
      });
    });

    // Reset this tool's mapping to CFG defaults
    const resetBtn = $(`btn-map-reset-${activeMapTab}`);
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const defaults = CFG.DEFAULT_MAPPING[activeMapTab] || {};
        currentMapping[activeMapTab] = { ...defaults };
        markDirty();
        renderMappingPanel();
      });
    }

    refreshIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     8. AI KEYWORDS
  ═══════════════════════════════════════════════════════════════════════════ */

  function renderAIKeywords() {
    const container = $("kw-chips");
    if (!container) return;
    container.innerHTML = aiKeywords.map(k => `
      <span class="kw-chip">
        ${esc(k)}
        <button class="kw-remove" data-kw="${esc(k)}" aria-label="Remove ${esc(k)}">
          <i data-lucide="x" style="width:10px;height:10px"></i>
        </button>
      </span>
    `).join("");
    container.querySelectorAll(".kw-remove").forEach(btn =>
      btn.addEventListener("click", () => {
        aiKeywords = aiKeywords.filter(k => k !== btn.dataset.kw);
        markDirty(); renderAIKeywords();
      })
    );
    refreshIcons();
  }

  function addAIKeyword() {
    const input = $("new-kw");
    if (!input) return;
    const v = input.value.trim();
    if (!v || aiKeywords.includes(v)) return;
    aiKeywords.push(v);
    input.value = "";
    markDirty(); renderAIKeywords();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     9. POPULATE DASHBOARD TOOL SELECT
  ═══════════════════════════════════════════════════════════════════════════ */

  function populateDashboardToolSelect() {
    const sel = $("matrix-default-tool");
    if (!sel) return;
    CFG.TOOLS.forEach(t => {
      const opt = document.createElement("option");
      opt.value       = t.id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     10. GENERIC TOGGLE / SEGMENTED
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireToggle(btn) {
    btn.addEventListener("click", () => {
      const on = btn.dataset.on !== "true";
      btn.dataset.on = String(on);
      btn.classList.toggle("on", on);
      markDirty();
    });
  }

  function wireSegmented(el) {
    if (!el) return;
    el.querySelectorAll(".seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        markDirty();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     11. RANGE LABELS
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireRange(inputId, labelId) {
    const input = $(inputId);
    const label = $(labelId);
    if (!input || !label) return;
    input.addEventListener("input", () => {
      const prefix = label.textContent.split(":")[0];
      label.textContent = `${prefix}: ${parseFloat(input.value).toFixed(2)}`;
      markDirty();
    });
  }

  function updateWeightTotal() {
    const bm25    = parseFloat($("bm25-weight")?.value || 0);
    const sem     = parseFloat($("sem-weight")?.value  || 0);
    const totalEl = $("weight-total");
    if (totalEl) totalEl.textContent = (bm25 + sem).toFixed(2);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     12. BUILD CONFIG PAYLOADS
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildConfIni() {
    // FIX: all IDs now match settings.html exactly
    return [
      "# conf.ini — MCP Dashboard General Configuration",
      "# Auto-saved by Settings UI",
      "",
      "[logging]",
      `log_level      = ${val("log-level",    "INFO")}`,
      `log_file       = ${val("log-file",      "logs/agent.log")}`,
      `log_max_size   = ${val("log-max-size",  "10485760")}`,  // FIX: was log-size
      `log_backups    = ${val("log-backups",   "5")}`,
      "",
      "[dashboard]",
      `periodic_fetch_time = ${val("dash-fetch-time",  "15 min")}`,  // FIX: was periodic-fetch-time
      `periodic_check_time = ${val("dash-check-time",  "30")}`,      // FIX: was periodic-check-time
      `ui_refresh_interval = ${val("dash-refresh",     "1")}`,       // FIX: was ui-refresh-interval
      `landing_view        = ${val("dash-landing",     "dashboard")}`,// FIX: was landing-view
      `default_sort        = ${val("dash-sort",        "startTime-desc")}`, // FIX: was default-sort
      `show_acknowledged   = ${toggleOn("toggle-ack")}`,             // FIX: was toggle-acknowledged
      `show_resolved       = ${toggleOn("toggle-resolved")}`,
      `compact_mode        = ${toggleOn("toggle-compact")}`,
      `density             = ${activeSegValue("seg-density") ?? "comfortable"}`,
      `theme               = ${activeSegValue("seg-theme")   ?? "dark"}`,
      "",
      "[notifications]",
      `notif_desktop       = ${toggleOn("toggle-notif-desktop")}`,   // FIX: was toggle-desktop
      `notif_sound         = ${toggleOn("toggle-notif-sound")}`,     // FIX: was toggle-sound
      `notif_critical_only = ${toggleOn("toggle-notif-critical")}`,  // FIX: was toggle-critical-only
    ].join("\n");
  }

  function buildMcpConf() {
    // FIX: aiKeywords is the local module variable — no longer reads broken window._aiKeywords
    return [
      "# mcpconf.properties — MCP AI & RAG Configuration",
      "# Auto-saved by Settings UI",
      "",
      "# AI / LLM",
      `llm.url              = ${val("llm-url",         "http://localhost:11434")}`,
      `llm.model            = ${val("llm-model",       "qwen2.5")}`,
      `llm.temperature      = ${val("llm-temp",        "0.2")}`,
      `llm.max_tokens       = ${val("llm-max-tokens",  "2048")}`,
      `llm.intent_mode      = ${activeSegValue("seg-intent") ?? "hybrid"}`,
      `llm.confidence       = ${val("llm-confidence",  "0.7")}`,
      `llm.timeout          = ${val("llm-timeout",     "15")}`,
      `llm.rag_keywords     = ${aiKeywords.join(",") || "SOP,incident,runbook"}`,  // FIX
      "",
      "# RAG Server",
      `rag.base_url         = ${val("rag-base-url",    "http://localhost:8000")}`,
      `rag.data_endpoint    = ${val("rag-data-ep",     "/data")}`,
      `rag.ask_endpoint     = ${val("rag-ask-ep",      "/ask")}`,
      `rag.metadata_file    = ${val("rag-meta",        "metadata.json")}`,
      `rag.timeout          = ${val("rag-timeout",     "30")}`,
      "",
      "# File Storage",
      `rag.upload_folder    = ${val("rag-upload-folder",    "storage/uploads")}`,
      `rag.vector_store     = ${val("rag-vector-store",     "storage/vectors")}`,
      `rag.bm25_store       = ${val("rag-bm25-store",       "storage/bm25")}`,
      "",
      "# Config Paths",
      `rag.instructions_file = ${val("rag-instructions-file", "config/instructions.md")}`,
      `rag.faq_file          = ${val("rag-faq-file",          "config/faq.json")}`,
      `rag.settings_file     = ${val("rag-settings-file",     "config/settings.yaml")}`,
      "",
      "# Search & Ranking",
      `search.embed_model    = ${val("embed-model",    "bge-small-en-v1.5")}`,
      `search.chunk_size     = ${val("chunk-size",     "512")}`,
      `search.chunk_overlap  = ${val("chunk-overlap",  "64")}`,
      `search.top_k          = ${val("top-k",          "8")}`,
      `search.bm25_weight    = ${val("bm25-weight",    "0.4")}`,
      `search.sem_weight     = ${val("sem-weight",     "0.6")}`,
      `search.rerank_enabled = ${toggleOn("toggle-rerank")}`,
      `search.rerank_model   = ${val("rerank-model",   "bge-reranker-base")}`,
      `search.top_n          = ${val("top-n",          "3")}`,
      "",
      "# Cache",
      `cache.enabled         = ${toggleOn("toggle-cache")}`,
      `cache.sim_threshold   = ${val("sim-threshold",  "0.92")}`,
      `cache.size            = ${val("cache-size",     "1024")}`,
      `cache.ttl             = ${val("cache-ttl",      "3600")}`,
      "",
      "# Performance",
      `perf.gpu_threshold    = ${val("gpu-threshold",  "85")}`,
    ].join("\n");
  }

  function buildApmConf() {
    // FIX: reads from data-tool-base / data-tool-ep attributes set in buildMonitoringSection()
    const lines = [
      "# apmconf.properties — APM Tool Connection Configuration",
      "# Auto-saved by Settings UI",
      "",
    ];
    CFG.TOOLS.forEach(t => {
      const id      = t.id;
      // Per-tool panel inputs carry data-tool-base / data-tool-ep attributes
      const baseEl  = document.querySelector(`[data-tool-base="${id}"]`);
      const epEl    = document.querySelector(`[data-tool-ep="${id}"]`);
      const togEl   = document.querySelector(`[data-tool-toggle="${id}"]`);
      const timeEl  = document.querySelector(`[data-tool-timeout="${id}"]`);
      const enabled = togEl ? togEl.dataset.on !== "false" : true;
      const base    = baseEl?.value ?? (CFG.SERVICE_DEFAULTS[id]?.baseUrl  ?? "");
      const ep      = epEl?.value   ?? (CFG.SERVICE_DEFAULTS[id]?.endpoint ?? "");
      const timeout = timeEl?.value ?? "30";
      lines.push(`# ── ${t.name} ─────────────────────────────────────────────────────────────────`);
      lines.push(`${id}.enabled    = ${enabled}`);
      lines.push(`${id}.base_url   = ${base}`);
      lines.push(`${id}.endpoint   = ${ep}`);
      lines.push(`${id}.timeout    = ${timeout}`);
      lines.push(`${id}.collection = file`);
      lines.push(`${id}.data_file  = backend/data/all_issues.json`);
      lines.push("");
    });
    return lines.join("\n");
  }

  function buildCategoryJson() {
    // FIX: reads from JS state (generalCats) — not from broken DOM class .cat-name-text
    const rules = [];
    generalCats.forEach(cat => {
      cat.keywords.forEach(kw => {
        rules.push({ keyword: kw, category: cat.name });
      });
    });
    return JSON.stringify(rules, null, 2);
  }

  function buildMappingJson() {
    // Serialize currentMapping (JS state updated as user edits inputs)
    const out = {};
    CFG.TOOLS.forEach(t => {
      out[t.id] = { ...currentMapping[t.id] };
    });
    return JSON.stringify(out, null, 2);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     13. VALIDATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function validate() {
    const errors = [];

    // URL validation
    const urlFields = [
      { id: "llm-url",      label: "LLM Base URL"  },
      { id: "rag-base-url", label: "RAG Base URL"  },
    ];
    urlFields.forEach(({ id, label }) => {
      const v = val(id, "").trim();
      if (v && !v.match(/^https?:\/\/.+/)) {
        errors.push(`${label}: must start with http:// or https://`);
      }
    });

    // Numeric range checks
    const numFields = [
      { id: "llm-max-tokens", label: "Max Tokens",    min: 1,   max: 32768 },
      { id: "llm-timeout",    label: "LLM Timeout",   min: 1,   max: 300   },
      { id: "rag-timeout",    label: "RAG Timeout",   min: 1,   max: 300   },
      { id: "top-k",          label: "Top K",         min: 1,   max: 100   },
      { id: "top-n",          label: "Top N",         min: 1,   max: 50    },
      { id: "log-max-size",   label: "Max Log Size",  min: 1024,max: Infinity },
      { id: "log-backups",    label: "Log Backups",   min: 0,   max: 100   },
    ];
    numFields.forEach(({ id, label, min, max }) => {
      const v = parseFloat(val(id, ""));
      if (isNaN(v) || v < min || v > max) {
        errors.push(`${label}: value must be between ${min} and ${max}`);
      }
    });

    // Duplicate mapping field check per tool
    CFG.TOOLS.forEach(t => {
      const map    = currentMapping[t.id] || {};
      const seen   = {};
      const dups   = [];
      Object.entries(map).forEach(([canonical, rawField]) => {
        if (!rawField || rawField === "null") return;
        if (seen[rawField]) dups.push(`"${rawField}" mapped to both "${seen[rawField]}" and "${canonical}"`);
        else seen[rawField] = canonical;
      });
      if (dups.length > 0) {
        errors.push(`${CFG.TOOL_MAP[t.id]?.name || t.id} mapping: ${dups.join("; ")}`);
      }
    });

    return errors;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     14. SAVE
  ═══════════════════════════════════════════════════════════════════════════ */

  async function saveSettings() {
    // Validate before writing
    const errors = validate();
    if (errors.length > 0) {
      alert("Cannot save — please fix the following:\n\n• " + errors.join("\n• "));
      return;
    }

    const btn = $("btn-save");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" style="width:14px;height:14px;animation:spin 1s linear infinite"></i> Saving…'; refreshIcons(); }

    const payload = {
      "conf.ini":           buildConfIni(),
      "mcpconf.properties": buildMcpConf(),
      "apmconf.properties": buildApmConf(),
      "category.json":      buildCategoryJson(),
      "mapping.json":       buildMappingJson(),
    };

    // API.saveSettings() tries POST /api/settings/save first,
    // falls back to individual putConfig() calls automatically.
    const result = await API.saveSettings(payload);

    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = result.ok
        ? '<i data-lucide="save" style="width:14px;height:14px"></i> Save Changes'
        : '<i data-lucide="alert-circle" style="width:14px;height:14px"></i> Save Failed';
      refreshIcons();
    }

    if (result.ok) {
      dirty = false;
      updateFooter();
      console.info("[settings] All config files saved.");
    } else {
      console.warn("[settings] Save failed:", result.error);
      alert(`Save failed: ${result.error || "unknown error"}`);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     15. LOAD CONFIGS FROM BACKEND ON INIT
  ═══════════════════════════════════════════════════════════════════════════ */

  async function loadConfigs() {
    // Try to load mapping.json and populate currentMapping
    const mappingText = await API.getConfig("mapping.json");
    if (mappingText) {
      try {
        const loaded = JSON.parse(mappingText);
        CFG.TOOLS.forEach(t => {
          if (loaded[t.id] && typeof loaded[t.id] === "object") {
            currentMapping[t.id] = { ...loaded[t.id] };
          }
        });
      } catch (e) {
        console.warn("[settings] Could not parse mapping.json:", e);
      }
    }

    // Try to load category.json and populate generalCats
    const catText = await API.getConfig("category.json");
    if (catText) {
      try {
        const rules = JSON.parse(catText);
        if (Array.isArray(rules) && rules.length > 0) {
          // Reconstruct generalCats from flat keyword rules
          const catMap = {};
          rules.forEach(r => {
            if (!r.keyword || !r.category) return;
            if (!catMap[r.category]) catMap[r.category] = [];
            catMap[r.category].push(r.keyword);
          });
          generalCats = Object.entries(catMap).map(([name, keywords], i) => ({
            id: `ic-loaded-${i}`,
            name,
            keywords,
          }));
        }
      } catch (e) {
        console.warn("[settings] Could not parse category.json:", e);
      }
    }

    // After loading, re-render dependent panels
    renderCatList();
    renderMappingPanel();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     16. EVENT WIRING
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireEvents() {
    // Nav search
    const navSearch = $("nav-search");
    if (navSearch) navSearch.addEventListener("input", Utils.debounce(e => renderNav(e.target.value), 200));

    // Static toggle switches in HTML
    document.querySelectorAll(".toggle-switch").forEach(wireToggle);

    // Static segmented controls
    ["seg-density", "seg-theme", "seg-intent"].forEach(id => wireSegmented($(id)));

    // Severity toggle buttons
    const sevToggles = $("sev-toggles");
    if (sevToggles) {
      sevToggles.querySelectorAll(".sev-btn").forEach(btn =>
        btn.addEventListener("click", () => { btn.classList.toggle("active"); markDirty(); })
      );
    }

    // Range sliders
    wireRange("llm-temp",       "temp-label");
    wireRange("llm-confidence", "conf-label");
    wireRange("bm25-weight",    "bm25-label");
    wireRange("sem-weight",     "sem-label");
    wireRange("sim-threshold",  "sim-label");

    // GPU threshold
    const gpuThresh = $("gpu-threshold");
    const gpuLabel  = $("gpu-thresh-label");
    const gpuDisp   = $("gpu-thresh-display");
    if (gpuThresh) {
      gpuThresh.addEventListener("input", () => {
        const v = gpuThresh.value;
        if (gpuLabel) gpuLabel.textContent = `GPU Memory Threshold (%): ${v}`;
        if (gpuDisp)  gpuDisp.textContent  = `Threshold ${v}%`;
        markDirty();
      });
    }

    // Weight totals
    ["bm25-weight", "sem-weight"].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener("input", updateWeightTotal);
    });

    // Re-ranking toggle
    const rerankToggle = $("toggle-rerank");
    const rerankFields = $("rerank-fields");
    if (rerankToggle && rerankFields) {
      rerankToggle.addEventListener("click", () => {
        rerankFields.style.display = rerankToggle.dataset.on === "true" ? "none" : "";
      });
    }

    // Cache toggle
    const cacheToggle = $("toggle-cache");
    const cacheFields = $("cache-fields");
    if (cacheToggle && cacheFields) {
      cacheToggle.addEventListener("click", () => {
        cacheFields.style.display = cacheToggle.dataset.on === "true" ? "none" : "";
      });
    }

    // AI keywords
    const addKwBtn = $("btn-add-kw");
    const newKw    = $("new-kw");
    if (addKwBtn) addKwBtn.addEventListener("click", addAIKeyword);
    if (newKw)    newKw.addEventListener("keydown",  e => { if (e.key === "Enter") { e.preventDefault(); addAIKeyword(); } });

    // Category new entry
    const addCatBtn   = $("btn-add-cat");
    const newCatInput = $("new-cat-name");
    if (addCatBtn)   addCatBtn.addEventListener("click",   addNewCategory);
    if (newCatInput) newCatInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addNewCategory(); } });

    // Footer buttons
    // FIX: was $(btn-save).addEventListener("click", () => { $(btn-save).addEventListener(…) })
    $("btn-save")?.addEventListener("click", saveSettings);
    $("btn-cancel")?.addEventListener("click", () => { dirty = false; updateFooter(); });
    $("btn-reset")?.addEventListener("click",  () => { dirty = false; updateFooter(); });

    // Any input/select change marks dirty
    document.querySelectorAll("#settings-body input, #settings-body select, #settings-body textarea").forEach(el =>
      el.addEventListener("change", markDirty)
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     17. BOOTSTRAP
  ═══════════════════════════════════════════════════════════════════════════ */

  document.addEventListener("DOMContentLoaded", () => {
    Utils.initHeader();

    if (global.lucide) global.lucide.createIcons();

    renderNav();
    buildMonitoringSection();
    populateDashboardToolSelect();
    buildCatTabs();
    updateCatCreateCard();
    renderLockBar();
    renderCatList();
    buildMappingSection();
    renderAIKeywords();
    wireEvents();
    switchSection(activeSection);
    updateFooter();
    refreshIcons();

    // Load live configs from backend (non-blocking)
    loadConfigs().catch(e => console.warn("[settings] loadConfigs failed:", e));
  });

  // Public debug surface
  global.SET = {
    switchSection,
    getState: () => ({ activeSection, dirty, activeCatTab, activeMapTab }),
    getCurrentMapping: () => currentMapping,
  };

})(window);