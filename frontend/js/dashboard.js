/**
 * dashboard.js — Unified MCP Dashboard
 * Depends on: config.js (window.CFG), api.js (window.API), common.js (window.Utils)
 *
 * On load:
 *   1. Init header + theme
 *   2. Fetch mapping.json + category.json from API
 *   3. Fetch all_issues.json from API, normalise via Utils
 *   4. Build UI: status cards, KPIs, graph, evaluation matrix, issues table
 *   5. Wire all interactive controls
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // 0. WAIT FOR DOM
  // ═══════════════════════════════════════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", async () => {
    Utils.initHeader();

    // ─── State ───────────────────────────────────────────────────────────────
    const state = {
      allIssues:      [],   // normalised, flat IssueRow[]
      mapping:        {},   // from mapping.json
      categoryRules:  [],   // from category.json

      activeTool:     "all",
      timeRange:      "15 min",
      customStart:    "",
      customEnd:      "",

      statusFilter:   null,        // null | "all" | "Active" | "Resolved"
      categoryFilters:[],          // Category[]

      globalKeyword:  "",
      tableSearch:    "",

      sortCol:        "srNo",
      sortDir:        "asc",
      pageSize:       10,
      currentPage:    1,

      uiRefreshMin:   1,
      countdown:      60,

      // Timestamps
      fileModified:   null,
      fileUpdated:    null,
      fileChecked:    null,

      // Chart instance
      chartInstance:  null,

      // Matrix sliding window
      matrixOffset:   0,
      MATRIX_VISIBLE: 6,

      // Sections open/closed
      sections: { issueDetails: true, kpis: true, graph: true },

      // Modal
      detailRow: null,

      // Copied row id
      copiedId: null,
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
    const countdownLabel  = $("countdown-label");
    const filterBar       = $("filter-bar");
    const filterTags      = $("filter-tags");
    const globalSearch    = $("global-search");
    const tableSearch     = $("table-search");
    const customStart     = $("custom-start");
    const customEnd       = $("custom-end");
    const timeRangeSelect = $("time-range-select");
    const uiRefreshInput  = $("ui-refresh-input");
    const toolBtns        = $("tool-btns");
    const statusCards     = $("status-cards");
    const kpiCards        = $("kpi-cards");
    const graphSubtitle   = $("graph-subtitle");
    const issuesTbody     = $("issues-tbody");
    const tableCount      = $("table-count");
    const pagination      = $("pagination");
    const matrixTable     = $("matrix-table");
    const matrixLeft      = $("matrix-left");
    const matrixRight     = $("matrix-right");
    const showEntries     = $("show-entries");
    const detailModal     = $("detail-modal");
    const modalTitle      = $("modal-title");
    const modalFields     = $("modal-fields");
    const modalClose      = $("modal-close");
    const exportMenu      = $("export-menu");
    const customRangeInfo = $("custom-range-info");
    const customRangeErr  = $("custom-range-error");

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. POPULATE STATIC UI ELEMENTS
    // ═══════════════════════════════════════════════════════════════════════════

    // Time range options
    CFG.TIME_RANGE_OPTIONS.forEach(opt => {
      const el = document.createElement("option");
      el.value = opt;
      el.textContent = opt;
      if (opt === "15 min") el.selected = true;
      timeRangeSelect.appendChild(el);
    });

    // Tool buttons
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
      // Load mapping + categories in parallel, then issues
      const [mappingRaw, categoryRaw] = await Promise.all([
        API.getConfig("mapping.json"),
        API.getConfig("category.json"),
      ]);

      try { state.mapping = JSON.parse(mappingRaw) || {}; } catch { state.mapping = CFG.DEFAULT_MAPPING || {}; }
      try { state.categoryRules = JSON.parse(categoryRaw) || []; } catch { state.categoryRules = CFG.DEFAULT_CATEGORY_RULES || []; }

      await loadIssues();
    }

    async function loadIssues() {
      const raw = await API.getIssues();
      if (!raw || !Array.isArray(raw.allIssues)) {
        showError("Failed to load issues — backend returned no data.");
        return;
      }
      hideError();
      const rows = Utils.normalizeAllIssues(raw, state.mapping, state.categoryRules);

      // Compute max start timestamp → "Last Data Loaded At"
      const maxTs = rows.reduce((m, r) => Math.max(m, r.ts || 0), 0);
      state.fileUpdated  = new Date();
      state.fileModified = maxTs ? new Date(maxTs) : state.fileUpdated;

      state.allIssues = rows;
      state.currentPage = 1;
      render();
    }

    // Periodic HEAD check for file changes
    async function headCheck() {
      try {
        const resp = await fetch("../../backend/data/all_issues.json", { method: "HEAD", cache: "no-store" });
        state.fileChecked = new Date();
        const lm = resp.headers.get("last-modified");
        if (lm) state.fileModified = new Date(lm);
      } catch { /* ignore */ }
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
      renderKPIs(filtered);
      renderGraph(filtered);
      renderMatrix(filtered);
      renderTable(filtered);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 5. STATUS BAR
    // ═══════════════════════════════════════════════════════════════════════════

    function updateStatusBar() {
      statusLeft.innerHTML =
        `Last Data Modified At: ${Utils.formatHeaderDate(state.fileModified)} &nbsp;|&nbsp; ` +
        `Last Data Updated At: ${Utils.formatHeaderDate(state.fileUpdated)}`;
      statusRight.innerHTML =
        `Last Data Checked At: ${Utils.formatHeaderDate(state.fileChecked)} &nbsp;|&nbsp; ` +
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
        { label: "Total",    count: total,    breakdown: toolBreakdown(filtered),                             value: "all"      },
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
          state.currentPage = 1;
          render();
        });
      });

      Utils.refreshIcons();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 9. KPIS
    // ═══════════════════════════════════════════════════════════════════════════

    function renderKPIs(filtered) {
      kpiCards.innerHTML = CFG.CATEGORIES.map(cat => {
        const catRows  = filtered.filter(r => r.category === cat);
        const count    = catRows.length;
        const critical = catRows.filter(r => r.severity === "Critical").length;
        const errors   = catRows.filter(r => r.category === "Application Error").length;
        const selected = state.categoryFilters.includes(cat);
        return `
          <button class="kpi-card${selected ? " selected" : ""}" data-cat="${Utils.escapeHtml(cat)}">
            <span class="kpi-label">${Utils.escapeHtml(cat)}</span>
            <span class="kpi-count">${count}</span>
            <span class="kpi-meta">Critical ${critical} | Error ${errors}</span>
          </button>
        `;
      }).join("");

      kpiCards.querySelectorAll(".kpi-card").forEach(btn => {
        btn.addEventListener("click", () => {
          const cat = btn.dataset.cat;
          if (state.categoryFilters.includes(cat)) {
            state.categoryFilters = state.categoryFilters.filter(c => c !== cat);
          } else {
            state.categoryFilters = [...state.categoryFilters, cat];
          }
          state.currentPage = 1;
          render();
        });
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 10. GRAPH
    // ═══════════════════════════════════════════════════════════════════════════

    function buildGraphData(filtered) {
      const { startMs, endMs } = getActiveWindow();
      const spanMs = Math.max(0, endMs - startMs);
      const hourly = spanMs <= 24 * 3600 * 1000;
      const bucketMs = hourly ? 3600 * 1000 : 24 * 3600 * 1000;

      const startDate = new Date(startMs);
      if (hourly) startDate.setMinutes(0, 0, 0);
      else startDate.setHours(0, 0, 0, 0);

      const buckets = [];
      for (let t = startDate.getTime(); t <= endMs; t += bucketMs) buckets.push(t);
      if (!buckets.length) buckets.push(startDate.getTime());

      return buckets.map((bucketStart, i) => {
        const bucketEnd = i === buckets.length - 1 ? endMs : buckets[i + 1] - 1;
        const bi = filtered.filter(r => r.ts >= bucketStart && r.ts <= bucketEnd);
        const row = {
          time: hourly
            ? new Date(bucketStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : new Date(bucketStart).toLocaleDateString("en-GB", { weekday: "short" }),
          total: bi.length,
        };
        CFG.TOOLS.forEach(t => { row[t.id] = bi.filter(r => r.source === t.id).length; });
        return row;
      });
    }

    function renderGraph(filtered) {
      const toolName = state.activeTool === "all" ? "All Sources" : (CFG.TOOL_MAP[state.activeTool]?.name || state.activeTool);
      graphSubtitle.textContent = `${toolName} · ${state.timeRange}`;

      const data = buildGraphData(filtered);
      const labels  = data.map(d => d.time);
      const totals  = state.activeTool === "all"
        ? data.map(d => d.total)
        : data.map(d => d[state.activeTool] || 0);

      const canvas = $("issues-chart");
      if (!canvas) return;

      if (state.chartInstance) {
        // Update in-place — never recreate
        state.chartInstance.data.labels = labels;
        state.chartInstance.data.datasets[0].data = totals;
        state.chartInstance.update();
        return;
      }

      // First render — create chart
      state.chartInstance = new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "Total",
            data: totals,
            borderColor: "#6366f1",
            backgroundColor: "rgba(99,102,241,.1)",
            borderWidth: 2,
            pointBackgroundColor: "#6366f1",
            pointRadius: 4,
            tension: 0.3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "var(--card)",
              titleColor: "var(--foreground)",
              bodyColor: "var(--muted-foreground)",
              borderColor: "var(--border)",
              borderWidth: 1,
              titleFont: { family: "'JetBrains Mono', monospace", size: 12, weight: "600" },
              bodyFont:  { family: "'JetBrains Mono', monospace", size: 10 },
            },
          },
          scales: {
            x: {
              grid: { color: "rgba(127,127,127,.15)" },
              ticks: { color: "var(--muted-foreground)", font: { family: "'JetBrains Mono', monospace", size: 10 } },
            },
            y: {
              grid: { color: "rgba(127,127,127,.15)" },
              ticks: { color: "var(--muted-foreground)", font: { family: "'JetBrains Mono', monospace", size: 10 } },
              title: { display: true, text: "Count", color: "var(--muted-foreground)", font: { size: 10 } },
            },
          },
        },
      });
    }

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
      const cols = buildMatrixCols(filtered);
      const visible = cols.slice(state.matrixOffset, state.matrixOffset + state.MATRIX_VISIBLE);

      matrixLeft.disabled  = state.matrixOffset === 0;
      matrixRight.disabled = state.matrixOffset >= Math.max(0, cols.length - state.MATRIX_VISIBLE);

      if (cols.length === 0) {
        matrixTable.innerHTML = `<tr><td class="matrix-empty" colspan="2">No data in selected time range.</td></tr>`;
        return;
      }

      let html = "<thead>";
      // Row 1: Application names
      html += `<tr><th class="cat-col" rowspan="2">CATEGORY /<br>APPLICATIONS</th>`;
      visible.forEach(c => { html += `<th>${Utils.escapeHtml(c.app)}</th>`; });
      html += "</tr>";
      // Row 2: Source names
      html += "<tr>";
      visible.forEach(c => { html += `<th>${Utils.escapeHtml(c.toolName)}</th>`; });
      html += "</tr></thead><tbody>";

      CFG.CATEGORIES.forEach(cat => {
        // Category total across all cols (not just visible) for sidebar label
        const allCols = cols.map(c => cellCounts(filtered, cat, c.app, c.tool));
        const catTotal   = allCols.reduce((s, x) => s + x.total, 0);
        const catOpen    = allCols.reduce((s, x) => s + x.open,  0);

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
    // 12. TABLE
    // ═══════════════════════════════════════════════════════════════════════════

    function getSortedFiltered(filtered) {
      let rows = [...filtered];

      // Apply table search on top of global filter
      if (state.tableSearch) {
        const ts = state.tableSearch.toLowerCase();
        rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(ts)));
      }

      rows.sort((a, b) => {
        const dir = state.sortDir === "asc" ? 1 : -1;
        if (state.sortCol === "startTime") return (a.ts - b.ts) * dir;
        if (state.sortCol === "endTime")   return ((a.endTs ?? a.ts) - (b.endTs ?? b.ts)) * dir;
        if (state.sortCol === "duration")  return (((a.endTs ?? Date.now()) - a.ts) - ((b.endTs ?? Date.now()) - b.ts)) * dir;
        const av = String(a[state.sortCol] ?? "");
        const bv = String(b[state.sortCol] ?? "");
        return av.localeCompare(bv, undefined, { numeric: true }) * dir;
      });

      return rows;
    }

    function renderTable(filtered) {
      const rows = getSortedFiltered(filtered);
      const total = rows.length;
      const ps    = state.pageSize;
      const totalPages = Math.max(1, Math.ceil(total / ps));
      state.currentPage = Math.min(state.currentPage, totalPages);

      const start = (state.currentPage - 1) * ps;
      const page  = rows.slice(start, start + ps);

      // Update sort arrow indicators in thead
      document.querySelectorAll("#issues-table thead th[data-col]").forEach(th => {
        const col = th.dataset.col;
        const icon = th.querySelector("i[data-lucide]");
        if (!icon) return;
        if (col === state.sortCol) {
          icon.dataset.lucide = state.sortDir === "asc" ? "arrow-up" : "arrow-down";
          icon.style.opacity = "1";
          icon.style.color = "var(--primary)";
        } else {
          icon.dataset.lucide = "arrow-up-down";
          icon.style.opacity = ".3";
          icon.style.color = "";
        }
      });

      // Table body
      if (page.length === 0) {
        issuesTbody.innerHTML = `<tr><td colspan="14" class="table-empty">No issues found.</td></tr>`;
      } else {
        issuesTbody.innerHTML = page.map(row => {
          const tool = CFG.TOOL_MAP[row.source] || {};
          const sevCls = { Critical: "chip-critical", High: "chip-high", Medium: "chip-medium", Low: "chip-low" }[row.severity] || "chip-low";
          const staCls = row.status === "Active" ? "chip-active" : "chip-resolved";
          const copied = state.copiedId === row.id;
          return `
            <tr data-id="${Utils.escapeHtml(row.id)}" style="cursor:pointer">
              <td style="font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)">${row.srNo}</td>
              <td style="font-family:var(--font-mono);font-size:11px;font-weight:500;color:${tool.color || "var(--foreground)"};white-space:nowrap">
                ${Utils.escapeHtml(tool.name || row.source)}
              </td>
              <td style="font-family:var(--font-mono);font-size:11px;color:var(--primary);white-space:nowrap">
                ${Utils.escapeHtml(row.issueId)}
              </td>
              <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${Utils.escapeHtml(row.application)}</td>
              <td>${Utils.escapeHtml(row.title)}</td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)">${Utils.escapeHtml(row.affectedEntities)}</td>
              <td><span class="chip ${sevCls}">${Utils.escapeHtml(row.severity)}</span></td>
              <td style="font-family:var(--font-sans);font-size:11px;white-space:nowrap">${Utils.escapeHtml(row.category)}</td>
              <td style="font-size:11px">${Utils.escapeHtml(row.description)}</td>
              <td><span class="chip ${staCls}">${Utils.escapeHtml(row.status)}</span></td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(row.startTime)}</td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(row.endTime)}</td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(row.duration)}</td>
              <td onclick="event.stopPropagation()">
                <div class="action-cell">
                  <button class="btn-icon copy-btn${copied ? " copied" : ""}" data-copy="${Utils.escapeHtml(row.id)}" title="Copy issue details">
                    <i data-lucide="${copied ? "check" : "copy"}" style="width:14px;height:14px"></i>
                  </button>
                  <a href="${Utils.escapeHtml(tool.url || "#")}" target="_blank" rel="noopener" class="btn-icon" title="Open in tool" onclick="event.stopPropagation()">
                    <i data-lucide="external-link" style="width:14px;height:14px"></i>
                  </a>
                </div>
              </td>
            </tr>
          `;
        }).join("");

        // Row click → detail modal
        issuesTbody.querySelectorAll("tr[data-id]").forEach(tr => {
          tr.addEventListener("click", () => {
            const id = tr.dataset.id;
            const row = rows.find(r => r.id === id);
            if (row) openDetailModal(row);
          });
        });

        // Copy buttons
        issuesTbody.querySelectorAll(".copy-btn").forEach(btn => {
          btn.addEventListener("click", e => {
            e.stopPropagation();
            const id  = btn.dataset.copy;
            const row = rows.find(r => r.id === id);
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
              state.copiedId = id;
              setTimeout(() => { state.copiedId = null; renderTable(filtered); }, 1500);
              renderTable(filtered);
            });
          });
        });
      }

      // Pagination count
      tableCount.textContent = total === 0
        ? "No entries"
        : `Showing ${start + 1}–${Math.min(start + ps, total)} of ${total} entries`;

      // Pagination buttons
      renderPagination(totalPages);

      Utils.refreshIcons();
    }

    function renderPagination(totalPages) {
      let html = "";
      for (let p = 1; p <= totalPages; p++) {
        html += `<button class="page-btn${p === state.currentPage ? " active" : ""}" data-page="${p}">${p}</button>`;
      }
      pagination.innerHTML = html;
      pagination.querySelectorAll(".page-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          state.currentPage = Number(btn.dataset.page);
          renderTable(getFilteredIssues());
        });
      });
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
    }

    function closeDetailModal() {
      detailModal.classList.add("hidden");
    }

    detailModal.addEventListener("click", closeDetailModal);
    modalClose.addEventListener("click", closeDetailModal);

    // ═══════════════════════════════════════════════════════════════════════════
    // 14. EXPORT
    // ═══════════════════════════════════════════════════════════════════════════

    function getExportRows() {
      return getSortedFiltered(getFilteredIssues());
    }

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

    // Global search (debounced)
    globalSearch.addEventListener("input", Utils.debounce(e => {
      state.globalKeyword = e.target.value;
      state.currentPage = 1;
      render();
    }, 250));

    // Table search
    tableSearch.addEventListener("input", Utils.debounce(e => {
      state.tableSearch = e.target.value;
      state.currentPage = 1;
      renderTable(getFilteredIssues());
      updateFilterBar();
    }, 250));

    // Time range
    timeRangeSelect.addEventListener("change", e => {
      state.timeRange = e.target.value;
      state.currentPage = 1;
      render();
    });

    // Custom date pickers
    customStart.addEventListener("change", e => { state.customStart = e.target.value; state.currentPage = 1; render(); });
    customEnd.addEventListener("change",   e => { state.customEnd   = e.target.value; state.currentPage = 1; render(); });

    // Tool buttons
    $("tool-all").addEventListener("click", () => setActiveTool("all"));

    function setActiveTool(toolId) {
      state.activeTool = toolId;
      // Update tool button active states
      $("tool-all").classList.toggle("active", toolId === "all");
      const check = document.getElementById("tool-all-check");
      if (check) check.style.display = toolId === "all" ? "" : "none";
      document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
        const t = CFG.TOOL_MAP[btn.dataset.tool];
        const isActive = btn.dataset.tool === toolId;
        btn.classList.toggle("active", isActive);
        if (t && isActive) {
          btn.style.borderColor  = t.color + "70";
          btn.style.background   = t.color + "22";
          btn.style.boxShadow    = `0 0 0 1px ${t.color}30`;
          btn.style.color        = t.color;
        } else if (t) {
          btn.style.borderColor  = "";
          btn.style.background   = "rgba(255,255,255,.02)";
          btn.style.boxShadow    = "";
          btn.style.color        = "";
        }
      });
      state.currentPage = 1;
      render();
    }

    // Show entries
    showEntries.addEventListener("change", e => {
      state.pageSize = Number(e.target.value);
      state.currentPage = 1;
      renderTable(getFilteredIssues());
    });

    // Previous / Next page buttons
    $("btn-prev").addEventListener("click", () => {
      if (state.currentPage > 1) { state.currentPage--; renderTable(getFilteredIssues()); }
    });
    $("btn-next").addEventListener("click", () => {
      const total = Math.max(1, Math.ceil(getSortedFiltered(getFilteredIssues()).length / state.pageSize));
      if (state.currentPage < total) { state.currentPage++; renderTable(getFilteredIssues()); }
    });

    // Clear filters
    $("btn-clear-filters").addEventListener("click", clearAllFilters);

    // Refresh button
    $("btn-refresh").addEventListener("click", () => {
      clearAllFilters();
      loadIssues();
      resetCountdown();
    });

    // UI Refresh interval
    uiRefreshInput.addEventListener("change", e => {
      state.uiRefreshMin = Math.max(1, parseInt(e.target.value) || 1);
      resetCountdown();
    });

    // Collapsible section toggles
    ["issue-details", "kpis", "graph"].forEach(id => {
      const key = id.replace(/-(\w)/g, (_, c) => c.toUpperCase()); // camelCase
      const btn = $(`toggle-${id}`);
      const body = $(`${id}-body`);
      if (!btn || !body) return;
      btn.addEventListener("click", () => {
        state.sections[key] = !state.sections[key];
        btn.classList.toggle("collapsed", !state.sections[key]);
        body.classList.toggle("hidden", !state.sections[key]);
        Utils.refreshIcons();
      });
    });

    // Table header sort
    document.querySelectorAll("#issues-table thead th[data-col]").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (state.sortCol === col) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortCol = col;
          state.sortDir = "asc";
        }
        state.currentPage = 1;
        renderTable(getFilteredIssues());
      });
    });

    // Matrix navigation
    matrixLeft.addEventListener("click",  () => { state.matrixOffset = Math.max(0, state.matrixOffset - 1); renderMatrix(getFilteredIssues()); });
    matrixRight.addEventListener("click", () => { state.matrixOffset++; renderMatrix(getFilteredIssues()); });

    // ═══════════════════════════════════════════════════════════════════════════
    // 16. COUNTDOWN + PERIODIC REFRESH
    // ═══════════════════════════════════════════════════════════════════════════

    let countdownTimer = null;

    function resetCountdown() {
      state.countdown = Math.max(1, state.uiRefreshMin) * 60;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        state.countdown--;
        updateStatusBar();
        if (state.countdown <= 0) {
          state.countdown = Math.max(1, state.uiRefreshMin) * 60;
          // Refresh durations for Active issues
          const now = Date.now();
          state.allIssues = state.allIssues.map(r => {
            if (r.status !== "Active" || !r.ts) return r;
            return { ...r, duration: Utils.formatDuration(new Date(r.ts), null) };
          });
          render();
        }
      }, 1000);
    }

    // Periodic HEAD check every 60s
    setInterval(headCheck, 60000);

    // ═══════════════════════════════════════════════════════════════════════════
    // 17. HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function clearAllFilters() {
      state.globalKeyword    = "";
      state.statusFilter     = null;
      state.categoryFilters  = [];
      state.tableSearch      = "";
      state.currentPage      = 1;
      globalSearch.value     = "";
      tableSearch.value      = "";
      render();
    }

    function showError(msg) {
      errorMsg.textContent = msg;
      errorBanner.classList.remove("hidden");
    }
    function hideError() {
      errorBanner.classList.add("hidden");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 18. BOOT
    // ═══════════════════════════════════════════════════════════════════════════

    await loadAllData();
    headCheck();
    resetCountdown();
    Utils.refreshIcons();
  });
})();