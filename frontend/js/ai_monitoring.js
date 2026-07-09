/**
 * ai_monitoring.js — AI Monitoring page logic
 *
 * FIX #3: initHeader() takes no arguments — removed the "ai-monitoring" arg.
 *
 * DATA SOURCE:
 *   Direct fetch from ../../backend/data/chatstats.json (no middleware).
 *   Path is configurable via API.CHAT_STATS_PATH (set in api.js).
 *   Falls back to CFG.AI_MONITORING_DEFAULTS on any error.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 *
 * REFRESH:
 *   Polls every POLL_INTERVAL_MS (30 s) and re-renders in place.
 *   All DOM writes are targeted — no full-page re-renders.
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) {
    console.error("[ai_monitoring.js] CFG not found — did config.js load?");
    return;
  }
  if (!global.API) {
    console.error("[ai_monitoring.js] API not found — did api.js load?");
    return;
  }

  /* ─── Constants ─────────────────────────────────────────────────────────── */
  const POLL_INTERVAL_MS = 30_000; // 30 s auto-refresh

  /* ─── Helpers ────────────────────────────────────────────────────────────── */

  function el(id) {
    const node = document.getElementById(id);
    if (!node) console.warn(`[ai_monitoring] #${id} not found`);
    return node;
  }

  function fmtPct(n) {
    return `${Math.round(n || 0)}%`;
  }

  function clampPct(n) {
    return Math.min(100, Math.max(0, n || 0));
  }

  /* ─── Status helpers ─────────────────────────────────────────────────────── */

  function resolveStatusClasses(status) {
    const s = (status || "").toLowerCase();
    if (s === "healthy") {
      return { badgeClass: "healthy",  modelClass: "healthy",  iconColor: "#10b981" };
    }
    if (s === "degraded") {
      return { badgeClass: "degraded", modelClass: "degraded", iconColor: "#e5a030" };
    }
    return     { badgeClass: "offline", modelClass: "offline",  iconColor: "#e5534b" };
  }

  /* ─── Render ─────────────────────────────────────────────────────────────── */

  function render(stats) {
    const u = stats.usage     || {};
    const r = stats.resources || {};
    const m = stats.model     || {};
    const b = stats.bottom    || {};

    /* ── Usage stats ── */
    setText("stat-totalTokens",       (u.totalTokens       || 0).toLocaleString());
    setText("stat-questionsToday",    String(u.questionsToday    || 0));
    setText("stat-requestsProcessed", (u.requestsProcessed  || 0).toLocaleString());
    setText("stat-totalConversations",String(u.totalConversations|| 0));
    setText("stat-promptTokens",      (u.promptTokens       || 0).toLocaleString());
    setText("stat-completionTokens",  (u.completionTokens   || 0).toLocaleString());
    setText("stat-avgResponseMs",     `${u.avgResponseMs || 0} ms`);
    setText("stat-p95Ms",             `P95: ${u.p95Ms || 0} ms`);
    setText("stat-cacheHitRatePct",   fmtPct(u.cacheHitRatePct));

    /* ── Resource meters ── */
    setMeter("cachePct",  r.cachePct);
    setMeter("memoryPct", r.memoryPct);
    setMeter("gpuPct",    r.gpuPct);
    setMeter("cpuPct",    r.cpuPct);

    /* ── Active model card ── */
    const { badgeClass, modelClass, iconColor } = resolveStatusClasses(m.status);

    setText("model-name",     m.name     || "—");
    setText("model-endpoint", m.endpoint || "—");
    setText("model-device",   m.device   || "—");

    const statusValueEl = el("model-status-value");
    if (statusValueEl) {
      statusValueEl.textContent = m.status || "Offline";
      statusValueEl.className = `aim-model-value aim-model-status ${modelClass}`;
    }

    const statusIconEl = el("model-status-icon");
    if (statusIconEl) {
      statusIconEl.style.color = iconColor;
    }

    /* ── Header badge ── */
    const badge    = el("model-status-badge");
    const badgeTxt = el("model-status-text");
    if (badge) {
      badge.className = `status-badge ${badgeClass}`;
    }
    if (badgeTxt) {
      badgeTxt.textContent = m.status || "Offline";
    }

    /* ── Bottom infrastructure stats ── */
    setText("stat-vectorStoreDocs", (b.vectorStoreDocs || 0).toLocaleString());
    setText("stat-storageUsed",     `${(b.storageUsedGb  || 0).toFixed(1)} GB`);
    setText("stat-storageTotal",    `of ${b.storageTotalGb || 0} GB`);
    setText("stat-throughput",      `${b.throughputTokPerSec || 0} t/s`);
    setText("stat-errorRate",       fmtPct(b.errorRatePct));

    if (global.Utils && typeof global.Utils.refreshIcons === "function") {
      global.Utils.refreshIcons();
    }
  }

  function setText(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function setMeter(key, value) {
    const pct = clampPct(value);
    const fillEl  = el(`meter-${key}`);
    const labelEl = el(`meter-${key}-label`);
    if (fillEl)  fillEl.style.width = `${pct}%`;
    if (labelEl) labelEl.textContent = `${pct}%`;
  }

  /* ─── Error banner ───────────────────────────────────────────────────────── */

  function setError(message) {
    const banner = el("error-banner");
    const text   = el("error-banner-text");
    if (!banner) return;

    if (message) {
      if (text) text.textContent =
        `Falling back to default AI monitoring values: ${message}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /* ─── Data fetch ─────────────────────────────────────────────────────────── */

  async function loadStats() {
    try {
      const stats = await API.getChatStats();
      setError(null);
      render(stats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ai_monitoring] getChatStats error:", msg);
      setError(msg);
      render(CFG.AI_MONITORING_DEFAULTS || {});
    }
  }

  /* ─── Polling ────────────────────────────────────────────────────────────── */

  let _pollTimer = null;

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(loadStats, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer !== null) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  /* ─── Bootstrap ──────────────────────────────────────────────────────────── */

  document.addEventListener("DOMContentLoaded", function () {

    /* 1. Render shared header via Utils — FIX #3: no argument needed */
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }

    /* 2. Stamp lucide icons that exist in static HTML */
    if (global.lucide) {
      global.lucide.createIcons();
    }

    /* 3. Initial data load */
    loadStats();

    /* 4. Start background polling */
    startPolling();

    /* 5. Stop polling when the tab is hidden, resume when visible */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopPolling();
      } else {
        loadStats();
        startPolling();
      }
    });
  });

  /* ─── Public surface ─────────────────────────────────────────────────────── */
  global.AIM = {
    reload:       loadStats,
    startPolling: startPolling,
    stopPolling:  stopPolling,
  };

})(window);