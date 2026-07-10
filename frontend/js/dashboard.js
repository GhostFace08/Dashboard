/**
 * dashboard.js — Unified MCP Dashboard
 * Depends on: config.js (window.CFG), api.js (window.API), common.js (window.Utils)
 *
 * Changes applied:
 *   Change 1 — Dynamic KPI cards (from payload, no 0-count) + click → popup modal
 *   Change 2 — DataTables for the issues log table
 *   Change 3 — Graph section commented out
 *   Change 4 — Refresh button preserves timer/filters; corrected timestamp semantics
 */

(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", async () => {
    Utils.initHeader();

    // ─── State ───────────────────────────────────────────────────────────────
    const state = {
      allIssues:      [],   // normalised, flat IssueRow[]
      mapping:        {},
      categoryRules:  [],

      // Derived from payload — drives KPI cards (Change 1)
      availableCategories: [],

      activeTool:     "all",
      timeRange:      "15 min",
      customStart:    "",
      customEnd:      "",

      statusFilter:   null,
      categoryFilters:[],

      globalKeyword:  "",
      tableSearch:    "",

      uiRefreshMin:   1,
      countdown:      60,

      // Timestamps (Change 4)
      fileModifiedAt: null,   // last-modified from file on disk (from HEAD or fetch)
      dataUpdatedAt:  null,   // when dashboard last ingested NEW data
      lastCheckedAt:  null,   // last time a check was attempted

      // DataTables instances (Change 2)
      dtInstance:     null,
      kpiDtInstance:  null,

      // Matrix
      matrixOffset:   0,
      MATRIX_VISIBLE: 6,

      // Sections
      sections: { issueDetails: true, kpis: true },

      // Modal
      detailRow:  null,
      copiedId:   null,

      // Guard against overlapping fetches (Change 4)
      isFetching: false,
    };

    const MAX_RANGE_MS     = CFG.MAX_RANGE_MS;
    const DEFAULT_RANGE_MS = CFG.DEFAULT_RANGE_MS;
    const TIME_RANGE_MS    = CFG.TIME_RANGE_MS;

    // ─── DOM refs ─────────────────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const errorBanner     = $("error-banner");
    const errorMsg        = $("error-msg");
    const statusLeft      = $("status-left");
    const statusRight     = $("status-right");
    const filterBar       = $("filter-bar");
    const filterTags      = $("filter-tags");
    const globalSearch    = $("global-search");
    const customStart     = $("custom-start");
    const customEnd       = $("custom-end");
    const timeRangeSelect = $("time-range-select");
    const uiRefreshInput  = $("ui-refresh-input");
    const toolBtns        = $("tool-btns");
    const statusCards     = $("status-cards");
    const kpiCards        = $("kpi-cards");
    const matrixTable     = $("matrix-table");
    const matrixLeft      = $("matrix-left");
    const matrixRight     = $("matrix-right");
    const detailModal     = $("detail-modal");
    const modalTitle      = $("modal-title");
    const modalFields     = $("modal-fields");
    const modalClose      = $("modal-close");
    const exportMenu      = $("export-menu");
    const customRangeInfo = $("custom-range-info");
    const customRangeErr  = $("custom-range-error");
    const kpiPopupOverlay = $("kpi-popup-overlay");
    const kpiPopupTitle   = $("kpi-popup-title");
    const kpiPopupClose   = $("kpi-popup-close");
    const btnRefresh      = $("btn-refresh");
    const btnRefreshLabel = $("btn-refresh-label");

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. POPULATE STATIC UI ELEMENTS
    // ═══════════════════════════════════════════════════════════════════════════

    CFG.TIME_RANGE_OPTIONS.forEach(opt => {
      const el = document.createElement("option");
      el.value = opt;
      el.textContent = opt;
      if (opt === "15 min") el.selected = true;
      timeRangeSelect.appendChild(el);
    });

    CFG.TOOLS.forEach(t => {
      const btn = document.createElement("button");
      btn.className = "tool-btn";
      btn.dataset.tool = t.id;
      const dotColor = t.status === "online" ? t.color : t.status === "degraded" ? "#f59e0b" : "#e5534b";
      btn.innerHTML = `
        <span class="tool-dot" style="background:${dotColor}"></span>
        <span style="color:inherit">${Utils.escapeHtml(t.name)}</span>
        ${t.status === "degraded" ? `<span style="font-family:var(--font-mono);font-size:9px;color:#f59e0b">⚠</span>` : ""}
      `;
      btn.addEventListener("click", () => setActiveTool(t.id));
      toolBtns.appendChild(btn);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. LOAD DATA
    // ═══════════════════════════════════════════════════════════════════════════

    async function loadAllData() {
      const [mappingRaw, categoryRaw] = await Promise.all([
        API.getConfig("mapping.json"),
        API.getConfig("category.json"),
      ]);
      try { state.mapping = JSON.parse(mappingRaw) || {}; } catch { state.mapping = CFG.DEFAULT_MAPPING || {}; }
      try { state.categoryRules = JSON.parse(categoryRaw) || []; } catch { state.categoryRules = CFG.DEFAULT_CATEGORY_RULES || []; }
      await loadIssues();
    }

    // Change 4: loadIssues sets dataUpdatedAt only when data actually changes.
    // Preserves filters and does NOT touch the countdown timer.
    async function loadIssues() {
      if (state.isFetching) return;
      state.isFetching = true;
      setRefreshBusy(true);

      try {
        const raw = await API.getIssues();
        if (!raw || !Array.isArray(raw.allIssues)) {
          showError("Failed to load issues — backend returned no data.");
          return;
        }
        hideError();

        const rows = Utils.normalizeAllIssues(raw, state.mapping, state.categoryRules);

        // Derive available categories from payload (Change 1)
        state.availableCategories = [...new Set(rows.map(r => r.category).filter(Boolean))];

        // fileModifiedAt: use last-modified from server if available in raw meta,
        // else derive from the max start timestamp in payload
        if (raw._lastModified) {
          state.fileModifiedAt = new Date(raw._lastModified);
        } else {
          const maxTs = rows.reduce((m, r) => Math.max(m, r.ts || 0), 0);
          state.fileModifiedAt = maxTs ? new Date(maxTs) : new Date();
        }

        // dataUpdatedAt: time we ingested the new data
        state.dataUpdatedAt = new Date();
        state.lastCheckedAt = new Date();

        state.allIssues = rows;
        render();
      } finally {
        state.isFetching = false;
        setRefreshBusy(false);
      }
    }

    function setRefreshBusy(busy) {
      if (!btnRefresh) return;
      btnRefresh.disabled = busy;
      if (btnRefreshLabel) btnRefreshLabel.textContent = busy ? "Loading…" : "Refresh";
      const icon = btnRefresh.querySelector("i[data-lucide]");
      if (icon) {
        icon.dataset.lucide = busy ? "loader" : "refresh-cw";
        Utils.refreshIcons();
      }
    }

    // Change 4: headCheck — always update lastCheckedAt; only reload if file newer than known fileModifiedAt
    async function headCheck() {
      if (state.isFetching) return;
      try {
        const resp = await fetch("../../backend/data/all_issues.json", { method: "HEAD", cache: "no-store" });
        state.lastCheckedAt = new Date();

        const lmStr = resp.headers.get("last-modified");
        if (lmStr) {
          const newTs = new Date(lmStr);
          if (!state.fileModifiedAt || newTs > state.fileModifiedAt) {
            // New data on disk — load it
            state.fileModifiedAt = newTs;
            await loadIssues();
          }
        }
      } catch { /* ignore network errors */ }
      updateStatusBar();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. FILTER PIPELINE
    // ═══════════════════════════════════════════════════════════════════════════

    function getActiveWindow() {
      const nowMs = Date.now();
      if (state.timeRange === "Custom") {
        if (state.customStart && state.customEnd && !getCustomRangeError()) {
          return { startMs: new Date(state.customStart).getTime(), endMs: new Date(state.customEnd).getTime() };
        }
        return { startMs: nowMs - DEFAULT_RANGE_MS, endMs: nowMs };
      }
      const windowMs = TIME_RANGE_MS[state.timeRange] || DEFAULT_RANGE_MS;
      return { startMs: nowMs - windowMs, endMs: nowMs };
    }

    function getCustomRangeError() {
      if (state.timeRange !== "Custom" || !state.customStart || !state.customEnd) return null;
      const s = new Date(state.customStart).getTime();
      const e = new Date(state.customEnd).getTime();
      if (isNaN(s) || isNaN(e)) return null;
      if (e <= s) return "End time must be after start time.";
      const nowMs = Date.now();
      if (s < nowMs - MAX_RANGE_MS) return "Start time cannot be more than 168 hours (7 days) before now.";
      if (e > nowMs + 60000) return "End time cannot be in the future.";
      if (e - s > MAX_RANGE_MS) return "Maximum selectable range is 168 hours (7 days).";
      return null;
    }

    function getFilteredIssues() {
      const { startMs, endMs } = getActiveWindow();
      let rows = state.activeTool === "all"
        ? state.allIssues
        : state.allIssues.filter(r => r.source === state.activeTool);

      rows = rows.filter(r => r.ts >= startMs && r.ts <= endMs);

      if (state.globalKeyword) {
        const kw = state.globalKeyword.toLowerCase();
        rows = rows.filter(r =>
          r.title.toLowerCase().includes(kw) ||
          r.description.toLowerCase().includes(kw) ||
          r.issueId.toLowerCase().includes(kw) ||
          r.application.toLowerCase().includes(kw) ||
          r.affectedEntities.toLowerCase().includes(kw) ||
          r.category.toLowerCase().includes(kw)
        );
      }
      if (state.statusFilter && state.statusFilter !== "all") {
        rows = rows.filter(r => r.status === state.statusFilter);
      }
      if (state.categoryFilters.length > 0) {
        rows = rows.filter(r => state.categoryFilters.includes(r.category));
      }
      return rows;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 4. RENDER ORCHESTRATOR
    // ═══════════════════════════════════════════════════════════════════════════

    function render() {
      const filtered = getFilteredIssues();
      updateStatusBar();
      updateFilterBar();
      updateCustomRangeUI();
      renderStatusCards(filtered);
      renderKPIs(filtered);         // Change 1
      // renderGraph(filtered);     // Change 3: commented out
      renderMatrix(filtered);
      renderTableDT(filtered);      // Change 2
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 5. STATUS BAR (Change 4)
    // ═══════════════════════════════════════════════════════════════════════════

    function fmt(d) {
      if (!d) return "—";
      if (typeof d === "string") return d; // raw server string
      return d.toLocaleString();
    }

    function updateStatusBar() {
      statusLeft.innerHTML =
        `Last Data Modified At: ${fmt(state.fileModifiedAt)} &nbsp;|&nbsp; ` +
        `Last Data Updated At: ${fmt(state.dataUpdatedAt)}`;
      statusRight.innerHTML =
        `Last Data Checked At: ${fmt(state.lastCheckedAt)} &nbsp;|&nbsp; ` +
        `<span id="countdown-label" style="color:var(--primary)">Next Refresh in: ${state.countdown}s</span>`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 6. FILTER BAR
    // ═══════════════════════════════════════════════════════════════════════════

    function updateFilterBar() {
      const active = state.globalKeyword || state.statusFilter || state.categoryFilters.length > 0 || state.tableSearch;
      filterBar.classList.toggle("hidden", !active);
      if (!active) return;

      let html = "";
      if (state.globalKeyword)
        html += `<span class="filter-tag">Search: "${Utils.escapeHtml(state.globalKeyword)}"</span>`;
      if (state.statusFilter)
        html += `<span class="filter-tag">Status: ${state.statusFilter}</span>`;
      state.categoryFilters.forEach(c =>
        html += `<span class="filter-tag">Category: ${Utils.escapeHtml(c)}</span>`
      );
      if (state.tableSearch)
        html += `<span class="filter-tag">Table: "${Utils.escapeHtml(state.tableSearch)}"</span>`;
      filterTags.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 7. CUSTOM RANGE UI
    // ═══════════════════════════════════════════════════════════════════════════

    function updateCustomRangeUI() {
      const isCustom = state.timeRange === "Custom";
      customStart.disabled = !isCustom;
      customEnd.disabled   = !isCustom;

      if (isCustom) {
        const nowMs  = Date.now();
        const minVal = Utils.toDatetimeLocalValue(new Date(nowMs - MAX_RANGE_MS));
        const maxVal = Utils.toDatetimeLocalValue(new Date(nowMs));
        customStart.min = customEnd.min = minVal;
        customStart.max = customEnd.max = maxVal;

        customRangeInfo.textContent =
          `Custom range must fall within the last 168 hours (7 days) — from ${minVal.replace("T"," ")} to ${maxVal.replace("T"," ")}.`;
        customRangeInfo.classList.remove("hidden");

        const err = getCustomRangeError();
        if (err) {
          customRangeErr.textContent = err;
          customRangeErr.classList.remove("hidden");
        } else {
          customRangeErr.classList.add("hidden");
        }
      } else {
        customRangeInfo.classList.add("hidden");
        customRangeErr.classList.add("hidden");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 8. STATUS CARDS
    // ═══════════════════════════════════════════════════════════════════════════

    function toolBreakdown(rows) {
      return CFG.TOOLS.map(t => {
        const c = rows.filter(r => r.source === t.id).length;
        return c > 0 ? `${t.shortName} ${c}` : null;
      }).filter(Boolean).join(" | ") || "—";
    }

    function renderStatusCards(filtered) {
      const total    = filtered.length;
      const active   = filtered.filter(r => r.status === "Active").length;
      const resolved = filtered.filter(r => r.status === "Resolved").length;

      const cards = [
        { label: "Total",    count: total,    breakdown: toolBreakdown(filtered),                                    value: "all"      },
        { label: "Active",   count: active,   breakdown: toolBreakdown(filtered.filter(r => r.status === "Active")),   value: "Active"   },
        { label: "Resolved", count: resolved, breakdown: toolBreakdown(filtered.filter(r => r.status === "Resolved")), value: "Resolved" },
      ];

      statusCards.innerHTML = cards.map(c => `
        <button class="status-card${state.statusFilter === c.value ? " selected" : ""}" data-status="${c.value}">
          <span class="status-card-label">${c.label}</span>
          <span class="status-card-count">${c.count}</span>
          <span class="status-card-breakdown">${Utils.escapeHtml(c.breakdown)}</span>
        </button>
      `).join("");

      statusCards.querySelectorAll(".status-card").forEach(btn => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.status;
          state.statusFilter = state.statusFilter === val ? null : val;
          render();
        });
      });

      Utils.refreshIcons();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 9. KPIs — Change 1: dynamic from payload + popup on click
    // ═══════════════════════════════════════════════════════════════════════════

    function renderKPIs(filtered) {
      // Use categories derived from the live payload; fall back to CFG if not yet loaded
      const sourceCats = state.availableCategories.length
        ? state.availableCategories
        : (CFG.CATEGORIES || []);

      // Only render cards where count > 0 in current filtered view
      const activeCats = sourceCats.filter(cat => filtered.some(r => r.category === cat));

      if (activeCats.length === 0) {
        kpiCards.innerHTML = `<span style="font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)">No categories in current view.</span>`;
        return;
      }

      kpiCards.innerHTML = activeCats.map(cat => {
        const catRows  = filtered.filter(r => r.category === cat);
        const count    = catRows.length;
        const critical = catRows.filter(r => r.severity === "Critical").length;
        const high     = catRows.filter(r => r.severity === "High").length;
        return `
          <button class="kpi-card" data-cat="${Utils.escapeHtml(cat)}">
            <span class="kpi-label">${Utils.escapeHtml(cat)}</span>
            <span class="kpi-count">${count}</span>
            <span class="kpi-meta">Critical ${critical} | High ${high}</span>
          </button>
        `;
      }).join("");

      kpiCards.querySelectorAll(".kpi-card").forEach(btn => {
        btn.addEventListener("click", () => {
          openKpiPopup(btn.dataset.cat, filtered);
        });
      });
    }

    // ── KPI Popup (Change 1) ──────────────────────────────────────────────────

    function openKpiPopup(cat, filtered) {
      const rows = filtered.filter(r => r.category === cat);
      kpiPopupTitle.textContent = `${cat} — ${rows.length} Issue${rows.length !== 1 ? "s" : ""}`;

      // Destroy previous DataTables instance if exists
      if (state.kpiDtInstance) {
        state.kpiDtInstance.destroy();
        state.kpiDtInstance = null;
        $("kpi-popup-table").querySelector("tbody").innerHTML = "";
      }

      // Build row data for popup table (reduced columns)
      const rowData = rows.map(r => {
        const tool = CFG.TOOL_MAP[r.source] || {};
        const sevCls = { Critical: "chip-critical", High: "chip-high", Medium: "chip-medium", Low: "chip-low" }[r.severity] || "chip-low";
        const staCls = r.status === "Active" ? "chip-active" : "chip-resolved";
        return [
          r.srNo,
          `<span style="font-family:var(--font-mono);font-size:11px;font-weight:500;color:${tool.color || "var(--foreground)"}">${Utils.escapeHtml(tool.name || r.source)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:11px;color:var(--primary)">${Utils.escapeHtml(r.issueId)}</span>`,
          Utils.escapeHtml(r.application),
          Utils.escapeHtml(r.title),
          `<span class="chip ${sevCls}">${Utils.escapeHtml(r.severity)}</span>`,
          `<span class="chip ${staCls}">${Utils.escapeHtml(r.status)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:10px">${Utils.escapeHtml(r.startTime)}</span>`,
        ];
      });

      state.kpiDtInstance = $("#kpi-popup-table").DataTable({
        data: rowData,
        columns: [
          { title: "Sr. No." },
          { title: "Source" },
          { title: "Issue ID" },
          { title: "Application" },
          { title: "Title" },
          { title: "Severity" },
          { title: "Status" },
          { title: "Start Time" },
        ],
        pageLength: 10,
        lengthMenu: [10, 25, 50],
        order: [],
        autoWidth: false,
        scrollX: true,
        language: {
          emptyTable: "No issues in this category.",
          info: "Showing _START_ to _END_ of _TOTAL_ issues",
          infoEmpty: "No issues",
          search: "Filter:",
        },
      });

      kpiPopupOverlay.classList.remove("hidden");
      document.body.classList.add("modal-open");
      Utils.refreshIcons();
    }

    function closeKpiPopup() {
      kpiPopupOverlay.classList.add("hidden");
      document.body.classList.remove("modal-open");
    }

    kpiPopupClose.addEventListener("click", closeKpiPopup);
    kpiPopupOverlay.addEventListener("click", e => {
      if (e.target === kpiPopupOverlay) closeKpiPopup();
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 10. GRAPH — Change 3: COMMENTED OUT
    // ═══════════════════════════════════════════════════════════════════════════
    /*
    function buildGraphData(filtered) { ... }
    function renderGraph(filtered) { ... }
    */

    // ═══════════════════════════════════════════════════════════════════════════
    // 11. EVALUATION MATRIX
    // ═══════════════════════════════════════════════════════════════════════════

    function buildMatrixCols(filtered) {
      const map = new Map();
      filtered.forEach(r => {
        const key = `${r.application}::${r.source}`;
        const prev = map.get(key);
        if (!prev || r.ts > prev.mostRecent) {
          map.set(key, {
            app: r.application,
            tool: r.source,
            toolName: CFG.TOOL_MAP[r.source]?.name || r.source,
            mostRecent: Math.max(prev?.mostRecent ?? -1, r.ts),
          });
        }
      });
      return Array.from(map.values()).sort((a, b) => {
        const vals = v => Array.from(map.values()).filter(x => x.app === v.app).map(x => x.mostRecent);
        const aMax = Math.max(...vals(a));
        const bMax = Math.max(...vals(b));
        if (bMax !== aMax) return bMax - aMax;
        if (a.app !== b.app) return a.app.localeCompare(b.app);
        return a.toolName.localeCompare(b.toolName);
      });
    }

    function cellCounts(filtered, cat, app, source) {
      const matches = filtered.filter(r => r.category === cat && r.application === app && r.source === source);
      return { open: matches.filter(r => r.status === "Active").length, total: matches.length };
    }

    function renderMatrix(filtered) {
      const cats = state.availableCategories.length ? state.availableCategories : (CFG.CATEGORIES || []);
      const cols    = buildMatrixCols(filtered);
      const visible = cols.slice(state.matrixOffset, state.matrixOffset + state.MATRIX_VISIBLE);

      matrixLeft.disabled  = state.matrixOffset === 0;
      matrixRight.disabled = state.matrixOffset >= Math.max(0, cols.length - state.MATRIX_VISIBLE);

      if (cols.length === 0) {
        matrixTable.innerHTML = `<tr><td class="matrix-empty" colspan="2">No data in selected time range.</td></tr>`;
        return;
      }

      let html = "<thead>";
      html += `<tr><th class="cat-col" rowspan="2">CATEGORY /<br>APPLICATIONS</th>`;
      visible.forEach(c => { html += `<th>${Utils.escapeHtml(c.app)}</th>`; });
      html += "</tr><tr>";
      visible.forEach(c => { html += `<th>${Utils.escapeHtml(c.toolName)}</th>`; });
      html += "</tr></thead><tbody>";

      cats.forEach(cat => {
        const allCols = cols.map(c => cellCounts(filtered, cat, c.app, c.tool));
        const catTotal = allCols.reduce((s, x) => s + x.total, 0);
        const catOpen  = allCols.reduce((s, x) => s + x.open,  0);

        html += `<tr><td class="cat-col" style="font-family:var(--font-mono);font-size:11px">${Utils.escapeHtml(cat)}<br>
          <span style="font-size:10px;color:#555">${catOpen}/${catTotal}</span></td>`;

        visible.forEach(c => {
          const { open, total } = cellCounts(filtered, cat, c.app, c.tool);
          const closed = Math.max(0, total - open);
          const bg      = open > 0 ? "#fde2e1" : total > 0 ? "#f3f4f6" : "#e6f9ed";
          const fg      = (open > 0 || total > 0) ? "#111827" : "#065f46";
          const display = `${closed}\\${open}\\${total}`;
          html += `<td class="matrix-cell" style="background:${bg};color:${fg}">${display}</td>`;
        });
        html += "</tr>";
      });

      html += "</tbody>";
      matrixTable.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 12. TABLE — Change 2: DataTables
    // ═══════════════════════════════════════════════════════════════════════════

    function renderTableDT(filtered) {
      const rows = filtered;

      // Build row data array for DataTables
      const rowData = rows.map(r => {
        const tool   = CFG.TOOL_MAP[r.source] || {};
        const sevCls = { Critical: "chip-critical", High: "chip-high", Medium: "chip-medium", Low: "chip-low" }[r.severity] || "chip-low";
        const staCls = r.status === "Active" ? "chip-active" : "chip-resolved";

        return [
          r.srNo,                                                                                                  // 0  Sr. No.
          `<span style="font-family:var(--font-mono);font-size:11px;font-weight:500;color:${tool.color || "var(--foreground)"};white-space:nowrap">${Utils.escapeHtml(tool.name || r.source)}</span>`, // 1
          `<span style="font-family:var(--font-mono);font-size:11px;color:var(--primary);white-space:nowrap">${Utils.escapeHtml(r.issueId)}</span>`,                                                  // 2
          `<span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${Utils.escapeHtml(r.application)}</span>`,                                                                    // 3
          Utils.escapeHtml(r.title),                                                                              // 4
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)">${Utils.escapeHtml(r.affectedEntities)}</span>`,                                                    // 5
          `<span class="chip ${sevCls}">${Utils.escapeHtml(r.severity)}</span>`,                                  // 6
          `<span style="font-family:var(--font-sans);font-size:11px">${Utils.escapeHtml(r.category)}</span>`,    // 7
          `<span style="font-size:11px">${Utils.escapeHtml(r.description)}</span>`,                               // 8
          `<span class="chip ${staCls}">${Utils.escapeHtml(r.status)}</span>`,                                   // 9
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.startTime)}</span>`,  // 10
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.endTime)}</span>`,    // 11
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.duration)}</span>`,   // 12
          // Action cell
          `<div class="action-cell">
            <button class="btn-icon copy-btn" data-copy="${Utils.escapeHtml(r.id)}" title="Copy issue details">
              <i data-lucide="copy" style="width:14px;height:14px"></i>
            </button>
            <a href="${Utils.escapeHtml(tool.url || "#")}" target="_blank" rel="noopener" class="btn-icon" title="Open in tool" onclick="event.stopPropagation()">
              <i data-lucide="external-link" style="width:14px;height:14px"></i>
            </a>
          </div>`,                                                                                                 // 13
          r.id,  // 14 — hidden, used for row-click
        ];
      });

      if (state.dtInstance) {
        // Reload data in-place — preserves pagination position and sort
        state.dtInstance.clear().rows.add(rowData).draw(false);
        // Re-bind copy buttons and row clicks after redraw
        bindTableEvents(rows);
        Utils.refreshIcons();
        return;
      }

      // First initialisation
      state.dtInstance = $("#issues-table").DataTable({
        data: rowData,
        columns: [
          { title: "Sr. No.",          width: "60px"  },
          { title: "Source",           width: "100px" },
          { title: "Issue ID",         width: "110px" },
          { title: "Application",      width: "120px" },
          { title: "Title",            width: "180px" },
          { title: "Affected Entities",width: "130px" },
          { title: "Severity",         width: "90px"  },
          { title: "Category",         width: "130px" },
          { title: "Description",      width: "180px" },
          { title: "Status",           width: "90px"  },
          { title: "Start Time",       width: "130px" },
          { title: "End Time",         width: "130px" },
          { title: "Duration",         width: "90px"  },
          { title: "Action",           orderable: false, width: "80px" },
          { title: "_id",              visible: false },
        ],
        pageLength: 10,
        lengthMenu: [10, 25, 50, 100],
        order: [[0, "asc"]],
        scrollX: true,
        autoWidth: false,
        language: {
          emptyTable: "No issues found.",
          info: "Showing _START_ to _END_ of _TOTAL_ entries",
          infoEmpty: "No entries",
          infoFiltered: "(filtered from _MAX_ total)",
          search: "Table filter:",
          lengthMenu: "Show _MENU_ entries",
          paginate: { first: "«", last: "»", next: "›", previous: "‹" },
        },
        drawCallback: function() {
          bindTableEvents(rows);
          Utils.refreshIcons();
        },
      });

      // Wire the external global search to DataTables search
      // (DataTables also has its own search box but we keep the global one driving it)
    }

    function bindTableEvents(allRows) {
      // Row click → detail modal
      document.querySelectorAll("#issues-table tbody tr").forEach(tr => {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function(e) {
          if (e.target.closest(".action-cell")) return;
          const dtRow = state.dtInstance.row(tr).data();
          if (!dtRow) return;
          const id  = dtRow[14];
          const row = allRows.find(r => r.id === id);
          if (row) openDetailModal(row);
        });
      });

      // Copy buttons
      document.querySelectorAll("#issues-table .copy-btn").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const id  = btn.dataset.copy;
          const row = allRows.find(r => r.id === id);
          if (!row) return;
          const text = [
            `Issue ID: ${row.issueId}`,
            `Source: ${CFG.TOOL_MAP[row.source]?.name || row.source}`,
            `Application: ${row.application}`,
            `Title: ${row.title}`,
            `Severity: ${row.severity}`,
            `Category: ${row.category}`,
            `Status: ${row.status}`,
            `Description: ${row.description}`,
            `Start: ${row.startTime} | End: ${row.endTime} | Duration: ${row.duration}`,
          ].join("\n");
          navigator.clipboard.writeText(text).then(() => {
            btn.classList.add("copied");
            const icon = btn.querySelector("i[data-lucide]");
            if (icon) { icon.dataset.lucide = "check"; Utils.refreshIcons(); }
            setTimeout(() => {
              btn.classList.remove("copied");
              if (icon) { icon.dataset.lucide = "copy"; Utils.refreshIcons(); }
            }, 1500);
          });
        });
      });
    }

    function getExportRows() {
      if (!state.dtInstance) return [];
      return state.dtInstance.rows({ search: "applied" }).data().toArray()
        .map(dtRow => {
          const id = dtRow[14];
          return getFilteredIssues().find(r => r.id === id);
        }).filter(Boolean);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 13. DETAIL MODAL
    // ═══════════════════════════════════════════════════════════════════════════

    function openDetailModal(row) {
      modalTitle.textContent = row.title;
      const fields = [
        { label: "Issue ID",          value: row.issueId,          full: false },
        { label: "Sr. No.",           value: String(row.srNo),     full: false },
        { label: "Source",            value: CFG.TOOL_MAP[row.source]?.name || row.source, full: false },
        { label: "Application",       value: row.application,      full: false },
        { label: "Affected Entities", value: row.affectedEntities, full: false },
        { label: "Severity",          value: row.severity,         full: false },
        { label: "Category",          value: row.category,         full: false },
        { label: "Status",            value: row.status,           full: false },
        { label: "Start Time",        value: row.startTime,        full: false },
        { label: "End Time",          value: row.endTime,          full: false },
        { label: "Duration",          value: row.duration,         full: false },
        { label: "Title",             value: row.title,            full: true  },
        { label: "Description",       value: row.description,      full: true  },
      ];

      modalFields.innerHTML = fields.map(f => `
        <div class="modal-field${f.full ? " full" : ""}">
          <span class="modal-field-label">${Utils.escapeHtml(f.label)}</span>
          <span class="modal-field-value">${Utils.escapeHtml(f.value || "—")}</span>
        </div>
      `).join("");

      detailModal.classList.remove("hidden");
      document.body.classList.add("modal-open");
    }

    function closeDetailModal() {
      detailModal.classList.add("hidden");
      document.body.classList.remove("modal-open");
    }

    detailModal.addEventListener("click", closeDetailModal);
    modalClose.addEventListener("click", closeDetailModal);

    // ═══════════════════════════════════════════════════════════════════════════
    // 14. EXPORT
    // ═══════════════════════════════════════════════════════════════════════════

    $("btn-export").addEventListener("click", e => {
      e.stopPropagation();
      exportMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => exportMenu.classList.add("hidden"));

    $("export-csv").addEventListener("click", () => {
      const rows = getExportRows();
      const hdrs = ["Sr.No","Source","Issue ID","Application","Title","Affected Entities","Severity","Category","Description","Status","Start Time","End Time","Duration"];
      const lines = rows.map(r =>
        [r.srNo, r.source, r.issueId, r.application, r.title, r.affectedEntities,
         r.severity, r.category, `"${r.description.replace(/"/g, '""')}"`,
         r.status, r.startTime, r.endTime, r.duration].join(",")
      );
      const blob = new Blob([[hdrs.join(","), ...lines].join("\n")], { type: "text/csv" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: "issues.csv" });
      a.click(); URL.revokeObjectURL(url);
      exportMenu.classList.add("hidden");
    });

    $("export-excel").addEventListener("click", () => {
      const rows = getExportRows();
      const hdrs = ["Sr.No","Source","Issue ID","Application","Title","Affected Entities","Severity","Category","Description","Status","Start Time","End Time","Duration"];
      const trs  = rows.map(r =>
        `<tr>${[r.srNo, r.source, r.issueId, r.application, r.title, r.affectedEntities,
          r.severity, r.category, r.description,
          r.status, r.startTime, r.endTime, r.duration].map(v => `<td>${v}</td>`).join("")}</tr>`
      ).join("");
      const html = `<table><tr>${hdrs.map(h => `<th>${h}</th>`).join("")}</tr>${trs}</table>`;
      const blob = new Blob([html], { type: "application/vnd.ms-excel" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: "issues.xls" });
      a.click(); URL.revokeObjectURL(url);
      exportMenu.classList.add("hidden");
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 15. EVENT WIRING
    // ═══════════════════════════════════════════════════════════════════════════

    // Global search (debounced) — drives DataTables search
    globalSearch.addEventListener("input", Utils.debounce(e => {
      state.globalKeyword = e.target.value;
      render();
    }, 250));

    // Time range
    timeRangeSelect.addEventListener("change", e => {
      state.timeRange = e.target.value;
      render();
    });

    // Custom date pickers
    customStart.addEventListener("change", e => { state.customStart = e.target.value; render(); });
    customEnd.addEventListener("change",   e => { state.customEnd   = e.target.value; render(); });

    // Tool buttons
    $("tool-all").addEventListener("click", () => setActiveTool("all"));

    function setActiveTool(toolId) {
      state.activeTool = toolId;
      $("tool-all").classList.toggle("active", toolId === "all");
      const check = $("tool-all-check");
      if (check) check.style.display = toolId === "all" ? "" : "none";
      document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
        const t = CFG.TOOL_MAP[btn.dataset.tool];
        const isActive = btn.dataset.tool === toolId;
        btn.classList.toggle("active", isActive);
        if (t && isActive) {
          btn.style.borderColor = t.color + "70";
          btn.style.background  = t.color + "22";
          btn.style.boxShadow   = `0 0 0 1px ${t.color}30`;
          btn.style.color       = t.color;
        } else if (t) {
          btn.style.borderColor = "";
          btn.style.background  = "rgba(255,255,255,.02)";
          btn.style.boxShadow   = "";
          btn.style.color       = "";
        }
      });
      render();
    }

    // Clear filters
    $("btn-clear-filters").addEventListener("click", clearAllFilters);

    // Change 4: Refresh button — re-fetch data only; timer and filters untouched
    btnRefresh.addEventListener("click", async () => {
      await loadIssues();
      // Timer (countdownTimer) is intentionally NOT reset here.
      // Filters are intentionally NOT cleared here.
    });

    // UI Refresh interval input
    uiRefreshInput.addEventListener("change", e => {
      state.uiRefreshMin = Math.max(1, parseInt(e.target.value) || 1);
      resetCountdown();
    });

    // Collapsible section toggles
    ["issue-details", "kpis"].forEach(id => {
      const key = id.replace(/-(\\w)/g, (_, c) => c.toUpperCase());
      const btn  = $(`toggle-${id}`);
      const body = $(`${id}-body`);
      if (!btn || !body) return;
      btn.addEventListener("click", () => {
        state.sections[key] = !state.sections[key];
        btn.classList.toggle("collapsed", !state.sections[key]);
        body.classList.toggle("hidden", !state.sections[key]);
        Utils.refreshIcons();
      });
    });

    // Matrix navigation
    matrixLeft.addEventListener("click",  () => { state.matrixOffset = Math.max(0, state.matrixOffset - 1); renderMatrix(getFilteredIssues()); });
    matrixRight.addEventListener("click", () => { state.matrixOffset++; renderMatrix(getFilteredIssues()); });

    // ═══════════════════════════════════════════════════════════════════════════
    // 16. COUNTDOWN + PERIODIC REFRESH (Change 4)
    // ═══════════════════════════════════════════════════════════════════════════

    let countdownTimer = null;

    // resetCountdown is called only on initial boot and when the user changes the
    // UI Refresh interval — NOT on manual refresh (Change 4).
    function resetCountdown() {
      state.countdown = Math.max(1, state.uiRefreshMin) * 60;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        state.countdown--;
        updateStatusBar();
        if (state.countdown <= 0) {
          state.countdown = Math.max(1, state.uiRefreshMin) * 60;
          // Refresh durations for Active issues
          state.allIssues = state.allIssues.map(r => {
            if (r.status !== "Active" || !r.ts) return r;
            return { ...r, duration: Utils.formatDuration(new Date(r.ts), null) };
          });
          render();
        }
      }, 1000);
    }

    // Change 4: Periodic HEAD check driven by config value (not hardcoded 60s)
    const headCheckInterval = (CFG.SETTINGS_DEFAULTS?.periodicCheckTime ?? 30) * 1000;
    setInterval(headCheck, headCheckInterval);

    // ═══════════════════════════════════════════════════════════════════════════
    // 17. HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function clearAllFilters() {
      state.globalKeyword   = "";
      state.statusFilter    = null;
      state.categoryFilters = [];
      state.tableSearch     = "";
      globalSearch.value    = "";
      // Clear DataTables internal search
      if (state.dtInstance) {
        state.dtInstance.search("").draw(false);
      }
      render();
    }

    function showError(msg) { errorMsg.textContent = msg; errorBanner.classList.remove("hidden"); }
    function hideError()    { errorBanner.classList.add("hidden"); }

    // ═══════════════════════════════════════════════════════════════════════════
    // 18. BOOT
    // ═══════════════════════════════════════════════════════════════════════════

    await loadAllData();
    headCheck();
    resetCountdown();
    Utils.refreshIcons();
  });
})();