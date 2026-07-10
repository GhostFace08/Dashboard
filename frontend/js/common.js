/**
 * common.js — Unified MCP Dashboard
 *
 * Renders the shared header (nav tabs + theme toggle) and exposes window.Utils —
 * shared formatters, parsers, and normalizers used across all page JS files.
 *
 * ── Change 5: SPA Shell mode ──────────────────────────────────────────────────
 *
 * The app now runs as a single-page shell (index.html) that hosts each page
 * inside a persistent <iframe>.  The shell calls Utils.initHeader() once and
 * owns the header DOM.  Page iframes must NOT render a second header.
 *
 * initHeader() detects its execution context:
 *
 *   1. Shell (index.html, window === top, #frame-container present)
 *      → Renders header into shell's #header-root.
 *      → Uses shell-relative hrefs for tab links (pages/xxx.html).
 *      → Theme toggle propagates to all frames via window.Shell.propagateTheme().
 *
 *   2. Page iframe (window !== top)
 *      → Returns immediately — the shell owns the header.
 *
 *   3. Standalone page opened directly (dev / fallback — window === top,
 *      but #frame-container is absent)
 *      → Renders header into #header-root using page-relative hrefs.
 *      → Works exactly as the pre-SPA behaviour.
 *
 * LOAD ORDER (every HTML page must still follow for its own JS deps):
 *   1. config.js   → window.CFG
 *   2. api.js      → window.API
 *   3. common.js   → window.Utils   (this file)
 *   4. page JS
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[common.js] window.CFG not found — load config.js first.");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     1. THEME
  ═══════════════════════════════════════════════════════════════════════════ */

  var THEME_KEY = "mcp-theme";

  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || "dark"; }
    catch (e) { return "dark"; }
  }

  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  function toggleTheme() {
    var next = getTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);

    /* Propagate to all iframes when running in the shell */
    if (global.Shell && typeof global.Shell.propagateTheme === "function") {
      global.Shell.propagateTheme(next);
    }

    /* Swap the icon without re-rendering the whole header */
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.innerHTML = next === "dark"
        ? '<i data-lucide="sun"  style="width:14px;height:14px;display:block"></i>'
        : '<i data-lucide="moon" style="width:14px;height:14px;display:block"></i>';
      if (global.lucide) lucide.createIcons();
    }
  }

  /* Apply stored theme immediately (before first paint) to avoid flash */
  applyTheme(getTheme());

  /* ═══════════════════════════════════════════════════════════════════════════
     2. ACTIVE TAB DETECTION
  ═══════════════════════════════════════════════════════════════════════════ */

  /* Maps a pathname substring to a tab id — order matters, most-specific first */
  var PATH_TO_TAB = [
    { match: "ai_monitoring", tab: "ai-monitoring" },
    { match: "ai_chat",       tab: "ai-chat"       },
    { match: "settings",      tab: "settings"      },
    { match: "dashboard",     tab: "dashboard"     }
  ];

  function detectActiveTab() {
    var path = global.location.pathname.toLowerCase();
    for (var i = 0; i < PATH_TO_TAB.length; i++) {
      if (path.indexOf(PATH_TO_TAB[i].match) !== -1) return PATH_TO_TAB[i].tab;
    }
    return "dashboard";
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3. TAB DEFINITIONS
  ═══════════════════════════════════════════════════════════════════════════ */

  /*
   * SHELL tabs — hrefs relative to index.html (root level).
   * The shell intercepts clicks via JS and calls Shell.showTab() instead of
   * navigating, so hrefs are effectively never followed in production.
   * They are kept so that if a link is opened in a new tab it still works.
   */
  var TABS_SHELL = [
    { id: "dashboard",     label: "Dashboard",     href: "pages/dashboard.html"     },
    { id: "ai-chat",       label: "AI Chat",       href: "pages/ai_chat.html"       },
    { id: "ai-monitoring", label: "AI Monitoring", href: "pages/ai_monitoring.html" },
    { id: "settings",      label: "Settings",      href: "pages/settings.html"      }
  ];

  /*
   * STANDALONE tabs — hrefs relative to a page inside pages/ folder.
   * Used when a page is opened directly (e.g. during development).
   */
  var TABS_STANDALONE = [
    { id: "dashboard",     label: "Dashboard",     href: "dashboard.html"     },
    { id: "ai-chat",       label: "AI Chat",       href: "ai_chat.html"       },
    { id: "ai-monitoring", label: "AI Monitoring", href: "ai_monitoring.html" },
    { id: "settings",      label: "Settings",      href: "settings.html"      }
  ];

  /* ═══════════════════════════════════════════════════════════════════════════
     4. HEADER HTML BUILDER
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildHeaderHTML(activeTab, tabs) {
    var theme = getTheme();

    var tabsHTML = tabs.map(function (t) {
      var isActive = t.id === activeTab;
      var checkIcon = isActive
        ? '<i data-lucide="check" style="width:14px;height:14px;display:block;flex-shrink:0"></i>'
        : "";
      return '<a'
        + ' href="' + t.href + '"'
        + ' class="header-tab' + (isActive ? ' active' : '') + '"'
        + ' aria-current="' + (isActive ? 'page' : 'false') + '"'
        + ' data-tab="' + t.id + '"'
        + '>'
        + checkIcon
        + t.label.toUpperCase()
        + '</a>';
    }).join("");

    var themeIcon = theme === "dark" ? "sun" : "moon";

    return '<header id="app-header">'
      + '<div class="header-left">' + tabsHTML + '</div>'
      + '<div class="header-right">'
      + '<button id="theme-toggle-btn" class="header-icon-btn" title="Toggle theme" aria-label="Toggle theme">'
      + '<i data-lucide="' + themeIcon + '" style="width:14px;height:14px;display:block"></i>'
      + '</button>'
      + '<button class="header-btn header-btn-ghost">Sign In</button>'
      + '<button class="header-btn header-btn-primary">Register</button>'
      + '</div>'
      + '</header>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     5. HEADER CSS  (injected once into <head> — keeps pages clean)
  ═══════════════════════════════════════════════════════════════════════════ */

  var HEADER_CSS = [
    "#app-header{",
      "display:flex;align-items:center;gap:8px;",
      "height:48px;padding:0 16px;",
      "background:var(--sidebar);border-bottom:1px solid var(--border);",
      "flex-shrink:0;position:sticky;top:0;z-index:var(--z-header);",
    "}",
    ".header-left{display:flex;align-items:center;gap:4px;flex:1;}",
    ".header-right{display:flex;align-items:center;gap:8px;flex-shrink:0;}",
    ".header-tab{",
      "display:inline-flex;align-items:center;gap:6px;",
      "padding:6px 16px;",
      "border-radius:var(--radius-sm);border:1px solid transparent;",
      "font-family:var(--font-sans);font-size:13px;font-weight:400;",
      "color:var(--muted-foreground);text-decoration:none;white-space:nowrap;",
      "transition:color var(--transition),background var(--transition),border-color var(--transition);",
    "}",
    ".header-tab:hover{color:var(--foreground);}",
    ".header-tab.active{",
      "background:var(--card);border-color:var(--border);",
      "color:var(--foreground);font-weight:500;",
    "}",
    ".header-tab.active i,.header-tab.active svg{color:var(--primary);}",
    ".header-icon-btn{",
      "width:32px;height:32px;",
      "display:flex;align-items:center;justify-content:center;",
      "border-radius:var(--radius-sm);border:1px solid var(--border);",
      "background:none;color:var(--muted-foreground);cursor:pointer;",
      "transition:color var(--transition),background var(--transition);",
    "}",
    ".header-icon-btn:hover{color:var(--foreground);background:var(--secondary);}",
    ".header-btn{",
      "padding:6px 12px;border-radius:var(--radius-sm);",
      "font-family:var(--font-sans);font-size:12px;cursor:pointer;white-space:nowrap;",
      "transition:color var(--transition),background var(--transition),border-color var(--transition);",
    "}",
    ".header-btn-ghost{border:1px solid var(--border);background:none;color:var(--muted-foreground);}",
    ".header-btn-ghost:hover{color:var(--foreground);background:var(--secondary);}",
    ".header-btn-primary{border:1px solid rgba(99,102,241,0.4);background:rgba(99,102,241,0.1);color:var(--primary);}",
    ".header-btn-primary:hover{background:rgba(99,102,241,0.2);}"
  ].join("");

  function injectHeaderCSS() {
    if (document.getElementById("mcp-header-css")) return;
    var style = document.createElement("style");
    style.id = "mcp-header-css";
    style.textContent = HEADER_CSS;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6. INIT HEADER  (Change 5 — SPA-aware)
  ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Utils.initHeader(activeTabOverride?)
   *
   * Context-aware header initialiser.
   *
   * @param {string} [activeTabOverride]  Tab id to highlight initially.
   *   In the shell this is the DEFAULT_TAB passed by index.html.
   *   In standalone pages it is auto-detected from window.location.pathname
   *   when omitted.
   */
  function initHeader(activeTabOverride) {
    injectHeaderCSS();

    /* ── 1. Inside an iframe: shell owns the header — do nothing ── */
    if (global !== global.top) {
      /* Page iframes must NOT render a header.  Return silently. */
      return;
    }

    /* ── 2. Find #header-root ── */
    var root = document.getElementById("header-root");
    if (!root) {
      console.warn("[common.js] #header-root not found — header not injected.");
      return;
    }

    /* ── 3. Detect context: SPA shell vs standalone page ── */
    var isShell = !!document.getElementById("frame-container");
    var tabs     = isShell ? TABS_SHELL : TABS_STANDALONE;
    var activeTab = activeTabOverride || detectActiveTab();

    /* ── 4. Render ── */
    root.innerHTML = buildHeaderHTML(activeTab, tabs);

    /* ── 5. Wire theme toggle ── */
    var toggleBtn = document.getElementById("theme-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", toggleTheme);
    }

    /*
     * Tab link clicks in STANDALONE mode navigate normally via href.
     * In SHELL mode the shell's own click listener (in index.html) intercepts
     * the click before it reaches here and calls Shell.showTab() instead.
     * We do NOT add a second listener in shell mode to avoid double-firing.
     */

    /* ── 6. Refresh Lucide icons ── */
    if (global.lucide) {
      lucide.createIcons();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     7. UTILS — shared formatters, parsers, and normalizers
  ═══════════════════════════════════════════════════════════════════════════ */

  function formatFullDate(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true
    });
  }

  function formatHeaderDate(d) { return formatFullDate(d); }

  function formatDuration(start, end) {
    if (!start || isNaN(start.getTime())) return "—";
    var e = end ? end.getTime() : Date.now();
    if (isNaN(e)) return "—";
    var diff = Math.max(0, e - start.getTime());

    var days    = Math.floor(diff / 86400000); diff -= days    * 86400000;
    var hours   = Math.floor(diff / 3600000);  diff -= hours   * 3600000;
    var minutes = Math.floor(diff / 60000);    diff -= minutes * 60000;
    var seconds = Math.floor(diff / 1000);

    var parts = [];
    if (days)    parts.push(days    + " day"  + (days    > 1 ? "s" : ""));
    if (hours)   parts.push(hours   + " hr"   + (hours   > 1 ? "s" : ""));
    if (minutes) parts.push(minutes + " min"  + (minutes > 1 ? "s" : ""));
    if (seconds || !parts.length) parts.push(seconds + " sec" + (seconds !== 1 ? "s" : ""));
    return parts.join(", ");
  }

  function parseDynatraceTime(str) {
    if (!str) return null;
    var cleaned = str.replace(/\.(\d{3})\d+Z$/, ".$1Z");
    var d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseOpManagerTime(str) {
    if (!str) return null;
    var match = str.match(/^(\d{1,2})\s([A-Za-z]{3})\s(\d{4})\s(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)\sIST$/);
    if (!match) return null;
    var MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    var h = Number(match[4]);
    if (match[7] === "PM" && h < 12) h += 12;
    if (match[7] === "AM" && h === 12) h = 0;
    var d = new Date(Number(match[3]), MONTHS[match[2]], Number(match[1]), h, Number(match[5]), Number(match[6]));
    return isNaN(d.getTime()) ? null : d;
  }

  function parseSourceTime(raw, source) {
    if (raw === null || raw === undefined || raw === "") return null;
    switch (source) {
      case "dynatrace":   return parseDynatraceTime(String(raw));
      case "opmanager":   return parseOpManagerTime(String(raw));
      case "heal":
      case "appdynamics": {
        var ts = Number(raw);
        if (!isFinite(ts) || ts <= 0) return null;
        var d = new Date(ts);
        return isNaN(d.getTime()) ? null : d;
      }
      default: {
        var d2 = new Date(raw);
        if (!isNaN(d2.getTime())) return d2;
        var ts2 = Number(raw);
        if (isFinite(ts2) && ts2 > 0) { var d3 = new Date(ts2); return isNaN(d3.getTime()) ? null : d3; }
        return null;
      }
    }
  }

  function normalizeSeverity(raw, source) {
    var value = String(raw == null ? "" : raw).trim();
    var lower = value.toLowerCase();
    switch (source) {
      case "dynatrace": {
        var sev = Number(value);
        if (sev >= 4) return "Critical"; if (sev === 3) return "High";
        if (sev === 2) return "Medium";  return "Low";
      }
      case "opmanager":
        if (lower.indexOf("critical") !== -1) return "Critical";
        if (lower.indexOf("major") !== -1 || lower.indexOf("trouble") !== -1) return "High";
        if (lower.indexOf("warning") !== -1 || lower.indexOf("minor") !== -1) return "Medium";
        return "Low";
      case "heal":
        if (lower === "critical") return "Critical"; if (lower === "severe") return "High";
        if (lower === "warning" || lower === "medium") return "Medium"; return "Low";
      case "appdynamics":
        if (lower === "critical") return "Critical"; if (lower === "high") return "High";
        if (lower === "medium" || lower === "warning") return "Medium"; return "Low";
      default:
        if (lower.indexOf("critical") !== -1) return "Critical";
        if (lower.indexOf("high") !== -1 || lower.indexOf("major") !== -1 || lower.indexOf("severe") !== -1) return "High";
        if (lower.indexOf("medium") !== -1 || lower.indexOf("warning") !== -1) return "Medium";
        return "Low";
    }
  }

  function normalizeStatus(raw, source) {
    var s = String(raw == null ? "" : raw).trim().toUpperCase();
    switch (source) {
      case "dynatrace":
        return (["ACTIVE","OPEN","REFRESHED","ONGOING"].indexOf(s) !== -1) ? "Active" : "Resolved";
      case "opmanager":
        return (["CLEAR","CLEARED","RESOLVED"].indexOf(s) !== -1) ? "Resolved" : "Active";
      case "heal":
        return (["OPEN","ACTIVE","ONGOING","NEW"].indexOf(s) !== -1) ? "Active" : "Resolved";
      case "appdynamics":
        return (["OPEN","ACTIVE","ONGOING"].indexOf(s) !== -1) ? "Active" : "Resolved";
      default:
        if (["ACTIVE","OPEN","ONGOING","NEW"].indexOf(s) !== -1) return "Active";
        if (["CLEAR","CLEARED","CLOSED","RESOLVED"].indexOf(s) !== -1) return "Resolved";
        return "Resolved";
    }
  }

  function normalizeCategory(raw, categoryRules) {
    if (!raw) return "Unknown";
    var clean = raw.replace(/[_\-]/g, " ").trim();
    var lower = clean.toLowerCase();
    var cfg = global.CFG || {};
    var CATEGORIES = cfg.CATEGORIES || [];
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (lower === CATEGORIES[i].toLowerCase() || lower.indexOf(CATEGORIES[i].toLowerCase()) !== -1)
        return CATEGORIES[i];
    }
    if (Array.isArray(categoryRules)) {
      for (var j = 0; j < categoryRules.length; j++) {
        var rule = categoryRules[j];
        if (rule.keyword && lower.indexOf(rule.keyword.toLowerCase()) !== -1) return rule.category;
      }
    }
    if (/avail/.test(lower))                                              return "Availability";
    if (/perf|latenc|response|throughput/.test(lower))                    return "Performance";
    if (/cpu|memory|disk|switch|interface|server|process|probe|network|apm/.test(lower)) return "Infrastructure";
    if (/error|exception|app|application|fault|service/.test(lower))     return "Application Error";
    if (/security|auth|access|attack|cve|ssl|intrusion/.test(lower))     return "Security";
    return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  }

  function resolveField(item, fieldPath) {
    if (!fieldPath || !item) return null;
    var arrayMatch = fieldPath.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      var base = item[arrayMatch[1]];
      return Array.isArray(base) ? (base[Number(arrayMatch[2])] != null ? base[Number(arrayMatch[2])] : null) : null;
    }
    if (fieldPath in item) return item[fieldPath];
    return fieldPath.split(".").reduce(function (cur, seg) {
      if (cur == null || typeof cur !== "object") return null;
      return cur[seg] != null ? cur[seg] : null;
    }, item);
  }

  function detectSource(item) {
    if (!item || typeof item !== "object") return "unknown";
    if (item.display_id !== undefined || item["event.id"] !== undefined) return "dynatrace";
    if (item.alarmId !== undefined || item.deviceName !== undefined)     return "opmanager";
    if (item.signalName !== undefined || item.applicationName !== undefined) return "heal";
    if (item.incidentStatus !== undefined || item.detectedTimeInMillis !== undefined) return "appdynamics";
    return "unknown";
  }

  function normalizeIssue(item, source, mapping, categoryRules, index) {
    var cfg = global.CFG || {};
    var sourceMap = (mapping && mapping[source]) || (cfg.DEFAULT_MAPPING && cfg.DEFAULT_MAPPING[source]) || {};

    var rawIssueId     = resolveField(item, sourceMap.issueId)         || ("#" + index);
    var rawTitle       = resolveField(item, sourceMap.title)           || "—";
    var rawApplication = resolveField(item, sourceMap.application)     || "—";
    var rawAffectedRaw = resolveField(item, sourceMap.affectedEntities);
    var rawSeverity    = resolveField(item, sourceMap.severity);
    var rawCategory    = resolveField(item, sourceMap.category)        || "";
    var rawStatus      = resolveField(item, sourceMap.status);
    var rawStartTime   = resolveField(item, sourceMap.startTime);
    var rawEndTime     = resolveField(item, sourceMap.endTime);
    var rawDescription = resolveField(item, sourceMap.description)     || "";

    var affectedEntities = Array.isArray(rawAffectedRaw)
      ? rawAffectedRaw.join(", ")
      : String(rawAffectedRaw || rawApplication || "—");

    var severity = normalizeSeverity(rawSeverity, source);
    var category = normalizeCategory(String(rawCategory), categoryRules);
    var status   = normalizeStatus(rawStatus, source);

    var startDate = parseSourceTime(rawStartTime, source);
    var endDate   = parseSourceTime(rawEndTime, source);

    var startTime = formatFullDate(startDate);
    var endTime   = status === "Active" ? "—" : formatFullDate(endDate || startDate);
    var duration  = formatDuration(startDate, status === "Active" ? null : (endDate || startDate));
    var ts        = startDate ? startDate.getTime() : 0;
    var endTs     = endDate ? endDate.getTime() : (status === "Active" ? null : ts);

    return {
      id: rawIssueId + "-" + source + "-" + index,
      source: source,
      issueId: String(rawIssueId),
      application: String(rawApplication),
      title: String(rawTitle),
      affectedEntities: String(affectedEntities),
      severity: severity,
      category: category,
      description: String(rawDescription),
      status: status,
      startTime: startTime,
      endTime: endTime,
      duration: duration,
      ts: ts,
      endTs: endTs
    };
  }

  function normalizeAllIssues(rawData, mapping, categoryRules) {
    var groups = Array.isArray(rawData && rawData.allIssues)
      ? rawData.allIssues
      : Array.isArray(rawData) ? rawData : [];

    var rows = [];
    groups.forEach(function (group) {
      var items = Array.isArray(group) ? group : (Array.isArray(group && group.data) ? group.data : []);
      items.forEach(function (item) {
        var source = detectSource(item);
        var row    = normalizeIssue(item, source, mapping, categoryRules, rows.length);
        rows.push(Object.assign({}, row, { srNo: rows.length + 1 }));
      });
    });
    return rows;
  }

  function toDatetimeLocalValue(d) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      var ctx  = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function refreshIcons() {
    if (global.lucide) lucide.createIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     8. PUBLIC SURFACE
  ═══════════════════════════════════════════════════════════════════════════ */

  global.Utils = Object.freeze({
    /* Header */
    initHeader:   initHeader,
    toggleTheme:  toggleTheme,
    getTheme:     getTheme,
    applyTheme:   applyTheme,
    refreshIcons: refreshIcons,

    /* Formatters */
    formatFullDate:        formatFullDate,
    formatHeaderDate:      formatHeaderDate,
    formatDuration:        formatDuration,
    toDatetimeLocalValue:  toDatetimeLocalValue,
    escapeHtml:            escapeHtml,
    debounce:              debounce,

    /* Parsers */
    parseDynatraceTime: parseDynatraceTime,
    parseOpManagerTime: parseOpManagerTime,
    parseSourceTime:    parseSourceTime,

    /* Normalizers */
    normalizeSeverity:  normalizeSeverity,
    normalizeStatus:    normalizeStatus,
    normalizeCategory:  normalizeCategory,
    resolveField:       resolveField,
    detectSource:       detectSource,
    normalizeIssue:     normalizeIssue,
    normalizeAllIssues: normalizeAllIssues
  });

})(window);