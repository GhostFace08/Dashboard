/**
 * common.js — Unified MCP Dashboard
 * Renders the shared header (with nav tabs + theme toggle) into every page.
 * Exposes: window.Utils — shared formatters and helpers used across all page JS files.
 *
 * LOAD ORDER (every HTML page must follow this):
 *   1. config.js
 *   2. api.js
 *   3. common.js        ← this file
 *   4. page-specific JS
 *
 * USAGE:
 *   - Call Utils.initHeader() once after DOMContentLoaded. It injects
 *     the <header> into #header-root and calls lucide.createIcons().
 *   - Active tab is detected automatically from window.location.pathname.
 *   - Theme persists in localStorage under key "mcp-theme". Default: dark.
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[common.js] window.CFG not found — load config.js first.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. THEME
  // ═══════════════════════════════════════════════════════════════════════════

  const THEME_KEY = "mcp-theme";

  function getTheme() {
    return localStorage.getItem(THEME_KEY) || "dark";
  }

  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  function toggleTheme() {
    const next = getTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    // Swap the icon in-place without re-rendering the whole header
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.innerHTML = next === "dark"
        ? '<i data-lucide="sun"   style="width:14px;height:14px;display:block"></i>'
        : '<i data-lucide="moon"  style="width:14px;height:14px;display:block"></i>';
      if (global.lucide) lucide.createIcons();
    }
  }

  // Apply stored theme immediately (before first paint) to avoid flash
  applyTheme(getTheme());

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. ACTIVE TAB DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Maps a pathname substring to a tab id.
   * Order matters — more specific first.
   */
  const PATH_TO_TAB = [
    { match: "ai_monitoring", tab: "ai-monitoring" },
    { match: "ai_chat",       tab: "ai-chat"       },
    { match: "settings",      tab: "settings"      },
    { match: "dashboard",     tab: "dashboard"     },
  ];

  function detectActiveTab() {
    const path = window.location.pathname.toLowerCase();
    for (const { match, tab } of PATH_TO_TAB) {
      if (path.includes(match)) return tab;
    }
    return "dashboard"; // default
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. HEADER HTML
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the header HTML string.
   * Tab hrefs use relative paths so the file works when served from any depth.
   */
  const TABS = [
    { id: "dashboard",     label: "Dashboard",     href: "../pages/dashboard.html"     },
    { id: "ai-chat",       label: "AI Chat",       href: "../pages/ai_chat.html"       },
    { id: "ai-monitoring", label: "AI Monitoring", href: "../pages/ai_monitoring.html" },
    { id: "settings",      label: "Settings",      href: "../pages/settings.html"      },
  ];

  function buildHeaderHTML(activeTab) {
    const theme = getTheme();

    const tabsHTML = TABS.map(({ id, label, href }) => {
      const isActive = id === activeTab;
      return `
        <a
          href="${href}"
          class="header-tab${isActive ? " active" : ""}"
          aria-current="${isActive ? "page" : "false"}"
          data-tab="${id}"
        >
          ${isActive
            ? `<i data-lucide="check" style="width:14px;height:14px;display:block;flex-shrink:0"></i>`
            : ""
          }
          ${label.toUpperCase()}
        </a>
      `;
    }).join("");

    const themeIcon = theme === "dark" ? "sun" : "moon";

    return `
      <header id="app-header">
        <div class="header-left">
          ${tabsHTML}
        </div>
        <div class="header-right">
          <button id="theme-toggle-btn" class="header-icon-btn" title="Toggle theme" aria-label="Toggle theme">
            <i data-lucide="${themeIcon}" style="width:14px;height:14px;display:block"></i>
          </button>
          <button class="header-btn header-btn-ghost">Sign In</button>
          <button class="header-btn header-btn-primary">Register</button>
        </div>
      </header>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. HEADER CSS (injected once into <head> — keeps pages clean)
  // ═══════════════════════════════════════════════════════════════════════════

  const HEADER_CSS = `
    #app-header {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 48px;
      padding: 0 16px;
      background: var(--sidebar);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: var(--z-header);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .header-tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 400;
      color: var(--muted-foreground);
      text-decoration: none;
      transition: color var(--transition), background var(--transition), border-color var(--transition);
      white-space: nowrap;
    }
    .header-tab:hover {
      color: var(--foreground);
      border-color: rgba(var(--border), 0.5);
    }
    .header-tab.active {
      background: var(--card);
      border-color: var(--border);
      color: var(--foreground);
      font-weight: 500;
    }
    .header-tab.active i,
    .header-tab.active svg {
      color: var(--primary);
    }
    .header-icon-btn {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: none;
      color: var(--muted-foreground);
      cursor: pointer;
      transition: color var(--transition), background var(--transition);
    }
    .header-icon-btn:hover {
      color: var(--foreground);
      background: var(--secondary);
    }
    .header-btn {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-family: var(--font-sans);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      transition: color var(--transition), background var(--transition), border-color var(--transition);
    }
    .header-btn-ghost {
      border: 1px solid var(--border);
      background: none;
      color: var(--muted-foreground);
    }
    .header-btn-ghost:hover {
      color: var(--foreground);
      background: var(--secondary);
    }
    .header-btn-primary {
      border: 1px solid rgba(99,102,241,0.4);
      background: rgba(99,102,241,0.1);
      color: var(--primary);
    }
    .header-btn-primary:hover {
      background: rgba(99,102,241,0.2);
    }
  `;

  function injectHeaderCSS() {
    if (document.getElementById("mcp-header-css")) return;
    const style = document.createElement("style");
    style.id = "mcp-header-css";
    style.textContent = HEADER_CSS;
    document.head.appendChild(style);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. INIT HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * initHeader()
   *
   * Call once inside DOMContentLoaded.
   * Looks for <div id="header-root"> in the page and injects the header.
   * Wires the theme toggle click handler.
   * Calls lucide.createIcons() if the Lucide CDN script is loaded.
   */
  function initHeader() {
    injectHeaderCSS();

    const root = document.getElementById("header-root");
    if (!root) {
      console.warn("[common.js] #header-root not found — header not injected.");
      return;
    }

    const activeTab = detectActiveTab();
    root.innerHTML = buildHeaderHTML(activeTab);

    // Wire theme toggle
    const toggleBtn = document.getElementById("theme-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", toggleTheme);
    }

    // Refresh Lucide icons
    if (global.lucide) {
      lucide.createIcons();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. UTILS — shared formatters and helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * formatFullDate(date)
   * Renders a Date (or null) as "DD Mon YYYY, HH:MM:SS AM/PM"
   * Used for Start Time / End Time in the issues table.
   *
   * @param {Date|null} d
   * @returns {string}
   */
  function formatFullDate(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", {
      day:    "2-digit",
      month:  "short",
      year:   "numeric",
      hour:   "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }

  /**
   * formatHeaderDate(date)
   * Same as formatFullDate — alias used in status bar timestamps.
   */
  function formatHeaderDate(d) {
    return formatFullDate(d);
  }

  /**
   * formatDuration(start, end)
   * Returns a human string like "2 hrs, 14 mins, 5 secs".
   * If end is null/undefined, uses Date.now() (running duration for Active issues).
   *
   * @param {Date|null} start
   * @param {Date|null} end  — null means "ongoing"
   * @returns {string}
   */
  function formatDuration(start, end) {
    if (!start || isNaN(start.getTime())) return "—";
    const s = start.getTime();
    const e = end ? end.getTime() : Date.now();
    if (isNaN(e)) return "—";
    let diff = Math.max(0, e - s);

    const days    = Math.floor(diff / (24 * 3600 * 1000)); diff -= days    * 24 * 3600 * 1000;
    const hours   = Math.floor(diff / (3600 * 1000));       diff -= hours   * 3600 * 1000;
    const minutes = Math.floor(diff / (60 * 1000));         diff -= minutes * 60 * 1000;
    const seconds = Math.floor(diff / 1000);

    const parts = [];
    if (days)    parts.push(`${days} day${days > 1 ? "s" : ""}`);
    if (hours)   parts.push(`${hours} hr${hours > 1 ? "s" : ""}`);
    if (minutes) parts.push(`${minutes} min${minutes > 1 ? "s" : ""}`);
    if (seconds || parts.length === 0) parts.push(`${seconds} sec${seconds !== 1 ? "s" : ""}`);

    return parts.join(", ");
  }

  /**
   * parseDynatraceTime(str)
   * Dynatrace sends ISO timestamps with 9 fractional-second digits
   * (e.g. "2026-05-08T06:00:47.972000000Z"). Truncate to 3 before parsing.
   *
   * @param {string|null|undefined} str
   * @returns {Date|null}
   */
  function parseDynatraceTime(str) {
    if (!str) return null;
    const cleaned = str.replace(/\.(\d{3})\d+Z$/, ".$1Z");
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * parseOpManagerTime(str)
   * OPManager sends timestamps like "17 Jun 2026 07:03:03 AM IST".
   * The native Date parser does not handle this format.
   *
   * @param {string|null|undefined} str
   * @returns {Date|null}
   */
  function parseOpManagerTime(str) {
    if (!str) return null;
    const match = str.match(
      /^(\d{1,2})\s([A-Za-z]{3})\s(\d{4})\s(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)\sIST$/
    );
    if (!match) return null;
    const [, day, month, year, hour, minute, second, ampm] = match;
    const MONTHS = {
      Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
      Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
    };
    let h = Number(hour);
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    const d = new Date(Number(year), MONTHS[month], Number(day), h, Number(minute), Number(second));
    return isNaN(d.getTime()) ? null : d;
  }

/**
 * parseSourceTime(raw, source)
 * Converts source-specific timestamps into JavaScript Date objects.
 *
 * Supported formats:
 *
 * Dynatrace
 *   2026-05-08T06:00:47.972000000Z
 *
 * OpManager
 *   23 Jun 2026 05:03:03 AM IST
 *
 * HEAL
 *   1782454980000
 *
 * AppDynamics
 *   1782454980000
 *
 * @param {string|number|null|undefined} raw
 * @param {string} source
 * @returns {Date|null}
 */
function parseSourceTime(raw, source) {

  if (raw === null || raw === undefined || raw === "") {
    return null;
  }

  switch (source) {

    case "dynatrace":
      return parseDynatraceTime(String(raw));

    case "opmanager":
      return parseOpManagerTime(String(raw));

    case "heal":
    case "appdynamics": {

      const ts = Number(raw);

      if (!Number.isFinite(ts) || ts <= 0) {
        return null;
      }

      const d = new Date(ts);

      return isNaN(d.getTime()) ? null : d;
    }

    default: {

      // Native Date parsing fallback
      const d = new Date(raw);

      if (!isNaN(d.getTime())) {
        return d;
      }

      // Last attempt:
      // maybe it's a numeric timestamp stored as a string.

      const ts = Number(raw);

      if (Number.isFinite(ts) && ts > 0) {

        const d2 = new Date(ts);

        return isNaN(d2.getTime())
          ? null
          : d2;
      }

      return null;
    }
  }
}

/**
 * normalizeSeverity(raw, source)
 * Maps raw APM severities to one of:
 *   Critical | High | Medium | Low
 *
 * Supported Sources:
 *   - Dynatrace
 *   - OpManager
 *   - HEAL
 *   - AppDynamics
 *
 * @param {string|number|null|undefined} raw
 * @param {string} source
 * @returns {"Critical"|"High"|"Medium"|"Low"}
 */
function normalizeSeverity(raw, source) {

  const value = String(raw ?? "").trim();
  const lower = value.toLowerCase();

  switch (source) {

    // ----------------------------------------------------
    // Dynatrace
    // event.severity : 1-5
    // ----------------------------------------------------
    case "dynatrace": {

      const sev = Number(value);

      switch (sev) {
        case 5:
        case 4:
          return "Critical";

        case 3:
          return "High";

        case 2:
          return "Medium";

        case 1:
        case 0:
        default:
          return "Low";
      }
    }

    // ----------------------------------------------------
    // OpManager
    // ----------------------------------------------------
    case "opmanager": {

      if (lower.includes("critical"))
        return "Critical";

      if (
        lower.includes("major") ||
        lower.includes("trouble")
      )
        return "High";

      if (
        lower.includes("warning") ||
        lower.includes("minor")
      )
        return "Medium";

      if (
        lower.includes("clear") ||
        lower.includes("normal")
      )
        return "Low";

      return "Medium";
    }

    // ----------------------------------------------------
    // HEAL
    // ----------------------------------------------------
    case "heal": {

      if (lower === "critical")
        return "Critical";

      if (lower === "severe")
        return "High";

      if (
        lower === "warning" ||
        lower === "medium"
      )
        return "Medium";

      if (
        lower === "info" ||
        lower === "low"
      )
        return "Low";

      return "Medium";
    }

    // ----------------------------------------------------
    // AppDynamics
    // ----------------------------------------------------
    case "appdynamics": {

      if (lower === "critical")
        return "Critical";

      if (lower === "high")
        return "High";

      if (
        lower === "medium" ||
        lower === "warning"
      )
        return "Medium";

      if (
        lower === "low" ||
        lower === "info"
      )
        return "Low";

      return "Medium";
    }

    // ----------------------------------------------------
    // Generic fallback
    // ----------------------------------------------------
    default: {

      if (lower.includes("critical"))
        return "Critical";

      if (
        lower.includes("high") ||
        lower.includes("major") ||
        lower.includes("severe")
      )
        return "High";

      if (
        lower.includes("medium") ||
        lower.includes("warning")
      )
        return "Medium";

      if (
        lower.includes("low") ||
        lower.includes("info")
      )
        return "Low";

      return "Medium";
    }
  }
}

/**
 * normalizeStatus(raw, source)
 * Maps raw monitoring tool status values to:
 *   Active | Resolved
 *
 * Supported Sources:
 *   - Dynatrace
 *   - OpManager
 *   - HEAL
 *   - AppDynamics
 *
 * @param {string|null|undefined} raw
 * @param {string} source
 * @returns {"Active"|"Resolved"}
 */
function normalizeStatus(raw, source) {

  const status = String(raw ?? "").trim().toUpperCase();

  switch (source) {

    // --------------------------------------------------
    // Dynatrace
    // --------------------------------------------------
    case "dynatrace":

      switch (status) {

        case "ACTIVE":
        case "OPEN":
        case "REFRESHED":
        case "ONGOING":
          return "Active";

        case "CLOSED":
        case "RESOLVED":
          return "Resolved";

        default:
          return "Resolved";
      }

    // --------------------------------------------------
    // OpManager
    // --------------------------------------------------
    case "opmanager":

      switch (status) {

        case "CLEAR":
        case "CLEARED":
        case "RESOLVED":
          return "Resolved";

        default:
          return "Active";
      }

    // --------------------------------------------------
    // HEAL
    // --------------------------------------------------
    case "heal":

      switch (status) {

        case "OPEN":
        case "ACTIVE":
        case "ONGOING":
        case "NEW":
          return "Active";

        case "CLOSED":
        case "RESOLVED":
          return "Resolved";

        default:
          return "Resolved";
      }

    // --------------------------------------------------
    // AppDynamics
    // --------------------------------------------------
    case "appdynamics":

      switch (status) {

        case "OPEN":
        case "ACTIVE":
        case "ONGOING":
          return "Active";

        case "CLOSED":
        case "RESOLVED":
          return "Resolved";

        default:
          return "Resolved";
      }

    // --------------------------------------------------
    // Generic fallback
    // --------------------------------------------------
    default:

      switch (status) {

        case "ACTIVE":
        case "OPEN":
        case "ONGOING":
        case "NEW":
          return "Active";

        case "CLEAR":
        case "CLEARED":
        case "CLOSED":
        case "RESOLVED":
          return "Resolved";

        default:
          return "Resolved";
      }
  }
}

  /**
   * normalizeCategory(raw, categoryRules)
   * Maps a raw category string to a canonical CATEGORY using:
   *   1. Exact match against CFG.CATEGORIES
   *   2. Rules loaded from category.json (keyword-based, first match wins)
   *   3. Heuristic keyword checks
   *   4. Title-case fallback
   *
   * @param {string|null|undefined} raw
   * @param {Array<{keyword:string, category:string}>} categoryRules  — from category.json
   * @returns {string}
   */
  function normalizeCategory(raw, categoryRules) {
    if (!raw) return "Unknown";
    const clean = raw.replace(/[_\-]/g, " ").trim();
    const lower = clean.toLowerCase();

    const cfg = global.CFG || {};
    const CATEGORIES = cfg.CATEGORIES || [];

    // 1. Exact canonical match
    const exact = CATEGORIES.find(c => c.toLowerCase() === lower || lower.includes(c.toLowerCase()));
    if (exact) return exact;

    // 2. Category rules (from category.json)
    if (Array.isArray(categoryRules)) {
      for (const rule of categoryRules) {
        if (rule.keyword && lower.includes(rule.keyword.toLowerCase())) {
          return rule.category;
        }
      }
    }

    // 3. Heuristic fallback
    if (/avail/.test(lower)) return "Availability";
    if (/perf|latenc|response|throughput/.test(lower)) return "Performance";
    if (/cpu|memory|disk|switch|interface|server|process|probe|network|apm/.test(lower)) return "Infrastructure";
    if (/error|exception|app|application|fault|service/.test(lower)) return "Application Error";
    if (/security|auth|access|attack|cve|ssl|intrusion/.test(lower)) return "Security";

    // 4. Title-case fallback
    return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  }

  /**
   * resolveField(item, fieldPath)
   * Reads a field from a raw APM item using a path from mapping.json.
   * Supports:
   *   - Simple keys:     "alarmId"                → item.alarmId
   *   - Dotted keys:     "event.name"             → item["event.name"]  (NOT nested)
   *   - Indexed arrays:  "affected_entity_names[0]" → item.affected_entity_names[0]
   *   - Null/undefined:  returns null
   *
   * NOTE: Dynatrace uses flat keys like "event.name" (the dot is part of the key
   * name, not a nested path). We first try the whole string as a flat key before
   * splitting on dots.
   *
   * @param {object} item
   * @param {string|null} fieldPath
   * @returns {*}
   */
  function resolveField(item, fieldPath) {
    if (!fieldPath || !item) return null;

    // Array index shorthand: "affected_entity_names[0]"
    const arrayMatch = fieldPath.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const base = item[arrayMatch[1]];
      return Array.isArray(base) ? base[Number(arrayMatch[2])] ?? null : null;
    }

    // Flat key first (handles Dynatrace "event.name" style)
    if (fieldPath in item) return item[fieldPath];

    // Nested path fallback (for generic future tools)
    return fieldPath.split(".").reduce((cur, seg) => {
      if (cur == null || typeof cur !== "object") return null;
      return cur[seg] ?? null;
    }, item);
  }

  /**
   * normalizeIssue(item, source, mapping, categoryRules, index)
   * Converts a raw APM item to a canonical IssueRow using the provided
   * per-source mapping (from mapping.json) and category rules (from category.json).
   *
   * Falls back to CFG.DEFAULT_MAPPING if mapping is absent for the source.
   *
   * @param {object} item            — raw APM JSON item
   * @param {string} source          — "dynatrace" | "opmanager" | etc.
   * @param {object} mapping         — full mapping object keyed by source
   * @param {Array}  categoryRules   — from category.json
   * @param {number} index           — position in array (for fallback id)
   * @returns {object}               — canonical issue row
   */
  function normalizeIssue(item, source, mapping, categoryRules, index) {
    const cfg = global.CFG || {};
    const sourceMap = (mapping && mapping[source]) || (cfg.DEFAULT_MAPPING && cfg.DEFAULT_MAPPING[source]) || {};

    const rawIssueId        = resolveField(item, sourceMap.issueId)        ?? `#${index}`;
    const rawTitle          = resolveField(item, sourceMap.title)          ?? "—";
    const rawApplication    = resolveField(item, sourceMap.application)    ?? "—";
    const rawAffectedRaw    = resolveField(item, sourceMap.affectedEntities);
    const rawSeverity       = resolveField(item, sourceMap.severity);
    const rawCategory       = resolveField(item, sourceMap.category)       ?? "";
    const rawStatus         = resolveField(item, sourceMap.status);
    const rawStartTime      = resolveField(item, sourceMap.startTime);
    const rawEndTime        = resolveField(item, sourceMap.endTime);
    const rawDescription    = resolveField(item, sourceMap.description)    ?? "";

    // Affected entities: join array or use string
    const affectedEntities = Array.isArray(rawAffectedRaw)
      ? rawAffectedRaw.join(", ")
      : String(rawAffectedRaw || rawApplication || "—");

    const severity = normalizeSeverity(rawSeverity, source);
    const category = normalizeCategory(String(rawCategory), categoryRules);
    const status   = normalizeStatus(rawStatus, source);

    const startDate = parseSourceTime(rawStartTime, source);
    const endDate   = parseSourceTime(rawEndTime, source);

    const startTime   = formatFullDate(startDate);
    const endTime     = status === "Active" ? "—" : formatFullDate(endDate ?? startDate);
    const duration    = formatDuration(startDate, status === "Active" ? null : (endDate ?? startDate));
    const ts          = startDate ? startDate.getTime() : 0;
    const endTs       = endDate ? endDate.getTime() : (status === "Active" ? null : ts);

    return {
      id:               `${rawIssueId}-${source}-${index}`,
      source,
      issueId:          String(rawIssueId),
      application:      String(rawApplication),
      title:            String(rawTitle),
      affectedEntities: String(affectedEntities),
      severity,
      category,
      description:      String(rawDescription),
      status,
      startTime,
      endTime,
      duration,
      ts,
      endTs,
    };
  }

/**
 * detectSource(item)
 * Detects the originating monitoring tool from a raw issue object.
 *
 * Supported:
 *  - Dynatrace
 *  - OpManager
 *  - HEAL
 *  - AppDynamics
 *
 * @param {object} item
 * @returns {"dynatrace"|"opmanager"|"heal"|"appdynamics"|"unknown"}
 */
function detectSource(item) {
  if (!item || typeof item !== "object") {
    return "unknown";
  }

  // -----------------------------
  // Dynatrace
  // -----------------------------
  if (
    item.display_id !== undefined ||
    item["event.id"] !== undefined ||
    item["event.name"] !== undefined ||
    item["event.category"] !== undefined
  ) {
    return "dynatrace";
  }

  // -----------------------------
  // OpManager
  // -----------------------------
  if (
    item.alarmId !== undefined ||
    item.deviceName !== undefined ||
    item.displayName !== undefined ||
    item.modTime !== undefined
  ) {
    return "opmanager";
  }

  // -----------------------------
  // HEAL
  // -----------------------------
  if (
    item.signalName !== undefined ||
    item.applicationName !== undefined ||
    item.metricCategory !== undefined ||
    item.lastEventTime !== undefined
  ) {
    return "heal";
  }

  // -----------------------------
  // AppDynamics
  // -----------------------------
  if (
    item.incidentStatus !== undefined ||
    item.affectedEntityDefinition !== undefined ||
    item.detectedTimeInMillis !== undefined
  ) {
    return "appdynamics";
  }

  return "unknown";
}

  /**
   * normalizeAllIssues(rawData, mapping, categoryRules)
   * Normalizes the full all_issues.json payload into a flat array of
   * canonical IssueRow objects, numbered sequentially (srNo).
   *
   * @param {object} rawData       — parsed all_issues.json ({ allIssues: [...] })
   * @param {object} mapping       — parsed mapping.json
   * @param {Array}  categoryRules — parsed category.json
   * @returns {Array<object>}      — flat array of canonical rows with srNo
   */
  function normalizeAllIssues(rawData, mapping, categoryRules) {
    const groups = Array.isArray(rawData?.allIssues)
      ? rawData.allIssues
      : Array.isArray(rawData)
        ? rawData
        : [];

    const rows = [];

    groups.forEach(group => {
      const items = Array.isArray(group)
        ? group
        : Array.isArray(group?.data)
          ? group.data
          : [];

      items.forEach((item, idx) => {
        const source = detectSource(item);
        const row = normalizeIssue(item, source, mapping, categoryRules, rows.length);
        rows.push({ ...row, srNo: rows.length + 1 });
      });
    });

    return rows;
  }

  /**
   * toDatetimeLocalValue(date)
   * Converts a Date to the format expected by <input type="datetime-local">:
   * "YYYY-MM-DDTHH:MM" (local time, no seconds, no timezone suffix).
   *
   * @param {Date} d
   * @returns {string}
   */
  function toDatetimeLocalValue(d) {
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * escapeHtml(str)
   * Prevents XSS when inserting user-controlled strings into innerHTML.
   *
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * debounce(fn, ms)
   * Returns a debounced version of fn that fires ms milliseconds after
   * the last call. Used for search inputs.
   *
   * @param {Function} fn
   * @param {number}   ms
   * @returns {Function}
   */
  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /**
   * refreshIcons()
   * Calls lucide.createIcons() if the Lucide CDN script is present.
   * Call this after any innerHTML update that includes data-lucide attributes.
   */
  function refreshIcons() {
    if (global.lucide) {
      lucide.createIcons();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. PUBLIC SURFACE
  // ═══════════════════════════════════════════════════════════════════════════

  global.Utils = {
    // Header
    initHeader,
    toggleTheme,
    getTheme,
    applyTheme,

    // Lucide helper
    refreshIcons,

    // Formatters
    formatFullDate,
    formatHeaderDate,
    formatDuration,
    toDatetimeLocalValue,
    escapeHtml,
    debounce,

    // Timestamp parsers
    parseDynatraceTime,
    parseOpManagerTime,
    parseSourceTime,

    // Normalizers
    normalizeSeverity,
    normalizeStatus,
    normalizeCategory,
    resolveField,
    detectSource,
    normalizeIssue,
    normalizeAllIssues,
  };

  Object.freeze(global.Utils);

})(window);