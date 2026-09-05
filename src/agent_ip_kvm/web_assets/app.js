const elements = {
  noSignal: document.querySelector("#no-signal"), videoFrame: document.querySelector("#video-frame"),
  videoShell: document.querySelector("#video-shell"), panel: document.querySelector("#settings-panel"),
  backdrop: document.querySelector("#panel-backdrop"), settingsButton: document.querySelector("#settings-button"),
  closeSettings: document.querySelector("#close-settings"), refreshButton: document.querySelector("#refresh-button"),
  screenButton: document.querySelector("#screen-button"), screenMenu: document.querySelector("#screen-menu"),
  resolutionSelect: document.querySelector("#resolution-select"), refreshRateSelect: document.querySelector("#refresh-rate-select"),
  screenMessage: document.querySelector("#screen-message"), applyScreenSettings: document.querySelector("#apply-screen-settings"),
  zoomOut: document.querySelector("#zoom-out"), zoomIn: document.querySelector("#zoom-in"),
  mouseButton: document.querySelector("#mouse-button"), mouseMenu: document.querySelector("#mouse-menu"),
  mouseMessage: document.querySelector("#mouse-message"),
  cursorSizeSelect: document.querySelector("#cursor-size-select"), keyboardButton: document.querySelector("#keyboard-button"),
  keyboard: document.querySelector("#onscreen-keyboard"), closeKeyboard: document.querySelector("#close-keyboard"),
  keyboardRows: document.querySelector("#keyboard-rows"), hidMessage: document.querySelector("#hid-message"),
  releaseKeys: document.querySelector("#release-keys"), v4l2Message: document.querySelector("#v4l2-message"),
  deviceCount: document.querySelector("#device-count"), deviceList: document.querySelector("#device-list"),
  agentModeButton: document.querySelector("#agent-mode-button"), agentShell: document.querySelector("#agent-shell"),
  agentComposer: document.querySelector("#agent-composer"), agentInput: document.querySelector("#agent-input"),
  agentSend: document.querySelector("#agent-send"), agentConversation: document.querySelector("#agent-conversation"),
  tools: document.querySelector(".tools"), agentModelSelect: document.querySelector("#agent-model-select"),
  agentApp: document.querySelector(".agent-app"), agentSidebar: document.querySelector("#agent-sidebar"),
  agentSidebarToggle: document.querySelector("#agent-sidebar-toggle"), newAgentChat: document.querySelector("#new-agent-chat"),
  agentSessionList: document.querySelector("#agent-session-list"), agentChatTitle: document.querySelector("#agent-chat-title"),
};

let videoModes = [];
let hidEnabled = false;
let zoomPercent = 100;
const activeModifiers = new Set();
let videoWidth = 16;
let videoHeight = 9;
let pendingPointer = null;
let pendingWheel = 0;
let pointerRequestActive = false;
let agentMode = false;
const agentStorageKey = "agent-ip-kvm.sessions.v1";
const agentModelStorageKey = "agent-ip-kvm.model.v1";
let agentSessions = [];
let activeAgentSessionId = "";

function text(id, value) { document.querySelector(`#${id}`).textContent = value ?? "--"; }

function modeLabel(capabilities, field) {
  const mode = capabilities?.[0];
  if (!mode) return "--";
  if (field === "resolution") return `${mode.width} × ${mode.height}`;
  if (field === "fps") return `${Number(mode.fps).toFixed(2)} fps`;
  return mode.pixel_format;
}

function updateDevices(v4l2) {
  const devices = v4l2?.devices ?? [];
  elements.deviceCount.textContent = String(devices.length);
  elements.v4l2Message.textContent = v4l2?.message ?? "未获得设备状态";
  elements.deviceList.replaceChildren();
  for (const device of devices) {
    const card = document.createElement("article"); card.className = "device-card";
    const name = document.createElement("strong"); name.textContent = device.display_name;
    const path = document.createElement("span"); path.textContent = `${device.device_path} · ${device.node_kind}`;
    const detail = document.createElement("span"); detail.textContent = `${device.driver ?? "未知驱动"} · ${device.capabilities.length} 种模式`;
    card.append(name, path, detail); elements.deviceList.append(card);
  }
}

function fillRefreshRates(selectedFps) {
  const [width, height] = elements.resolutionSelect.value.split("x").map(Number);
  const rates = [...new Set(videoModes.filter((mode) => mode.width === width && mode.height === height)
    .map((mode) => Number(mode.fps)))].sort((a, b) => b - a);
  elements.refreshRateSelect.replaceChildren();
  for (const rate of rates) {
    const option = document.createElement("option"); option.value = String(rate); option.textContent = `${rate} Hz`;
    option.selected = Math.abs(rate - selectedFps) < 0.01; elements.refreshRateSelect.append(option);
  }
}

function updateScreenOptions(payload) {
  const sourceMode = payload.source?.capabilities?.[0];
  const captureDevice = payload.v4l2?.devices?.find((device) =>
    device.device_path === payload.source?.source_id?.replace("v4l2:", "") && device.supports_video_capture);
  videoModes = (captureDevice?.capabilities ?? []).filter((mode) => mode.pixel_format === "MJPG" || mode.pixel_format === "MJPEG");
  const resolutions = [...new Map(videoModes.map((mode) => [`${mode.width}x${mode.height}`, mode])).values()]
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  elements.resolutionSelect.replaceChildren();
  for (const mode of resolutions) {
    const option = document.createElement("option"); option.value = `${mode.width}x${mode.height}`;
    option.textContent = `${mode.width} × ${mode.height}`;
    option.selected = mode.width === sourceMode?.width && mode.height === sourceMode?.height;
    elements.resolutionSelect.append(option);
  }
  const supported = resolutions.length > 0;
  elements.resolutionSelect.disabled = !supported; elements.refreshRateSelect.disabled = !supported;
  elements.applyScreenSettings.disabled = !supported;
  elements.screenMessage.textContent = supported ? "" : "当前视频源不支持调整";
  if (supported) fillRefreshRates(Number(sourceMode?.fps ?? 0));
}

function clearModifiers() {
  activeModifiers.clear();
  for (const button of elements.keyboardRows.querySelectorAll("[data-modifier]")) {
    button.classList.remove("active"); button.setAttribute("aria-pressed", "false");
  }
}

function updateHidStatus(hid) {
  hidEnabled = Boolean(hid?.enabled && hid?.state !== "stopped" && hid?.state !== "error");
  const disconnected = hid?.backend === "linux-auto";
  const statusText = hidEnabled ? (hid.backend === "simulated" ? "HID 模拟模式" : "HID 已连接")
    : (disconnected ? "HID 未连接" : "HID 尚未启用");
  elements.hidMessage.textContent = statusText;
  elements.mouseMessage.textContent = hidEnabled ? "HID 已连接 · 鼠标位置自动同步" : statusText;
  elements.releaseKeys.disabled = !hidEnabled;
  for (const key of elements.keyboardRows.querySelectorAll("button")) key.disabled = !hidEnabled;
  if (!hidEnabled) {
    clearModifiers();
    pendingPointer = null;
    pendingWheel = 0;
  }
}

function updateStatus(payload) {
  const source = payload.source; const stream = payload.stream;
  const sourceMode = source?.capabilities?.[0];
  if (Number(sourceMode?.width) > 0 && Number(sourceMode?.height) > 0) {
    videoWidth = Number(sourceMode.width);
    videoHeight = Number(sourceMode.height);
  }
  const available = source?.health === "available" && stream?.state !== "error" && stream?.state !== "ended";
  elements.noSignal.classList.toggle("unavailable", !available);
  const hasFrame = stream?.state === "streaming" && Number.isInteger(stream?.sequence);
  elements.videoFrame.classList.toggle("visible", hasFrame); elements.noSignal.hidden = hasFrame;
  text("info-backend", source?.backend); text("info-source", source?.source_id); text("info-health", source?.health);
  text("info-format", modeLabel(source?.capabilities, "format"));
  text("info-resolution", modeLabel(source?.capabilities, "resolution")); text("info-fps", modeLabel(source?.capabilities, "fps"));
  text("info-error", source?.error || "无"); updateDevices(payload.v4l2); updateHidStatus(payload.hid);
  if (elements.screenMenu.hidden) updateScreenOptions(payload);
}

function connectStream() {
  elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false;
  elements.videoFrame.src = `/api/stream.mjpg?t=${Date.now()}`;
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`); updateStatus(await response.json());
  } catch (error) { elements.noSignal.classList.add("unavailable"); text("info-error", error.message); }
}

function setPanel(open) {
  elements.panel.classList.toggle("open", open); elements.panel.setAttribute("aria-hidden", String(!open));
  elements.settingsButton.setAttribute("aria-expanded", String(open)); elements.backdrop.hidden = !open;
}
function setScreenMenu(open) {
  elements.screenMenu.hidden = !open; elements.screenButton.setAttribute("aria-expanded", String(open));
  if (open) { setMouseMenu(false); setPanel(false); }
}
function setMouseMenu(open) {
  elements.mouseMenu.hidden = !open; elements.mouseButton.setAttribute("aria-expanded", String(open));
  if (open) { setScreenMenu(false); setPanel(false); }
}
function setKeyboard(open) {
  elements.keyboard.hidden = !open; elements.keyboardButton.setAttribute("aria-expanded", String(open));
  if (open) { setScreenMenu(false); setMouseMenu(false); setPanel(false); } else clearModifiers();
}

function setAgentMode(open) {
  agentMode = Boolean(open);
  if (!agentMode) {
    elements.agentApp.classList.remove("sidebar-open");
    elements.agentSidebarToggle.setAttribute("aria-expanded", "false");
  }
  document.body.classList.toggle("agent-mode", agentMode);
  elements.agentModeButton.setAttribute("aria-pressed", String(agentMode));
  elements.agentModeButton.title = agentMode ? "返回 KVM 模式" : "切换到 Agent 模式";
  elements.agentShell.setAttribute("aria-hidden", String(!agentMode));
  elements.videoShell.setAttribute("aria-hidden", String(agentMode));
  elements.tools.setAttribute("aria-hidden", String(agentMode));
  if (agentMode) {
    setPanel(false);
    setScreenMenu(false);
    setMouseMenu(false);
    setKeyboard(false);
    elements.agentInput.focus({ preventScroll: true });
  }
}

function newSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeAgentSession() {
  const now = Date.now();
  return { id: newSessionId(), title: "新会话", createdAt: now, updatedAt: now, messages: [] };
}

function saveAgentSessions() {
  try {
    localStorage.setItem(agentStorageKey, JSON.stringify({ activeId: activeAgentSessionId, sessions: agentSessions }));
  } catch (_) { /* The interface remains usable if local storage is unavailable. */ }
}

function loadAgentSessions() {
  try {
    const saved = JSON.parse(localStorage.getItem(agentStorageKey) ?? "null");
    if (Array.isArray(saved?.sessions)) {
      agentSessions = saved.sessions.filter((session) =>
        session && typeof session.id === "string" && typeof session.title === "string" && Array.isArray(session.messages));
      activeAgentSessionId = typeof saved.activeId === "string" ? saved.activeId : "";
    }
  } catch (_) { agentSessions = []; }
  if (agentSessions.length === 0) agentSessions.push(makeAgentSession());
  if (!agentSessions.some((session) => session.id === activeAgentSessionId)) activeAgentSessionId = agentSessions[0].id;
  saveAgentSessions();
}

function loadAgentModel() {
  try {
    const saved = localStorage.getItem(agentModelStorageKey);
    if ([...elements.agentModelSelect.options].some((option) => option.value === saved)) elements.agentModelSelect.value = saved;
  } catch (_) { /* Keep the default model if local storage is unavailable. */ }
}

function activeAgentSession() {
  return agentSessions.find((session) => session.id === activeAgentSessionId) ?? agentSessions[0];
}

function renderAgentSessions() {
  elements.agentSessionList.replaceChildren();
  const sorted = [...agentSessions].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  for (const session of sorted) {
    const item = document.createElement("div");
    item.className = `session-item${session.id === activeAgentSessionId ? " active" : ""}`;
    item.dataset.sessionId = session.id;

    const select = document.createElement("button");
    select.className = "session-select";
    select.type = "button";
    select.dataset.sessionAction = "select";
    select.title = session.title;
    select.textContent = session.title;

    const actions = document.createElement("span");
    actions.className = "session-actions";
    const rename = document.createElement("button");
    rename.className = "session-action";
    rename.type = "button";
    rename.dataset.sessionAction = "rename";
    rename.title = "重命名会话";
    rename.setAttribute("aria-label", `重命名 ${session.title}`);
    rename.textContent = "✎";
    const remove = document.createElement("button");
    remove.className = "session-action delete";
    remove.type = "button";
    remove.dataset.sessionAction = "delete";
    remove.title = "删除会话";
    remove.setAttribute("aria-label", `删除 ${session.title}`);
    remove.textContent = "×";
    actions.append(rename, remove);
    item.append(select, actions);
    elements.agentSessionList.append(item);
  }
}

function renderAgentMessage(message) {
  const article = document.createElement("article");
  const assistant = message.role === "assistant";
  article.className = `agent-message ${assistant ? "assistant-message" : "user-message"}`;
  if (assistant) {
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "A";
    article.append(avatar);
  }
  const content = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = assistant ? "Agent" : "你";
  const paragraph = document.createElement("p");
  paragraph.textContent = String(message.content ?? "");
  content.append(name, paragraph);
  article.append(content);
  return article;
}

function renderAgentConversation() {
  const session = activeAgentSession();
  elements.agentChatTitle.textContent = session.title;
  elements.agentConversation.replaceChildren();
  if (session.messages.length === 0) return;
  for (const message of session.messages) elements.agentConversation.append(renderAgentMessage(message));
  elements.agentConversation.scrollTop = elements.agentConversation.scrollHeight;
}

function selectAgentSession(sessionId) {
  if (!agentSessions.some((session) => session.id === sessionId)) return;
  activeAgentSessionId = sessionId;
  elements.agentApp.classList.remove("sidebar-open");
  saveAgentSessions();
  renderAgentSessions();
  renderAgentConversation();
  elements.agentInput.focus({ preventScroll: true });
}

function createAgentSession() {
  const session = makeAgentSession();
  agentSessions.push(session);
  activeAgentSessionId = session.id;
  saveAgentSessions();
  renderAgentSessions();
  renderAgentConversation();
  elements.agentInput.focus({ preventScroll: true });
}

function renameAgentSession(sessionId) {
  const session = agentSessions.find((item) => item.id === sessionId);
  if (!session) return;
  const title = window.prompt("输入新的会话名称", session.title)?.trim();
  if (!title) return;
  session.title = title.slice(0, 60);
  session.updatedAt = Date.now();
  saveAgentSessions();
  renderAgentSessions();
  renderAgentConversation();
}

function deleteAgentSession(sessionId) {
  const session = agentSessions.find((item) => item.id === sessionId);
  if (!session || !window.confirm(`删除会话“${session.title}”？`)) return;
  agentSessions = agentSessions.filter((item) => item.id !== sessionId);
  if (agentSessions.length === 0) agentSessions.push(makeAgentSession());
  if (activeAgentSessionId === sessionId) activeAgentSessionId = [...agentSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  saveAgentSessions();
  renderAgentSessions();
  renderAgentConversation();
}

function resizeAgentInput() {
  elements.agentInput.style.height = "auto";
  elements.agentInput.style.height = `${Math.min(130, elements.agentInput.scrollHeight)}px`;
}

function submitAgentPrompt(prompt) {
  const value = String(prompt ?? "").trim();
  if (!value) return;
  const session = activeAgentSession();
  session.messages.push({ role: "user", content: value, createdAt: Date.now() });
  if (session.title === "新会话") session.title = value.replace(/\s+/g, " ").slice(0, 24);
  session.updatedAt = Date.now();
  saveAgentSessions();
  renderAgentSessions();
  renderAgentConversation();
  elements.agentInput.value = "";
  resizeAgentInput();
}

function setZoom(value) {
  zoomPercent = Math.min(200, Math.max(50, Number(value)));
  elements.videoFrame.style.setProperty("--video-zoom", String(zoomPercent / 100));
  elements.zoomOut.disabled = zoomPercent <= 50;
  elements.zoomIn.disabled = zoomPercent >= 200;
  elements.zoomOut.title = `缩小画面（当前 ${zoomPercent}%）`;
  elements.zoomIn.title = `放大画面（当前 ${zoomPercent}%）`;
}
function setCursorSize(size) {
  const selected = ["small", "medium", "large"].includes(size) ? size : "medium";
  elements.cursorSizeSelect.value = selected;
  elements.videoShell.classList.remove("cursor-small", "cursor-medium", "cursor-large");
  elements.videoShell.classList.add(`cursor-${selected}`);
}
function toggleModifier(name) {
  if (activeModifiers.has(name)) activeModifiers.delete(name); else activeModifiers.add(name);
  for (const button of elements.keyboardRows.querySelectorAll(`[data-modifier="${name}"]`)) {
    const active = activeModifiers.has(name); button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function postJson(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}

function videoContentRect() {
  const shell = elements.videoShell.getBoundingClientRect();
  const aspect = videoWidth / videoHeight;
  let width = shell.width;
  let height = width / aspect;
  if (height > shell.height) {
    height = shell.height;
    width = height * aspect;
  }
  const zoom = zoomPercent / 100;
  width *= zoom;
  height *= zoom;
  return {
    left: shell.left + (shell.width - width) / 2,
    top: shell.top + (shell.height - height) / 2,
    width,
    height,
    shell,
  };
}

function pointerFromEvent(event) {
  if (event.target.closest?.(".zoom-buttons")) return null;
  const rect = videoContentRect();
  const insideShell = event.clientX >= rect.shell.left && event.clientX <= rect.shell.right
    && event.clientY >= rect.shell.top && event.clientY <= rect.shell.bottom;
  const insideVideo = event.clientX >= rect.left && event.clientX <= rect.left + rect.width
    && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
  if (!insideShell || !insideVideo) return null;
  return {
    x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 32767),
    y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 32767),
  };
}

async function flushPointerPosition() {
  if (pointerRequestActive || !hidEnabled || pendingPointer === null) return;
  const pointer = pendingPointer;
  const wheel = Math.max(-127, Math.min(127, Math.round(pendingWheel)));
  pendingPointer = null;
  pendingWheel -= wheel;
  pointerRequestActive = true;
  try {
    await postJson("/api/hid/mouse-position", { x: pointer.x, y: pointer.y, wheel });
  } catch (error) {
    elements.mouseMessage.textContent = error.message;
    await refreshStatus();
  } finally {
    pointerRequestActive = false;
    if (pendingPointer !== null) requestAnimationFrame(flushPointerPosition);
  }
}

async function clickMouse(buttonNumber, pointer) {
  const names = { 0: "left", 1: "middle", 2: "right" };
  const button = names[buttonNumber];
  if (!button || !hidEnabled) return;
  try { await postJson("/api/hid/mouse-click", { button, x: pointer.x, y: pointer.y }); }
  catch (error) { elements.mouseMessage.textContent = error.message; await refreshStatus(); }
}
async function tapKey(button) {
  if (!hidEnabled) return;
  button.disabled = true;
  try {
    await postJson("/api/hid/key", { key: button.dataset.key, modifiers: [...activeModifiers] });
    elements.hidMessage.textContent = `已发送 ${button.textContent.trim()}`;
  } catch (error) { elements.hidMessage.textContent = error.message; await refreshStatus(); }
  finally { button.disabled = !hidEnabled; clearModifiers(); }
}

elements.settingsButton.addEventListener("click", () => { setScreenMenu(false); setMouseMenu(false); setKeyboard(false); setPanel(true); });
elements.closeSettings.addEventListener("click", () => setPanel(false));
elements.backdrop.addEventListener("click", () => setPanel(false));
elements.refreshButton.addEventListener("click", () => { connectStream(); refreshStatus(); });
elements.videoFrame.addEventListener("load", () => { elements.videoFrame.classList.add("visible"); elements.noSignal.hidden = true; });
elements.videoFrame.addEventListener("error", () => { elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false; refreshStatus(); });
elements.screenButton.addEventListener("click", () => setScreenMenu(elements.screenMenu.hidden));
elements.mouseButton.addEventListener("click", () => setMouseMenu(elements.mouseMenu.hidden));
elements.keyboardButton.addEventListener("click", () => setKeyboard(elements.keyboard.hidden));
elements.closeKeyboard.addEventListener("click", () => setKeyboard(false));
elements.zoomOut.addEventListener("click", () => setZoom(zoomPercent - 10));
elements.zoomIn.addEventListener("click", () => setZoom(zoomPercent + 10));
elements.cursorSizeSelect.addEventListener("change", () => setCursorSize(elements.cursorSizeSelect.value));
document.addEventListener("mousemove", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains(event.target)) return;
  const pointer = pointerFromEvent(event);
  if (pointer === null) return;
  pendingPointer = pointer;
  requestAnimationFrame(flushPointerPosition);
});
document.addEventListener("mousedown", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains(event.target)) return;
  const pointer = pointerFromEvent(event);
  if (pointer === null) return;
  event.preventDefault();
  pendingPointer = pointer;
  clickMouse(event.button, pointer);
});
document.addEventListener("wheel", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains(event.target)) return;
  const pointer = pointerFromEvent(event);
  if (pointer === null) return;
  event.preventDefault();
  pendingPointer = pointer;
  pendingWheel += Math.sign(-event.deltaY);
  requestAnimationFrame(flushPointerPosition);
}, { passive: false });
elements.videoShell.addEventListener("contextmenu", (event) => {
  if (!agentMode && hidEnabled && pointerFromEvent(event) !== null) event.preventDefault();
});
elements.agentModeButton.addEventListener("click", () => setAgentMode(!agentMode));
elements.newAgentChat.addEventListener("click", createAgentSession);
elements.agentSidebarToggle.addEventListener("click", () => {
  const open = !elements.agentApp.classList.contains("sidebar-open");
  elements.agentApp.classList.toggle("sidebar-open", open);
  elements.agentSidebarToggle.setAttribute("aria-expanded", String(open));
});
elements.agentSessionList.addEventListener("click", (event) => {
  const action = event.target.closest("[data-session-action]");
  const sessionId = event.target.closest("[data-session-id]")?.dataset.sessionId;
  if (!action || !sessionId) return;
  if (action.dataset.sessionAction === "select") selectAgentSession(sessionId);
  if (action.dataset.sessionAction === "rename") renameAgentSession(sessionId);
  if (action.dataset.sessionAction === "delete") deleteAgentSession(sessionId);
});
elements.agentInput.addEventListener("input", resizeAgentInput);
elements.agentInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitAgentPrompt(elements.agentInput.value);
  }
});
elements.agentComposer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAgentPrompt(elements.agentInput.value);
});
elements.agentModelSelect.addEventListener("change", () => {
  try { localStorage.setItem(agentModelStorageKey, elements.agentModelSelect.value); } catch (_) { /* UI selection still works. */ }
});
elements.resolutionSelect.addEventListener("change", () => fillRefreshRates(0));
elements.keyboardRows.addEventListener("click", (event) => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  if (button.dataset.modifier) toggleModifier(button.dataset.modifier); else if (button.dataset.key) tapKey(button);
});
elements.releaseKeys.addEventListener("click", async () => {
  try { await postJson("/api/hid/release", {}); elements.hidMessage.textContent = "已释放全部按键"; }
  catch (error) { elements.hidMessage.textContent = error.message; } finally { clearModifiers(); }
});
elements.applyScreenSettings.addEventListener("click", async () => {
  const [width, height] = elements.resolutionSelect.value.split("x").map(Number); const fps = Number(elements.refreshRateSelect.value);
  elements.applyScreenSettings.disabled = true; elements.screenMessage.textContent = "正在应用";
  try { await postJson("/api/video-settings", { width, height, fps }); setScreenMenu(false); connectStream(); await refreshStatus(); }
  catch (error) { elements.screenMessage.textContent = error.message; }
  finally { elements.applyScreenSettings.disabled = videoModes.length === 0; }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#mouse-tool-menu") && !event.target.closest("#mouse-button")) setMouseMenu(false);
  if (!event.target.closest("#screen-menu") && !event.target.closest("#screen-button")) setScreenMenu(false);
  if (elements.agentApp.classList.contains("sidebar-open") && !event.target.closest("#agent-sidebar") && !event.target.closest("#agent-sidebar-toggle")) {
    elements.agentApp.classList.remove("sidebar-open");
    elements.agentSidebarToggle.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (agentMode) setAgentMode(false);
    else { setPanel(false); setScreenMenu(false); setMouseMenu(false); setKeyboard(false); }
  }
});

loadAgentSessions(); loadAgentModel(); renderAgentSessions(); renderAgentConversation();
setZoom(100); setCursorSize("medium"); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000);
