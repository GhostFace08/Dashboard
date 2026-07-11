/**
 * dashboard.js — Unified MCP Dashboard
 * Depends on: config.js (window.CFG), api.js (window.API), common.js (window.Utils)
 */

(function () {
  "use strict";

  // jQuery $ and local $ must not conflict — keep jQ alias for DataTables
  const jQ = window.jQuery || window.$;

  document.addEventListener("DOMContentLoaded", async () => {
    Utils.initHeader();

    // ─── State ───────────────────────────────────────────────────────────────
    const state = {
      allIssues:           [],
      mapping:             {},
      categoryRules:       [],
      availableCategories: [],

      activeTool:     "all",
      timeRange:      "7 days",   // default to 7 days so data is visible on load
      customStart:    "",
      customEnd:      "",

      statusFilter:   null,
      categoryFilters:[],
      globalKeyword:  "",
      tableSearch:    "",

      uiRefreshMin:   1,
      countdown:      60,

      // Timestamps (Change 4)
      fileModifiedAt: null,
      dataUpdatedAt:  null,
      lastCheckedAt:  null,

      // DataTables instances
      dtInstance:    null,
      kpiDtInstance: null,

      // Current filtered rows — kept in sync so drawCallback always has latest
      currentFilteredRows: [],

      matrixOffset:   0,
      MATRIX_VISIBLE: 6,

      sections: { issueDetails: true, kpis: true },

      detailRow: null,
      copiedId:  null,
      isFetching: false,
      isRefreshPending: false,   // Change 3 — guards duplicate manual refreshes
    };

    const MAX_RANGE_MS     = CFG.MAX_RANGE_MS;
    const DEFAULT_RANGE_MS = CFG.DEFAULT_RANGE_MS;
    const TIME_RANGE_MS    = CFG.TIME_RANGE_MS;

    // ─── DOM refs — use plain getElementById, never shadow jQuery $ ──────────
    const byId = id => document.getElementById(id);
    const errorBanner     = byId("error-banner");
    const errorMsg        = byId("error-msg");
    const statusLeft      = byId("status-left");
    const statusRight     = byId("status-right");
    const filterBar       = byId("filter-bar");
    const filterTags      = byId("filter-tags");
    const globalSearch    = byId("global-search");
    const customStart     = byId("custom-start");
    const customEnd       = byId("custom-end");
    const timeRangeSelect = byId("time-range-select");
    const uiRefreshInput  = byId("ui-refresh-input");
    const toolBtns        = byId("tool-btns");
    const statusCards     = byId("status-cards");
    const kpiCards        = byId("kpi-cards");
    const matrixTable     = byId("matrix-table");
    const matrixLeft      = byId("matrix-left");
    const matrixRight     = byId("matrix-right");
    const detailModal     = byId("detail-modal");
    const modalTitle      = byId("modal-title");
    const modalFields     = byId("modal-fields");
    const modalClose      = byId("modal-close");
    const exportMenu      = byId("export-menu");
    const customRangeInfo = byId("custom-range-info");
    const customRangeErr  = byId("custom-range-error");
    const kpiPopupOverlay = byId("kpi-popup-overlay");
    const kpiPopupTitle   = byId("kpi-popup-title");
    const kpiPopupClose   = byId("kpi-popup-close");
    const btnRefresh      = byId("btn-refresh");
    const btnRefreshLabel = byId("btn-refresh-label");

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. STATIC UI
    // ═══════════════════════════════════════════════════════════════════════════

    CFG.TIME_RANGE_OPTIONS.forEach(opt => {
      const el = document.createElement("option");
      el.value = opt;
      el.textContent = opt;
      if (opt === state.timeRange) el.selected = true;
      timeRangeSelect.appendChild(el);
    });
    // Sync the select element to state default
    timeRangeSelect.value = state.timeRange;

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
        state.availableCategories = [...new Set(rows.map(r => r.category).filter(Boolean))];

        // Change 3 — timestamps come from server headers/payload, never new Date()
        // X-File-Modified-At and X-Server-Time are set by the updated middleware
        if (raw._fileModifiedAt) {
          state.fileModifiedAt = new Date(raw._fileModifiedAt);
        } else if (raw._lastModified) {
          state.fileModifiedAt = new Date(raw._lastModified);
        } else {
          const maxTs = rows.reduce((m, r) => Math.max(m, r.ts || 0), 0);
          if (maxTs) state.fileModifiedAt = new Date(maxTs);
        }
        if (raw._serverTime) {
          state.dataUpdatedAt = new Date(raw._serverTime);
          state.lastCheckedAt = new Date(raw._serverTime);
        }
        // If middleware hasn't added headers yet, leave existing timestamps intact

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

    // Change 3 — replaces headCheck(). Calls /api/status; loads data only when
    // the middleware signals hasNewData. Never touches user clock for timestamps.
    async function pollStatus() {
      if (state.isFetching) return;
      try {
        const status = await API.getStatus();
        // Always update lastCheckedAt from server time
        if (status.lastCheckedAt) state.lastCheckedAt = new Date(status.lastCheckedAt);
        // Only pull fresh data when the middleware says there is new data
        if (status.hasNewData) {
          if (status.lastFileModifiedAt) state.fileModifiedAt = new Date(status.lastFileModifiedAt);
          if (status.lastDataUpdatedAt)  state.dataUpdatedAt  = new Date(status.lastDataUpdatedAt);
          await loadIssues();
        }
      } catch { /* silently ignore network errors */ }
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
    // 4. RENDER
    // ═══════════════════════════════════════════════════════════════════════════

    function render() {
      const filtered = getFilteredIssues();
      state.currentFilteredRows = filtered; // keep in sync for drawCallback
      updateStatusBar();
      updateFilterBar();
      updateCustomRangeUI();
      renderStatusCards(filtered);
      renderKPIs(filtered);
      // graph commented out (Change 3)
      renderMatrix(filtered);
      renderTableDT(filtered);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 5. STATUS BAR
    // ═══════════════════════════════════════════════════════════════════════════

    function fmt(d) {
      if (!d) return "—";
      if (typeof d === "string") return d;
      return d.toLocaleString();
    }

    function updateStatusBar() {
      statusLeft.innerHTML =
        `Last Data Modified At: ${fmt(state.fileModifiedAt)} &nbsp;|&nbsp; ` +
        `Last Data Updated At: ${fmt(state.dataUpdatedAt)}`;
      statusRight.innerHTML =
        `Last Data Checked At: ${fmt(state.lastCheckedAt)} &nbsp;|&nbsp; ` +
        `<span style="color:var(--primary)">Next Refresh in: ${state.countdown}s</span>`;
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
        if (err) { customRangeErr.textContent = err; customRangeErr.classList.remove("hidden"); }
        else      { customRangeErr.classList.add("hidden"); }
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
    // 9. KPIs — dynamic from payload; click opens popup (Change 1)
    // ═══════════════════════════════════════════════════════════════════════════

    function renderKPIs(filtered) {
      const sourceCats = state.availableCategories.length
        ? state.availableCategories
        : (CFG.CATEGORIES || []);
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
        btn.addEventListener("click", () => openKpiPopup(btn.dataset.cat, filtered));
      });
    }

    // ── KPI Popup ─────────────────────────────────────────────────────────────

    function openKpiPopup(cat, filtered) {
      const rows = filtered.filter(r => r.category === cat);
      kpiPopupTitle.textContent = `${cat} — ${rows.length} Issue${rows.length !== 1 ? "s" : ""}`;

      // Destroy previous instance cleanly
      if (state.kpiDtInstance) {
        state.kpiDtInstance.destroy(true); // true = remove DOM too
        state.kpiDtInstance = null;
        // Rebuild clean table skeleton
        const wrap = byId("kpi-popup-table-wrap");
        wrap.innerHTML = `
          <table id="kpi-popup-table" class="data-table display" style="width:100%">
            <thead>
              <tr>
                <th>Sr. No.</th><th>Source</th><th>Issue ID</th><th>Application</th>
                <th>Title</th><th>Severity</th><th>Status</th><th>Start Time</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>`;
      }

      const rowData = rows.map(r => {
        const tool   = CFG.TOOL_MAP[r.source] || {};
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

      // Use jQuery $ (jQ) for DataTables — NOT the local byId alias
      state.kpiDtInstance = jQ("#kpi-popup-table").DataTable({
        data: rowData,
        columns: [
          { title: "Sr. No.",     width: "60px"  },
          { title: "Source",      width: "100px" },
          { title: "Issue ID",    width: "110px" },
          { title: "Application", width: "120px" },
          { title: "Title",       width: "200px" },
          { title: "Severity",    width: "90px"  },
          { title: "Status",      width: "90px"  },
          { title: "Start Time",  width: "140px" },
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

      // Show modal FIRST so the DOM has real dimensions, then adjust columns.
      // Without this, scrollX DataTables initialised in a hidden container
      // miscalculates widths and header/body misalign until a redraw is forced.
      kpiPopupOverlay.classList.remove("hidden");
      document.body.classList.add("modal-open");
      // Use setTimeout(0) to let the browser paint the visible modal before measuring
      setTimeout(() => {
        if (state.kpiDtInstance) {
          state.kpiDtInstance.columns.adjust().draw(false);
        }
      }, 0);
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
    // 10. GRAPH — commented out (Change 3)
    // ═══════════════════════════════════════════════════════════════════════════

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
        const allCols  = cols.map(c => cellCounts(filtered, cat, c.app, c.tool));
        const catTotal = allCols.reduce((s, x) => s + x.total, 0);
        const catOpen  = allCols.reduce((s, x) => s + x.open,  0);

        html += `<tr><td class="cat-col" style="font-family:var(--font-mono);font-size:11px">${Utils.escapeHtml(cat)}<br>
          <span style="font-size:10px;color:var(--muted-foreground)">${catOpen}/${catTotal}</span></td>`;

        visible.forEach(c => {
          const { open, total } = cellCounts(filtered, cat, c.app, c.tool);
          let cellClass;
          if (open > 0)        cellClass = "matrix-cell-red";
          else if (total > 0)  cellClass = "matrix-cell-green";
          else                 cellClass = "matrix-cell-empty";
          html += `<td class="matrix-cell ${cellClass}">${open}/${total}</td>`;
        });
        html += "</tr>";
      });

      html += "</tbody>";
      matrixTable.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 12. TABLE — DataTables (Change 2)
    // ═══════════════════════════════════════════════════════════════════════════

    function buildRowData(rows) {
      return rows.map(r => {
        const tool   = CFG.TOOL_MAP[r.source] || {};
        const sevCls = { Critical: "chip-critical", High: "chip-high", Medium: "chip-medium", Low: "chip-low" }[r.severity] || "chip-low";
        const staCls = r.status === "Active" ? "chip-active" : "chip-resolved";
        return [
          r.srNo,
          `<span style="font-family:var(--font-mono);font-size:11px;font-weight:500;color:${tool.color || "var(--foreground)"};white-space:nowrap">${Utils.escapeHtml(tool.name || r.source)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:11px;color:var(--primary);white-space:nowrap">${Utils.escapeHtml(r.issueId)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${Utils.escapeHtml(r.application)}</span>`,
          Utils.escapeHtml(r.title),
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)">${Utils.escapeHtml(r.affectedEntities)}</span>`,
          `<span class="chip ${sevCls}">${Utils.escapeHtml(r.severity)}</span>`,
          `<span style="font-family:var(--font-sans);font-size:11px">${Utils.escapeHtml(r.category)}</span>`,
          `<span style="font-size:11px">${Utils.escapeHtml(r.description)}</span>`,
          `<span class="chip ${staCls}">${Utils.escapeHtml(r.status)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.startTime)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.endTime)}</span>`,
          `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(r.duration)}</span>`,
          `<div class="action-cell">
            <button class="btn-icon copy-btn" data-copy="${Utils.escapeHtml(r.id)}" title="Copy issue details">
              <i data-lucide="copy" style="width:14px;height:14px"></i>
            </button>
            <a href="${Utils.escapeHtml(tool.url || "#")}" target="_blank" rel="noopener" class="btn-icon" title="Open in tool" onclick="event.stopPropagation()">
              <i data-lucide="external-link" style="width:14px;height:14px"></i>
            </a>
          </div>`,
          r.id,  // col 14 — hidden
        ];
      });
    }

    function renderTableDT(filtered) {
      const rowData = buildRowData(filtered);

      if (state.dtInstance) {
        state.dtInstance.clear().rows.add(rowData).draw(false);
        // drawCallback uses state.currentFilteredRows which is always fresh
        return;
      }

      // First init — use jQuery jQ, not byId
      state.dtInstance = jQ("#issues-table").DataTable({
        data: rowData,
        columns: [
          { title: "Sr. No.",           width: "60px"  },
          { title: "Source",            width: "100px" },
          { title: "Issue ID",          width: "110px" },
          { title: "Application",       width: "120px" },
          { title: "Title",             width: "180px" },
          { title: "Affected Entities", width: "130px" },
          { title: "Severity",          width: "90px"  },
          { title: "Category",          width: "130px" },
          { title: "Description",       width: "180px" },
          { title: "Status",            width: "90px"  },
          { title: "Start Time",        width: "130px" },
          { title: "End Time",          width: "130px" },
          { title: "Duration",          width: "90px"  },
          { title: "Action",            orderable: false, width: "80px" },
          { title: "_id",               visible: false },
        ],
        pageLength: 10,
        lengthMenu: [10, 25, 50, 100],
        order: [[0, "asc"]],
        scrollX: true,
        autoWidth: false,
        language: {
          emptyTable:   "No issues found.",
          info:         "Showing _START_ to _END_ of _TOTAL_ entries",
          infoEmpty:    "No entries",
          infoFiltered: "(filtered from _MAX_ total)",
          search:       "Table filter:",
          lengthMenu:   "Show _MENU_ entries",
          paginate:     { first: "«", last: "»", next: "›", previous: "‹" },
        },
        drawCallback: function () {
          // Always read from state.currentFilteredRows — never a stale closure
          bindTableEvents(state.currentFilteredRows);
          Utils.refreshIcons();
        },
      });
    }

    function bindTableEvents(allRows) {
      document.querySelectorAll("#issues-table tbody tr").forEach(tr => {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function (e) {
          if (e.target.closest(".action-cell")) return;
          const dtRow = state.dtInstance.row(tr).data();
          if (!dtRow) return;
          const id  = dtRow[14];
          const row = allRows.find(r => r.id === id);
          if (row) openDetailModal(row);
        });
      });

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
      if (!state.dtInstance) return getFilteredIssues();
      const ids = state.dtInstance.rows({ search: "applied" }).data().toArray().map(d => d[14]);
      const lookup = new Map(getFilteredIssues().map(r => [r.id, r]));
      return ids.map(id => lookup.get(id)).filter(Boolean);
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

    byId("btn-export").addEventListener("click", e => {
      e.stopPropagation();
      exportMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => exportMenu.classList.add("hidden"));

    byId("export-csv").addEventListener("click", () => {
      const rows = getExportRows();
      const hdrs = ["Sr.No","Source","Issue ID","Application","Title","Affected Entities","Severity","Category","Description","Status","Start Time","End Time","Duration"];
      const lines = rows.map(r =>
        [r.srNo, r.source, r.issueId, r.application, r.title, r.affectedEntities,
         r.severity, r.category, `"${r.description.replace(/"/g, '""')}"`,
         r.status, r.startTime, r.endTime, r.duration].join(",")
      );
      const blob = new Blob([[hdrs.join(","), ...lines].join("\n")], { type: "text/csv" });
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: "issues.csv" }).click();
      URL.revokeObjectURL(url);
      exportMenu.classList.add("hidden");
    });

    byId("export-excel").addEventListener("click", () => {
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
      Object.assign(document.createElement("a"), { href: url, download: "issues.xls" }).click();
      URL.revokeObjectURL(url);
      exportMenu.classList.add("hidden");
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 15. EVENT WIRING
    // ═══════════════════════════════════════════════════════════════════════════

    globalSearch.addEventListener("input", Utils.debounce(e => {
      state.globalKeyword = e.target.value;
      render();
    }, 250));

    timeRangeSelect.addEventListener("change", e => {
      state.timeRange = e.target.value;
      render();
    });

    customStart.addEventListener("change", e => { state.customStart = e.target.value; render(); });
    customEnd.addEventListener("change",   e => { state.customEnd   = e.target.value; render(); });

    byId("tool-all").addEventListener("click", () => setActiveTool("all"));

    function setActiveTool(toolId) {
      state.activeTool = toolId;
      byId("tool-all").classList.toggle("active", toolId === "all");
      const check = byId("tool-all-check");
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

    byId("btn-clear-filters").addEventListener("click", clearAllFilters);

    // Change 3 — manual refresh: triggers Java fetch via middleware, then waits
    // for the deferred pollStatus() to detect and load the new file.
    // Does NOT call loadIssues() directly. Countdown and filters are untouched.
    btnRefresh.addEventListener("click", async () => {
      if (state.isFetching || state.isRefreshPending) return;
      state.isRefreshPending = true;
      setRefreshBusy(true);
      try {
        const result = await API.triggerRefresh();
        if (result && result.scheduled) {
          // Schedule a single status poll after the indicated delay (~60 s)
          setTimeout(async () => {
            await pollStatus();
            state.isRefreshPending = false;
            setRefreshBusy(false);
          }, (result.checkIn || 60) * 1000);
        } else {
          // Middleware responded but didn't schedule — reset immediately
          state.isRefreshPending = false;
          setRefreshBusy(false);
        }
      } catch {
        // Network error — reset state so button is usable again
        state.isRefreshPending = false;
        setRefreshBusy(false);
      }
      // Note: countdown untouched, filters untouched
    });

    uiRefreshInput.addEventListener("change", e => {
      state.uiRefreshMin = Math.max(1, parseInt(e.target.value) || 1);
      resetCountdown();
    });

    // Section toggles — fix regex: use literal \w not \\w
    ["issue-details", "kpis"].forEach(id => {
      const key  = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // camelCase without regex escape bug
      const btn  = byId(`toggle-${id}`);
      const body = byId(`${id}-body`);
      if (!btn || !body) return;
      btn.addEventListener("click", () => {
        state.sections[key] = !state.sections[key];
        btn.classList.toggle("collapsed", !state.sections[key]);
        body.classList.toggle("hidden", !state.sections[key]);
        Utils.refreshIcons();
      });
    });

    matrixLeft.addEventListener("click",  () => { state.matrixOffset = Math.max(0, state.matrixOffset - 1); renderMatrix(getFilteredIssues()); });
    matrixRight.addEventListener("click", () => { state.matrixOffset++; renderMatrix(getFilteredIssues()); });

    // ═══════════════════════════════════════════════════════════════════════════
    // 16. COUNTDOWN + PERIODIC REFRESH (Change 4)
    // ═══════════════════════════════════════════════════════════════════════════

    let countdownTimer = null;

    function resetCountdown() {
      state.countdown = Math.max(1, state.uiRefreshMin) * 60;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        state.countdown--;
        updateStatusBar(); // direct DOM write — no recreation of interval-breaking elements
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

    // Change 3 — poll /api/status at the configured interval (default 300 s / 5 min).
    // headCheck() is removed; pollStatus() owns all data-availability detection.
    const CHECK_INTERVAL_MS = (CFG.SETTINGS_DEFAULTS?.periodicCheckTime ?? 300) * 1000;
    setInterval(pollStatus, CHECK_INTERVAL_MS);

    // ═══════════════════════════════════════════════════════════════════════════
    // 17. HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function clearAllFilters() {
      state.globalKeyword   = "";
      state.statusFilter    = null;
      state.categoryFilters = [];
      state.tableSearch     = "";
      globalSearch.value    = "";
      if (state.dtInstance) state.dtInstance.search("").draw(false);
      render();
    }

    function showError(msg) { errorMsg.textContent = msg; errorBanner.classList.remove("hidden"); }
    function hideError()    { errorBanner.classList.add("hidden"); }

    // ═══════════════════════════════════════════════════════════════════════════
    // 18. BOOT
    // ═══════════════════════════════════════════════════════════════════════════

    await loadAllData();
    pollStatus();      // Change 3 — initial status check on boot
    resetCountdown();
    Utils.refreshIcons();
  });
})();