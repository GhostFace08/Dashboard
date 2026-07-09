/**
 * ai_chat.js — AI Chat page logic
 *
 * FIX #3: initHeader() called without arguments (auto-detects from pathname).
 *
 * CURRENT BEHAVIOUR:
 *   postChat() always returns CFG.CHAT_FALLBACK_REPLY immediately.
 *   No backend call is made. One TODO comment marks where to wire it.
 *
 * FEATURES:
 *   - Multi-session sidebar (pinned-first, then createdAt desc)
 *   - Session operations: create / rename (prompt) / pin-toggle / delete (confirm)
 *   - File attachments: display chips, pass metadata in message object
 *   - Auto-growing textarea (Shift+Enter = newline, Enter = send)
 *   - Thinking dots shown while "waiting" for reply
 *   - Markdown-lite renderer: **bold**, blank line → spacer, otherwise plain para
 *   - Context-menu (pin / rename / delete) positioned absolutely, closes on outside click
 *   - State held entirely in memory; no localStorage
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) { console.error("[ai_chat] CFG missing — load config.js first"); return; }
  if (!global.API) { console.error("[ai_chat] API missing — load api.js first");    return; }

  /* ─── Constants ──────────────────────────────────────────────────────────── */
  const FALLBACK_REPLY = CFG.CHAT_FALLBACK_REPLY || "Backend unavailable.";

  /* ─── State ──────────────────────────────────────────────────────────────── */
  let sessions  = (CFG.SEED_CHAT_SESSIONS || []).map(s => ({
    ...s,
    messages: s.messages.map(m => ({ ...m })),
  }));
  let activeId       = null;
  let pendingFiles   = [];
  let isSending      = false;
  let openMenuId     = null;

  /* ─── Tiny helpers ───────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  function nowTs() {
    return new Date().toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }

  function uid() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

  function getSession(id) { return sessions.find(s => s.id === id) || null; }

  function sortedSessions() {
    return [...sessions].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        return (b.pinnedAt || b.createdAt) - (a.pinnedAt || a.createdAt);
      }
      return b.createdAt - a.createdAt;
    });
  }

  /* ─── Markdown-lite renderer ─────────────────────────────────────────────── */
  function renderMarkdown(text) {
    const lines = text.split("\n");
    let html = "";
    for (const line of lines) {
      if (!line.trim()) {
        html += `<div style="height:8px"></div>`;
        continue;
      }
      const safe = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html += `<p>${safe}</p>`;
    }
    return html;
  }

  /* ─── File chip builder ──────────────────────────────────────────────────── */
  function buildFileChipHTML(file, showRemove, idx) {
    const icon = file.type === "image" ? "image" : "file-text";
    const removeBtn = showRemove
      ? `<button class="chip-remove" data-idx="${idx}" aria-label="Remove ${file.name}">
           <i data-lucide="x"></i>
         </button>`
      : "";
    return `
      <div class="aic-file-chip">
        <i data-lucide="${icon}"></i>
        <span class="chip-name">${escHtml(file.name)}</span>
        <span class="chip-size">${escHtml(file.size)}</span>
        ${removeBtn}
      </div>`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ─── Message HTML builder ───────────────────────────────────────────────── */
  function buildMessageHTML(msg) {
    const isUser = msg.role === "user";
    const isAI   = msg.role === "assistant";
    const rowCls = isUser ? "aic-msg-row user" : "aic-msg-row assistant";

    if (msg.thinking) {
      return `
        <div class="${rowCls}" data-msg-id="${msg.id}">
          <div class="aic-avatar ai"><i data-lucide="sparkles"></i></div>
          <div class="aic-bubble-col">
            <div class="aic-thinking">
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
              <span class="thinking-lbl">Analysing…</span>
            </div>
          </div>
        </div>`;
    }

    let fileChipsHTML = "";
    if (msg.files && msg.files.length) {
      const chipsInner = msg.files.map(f => buildFileChipHTML(f, false, 0)).join("");
      fileChipsHTML = `<div class="aic-file-chips">${chipsInner}</div>`;
    }

    const bubbleContent = isAI
      ? renderMarkdown(msg.content)
      : `<p>${escHtml(msg.content)}</p>`;

    const avatarInner = isAI
      ? `<i data-lucide="sparkles"></i>`
      : `<span class="aic-user-icon">U</span>`;
    const avatarCls = isAI ? "ai" : "user";
    const bubbleCls = isAI ? "ai" : "user";

    const ts = msg.timestamp
      ? `<span class="aic-timestamp">${escHtml(msg.timestamp)}</span>`
      : "";

    return `
      <div class="${rowCls}" data-msg-id="${msg.id}">
        <div class="aic-avatar ${avatarCls}">${avatarInner}</div>
        <div class="aic-bubble-col">
          ${fileChipsHTML}
          <div class="aic-bubble ${bubbleCls}">${bubbleContent}</div>
          ${ts}
        </div>
      </div>`;
  }

  /* ─── Session list renderer ──────────────────────────────────────────────── */
  function renderSessionList() {
    const listEl = el("session-list");
    if (!listEl) return;

    const sorted = sortedSessions();
    if (!sorted.length) {
      listEl.innerHTML = `<p style="font-size:11px;color:var(--muted-foreground);padding:8px 8px;font-family:var(--font-mono)">No chats yet.</p>`;
      return;
    }

    listEl.innerHTML = sorted.map(s => {
      const isActive = s.id === activeId;
      const isPinned = !!s.pinned;
      const pinIcon  = isPinned ? `<i data-lucide="pin" class="aic-session-pin-icon"></i>` : "";
      return `
        <div class="aic-session-item${isActive ? " active" : ""}" data-session-id="${s.id}">
          <button class="aic-session-btn" data-session-btn="${s.id}" aria-label="Open chat: ${escHtml(s.title)}">
            <div class="aic-session-title-row">
              <span class="aic-session-title">${escHtml(s.title)}</span>
              ${pinIcon}
            </div>
            <span class="aic-session-preview">${escHtml(s.preview || "")}</span>
          </button>
          <button class="aic-session-more" data-more-btn="${s.id}" aria-label="Options for ${escHtml(s.title)}" aria-haspopup="menu">
            <i data-lucide="more-vertical"></i>
          </button>
        </div>`;
    }).join("");

    refreshIcons();
  }

  /* ─── Message list renderer ──────────────────────────────────────────────── */
  function renderMessages() {
    const listEl = el("message-list");
    if (!listEl) return;

    const session = getSession(activeId);
    if (!session) {
      listEl.innerHTML = `
        <div class="aic-empty-state">
          <i data-lucide="message-square"></i>
          <p>Select a chat or start a new one.</p>
        </div>`;
      refreshIcons();
      return;
    }

    listEl.innerHTML = session.messages.map(m => buildMessageHTML(m)).join("");
    refreshIcons();
    scrollToBottom();
  }

  /* ─── Chat header ────────────────────────────────────────────────────────── */
  function renderChatHeader() {
    const session = getSession(activeId);
    const titleEl = el("chat-title");
    if (titleEl) titleEl.textContent = session ? session.title : "Select a chat";
  }

  /* ─── Full re-render ─────────────────────────────────────────────────────── */
  function render() {
    renderSessionList();
    renderMessages();
    renderChatHeader();
    updateSendBtn();
  }

  /* ─── Scroll to bottom ───────────────────────────────────────────────────── */
  function scrollToBottom() {
    const listEl = el("message-list");
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  /* ─── Send button enabled state ──────────────────────────────────────────── */
  function updateSendBtn() {
    const btn   = el("btn-send");
    const input = el("chat-input");
    if (!btn) return;
    const hasText  = input && input.value.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    btn.disabled = isSending || (!hasText && !hasFiles) || !activeId;
  }

  /* ─── refreshIcons wrapper ───────────────────────────────────────────────── */
  function refreshIcons() {
    if (global.Utils && typeof global.Utils.refreshIcons === "function") {
      global.Utils.refreshIcons();
    } else if (global.lucide) {
      global.lucide.createIcons();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SESSION OPERATIONS
  ═══════════════════════════════════════════════════════════════════════════ */

  function createNewSession() {
    const id       = `chat-${Date.now()}`;
    const greeting = "Hello! I'm your MCP Observability AI. I have full context across all connected sources.\n\nWhat would you like to explore?";
    const session  = {
      id,
      createdAt: Date.now(),
      title:     "New chat",
      preview:   greeting.slice(0, 60),
      pinned:    false,
      pinnedAt:  null,
      messages: [{
        id:        uid(),
        role:      "assistant",
        timestamp: nowTs(),
        content:   greeting,
      }],
    };
    sessions.unshift(session);
    setActiveSession(id);
  }

  function setActiveSession(id) {
    activeId = id;
    closeContextMenu();
    render();
  }

  function renameSession(id) {
    const s = getSession(id);
    if (!s) return;
    const next = window.prompt("Rename chat", s.title);
    if (next && next.trim()) {
      s.title = next.trim();
      render();
    }
    closeContextMenu();
  }

  function togglePinSession(id) {
    const s = getSession(id);
    if (!s) return;
    s.pinned    = !s.pinned;
    s.pinnedAt  = s.pinned ? Date.now() : null;
    renderSessionList();
    closeContextMenu();
  }

  function deleteSession(id) {
    const s = getSession(id);
    if (!s) return;
    if (!window.confirm(`Delete "${s.title}"?`)) { closeContextMenu(); return; }
    sessions = sessions.filter(x => x.id !== id);
    if (activeId === id) {
      activeId = sessions.length ? sortedSessions()[0].id : null;
    }
    render();
    closeContextMenu();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CONTEXT MENU
  ═══════════════════════════════════════════════════════════════════════════ */

  function openContextMenu(sessionId, anchorEl) {
    openMenuId = sessionId;
    const menuEl = el("session-menu");
    if (!menuEl) return;

    const s = getSession(sessionId);
    const pinLabel = el("menu-pin-label");
    if (pinLabel) pinLabel.textContent = s && s.pinned ? "Unpin chat" : "Pin chat to top";

    const rect = anchorEl.getBoundingClientRect();
    menuEl.style.top  = `${rect.bottom + 4}px`;
    menuEl.style.left = `${Math.min(rect.left, window.innerWidth - 170)}px`;

    menuEl.classList.remove("hidden");
    refreshIcons();
  }

  function closeContextMenu() {
    openMenuId = null;
    const menuEl = el("session-menu");
    if (menuEl) menuEl.classList.add("hidden");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MESSAGING
  ═══════════════════════════════════════════════════════════════════════════ */

  async function sendMessage() {
    if (isSending || !activeId) return;
    const inputEl = el("chat-input");
    if (!inputEl) return;

    const text  = inputEl.value.trim();
    const files = [...pendingFiles];
    if (!text && !files.length) return;

    isSending = true;
    updateSendBtn();

    inputEl.value = "";
    inputEl.style.height = "auto";
    pendingFiles = [];
    renderFilePreview();

    const session = getSession(activeId);
    if (!session) { isSending = false; updateSendBtn(); return; }

    const userMsg = {
      id:        uid(),
      role:      "user",
      timestamp: nowTs(),
      content:   text,
      files:     files.length ? files : undefined,
    };
    const thinkMsg = {
      id:       uid() + "-think",
      role:     "assistant",
      content:  "",
      thinking: true,
    };

    if (session.title === "New chat" && text) {
      session.title = text.slice(0, 40);
    }
    session.preview = text || session.preview;
    session.messages.push(userMsg, thinkMsg);

    renderMessages();
    renderSessionList();

    try {
      const response = await API.postChat({
        sessionId: activeId,
        message:   text,
        history:   session.messages
          .filter(m => !m.thinking)
          .map(m => ({ role: m.role, content: m.content })),
      });
      const replyText = (response && response.reply) ? response.reply : FALLBACK_REPLY;

      session.messages = session.messages.filter(m => !m.thinking);
      session.messages.push({
        id:        uid() + "-reply",
        role:      "assistant",
        timestamp: nowTs(),
        content:   replyText,
      });
    } catch (err) {
      console.warn("[ai_chat] sendMessage error:", err);
      session.messages = session.messages.filter(m => !m.thinking);
      session.messages.push({
        id:        uid() + "-err",
        role:      "assistant",
        timestamp: nowTs(),
        content:   FALLBACK_REPLY,
      });
    } finally {
      isSending = false;
      updateSendBtn();
      renderMessages();
      renderSessionList();
    }
  }

  /* ─── File handling ──────────────────────────────────────────────────────── */

  function handleFileInput(e) {
    const fileList = e.target.files;
    if (!fileList) return;
    for (const f of fileList) {
      pendingFiles.push({
        name: f.name,
        size: `${(f.size / 1024).toFixed(1)} KB`,
        type: f.type.startsWith("image/") ? "image" : "file",
      });
    }
    e.target.value = "";
    renderFilePreview();
    updateSendBtn();
  }

  function removeFile(idx) {
    pendingFiles.splice(idx, 1);
    renderFilePreview();
    updateSendBtn();
  }

  function renderFilePreview() {
    const bar = el("file-preview");
    if (!bar) return;
    if (!pendingFiles.length) {
      bar.innerHTML = "";
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    bar.innerHTML = pendingFiles.map((f, i) => buildFileChipHTML(f, true, i)).join("");
    refreshIcons();

    bar.querySelectorAll(".chip-remove").forEach(btn => {
      btn.addEventListener("click", () => removeFile(parseInt(btn.dataset.idx, 10)));
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENT WIRING
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireEvents() {

    const newBtn       = el("btn-new-chat");
    const headerNewBtn = el("btn-header-new-chat");
    if (newBtn)       newBtn.addEventListener("click",       () => createNewSession());
    if (headerNewBtn) headerNewBtn.addEventListener("click", () => createNewSession());

    const listEl = el("session-list");
    if (listEl) {
      listEl.addEventListener("click", e => {
        const sessionBtn = e.target.closest("[data-session-btn]");
        if (sessionBtn) {
          const id = sessionBtn.dataset.sessionBtn;
          if (id !== activeId) setActiveSession(id);
          return;
        }
        const moreBtn = e.target.closest("[data-more-btn]");
        if (moreBtn) {
          e.stopPropagation();
          const id = moreBtn.dataset.moreBtn;
          if (openMenuId === id) {
            closeContextMenu();
          } else {
            openContextMenu(id, moreBtn);
          }
        }
      });
    }

    const menuEl = el("session-menu");
    if (menuEl) {
      menuEl.addEventListener("click", e => {
        const item = e.target.closest("[data-action]");
        if (!item || !openMenuId) return;
        const action = item.dataset.action;
        if (action === "pin")    togglePinSession(openMenuId);
        if (action === "rename") renameSession(openMenuId);
        if (action === "delete") deleteSession(openMenuId);
      });
    }

    document.addEventListener("click", e => {
      if (!openMenuId) return;
      const menu = el("session-menu");
      if (menu && !menu.contains(e.target)) closeContextMenu();
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && openMenuId) closeContextMenu();
    });

    const inputEl = el("chat-input");
    if (inputEl) {
      inputEl.addEventListener("input", () => {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
        updateSendBtn();
      });
      inputEl.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    const sendBtn = el("btn-send");
    if (sendBtn) sendBtn.addEventListener("click", () => sendMessage());

    const attachBtn  = el("btn-attach");
    const fileInput  = el("file-input");
    if (attachBtn && fileInput) {
      attachBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", handleFileInput);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BOOTSTRAP
  ═══════════════════════════════════════════════════════════════════════════ */

  document.addEventListener("DOMContentLoaded", () => {

    /* 1. Shared header — FIX #3: no argument, auto-detects from pathname */
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }

    /* 2. Stamp static lucide icons */
    if (global.lucide) global.lucide.createIcons();

    /* 3. Set default active session to first pinned, then first overall */
    const sorted = sortedSessions();
    activeId = sorted.length ? sorted[0].id : null;

    /* 4. Initial render */
    render();

    /* 5. Wire all interactions */
    wireEvents();
  });

  /* ─── Public surface (debug) ─────────────────────────────────────────────── */
  global.AIC = {
    getSessions:  () => sessions,
    getActiveId:  () => activeId,
    createChat:   createNewSession,
    sendMessage:  sendMessage,
  };

})(window);