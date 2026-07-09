/**
 * api.js — Unified MCP Dashboard
 * All backend endpoint definitions and fetch wrappers.
 * Exposes: window.API
 *
 * HOW TO CONNECT THE BACKEND:
 *   1. Change BASE_URL to your Spring Boot server (e.g. "http://localhost:8080")
 *   2. All named functions below automatically use the new base — no other edits needed.
 *
 * ENDPOINTS:
 *   GET  /api/issues                → getIssues()
 *   GET  /api/config/:filename      → getConfig(filename)
 *   PUT  /api/config/:filename      → putConfig(filename, content)
 *   POST /api/settings/save         → saveSettings(payload)   ← NEW: atomic multi-file save
 *   POST /api/chat                  → postChat(payload)       (future)
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[api.js] window.CFG not found — make sure config.js loads before api.js.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CONSTANTS — ONE PLACE TO EDIT WHEN BACKEND IS READY
  // ═══════════════════════════════════════════════════════════════════════════

  const BASE_URL = "http://localhost:8080";

  const DEFAULT_TIMEOUT_MS = 20_000;

  const CHAT_STATS_PATH = "../../backend/data/chatstats.json";

  const ENDPOINTS = {
    issues:       "/api/issues",          // GET
    config:       "/api/config",          // GET | PUT /:filename
    settingsSave: "/api/settings/save",   // POST — atomic multi-file save
    chat:         "/api/chat",            // POST (future)
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. CORE FETCH WRAPPER
  // ═══════════════════════════════════════════════════════════════════════════

  async function fetchWithFallback(url, options = {}, fallback = null) {
    const { responseType = "json", timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOpts } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...fetchOpts, signal: controller.signal });

      if (!response.ok) {
        console.warn(`[API] ${fetchOpts.method || "GET"} ${url} → HTTP ${response.status}`);
        return fallback;
      }

      if (responseType === "text") {
        const text = await response.text().catch(() => null);
        return text !== null ? text : fallback;
      }

      const data = await response.json().catch(() => null);
      return data !== null ? data : fallback;

    } catch (err) {
      if (err.name === "AbortError") {
        console.warn(`[API] ${url} timed out after ${timeoutMs}ms`);
      } else {
        console.warn(`[API] ${url} fetch error:`, err.message);
      }
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. NAMED ENDPOINT FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * getIssues()
   * GET /api/issues
   * Fallback: { allIssues: [] }
   */
  async function getIssues() {
    const url = `${BASE_URL}${ENDPOINTS.issues}`;
    const fallback = { allIssues: [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.allIssues)) {
      if (Array.isArray(data)) return { allIssues: data };
      return fallback;
    }
    return data;
  }

  /**
   * getChatStats()
   * Direct fetch from static file: backend/data/chatstats.json
   * Fallback: CFG.AI_MONITORING_DEFAULTS
   */
  async function getChatStats() {
    const cfg = global.CFG || {};
    const fallback = cfg.AI_MONITORING_DEFAULTS || {};
    const data = await fetchWithFallback(CHAT_STATS_PATH, { cache: "no-store" }, null);
    if (!data || typeof data !== "object") return fallback;
    return {
      ...fallback,
      ...data,
      usage:     { ...(fallback.usage     || {}), ...(data.usage     || {}) },
      resources: { ...(fallback.resources || {}), ...(data.resources || {}) },
      model:     { ...(fallback.model     || {}), ...(data.model     || {}) },
      bottom:    { ...(fallback.bottom    || {}), ...(data.bottom    || {}) },
    };
  }

  /**
   * getConfig(filename)
   * GET /api/config/:filename
   * Returns file content as raw text. Fallback: ""
   */
  async function getConfig(filename) {
    if (!filename) return "";
    const url = `${BASE_URL}${ENDPOINTS.config}/${encodeURIComponent(filename)}`;
    return await fetchWithFallback(url, { responseType: "text", cache: "no-store" }, "");
  }

  /**
   * putConfig(filename, content)
   * PUT /api/config/:filename
   * Writes raw text. Returns true on 2xx, false on failure.
   */
  async function putConfig(filename, content) {
    if (!filename) return false;
    const url = `${BASE_URL}${ENDPOINTS.config}/${encodeURIComponent(filename)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let ok = false;
      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: String(content),
          signal: controller.signal,
        });
        ok = response.ok;
        if (!ok) console.warn(`[API] PUT ${url} → HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
      return ok;
    } catch (err) {
      if (err.name === "AbortError") console.warn(`[API] PUT ${url} timed out`);
      else console.warn(`[API] PUT ${url} error:`, err.message);
      return false;
    }
  }

  /**
   * saveSettings(payload)
   * POST /api/settings/save
   *
   * Sends all config files in a single atomic request to DashboardMiddleware.
   * The backend writes them all or rolls back on any error.
   *
   * payload shape:
   * {
   *   "conf.ini":           "<raw text>",
   *   "mcpconf.properties": "<raw text>",
   *   "apmconf.properties": "<raw text>",
   *   "category.json":      "<json string>",
   *   "mapping.json":       "<json string>"   // optional
   * }
   *
   * Returns { ok: true } on success, { ok: false, error: "..." } on failure.
   * Falls back to individual putConfig() calls if the POST endpoint is absent
   * (404/405), enabling backward-compat with older backend builds.
   *
   * @param {Object<string,string>} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function saveSettings(payload) {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Invalid payload" };
    }

    const url = `${BASE_URL}${ENDPOINTS.settingsSave}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // If /api/settings/save not yet deployed, fall back to individual PUTs
      if (response.status === 404 || response.status === 405) {
        console.warn("[API] POST /api/settings/save not available — falling back to individual PUTs");
        return _saveSettingsFallback(payload);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[API] POST ${url} → HTTP ${response.status}`, body);
        return { ok: false, error: `HTTP ${response.status}: ${body}` };
      }

      const data = await response.json().catch(() => ({ ok: true }));
      return { ok: true, ...data };

    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        console.warn(`[API] POST ${url} timed out — falling back to individual PUTs`);
      } else {
        console.warn(`[API] POST ${url} error:`, err.message, "— falling back to individual PUTs");
      }
      // Network error — try individual PUTs as fallback
      return _saveSettingsFallback(payload);
    }
  }

  /**
   * _saveSettingsFallback(payload)
   * Internal: fires individual putConfig() for each file when the unified
   * POST /api/settings/save endpoint is not yet available.
   */
  async function _saveSettingsFallback(payload) {
    const entries = Object.entries(payload);
    const results = await Promise.all(
      entries.map(([filename, content]) => putConfig(filename, content))
    );
    const failed = entries.filter((_, i) => !results[i]).map(([f]) => f);
    if (failed.length > 0) {
      return { ok: false, error: `Failed to save: ${failed.join(", ")}` };
    }
    return { ok: true };
  }

  /**
   * postChat(payload)
   * POST /api/chat → ChatMiddleware (future)
   * Currently returns fallback reply immediately.
   */
  async function postChat(payload) {
    const cfg = global.CFG || {};
    const FALLBACK_REPLY = cfg.CHAT_FALLBACK_REPLY || "Backend unavailable.";

    // TODO: remove this early return when ChatMiddleware is connected
    return { reply: FALLBACK_REPLY };

    /* Future — uncomment when ChatMiddleware is ready:
    const url = `${BASE_URL}${ENDPOINTS.chat}`;
    const data = await fetchWithFallback(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, null);
    if (!data) return { reply: FALLBACK_REPLY };
    const reply = (typeof data.reply === "string" && data.reply.trim())
      ? data.reply
      : (typeof data.response === "string" && data.response.trim())
        ? data.response
        : FALLBACK_REPLY;
    return { reply, meta: data.meta };
    */
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. PUBLIC SURFACE
  // ═══════════════════════════════════════════════════════════════════════════

  global.API = {
    BASE_URL,
    ENDPOINTS,
    CHAT_STATS_PATH,

    fetchWithFallback,

    getIssues,
    getChatStats,
    getConfig,
    putConfig,
    saveSettings,   // NEW
    postChat,
  };

  Object.freeze(global.API);

})(window);