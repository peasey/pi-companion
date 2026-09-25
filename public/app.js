/* Pi Companion — mobile PWA client (vanilla JS, no build step). */

const store = {
  get token() { return localStorage.getItem("pi.token") || ""; },
  set token(v) { localStorage.setItem("pi.token", v); },
  get server() { return localStorage.getItem("pi.server") || ""; },
  set server(v) { localStorage.setItem("pi.server", v); },
  get draft() { return sessionStorage.getItem("pi.draft") || ""; },
  set draft(v) { sessionStorage.setItem("pi.draft", v); },
};

function apiBase() {
  return store.server || ""; // same origin by default
}

async function api(path, opts = {}) {
  const res = await fetch(apiBase() + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${store.token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { showView("login"); throw new Error("unauthorized"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/* ---------------- routing ---------------- */

const views = { login: loginView, inbox: inboxView, chat: chatView };
let currentSessionId = null;

function showView(name) {
  for (const v of ["login", "inbox", "chat"]) {
    document.getElementById(`${v}-view`).hidden = v !== name;
  }
}

function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/session\/(.+)$/);
  if (m && store.token) {
    currentSessionId = m[1];
    openChat(currentSessionId);
  } else if (store.token) {
    currentSessionId = null;
    closeChat();
    showView("inbox");
    refreshInbox();
  } else {
    showView("login");
  }
}
window.addEventListener("hashchange", route);

/* ---------------- login ---------------- */

const loginView = document.getElementById("login-view");
function initLogin() {
  const err = document.getElementById("login-error");
  document.getElementById("login-btn").addEventListener("click", tryLogin);
  document.getElementById("token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryLogin();
  });
  async function tryLogin() {
    err.hidden = true;
    const token = document.getElementById("token-input").value.trim();
    const server = document.getElementById("server-input").value.trim().replace(/\/+$/, "");
    if (!token) { err.textContent = "Token required."; err.hidden = false; return; }
    try {
      const saved = { t: store.token, s: store.server };
      store.token = token; store.server = server;
      await api("/api/health");
      if (!location.hash) showView("inbox");
      route();
      initPush();
    } catch (e) {
      store.token = saved.t; store.server = saved.s;
      err.textContent = `Connection failed: ${e.message}`;
      err.hidden = false;
    }
  }
}

/* ---------------- inbox ---------------- */

const inboxView = document.getElementById("inbox-view");
let inboxTimer = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function elapsed(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function cardHtml(row) {
  const { summary, state, needsInput } = row;
  const st = needsInput ? "needs-input" : state;
  const preview = summary.title;
  return `
  <div class="session-card" data-id="${escapeHtml(summary.id)}">
    <div class="row">
      <span class="state-dot ${escapeHtml(st)}"></span>
      <span class="project">${escapeHtml(summary.project)}</span>
      <span class="elapsed" data-started="${summary.lastUpdate}">${elapsed(summary.lastUpdate)}</span>
    </div>
    <div class="title">${escapeHtml(preview)}</div>
    <div class="preview">${escapeHtml(st === "needs-input" ? "Waiting for your response" : stateLabel(st))}</div>
  </div>`;
}

function stateLabel(s) {
  return {
    idle: "Idle", streaming: "Working…", starting: "Starting…",
    "needs-input": "Needs your input", finished: "Done", failed: "Failed", stopped: "Stopped",
  }[s] || s;
}

async function refreshInbox() {
  if (!document.getElementById("inbox-view").hidden === false) return;
  try {
    const { sessions } = await api("/api/sessions");
    const groups = { "needs-input": [], running: [], recent: [] };
    for (const row of sessions) {
      const st = row.needsInput ? "needs-input" : row.state;
      if (st === "needs-input") groups["needs-input"].push(row);
      else if (st === "streaming" || st === "starting") groups.running.push(row);
      else groups.recent.push(row);
    }
    for (const key of Object.keys(groups)) {
      const section = document.querySelector(`[data-group="${key}"]`);
      const wrap = section.closest(".group");
      wrap.hidden = groups[key].length === 0;
      section.innerHTML = groups[key].map(cardHtml).join("");
    }
    const empty = sessions.length === 0;
    if (empty) {
      document.querySelector('[data-group="recent"]').innerHTML =
        `<div class="empty">No sessions yet.<br>Start one with <code>pi --name "my task"</code> on the server.</div>`;
      document.querySelector('[data-group="recent"]').closest(".group").hidden = false;
    }
  } catch { /* offline; retry on timer */ }
}

function startInboxPolling() {
  clearInterval(inboxTimer);
  inboxTimer = setInterval(() => {
    if (document.getElementById("inbox-view").hidden) return;
    refreshInbox();
  }, 4000);
  // elapsed-time refresh
  setInterval(() => {
    document.querySelectorAll(".elapsed[data-started]").forEach((el) => {
      el.textContent = elapsed(Number(el.dataset.started));
    });
  }, 30_000);
}

document.querySelector("#inbox-scroll").addEventListener("click", (e) => {
  const card = e.target.closest(".session-card");
  if (card) location.hash = `#/session/${card.dataset.id}`;
});

/* ---------------- chat ---------------- */

const chatView = document.getElementById("chat-view");
const transcriptEl = document.getElementById("transcript");
let es = null;
let chatState = "idle";
let streamingEl = null; // current streaming assistant bubble

function openChat(id) {
  showView("chat");
  transcriptEl.innerHTML = "";
  streamingEl = null;
  document.getElementById("composer-input").value = store.draft;
  loadTranscript(id).then(() => connectEvents(id));
  startPushRegistration();
}

function closeChat() {
  if (es) { es.close(); es = null; }
}

async function loadTranscript(id) {
  let data;
  try {
    data = await api(`/api/sessions/${id}`);
  } catch (e) {
    transcriptEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const { summary, state, pendingUi, lastError, transcript } = data;
  document.getElementById("chat-project").textContent = summary.project;
  document.getElementById("chat-subtitle").textContent = summary.title;
  renderTranscript(transcript);
  if (lastError) addNotice(lastError, "error");
  setChatState(pendingUi?.length ? "needs-input" : state);
  if (pendingUi?.length) showApproval(pendingUi[0]);
  scrollToBottom();
}

function renderTranscript(messages) {
  const toolCards = new Map(); // toolCallId -> card element
  for (const m of messages) {
    if (m.role === "user") {
      addBubble("user", m.text);
    } else if (m.role === "assistant") {
      for (const block of parts(m)) {
        if (block.type === "text" && block.text.trim()) {
          addBubble("assistant", block.text);
        } else if (block.type === "toolCall") {
          toolCards.set(block.id, addToolCard(block.id, block.name, block.args, false));
        }
      }
    } else if (m.role === "toolResult") {
      const card = toolCards.get(m.toolCallId);
      if (card) finishToolCard(card, m.outputPreview || "", !!m.isError);
      else addToolCard(m.toolCallId, m.toolName, null, !!m.isError, m.outputPreview);
    } else if (m.role === "bashExecution") {
      addToolCard("bash", m.text || "bash", null, !!m.isError, m.outputPreview);
    }
  }
}

function parts(m) {
  return Array.isArray(m.content) ? m.content : (typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);
}

function addBubble(role, text, streaming = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = renderMarkdown(text);
  if (streaming) {
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    div.appendChild(cursor);
  }
  transcriptEl.appendChild(div);
  if (!streaming) scrollToBottom();
  return div;
}

// Minimal markdown: code fences, inline code, bold — phone-readable only.
function renderMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/^\w*\n/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return s;
}

function addToolCard(id, name, args, isError, output = "") {
  const d = document.createElement("details");
  d.className = "tool-card" + (isError ? " error" : "");
  d.dataset.toolId = id;
  const argsPreview = args ? toolArgsPreview(args) : "";
  d.innerHTML = `
    <summary>
      <span class="tool-spinner">▸</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-args muted">${escapeHtml(argsPreview)}</span>
    </summary>
    <div class="tool-output">${escapeHtml(output)}</div>`;
  transcriptEl.appendChild(d);
  scrollToBottom();
  return d;
}

function toolArgsPreview(args) {
  const a = args || {};
  for (const k of ["command", "file_path", "path", "pattern", "query", "url"]) {
    if (a[k]) return String(a[k]).slice(0, 80);
  }
  const first = Object.values(a)[0];
  return first ? String(first).slice(0, 80) : "";
}

function finishToolCard(card, output, isError) {
  card.querySelector(".tool-spinner").textContent = isError ? "✗" : "✓";
  if (isError) card.classList.add("error");
  card.querySelector(".tool-output").textContent = output;
}

function addNotice(text, level = "info") {
  const d = document.createElement("div");
  d.className = `notice ${level}`;
  d.textContent = text;
  transcriptEl.appendChild(d);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => { transcriptEl.scrollTop = transcriptEl.scrollHeight; });
}

function setChatState(state) {
  chatState = state;
  const chip = document.getElementById("chat-state");
  chip.textContent = stateLabel(state);
  chip.className = `state-chip ${state}`;
  document.getElementById("stop-btn").hidden = state !== "streaming";
}

/* ---------------- live events (SSE) ---------------- */

function connectEvents(id) {
  closeChat();
  const url = `${apiBase()}/api/sessions/${id}/events?token=${encodeURIComponent(store.token)}`;
  es = new EventSource(url);

  es.addEventListener("snapshot", (e) => {
    const snap = JSON.parse(e.data);
    setChatState(snap.pendingUi?.length ? "needs-input" : snap.state);
    if (snap.pendingUi?.length) showApproval(snap.pendingUi[0]);
    if (snap.lastError) addNotice(snap.lastError, "error");
  });

  es.addEventListener("event", (e) => {
    const { event } = JSON.parse(e.data);
    handleLiveEvent(event);
  });

  es.onerror = () => {
    // EventSource auto-reconnects; server snapshot re-syncs state.
  };
}

function handleLiveEvent(evt) {
  switch (evt.type) {
    case "status":
      setChatState(evt.state);
      if (evt.state === "streaming" && !streamingEl) {
        streamingEl = addBubble("assistant", "", true);
      }
      if (evt.state === "idle" && streamingEl) {
        streamingEl.querySelector(".cursor")?.remove();
        if (!streamingEl.textContent.trim()) streamingEl.remove();
        streamingEl = null;
      }
      break;
    case "delta":
      ensureStreamingBubble();
      streamingEl.querySelector(".cursor")?.insertAdjacentText("beforebegin", evt.text);
      scrollToBottom();
      break;
    case "thinking_delta":
      break; // collapsed by default; final message arrives via message_end
    case "tool_start":
      addToolCard(evt.toolCallId, evt.toolName, evt.args, false);
      break;
    case "tool_update":
      break;
    case "tool_end": {
      const card = transcriptEl.querySelector(`[data-tool-id="${evt.toolCallId}"]`);
      if (card) finishToolCard(card, evt.preview, evt.isError);
      break;
    }
    case "message_end": {
      const m = evt.message;
      if (m?.role === "assistant") {
        const texts = parts(m).filter((b) => b.type === "text" && b.text.trim());
        if (texts.length) {
          if (streamingEl) {
            streamingEl.querySelector(".cursor")?.remove();
            streamingEl.innerHTML = renderMarkdown(texts.map((b) => b.text).join("\n"));
            streamingEl = null;
          } else {
            for (const b of texts) addBubble("assistant", b.text);
          }
        } else if (streamingEl && !streamingEl.textContent.trim()) {
          streamingEl.remove();
          streamingEl = null;
        }
        // Register any tool calls so results attach
        for (const b of parts(m)) {
          if (b.type === "toolCall" && !transcriptEl.querySelector(`[data-tool-id="${b.id}"]`)) {
            addToolCard(b.id, b.name, b.arguments, false);
          }
        }
        if (m.stopReason === "error" || m.errorMessage) addNotice(m.errorMessage || "error", "error");
      }
      break;
    }
    case "user_message":
      addBubble("user", evt.text);
      break;
    case "ui_request":
      showApproval(evt);
      setChatState("needs-input");
      break;
    case "notice":
      addNotice(evt.message, evt.level);
      break;
    case "error":
      addNotice(evt.error, "error");
      break;
    case "exit":
      addNotice("Agent process stopped.");
      break;
  }
}

function ensureStreamingBubble() {
  if (!streamingEl) streamingEl = addBubble("assistant", "", true);
}

/* ---------------- approval UI ---------------- */

const approvalBar = document.getElementById("approval-bar");
let currentApproval = null;

function showApproval(req) {
  currentApproval = req;
  approvalBar.hidden = false;
  const options = req.options || (req.method === "confirm" ? ["Approve", "Reject"] : null);
  let html = `<div class="approval-title">⚠️ ${escapeHtml(req.title || "Agent needs your input")}</div>`;
  if (req.message) html += `<div class="approval-message">${escapeHtml(req.message)}</div>`;
  if (req.method === "input" || req.method === "editor") {
    html += `<input id="approval-input" placeholder="Type your response…" />`;
  }
  html += `<div class="approval-options">`;
  if (options) {
    options.forEach((o, i) => {
      const cls = i === 0 ? "primary" : "";
      html += `<button class="${cls}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`;
    });
    html += `<button class="muted" data-cancel>Dismiss</button>`;
  } else {
    html += `<button class="primary" data-send-response>Send</button><button data-cancel>Dismiss</button>`;
  }
  html += `</div>`;
  approvalBar.innerHTML = html;

  approvalBar.querySelectorAll("[data-value]").forEach((btn) =>
    btn.addEventListener("click", () => respondApproval({ value: btn.dataset.value }))
  );
  approvalBar.querySelector("[data-cancel]")?.addEventListener("click", () => respondApproval({ cancelled: true }));
  approvalBar.querySelector("[data-send-response]")?.addEventListener("click", () => {
    const input = approvalBar.querySelector("#approval-input");
    respondApproval({ value: input ? input.value : "" });
  });
  approvalBar.querySelector("#approval-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      respondApproval({ value: e.target.value });
    }
  });
}

async function respondApproval(body) {
  if (!currentApproval) return;
  try {
    await api(`/api/sessions/${currentSessionId}/actions/respond`, {
      method: "POST",
      body: JSON.stringify({ requestId: currentApproval.requestId, ...body }),
    });
    approvalBar.hidden = true;
    approvalBar.innerHTML = "";
    currentApproval = null;
    setChatState("streaming");
    addNotice(`Responded: ${body.cancelled ? "dismissed" : JSON.stringify(body.value ?? body.confirmed ?? "")}`);
  } catch (e) {
    addNotice(`Action failed: ${e.message}`, "error");
  }
}

/* ---------------- composer ---------------- */

const composerInput = document.getElementById("composer-input");
const composerForm = document.getElementById("composer-form");

composerInput.addEventListener("input", () => {
  store.draft = composerInput.value;
  autosize();
});

function autosize() {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
}

composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text || !currentSessionId) return;
  composerInput.value = "";
  store.draft = "";
  autosize();
  try {
    await api(`/api/sessions/${currentSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    addBubble("user", text);
    // Optimistically show streaming state; SSE confirms.
    setChatState("streaming");
  } catch (err) {
    composerInput.value = text; // never lose a draft
    store.draft = text;
    addNotice(`Send failed: ${err.message}`, "error");
  }
});

document.getElementById("stop-btn").addEventListener("click", async () => {
  try {
    await api(`/api/sessions/${currentSessionId}/interrupt`, { method: "POST" });
    addNotice("Interrupt sent.");
  } catch (e) {
    addNotice(`Interrupt failed: ${e.message}`, "error");
  }
});

document.getElementById("back-btn").addEventListener("click", () => {
  history.pushState("", document.title, location.pathname + location.search);
  location.hash = "";
});

/* ---------------- iOS keyboard / visualViewport ---------------- */

// Fixed app-shell height from the real visual viewport — never 100vh.
function applyViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
  // When keyboard opens, iOS shifts visualViewport up but pageOffset reflects
  // it; pin the composer so it sits directly above the keyboard.
  if (vv) {
    const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    document.documentElement.style.setProperty("--kb-offset", `${overlap > 120 ? 0 : 0}px`);
  }
}

function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const handler = () => {
    applyViewport();
    // Keep the focused input visible above the keyboard.
    const active = document.activeElement;
    if (active && (active === composerInput || active.closest?.("#approval-bar"))) {
      requestAnimationFrame(() =>
        active.scrollIntoView({ block: "nearest", behavior: "instant" })
      );
    }
  };
  vv.addEventListener("resize", handler);
  vv.addEventListener("scroll", handler);
  window.addEventListener("orientationchange", handler);
  handler();
}

/* ---------------- push notifications ---------------- */

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

let pushReady = false;

async function initPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    document.getElementById("notif-btn").addEventListener("click", enablePush);
    const { enabled, publicKey } = await api("/api/push-subscriptions").catch(() => ({ enabled: false }));
    if (enabled && Notification.permission === "granted") {
      await subscribePush(reg, publicKey);
    }
  } catch { /* push optional */ }
}

async function startPushRegistration() {
  if (pushReady) return;
  pushReady = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { enabled, publicKey } = await api("/api/push-subscriptions");
    if (enabled && Notification.permission === "granted") {
      await subscribePush(reg, publicKey);
    }
  } catch { /* push optional */ }
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;
  const { enabled, publicKey } = await api("/api/push-subscriptions");
  if (!enabled) {
    alert("Push is not configured on the server (missing VAPID keys).");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  await subscribePush(reg, publicKey);
  document.getElementById("notif-btn").textContent = "✅";
}

async function subscribePush(reg, publicKey) {
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api("/api/push-subscriptions", {
    method: "POST",
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
}

navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-session" && e.data.sessionId) {
    location.hash = `#/session/${e.data.sessionId}`;
  }
});

/* ---------------- boot ---------------- */

initLogin();
setupViewport();
if (store.token) {
  api("/api/health")
    .then(() => route())
    .catch(() => showView("login"));
} else {
  showView("login");
}
startInboxPolling();
setInterval(applyViewport, 2000);