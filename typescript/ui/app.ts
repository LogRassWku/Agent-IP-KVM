import { text, modeLabel } from "./formatting.js";
import { updateHostInfo } from "./host-info.js";
import { renderAgentPlan, renderModelSetup, renderRemoteModelSetup } from "./cards.js";
import { createAgentJobs } from "./agent-jobs.js";
import { postJson, fetchJson } from "./api.js";
import { SessionSynchronizer } from "./session-sync.js";
const elements = {
  noSignal: document.querySelector<HTMLElement>("#no-signal"), videoFrame: document.querySelector<HTMLImageElement>("#video-frame"),
  videoShell: document.querySelector<HTMLElement>("#video-shell"), panel: document.querySelector<HTMLElement>("#settings-panel"),
  backdrop: document.querySelector<HTMLElement>("#panel-backdrop"), settingsButton: document.querySelector<HTMLButtonElement>("#settings-button"),
  closeSettings: document.querySelector<HTMLButtonElement>("#close-settings"), refreshButton: document.querySelector<HTMLButtonElement>("#refresh-button"),
  screenButton: document.querySelector<HTMLButtonElement>("#screen-button"), screenMenu: document.querySelector<HTMLElement>("#screen-menu"),
  powerButton: document.querySelector<HTMLButtonElement>("#power-button"), powerMenu: document.querySelector<HTMLElement>("#power-menu"),
  powerMessage: document.querySelector<HTMLElement>("#power-message"), powerAction: document.querySelector<HTMLButtonElement>("#power-action"),
  resolutionSelect: document.querySelector<HTMLSelectElement>("#resolution-select"), refreshRateSelect: document.querySelector<HTMLSelectElement>("#refresh-rate-select"),
  screenMessage: document.querySelector<HTMLElement>("#screen-message"), applyScreenSettings: document.querySelector<HTMLButtonElement>("#apply-screen-settings"),
  zoomOut: document.querySelector<HTMLButtonElement>("#zoom-out"), zoomIn: document.querySelector<HTMLButtonElement>("#zoom-in"),
  keyboardButton: document.querySelector<HTMLButtonElement>("#keyboard-button"),
  keyboard: document.querySelector<HTMLElement>("#onscreen-keyboard"), closeKeyboard: document.querySelector<HTMLButtonElement>("#close-keyboard"),
  keyboardRows: document.querySelector<HTMLElement>("#keyboard-rows"), stickyKeys: document.querySelector<HTMLButtonElement>("#sticky-keys"),
  v4l2Message: document.querySelector<HTMLElement>("#v4l2-message"),
  deviceCount: document.querySelector<HTMLElement>("#device-count"), deviceList: document.querySelector<HTMLElement>("#device-list"),
  agentModeButton: document.querySelector<HTMLButtonElement>("#agent-mode-button"), agentShell: document.querySelector<HTMLElement>("#agent-shell"),
  agentComposer: document.querySelector<HTMLFormElement>("#agent-composer"), agentInput: document.querySelector<HTMLTextAreaElement>("#agent-input"),
  agentSend: document.querySelector<HTMLButtonElement>("#agent-send"), agentConversation: document.querySelector<HTMLElement>("#agent-conversation"),
  tools: document.querySelector<HTMLElement>(".tools"), agentModelPicker: document.querySelector<HTMLElement>("#agent-model-picker"),
  agentModelButton: document.querySelector<HTMLButtonElement>("#agent-model-button"), agentModelMenu: document.querySelector<HTMLElement>("#agent-model-menu"),
  agentModelName: document.querySelector<HTMLElement>("#agent-model-name"),
  agentApp: document.querySelector<HTMLElement>(".agent-app"), agentSidebar: document.querySelector<HTMLElement>("#agent-sidebar"),
  agentSidebarToggle: document.querySelector<HTMLButtonElement>("#agent-sidebar-toggle"), newAgentChat: document.querySelector<HTMLButtonElement>("#new-agent-chat"),
  agentSessionList: document.querySelector<HTMLElement>("#agent-session-list"), agentChatTitle: document.querySelector<HTMLElement>("#agent-chat-title"),
};

let videoModes = [];
let screenModesSignature = "";
let streamFrameLoaded = false;
let hidEnabled = false;
let zoomPercent = 100;
const activeModifiers = new Set();
const queuedStickyKeys = new Set();
let stickyKeysEnabled = false;
let videoWidth = 16;
let videoHeight = 9;
let pendingPointer = null;
let pendingWheel = 0;
let pointerRequestActive = false;
let agentMode = false;
let videoPauseRequest: Promise<unknown> = Promise.resolve();
const agentStorageKey = "agent-ip-kvm.sessions.v1";
const agentModelStorageKey = "agent-ip-kvm.model.v1";
const agentModelNames = {
  "qwen2.5-1.5b": "Qwen2.5 1.5B",
  "pc-agent": "PC Agent",
  "remote-api": "远程 API",
};
let agentSessions = [];
let deletedAgentSessionIds = new Set();
let activeAgentSessionId = "";
let selectedAgentModel = "qwen2.5-1.5b";
let modelSetupPollActive = false;

const legacyAgentProgress = new Set([
  "正在分析并准备安全操作…",
  "正在分析环境并规划操作…",
  "正在识别屏幕并准备安全操作…",
]);



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

function screenModes(payload) {
  const captureDevice = payload.v4l2?.devices?.find((device) =>
    device.device_path === payload.source?.source_id?.replace("v4l2:", "") && device.supports_video_capture);
  return (captureDevice?.capabilities ?? []).filter((mode) => mode.pixel_format === "MJPG" || mode.pixel_format === "MJPEG");
}

function screenSignature(payload) {
  return JSON.stringify([payload.source?.source_id, screenModes(payload)]);
}

function updateScreenOptions(payload) {
  const sourceMode = payload.source?.capabilities?.[0];
  videoModes = screenModes(payload);
  screenModesSignature = screenSignature(payload);
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

function resetStickyKeys() {
  stickyKeysEnabled = false;
  queuedStickyKeys.clear();
  elements.stickyKeys.classList.remove("active");
  elements.stickyKeys.setAttribute("aria-pressed", "false");
  elements.stickyKeys.title = "选择多个按键后再次点击发送";
  for (const button of elements.keyboardRows.querySelectorAll("[data-key]")) button.classList.remove("queued");
  clearModifiers();
}

function updateHidStatus(hid) {
  hidEnabled = Boolean(hid?.enabled && hid?.state !== "stopped" && hid?.state !== "error");
  for (const key of elements.keyboardRows.querySelectorAll("button")) key.disabled = !hidEnabled;
  if (!hidEnabled) {
    resetStickyKeys();
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
  // Status can describe the instant before this browser connected. An idle
  // response arriving after image load must not hide an already decoded frame.
  const hasFrame = !agentMode && streamFrameLoaded && available;
  elements.videoFrame.classList.toggle("visible", hasFrame); elements.noSignal.hidden = hasFrame;
  text("info-backend", source?.backend); text("info-source", source?.source_id); text("info-health", source?.health);
  text("info-format", modeLabel(source?.capabilities, "format"));
  text("info-resolution", modeLabel(source?.capabilities, "resolution")); text("info-fps", modeLabel(source?.capabilities, "fps"));
  text("info-error", source?.error || "无"); updateDevices(payload.v4l2); updateHidStatus(payload.hid); updateHostInfo(payload.controlled_host);
  updatePowerStatus(payload.power);
  // Discovery may finish after the user opens the menu. Refresh changed
  // capabilities then, but preserve an unsaved selection during ordinary polls.
  if (elements.screenMenu.hidden || screenSignature(payload) !== screenModesSignature) updateScreenOptions(payload);
}

function updatePowerStatus(power) {
  const available = Boolean(power?.available);
  elements.powerAction.disabled = false;
  elements.powerAction.setAttribute("aria-disabled", String(!available));
  elements.powerMessage.textContent = power?.message || (available ? "可发送唤醒信号" : "未配置电源控制");
  elements.powerMessage.classList.toggle("available", available);
}

function connectStream() {
  if (agentMode) return;
  streamFrameLoaded = false;
  elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false;
  elements.videoFrame.src = `/api/stream.mjpg?t=${Date.now()}`;
}

function disconnectStream() {
  streamFrameLoaded = false;
  elements.videoFrame.classList.remove("visible");
  elements.videoFrame.removeAttribute("src");
  elements.noSignal.hidden = false;
}

function requestVideoPause() {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/video/pause", true);
    request.setRequestHeader("Content-Type", "application/json");
    request.timeout = 8000;
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`HTTP ${request.status}`));
    });
    request.addEventListener("error", () => reject(new Error("video pause request failed")));
    request.addEventListener("timeout", () => reject(new Error("video pause request timed out")));
    request.send("{}");
  });
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`); updateStatus(await response.json());
  } catch (error) { elements.noSignal.classList.add("unavailable"); text("info-error", (error instanceof Error ? error.message : String(error))); }
}

function setPanel(open) {
  elements.panel.classList.toggle("open", open); elements.panel.setAttribute("aria-hidden", String(!open));
  elements.settingsButton.setAttribute("aria-expanded", String(open)); elements.backdrop.hidden = !open;
}
function setScreenMenu(open) {
  elements.screenMenu.hidden = !open; elements.screenButton.setAttribute("aria-expanded", String(open));
  if (open) { setKeyboard(false); setPanel(false); }
}
function setPowerMenu(open) {
  elements.powerMenu.hidden = !open;
  elements.powerButton.setAttribute("aria-expanded", String(open));
  if (open) { setScreenMenu(false); setKeyboard(false); setPanel(false); }
}
function setKeyboard(open) {
  elements.keyboard.hidden = !open; elements.keyboardButton.setAttribute("aria-expanded", String(open));
  if (open) { setScreenMenu(false); setPanel(false); } else resetStickyKeys();
}

function setAgentMode(open) {
  agentMode = Boolean(open);
  setAgentModelMenu(false);
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
    disconnectStream();
    videoPauseRequest = requestVideoPause().catch((error) => {
      console.warn("Unable to release video capture", error);
    });
    setPanel(false);
    setScreenMenu(false);
    setKeyboard(false);
    elements.agentInput.focus({ preventScroll: true });
  } else {
    const pendingPause = videoPauseRequest;
    pendingPause.finally(() => {
      if (!agentMode) connectStream();
    });
  }
}

const { runRemoteAgentJob, applyRemoteAgentResult, resumeRemoteAgentJob, resumePendingAgentJobs } = createAgentJobs({
  save: () => saveAgentSessions(), renderConversation: () => renderAgentConversation(),
  renderSessions: () => renderAgentSessions(), activeId: () => activeAgentSessionId,
  sessions: () => agentSessions,
});
function newSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeAgentSession() {
  const now = Date.now();
  return { id: newSessionId(), title: "新会话", createdAt: now, updatedAt: now, messages: [] };
}

function saveAgentSessions(sync = true) {
  try {
    localStorage.setItem(agentStorageKey, JSON.stringify({
      activeId: activeAgentSessionId,
      sessions: agentSessions,
      deletedIds: [...deletedAgentSessionIds],
    }));
  } catch (_) { /* The interface remains usable if local storage is unavailable. */ }
  if (sync) for (const session of agentSessions) queueSessionSync(session);
}

const syncMessages = new Map<string, string>();
const sessionSync = new SessionSynchronizer({
  find: (id) => agentSessions.find(s => s.id === id),
  saved: (id, revision) => {
    const session = agentSessions.find(s => s.id === id);
    if (session) session.revision = revision;
    saveAgentSessions(false);
  },
  status: (id, message) => { syncMessages.set(id, message); renderSyncStatus(); },
  conflict: (local, remote, deleted) => {
    const previousId = local.id;
    // Preserve object identity for an in-flight Agent job's completion callback.
    const copy = Object.assign(local, { id: newSessionId(), revision: 0, title: (local.title + "（本地冲突副本）").slice(0, 120) });
    agentSessions = agentSessions.filter(s => s !== local && s.id !== previousId);
    if (remote && !deleted) agentSessions.push(remote);
    agentSessions.push(copy);
    if (activeAgentSessionId === previousId) activeAgentSessionId = copy.id;
    syncMessages.delete(previousId);
    syncMessages.set(copy.id, "其他页面已更新此会话，本地内容已保留为独立副本。");
    saveAgentSessions(false); queueSessionSync(copy);
    renderAgentSessions(); renderAgentConversation();
  },
});
function renderSyncStatus() {
  let status = document.querySelector<HTMLElement>("#session-sync-status");
  if (!status) {
    status = document.createElement("p"); status.id = "session-sync-status";
    status.setAttribute("role", "status"); elements.agentChatTitle.after(status);
  }
  status.textContent = syncMessages.get(activeAgentSessionId) || "";
  status.hidden = !status.textContent;
}
function queueSessionSync(session) {
  if (session?.id && !deletedAgentSessionIds.has(session.id)) sessionSync.queue(session);
}

function queueSessionDelete(sessionId) {
  sessionSync.cancel(sessionId);
  window.fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
    .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
    .catch(() => { /* The persisted tombstone retries this deletion during synchronization. */ });
}

function retireLegacyAgentProgress() {
  let changed = false;
  for (const session of agentSessions) {
    let sessionChanged = false;
    for (const message of session.messages) {
      if (message?.role !== "assistant" || message.remoteRequestId
          || !legacyAgentProgress.has(String(message.content ?? "").trim())) continue;
      message.content = "上一次 Agent 请求的网页连接已中断，请重新发送。";
      message.transient = false;
      sessionChanged = true;
      changed = true;
    }
    if (sessionChanged) session.updatedAt = Date.now();
  }
  return changed;
}

async function syncAgentSessionsFromBoard() {
  try {
    const result = await fetchJson("/api/agent/sessions");
    const remote = Array.isArray(result.sessions) ? result.sessions : [];
    const remoteDeleted = new Set(Array.isArray(result.deleted_session_ids) ? result.deleted_session_ids : []);
    for (const sessionId of remoteDeleted) deletedAgentSessionIds.add(sessionId);
    agentSessions = agentSessions.filter((session) => !deletedAgentSessionIds.has(session.id));
    const byId = new Map(agentSessions.map((session) => [session.id, session]));
    for (const session of remote) {
      if (deletedAgentSessionIds.has(session.id)) continue;
      const local = byId.get(session.id);
      if (!local || (!sessionSync.isDirty(local.id) && Number(session.revision ?? 0) >= Number(local.revision ?? 0))) byId.set(session.id, session);
    }
    for (const session of agentSessions) {
      if (!remote.some((item) => item.id === session.id) || sessionSync.isDirty(session.id)) queueSessionSync(session);
    }
    for (const sessionId of deletedAgentSessionIds) {
      if (!remoteDeleted.has(sessionId)) queueSessionDelete(sessionId);
    }
    agentSessions = [...byId.values()].filter((session) => session && typeof session.id === "string");
    if (agentSessions.length === 0) {
      const session = makeAgentSession();
      agentSessions.push(session);
      queueSessionSync(session);
    }
    if (!agentSessions.some((session) => session.id === activeAgentSessionId)) activeAgentSessionId = agentSessions[0].id;
    const retiredLegacyProgress = retireLegacyAgentProgress();
    saveAgentSessions(retiredLegacyProgress); renderAgentSessions(); renderAgentConversation(); resumePendingAgentJobs();
  } catch (_) { /* The browser cache remains usable during a board reconnect. */ }
}

function loadAgentSessions() {
  try {
    const saved = JSON.parse(localStorage.getItem(agentStorageKey) ?? "null");
    if (Array.isArray(saved?.sessions)) {
      agentSessions = saved.sessions.filter((session) =>
        session && typeof session.id === "string" && typeof session.title === "string" && Array.isArray(session.messages));
      for (const session of agentSessions) {
        for (const message of session.messages) {
          if (message && typeof message === "object" && ["ready", "pending_approval", "approved", "executing"].includes(message.plan?.status)) {
            message.plan.status = "expired";
          }
        }
      }
      activeAgentSessionId = typeof saved.activeId === "string" ? saved.activeId : "";
      deletedAgentSessionIds = new Set(Array.isArray(saved.deletedIds) ? saved.deletedIds.filter((id) => typeof id === "string") : []);
      agentSessions = agentSessions.filter((session) => !deletedAgentSessionIds.has(session.id));
    }
  } catch (_) { agentSessions = []; }
  if (agentSessions.length === 0) agentSessions.push(makeAgentSession());
  if (!agentSessions.some((session) => session.id === activeAgentSessionId)) activeAgentSessionId = agentSessions[0].id;
  retireLegacyAgentProgress();
  saveAgentSessions();
}

function loadAgentModel() {
  let selected = "qwen2.5-1.5b";
  try {
    const saved = localStorage.getItem(agentModelStorageKey);
    if (saved in agentModelNames) selected = saved;
  } catch (_) { /* Keep the default model if local storage is unavailable. */ }
  selectAgentModel(selected, false);
}

function setAgentModelMenu(open) {
  elements.agentModelMenu.hidden = !open;
  elements.agentModelButton.setAttribute("aria-expanded", String(open));
}

function selectAgentModel(modelId, persist = true) {
  const selected = modelId in agentModelNames ? modelId : "qwen2.5-1.5b";
  selectedAgentModel = selected;
  elements.agentModelName.textContent = agentModelNames[selected];
  for (const option of elements.agentModelMenu.querySelectorAll<HTMLElement>("[data-model-option]")) {
    option.classList.toggle("selected", option.dataset.modelOption === selected);
  }
  setAgentModelMenu(false);
  if (persist) {
    try { localStorage.setItem(agentModelStorageKey, selected); } catch (_) { /* UI selection still works. */ }
  }
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
  const content = document.createElement("div");
  const paragraph = document.createElement("p");
  paragraph.textContent = String(message.content ?? "");
  content.append(paragraph);
  if (message.plan) content.append(renderAgentPlan(message.plan));
  if (message.modelSetup) content.append(renderModelSetup(message));
  if (message.remoteModelSetup) content.append(renderRemoteModelSetup(message));
  article.append(content);
  return article;
}

function renderAgentConversation() {
  const session = activeAgentSession();
  elements.agentChatTitle.textContent = session.title;
  renderSyncStatus();
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
  deletedAgentSessionIds.add(sessionId);
  if (agentSessions.length === 0) agentSessions.push(makeAgentSession());
  if (activeAgentSessionId === sessionId) activeAgentSessionId = [...agentSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  saveAgentSessions();
  queueSessionDelete(sessionId);
  renderAgentSessions();
  renderAgentConversation();
}

function resizeAgentInput() {
  elements.agentInput.style.height = "auto";
  elements.agentInput.style.height = `${Math.min(130, elements.agentInput.scrollHeight)}px`;
}



async function submitAgentPrompt(prompt) {
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
  elements.agentSend.disabled = true;
  let progressMessage = null;
  try {
    if (selectedAgentModel === "remote-api") {
      progressMessage = {
        role: "assistant", content: "正在连接开发板…", createdAt: Date.now(), transient: true,
        remoteRequestId: newSessionId(), agentJobId: "",
      };
      session.messages.push(progressMessage);
      saveAgentSessions(); renderAgentConversation();
      const response = await runRemoteAgentJob(session, progressMessage);
      applyRemoteAgentResult(session, progressMessage, response);
      progressMessage = null;
    } else {
      const response = await postJson("/api/agent/plans", { objective: value, model: selectedAgentModel });
      const plan = response.plan;
      const assistantMessage = { role: "assistant", content: plan.summary, plan, createdAt: Date.now() };
      session.messages.push(assistantMessage);
      session.updatedAt = Date.now();
      if (!plan.approval_required) {
        const executed = await postJson("/api/agent/execute", { plan_id: plan.plan_id });
        assistantMessage.plan = executed.plan;
      }
    }
  } catch (error) {
    if (progressMessage) session.messages = session.messages.filter((item) => item !== progressMessage);
    session.messages.push({ role: "assistant", content: `无法处理：${(error instanceof Error ? error.message : String(error))}`, createdAt: Date.now() });
  } finally {
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentSessions(); renderAgentConversation();
    elements.agentSend.disabled = false; elements.agentInput.focus({ preventScroll: true });
  }
}

async function openPcAgentSetup() {
  setAgentModelMenu(false);
  let catalog;
  let latest;
  try {
    [catalog, latest] = await Promise.all([fetchJson("/api/model-setup/catalog"), fetchJson("/api/model-setup/tasks/latest")]);
  } catch (error) {
    window.alert(`无法读取模型配置：${(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  const locations = catalog.locations ?? [];
  const preferred = locations.find((item) => item.drive === "D:") ?? locations[0];
  const session = makeAgentSession();
  session.title = "配置 PC Agent 模型";
  const task = latest.task && !["completed", "failed", "cancelled"].includes(latest.task.status) ? latest.task : null;
  session.messages.push({
    id: newSessionId(), role: "assistant", content: task ? "已找到最近的模型配置任务。" : "请选择模型和安装位置。",
    createdAt: Date.now(), modelSetup: {
      catalog, model: "qwen3.5:9b", modelsDir: preferred?.models_dir ?? "D:\\AgentIPKVM\\Models",
      installDir: `${preferred?.drive ?? "D:"}\\AgentIPKVM\\Ollama`, task,
    },
  });
  agentSessions.push(session); activeAgentSessionId = session.id;
  saveAgentSessions(); renderAgentSessions(); renderAgentConversation();
  if (task && !["completed", "failed", "cancelled"].includes(task.status)) pollModelSetupTasks();
}

async function openRemoteModelSetup() {
  setAgentModelMenu(false);
  let catalog;
  let current;
  try {
    [catalog, current] = await Promise.all([fetchJson("/api/remote-model/catalog"), fetchJson("/api/remote-model/config")]);
  } catch (error) {
    window.alert(`无法读取远程 API 配置：${(error instanceof Error ? error.message : String(error))}`); return;
  }
  const session = makeAgentSession(); session.title = "配置远程 API";
  session.messages.push({
    id: newSessionId(), role: "assistant", content: current.configured ? "远程 API 已配置，可以替换密钥或测试连接。" : "请选择 DeepSeek 模型并填写 API 密钥。",
    createdAt: Date.now(), remoteModelSetup: {
      catalog, baseUrl: current.base_url, model: current.model, visionModel: current.vision_model, configured: current.configured, result: "",
    },
  });
  agentSessions.push(session); activeAgentSessionId = session.id;
  saveAgentSessions(); renderAgentSessions(); renderAgentConversation();
}

async function saveRemoteModelSetup(card) {
  const session = activeAgentSession();
  const message = session.messages.find((item) => item.id === card.dataset.remoteSetupMessageId);
  if (!message?.remoteModelSetup) return;
  const button = card.querySelector("[data-remote-setup-action='save']"); button.disabled = true;
  const baseUrl = card.querySelector("[data-remote-field='base_url']").value.trim();
  const model = card.querySelector("[data-remote-field='model']").value;
  const visionModel = card.querySelector("[data-remote-field='vision_model']").value || "deepseek-v4-flash-vision-exp";
  const apiKey = card.querySelector("[data-remote-field='api_key']").value.trim();
  try {
    const saved = await postJson("/api/remote-model/config", { base_url: baseUrl, model, vision_model: visionModel, api_key: apiKey });
    message.remoteModelSetup = { ...message.remoteModelSetup, baseUrl: saved.remote_model.base_url, model: saved.remote_model.model, visionModel: saved.remote_model.vision_model, configured: true, result: "配置已保存。文字模型负责规划；视觉模型只在请求截图时读取单帧。" };
    selectAgentModel("remote-api");
  } catch (error) { message.remoteModelSetup.result = `保存失败：${(error instanceof Error ? error.message : String(error))}`; }
  session.updatedAt = Date.now(); saveAgentSessions(); renderAgentSessions(); renderAgentConversation();
}

async function testRemoteModelSetup(card) {
  const session = activeAgentSession();
  const message = session.messages.find((item) => item.id === card.dataset.remoteSetupMessageId);
  if (!message?.remoteModelSetup) return;
  const button = card.querySelector("[data-remote-setup-action='test']"); if (button) button.disabled = true;
  try {
    const result = await postJson("/api/remote-model/test", {});
    message.remoteModelSetup.result = `连接成功：${result.remote_model.reply}`;
  } catch (error) { message.remoteModelSetup.result = `连接失败：${(error instanceof Error ? error.message : String(error))}`; }
  session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
}

async function cancelModelSetup(card) {
  const session = activeAgentSession();
  const message = session.messages.find(item => item.id === card.dataset.setupMessageId);
  if (!message?.modelSetup?.task) return;
  try {
    message.modelSetup.task = (await postJson("/api/model-setup/cancel", { task_id: message.modelSetup.task.task_id })).task;
    message.content = "配置已取消。";
  } catch (error) { message.content = String(error); }
  session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
}

async function startModelSetup(card) {
  const session = activeAgentSession();
  const message = session.messages.find((item) => item.id === card.dataset.setupMessageId);
  if (!message?.modelSetup || (message.modelSetup.task && !["awaiting_start", "failed"].includes(message.modelSetup.task.status))) return;
  const button = card.querySelector("[data-setup-action='start']"); button.disabled = true;
  const model = message.modelSetup.task?.model ?? card.querySelector("[data-setup-field='model']").value;
  const modelsDir = message.modelSetup.task?.models_dir ?? card.querySelector("[data-setup-field='models_dir']").value;
  const installDir = message.modelSetup.task?.install_dir ?? card.querySelector("[data-setup-field='install_dir']").value.trim();
  try {
    if (message.modelSetup.task) await postJson("/api/model-setup/cancel", { task_id: message.modelSetup.task.task_id });
    const created = await postJson("/api/model-setup/tasks", { model, models_dir: modelsDir, install_dir: installDir });
    message.modelSetup.task = created.task; message.content = "模型配置任务已经创建。";
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
    const launched = await postJson("/api/model-setup/launch", { task_id: created.task.task_id });
    message.modelSetup.task = launched.task; message.content = "安装指令已发送到被控电脑。";
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation(); pollModelSetupTasks();
  } catch (error) {
    message.content = `无法启动配置：${(error instanceof Error ? error.message : String(error))}`;
    if (message.modelSetup.task) {
      try { message.modelSetup.task = (await fetchJson(`/api/model-setup/tasks/${message.modelSetup.task.task_id}`)).task; } catch {}
    }
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
  }
}

async function pollModelSetupTasks() {
  if (modelSetupPollActive) return;
  modelSetupPollActive = true;
  try {
    let pending = false;
    for (const session of agentSessions) {
      for (const message of session.messages) {
        const task = message.modelSetup?.task;
        if (!task || ["completed", "failed", "cancelled"].includes(task.status)) continue;
        pending = true;
        try { message.modelSetup.task = (await fetchJson(`/api/model-setup/tasks/${task.task_id}`)).task; }
        catch (_) { /* Keep the latest visible state during a transient disconnect. */ }
      }
    }
    saveAgentSessions(); renderAgentConversation();
    if (pending) window.setTimeout(pollModelSetupTasks, 2000);
  } finally { modelSetupPollActive = false; }
}

async function handleAgentPlanAction(button: HTMLButtonElement) {
  const card = button.closest<HTMLElement>("[data-plan-id]");
  const session = activeAgentSession();
  const message = session.messages.find((item) => item.plan?.plan_id === card?.dataset.planId);
  if (!message) return;
  for (const control of card.querySelectorAll("button")) control.disabled = true;
  try {
    if (button.dataset.planAction === "reject") {
      message.plan = (await postJson("/api/agent/reject", { plan_id: message.plan.plan_id })).plan;
    } else {
      message.plan = (await postJson("/api/agent/approve", {
        plan_id: message.plan.plan_id,
        digest: message.plan.digest,
      })).plan;
      message.plan = (await postJson("/api/agent/execute", { plan_id: message.plan.plan_id })).plan;
    }
  } catch (error) {
    message.content = `${message.content}\n无法完成：${(error instanceof Error ? error.message : String(error))}`;
  }
  session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
}

function setZoom(value) {
  zoomPercent = Math.min(200, Math.max(50, Number(value)));
  elements.videoFrame.style.setProperty("--video-zoom", String(zoomPercent / 100));
  elements.zoomOut.disabled = zoomPercent <= 50;
  elements.zoomIn.disabled = zoomPercent >= 200;
  elements.zoomOut.title = `缩小画面（当前 ${zoomPercent}%）`;
  elements.zoomIn.title = `放大画面（当前 ${zoomPercent}%）`;
}
function toggleModifier(name) {
  if (activeModifiers.has(name)) activeModifiers.delete(name); else activeModifiers.add(name);
  for (const button of elements.keyboardRows.querySelectorAll(`[data-modifier="${name}"]`)) {
    const active = activeModifiers.has(name); button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function queueStickyKey(button) {
  const key = button.dataset.key;
  if (queuedStickyKeys.has(key)) queuedStickyKeys.delete(key); else queuedStickyKeys.add(key);
  button.classList.toggle("queued", queuedStickyKeys.has(key));
  elements.stickyKeys.title = `已选择 ${queuedStickyKeys.size} 个按键；再次点击发送`;
}

async function toggleStickyKeys() {
  if (!stickyKeysEnabled) {
    stickyKeysEnabled = true;
    elements.stickyKeys.classList.add("active");
    elements.stickyKeys.setAttribute("aria-pressed", "true");
    elements.stickyKeys.title = "选择按键；再次点击粘滞键发送";
    return;
  }
  const keys = [...queuedStickyKeys];
  const modifiers = [...activeModifiers];
  elements.stickyKeys.disabled = true;
  try {
    if (keys.length > 0) {
      for (const key of keys) await postJson("/api/hid/key", { key, modifiers });
    } else {
      for (const modifier of modifiers) await postJson("/api/hid/key", { key: modifier, modifiers: [] });
    }
  } catch (error) {
    console.warn("Unable to send sticky keys", error);
    await refreshStatus();
  } finally {
    resetStickyKeys();
    elements.stickyKeys.disabled = !hidEnabled;
  }
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
  if ((event.target as HTMLElement).closest?.(".zoom-buttons")) return null;
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
    console.warn("Unable to move HID pointer", error);
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
  catch (error) { console.warn("Unable to click HID pointer", error); await refreshStatus(); }
}
async function tapKey(button) {
  if (!hidEnabled) return;
  button.disabled = true;
  try {
    await postJson("/api/hid/key", { key: button.dataset.key, modifiers: [...activeModifiers] });
  } catch (error) { console.warn("Unable to send HID key", error); await refreshStatus(); }
  finally { button.disabled = !hidEnabled; clearModifiers(); }
}

async function tapModifier(button) {
  if (!hidEnabled) return;
  button.disabled = true;
  try {
    await postJson("/api/hid/key", { key: button.dataset.modifier, modifiers: [] });
  } catch (error) { console.warn("Unable to send HID modifier", error); await refreshStatus(); }
  finally { button.disabled = !hidEnabled; }
}

elements.settingsButton.addEventListener("click", () => { setScreenMenu(false); setKeyboard(false); setPanel(true); });
elements.closeSettings.addEventListener("click", () => setPanel(false));
elements.backdrop.addEventListener("click", () => setPanel(false));
elements.refreshButton.addEventListener("click", () => { connectStream(); refreshStatus(); });
elements.videoFrame.addEventListener("load", () => { if (agentMode || !elements.videoFrame.hasAttribute("src")) return; streamFrameLoaded = true; elements.videoFrame.classList.add("visible"); elements.noSignal.hidden = true; });
elements.videoFrame.addEventListener("error", () => { streamFrameLoaded = false; elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false; refreshStatus(); });
elements.screenButton.addEventListener("click", () => setScreenMenu(elements.screenMenu.hidden));
elements.powerButton.addEventListener("click", () => setPowerMenu(elements.powerMenu.hidden));
elements.powerAction.addEventListener("click", async () => {
  elements.powerAction.disabled = true;
  elements.powerMessage.textContent = "正在发送唤醒信号";
  try {
    await postJson("/api/power", { action: "wake" });
    elements.powerMessage.textContent = "唤醒信号已发送";
  } catch (error) {
    elements.powerMessage.textContent = (error instanceof Error ? error.message : String(error));
  } finally {
    elements.powerAction.disabled = false;
  }
});
elements.keyboardButton.addEventListener("click", () => setKeyboard(elements.keyboard.hidden));
elements.closeKeyboard.addEventListener("click", () => setKeyboard(false));
elements.zoomOut.addEventListener("click", () => setZoom(zoomPercent - 10));
elements.zoomIn.addEventListener("click", () => setZoom(zoomPercent + 10));
document.addEventListener("mousemove", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains((event.target as HTMLElement))) return;
  const pointer = pointerFromEvent(event);
  if (pointer === null) return;
  pendingPointer = pointer;
  requestAnimationFrame(flushPointerPosition);
});
document.addEventListener("mousedown", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains((event.target as HTMLElement))) return;
  const pointer = pointerFromEvent(event);
  if (pointer === null) return;
  event.preventDefault();
  pendingPointer = pointer;
  clickMouse(event.button, pointer);
});
document.addEventListener("wheel", (event) => {
  if (agentMode || !hidEnabled || !elements.videoShell.contains((event.target as HTMLElement))) return;
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
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-session-action]");
  const sessionId = (event.target as HTMLElement).closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
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
elements.agentConversation.addEventListener("click", (event) => {
  const setupButton = (event.target as HTMLElement).closest<HTMLElement>("[data-setup-action]");
  if (setupButton) {
    const card = setupButton.closest<HTMLElement>("[data-setup-message-id]");
    if (setupButton.dataset.setupAction === "cancel") cancelModelSetup(card);
    else startModelSetup(card);
    return;
  }
  const remoteSetupButton = (event.target as HTMLElement).closest<HTMLElement>("[data-remote-setup-action]");
  if (remoteSetupButton) {
    const card = remoteSetupButton.closest<HTMLElement>("[data-remote-setup-message-id]");
    if (remoteSetupButton.dataset.remoteSetupAction === "save") saveRemoteModelSetup(card);
    if (remoteSetupButton.dataset.remoteSetupAction === "test") testRemoteModelSetup(card);
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-plan-action]");
  if (button) handleAgentPlanAction(button);
});
elements.agentModelButton.addEventListener("click", () => setAgentModelMenu(elements.agentModelMenu.hidden));
elements.agentModelMenu.addEventListener("click", (event) => {
  const configure = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-config-model]");
  if (configure && !configure.disabled) {
    if (configure.dataset.configModel === "remote-api") openRemoteModelSetup();
    else openPcAgentSetup();
    return;
  }
  const option = (event.target as HTMLElement).closest<HTMLElement>("[data-model-option]");
  if (option) selectAgentModel(option.dataset.modelOption);
});
elements.resolutionSelect.addEventListener("change", () => fillRefreshRates(0));
elements.keyboardRows.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button"); if (!button || button.disabled) return;
  if (button === elements.stickyKeys) toggleStickyKeys();
  else if (button.dataset.modifier && stickyKeysEnabled) toggleModifier(button.dataset.modifier);
  else if (button.dataset.modifier) tapModifier(button);
  else if (button.dataset.key && stickyKeysEnabled) queueStickyKey(button);
  else if (button.dataset.key) tapKey(button);
});
elements.applyScreenSettings.addEventListener("click", async () => {
  const [width, height] = elements.resolutionSelect.value.split("x").map(Number); const fps = Number(elements.refreshRateSelect.value);
  elements.applyScreenSettings.disabled = true; elements.screenMessage.textContent = "正在应用";
  try { await postJson("/api/video-settings", { width, height, fps }); setScreenMenu(false); connectStream(); await refreshStatus(); }
  catch (error) { elements.screenMessage.textContent = (error instanceof Error ? error.message : String(error)); }
  finally { elements.applyScreenSettings.disabled = videoModes.length === 0; }
});
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("#screen-menu") && !(event.target as HTMLElement).closest("#screen-button")) setScreenMenu(false);
  if (!(event.target as HTMLElement).closest("#power-menu") && !(event.target as HTMLElement).closest("#power-button")) setPowerMenu(false);
  if (!(event.target as HTMLElement).closest("#agent-model-picker")) setAgentModelMenu(false);
  if (elements.agentApp.classList.contains("sidebar-open") && !(event.target as HTMLElement).closest("#agent-sidebar") && !(event.target as HTMLElement).closest("#agent-sidebar-toggle")) {
    elements.agentApp.classList.remove("sidebar-open");
    elements.agentSidebarToggle.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (agentMode) setAgentMode(false);
    else { setPanel(false); setScreenMenu(false); setPowerMenu(false); setKeyboard(false); }
  }
});

loadAgentSessions(); loadAgentModel(); renderAgentSessions(); renderAgentConversation(); pollModelSetupTasks(); resumePendingAgentJobs(); syncAgentSessionsFromBoard();
setZoom(100); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000); setInterval(syncAgentSessionsFromBoard, 5000);
