const elements = {
  noSignal: document.querySelector("#no-signal"), videoFrame: document.querySelector("#video-frame"),
  videoShell: document.querySelector("#video-shell"), panel: document.querySelector("#settings-panel"),
  backdrop: document.querySelector("#panel-backdrop"), settingsButton: document.querySelector("#settings-button"),
  closeSettings: document.querySelector("#close-settings"), refreshButton: document.querySelector("#refresh-button"),
  screenButton: document.querySelector("#screen-button"), screenMenu: document.querySelector("#screen-menu"),
  resolutionSelect: document.querySelector("#resolution-select"), refreshRateSelect: document.querySelector("#refresh-rate-select"),
  screenMessage: document.querySelector("#screen-message"), applyScreenSettings: document.querySelector("#apply-screen-settings"),
  zoomOut: document.querySelector("#zoom-out"), zoomIn: document.querySelector("#zoom-in"),
  keyboardButton: document.querySelector("#keyboard-button"),
  keyboard: document.querySelector("#onscreen-keyboard"), closeKeyboard: document.querySelector("#close-keyboard"),
  keyboardRows: document.querySelector("#keyboard-rows"), stickyKeys: document.querySelector("#sticky-keys"),
  v4l2Message: document.querySelector("#v4l2-message"),
  deviceCount: document.querySelector("#device-count"), deviceList: document.querySelector("#device-list"),
  agentModeButton: document.querySelector("#agent-mode-button"), agentShell: document.querySelector("#agent-shell"),
  agentComposer: document.querySelector("#agent-composer"), agentInput: document.querySelector("#agent-input"),
  agentSend: document.querySelector("#agent-send"), agentConversation: document.querySelector("#agent-conversation"),
  tools: document.querySelector(".tools"), agentModelPicker: document.querySelector("#agent-model-picker"),
  agentModelButton: document.querySelector("#agent-model-button"), agentModelMenu: document.querySelector("#agent-model-menu"),
  agentModelName: document.querySelector("#agent-model-name"),
  agentApp: document.querySelector(".agent-app"), agentSidebar: document.querySelector("#agent-sidebar"),
  agentSidebarToggle: document.querySelector("#agent-sidebar-toggle"), newAgentChat: document.querySelector("#new-agent-chat"),
  agentSessionList: document.querySelector("#agent-session-list"), agentChatTitle: document.querySelector("#agent-chat-title"),
};

let videoModes = [];
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
let videoPauseRequest = Promise.resolve();
const agentStorageKey = "agent-ip-kvm.sessions.v1";
const agentModelStorageKey = "agent-ip-kvm.model.v1";
const agentModelNames = {
  "qwen2.5-1.5b": "Qwen2.5 1.5B",
  "pc-agent": "PC Agent",
  "remote-api": "远程 API",
};
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

function formatBytes(value) {
  if (value === null || value === undefined) return "--";
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = size;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function compact(values, separator = " · ") {
  return values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").join(separator) || "--";
}

function renderHostStorage(host) {
  const container = document.querySelector("#host-storage");
  container.replaceChildren();
  const disks = host.disks || [];
  const hasMappedPartitions = disks.some((disk) => (disk.partitions || []).length > 0);

  disks.forEach((disk, index) => {
    const card = document.createElement("article"); card.className = "storage-card";
    const title = document.createElement("strong");
    title.textContent = `磁盘 ${disk.number ?? index} · ${disk.model}`;
    const detail = document.createElement("span");
    detail.textContent = compact([formatBytes(disk.size_bytes), disk.interface, disk.partition_style, disk.health]);
    card.append(title, detail);

    if ((disk.partitions || []).length > 0) {
      const partitionList = document.createElement("div"); partitionList.className = "storage-partitions";
      for (const partition of disk.partitions) {
        const row = document.createElement("div"); row.className = "storage-partition";
        const name = document.createElement("b");
        name.textContent = partition.name || `分区 ${partition.number ?? "--"}`;
        const flags = compact([
          partition.label,
          partition.filesystem,
          partition.type,
          partition.is_system ? "系统" : null,
          partition.is_boot ? "启动" : null,
          partition.is_hidden ? "隐藏" : null,
        ]);
        const capacity = partition.free_bytes == null
          ? `${formatBytes(partition.size_bytes)} 总计`
          : `${formatBytes(partition.free_bytes)} 可用 / ${formatBytes(partition.size_bytes)} 总计`;
        const summary = document.createElement("span"); summary.textContent = `${flags}\n${capacity}`;
        row.append(name, summary); partitionList.append(row);
      }
      card.append(partitionList);
    }
    container.append(card);
  });

  if (!hasMappedPartitions && (host.volumes || []).length > 0) {
    const card = document.createElement("article"); card.className = "storage-card";
    const title = document.createElement("strong"); title.textContent = "已挂载分区";
    const partitionList = document.createElement("div"); partitionList.className = "storage-partitions";
    for (const volume of host.volumes) {
      const row = document.createElement("div"); row.className = "storage-partition";
      const name = document.createElement("b"); name.textContent = volume.name;
      const summary = document.createElement("span");
      summary.textContent = `${compact([volume.label, volume.filesystem])}\n${formatBytes(volume.free_bytes)} 可用 / ${formatBytes(volume.size_bytes)} 总计`;
      row.append(name, summary); partitionList.append(row);
    }
    card.append(title, partitionList); container.append(card);
  }

  if (!container.hasChildNodes()) container.textContent = "--";
}

function updateHostInfo(report) {
  const state = document.querySelector("#host-info-state");
  const list = document.querySelector("#host-info-list");
  const available = report?.status === "available" && report.data;
  state.classList.toggle("error", report?.status === "error");
  state.textContent = available ? "已同步" : report?.status === "error" ? "数据错误" : "未连接";
  text("host-info-message", report?.message || "尚未收到被控主机信息");
  list.hidden = !available;
  if (!available) return;

  const host = report.data;
  text("host-collected-at", host.collected_at ? new Date(host.collected_at).toLocaleString() : "--");
  text("host-name", host.hostname);
  text("host-os", compact([host.os?.name, host.os?.version, host.os?.build ? `Build ${host.os.build}` : null, host.os?.architecture]));
  text("host-system", compact([host.system?.manufacturer, host.system?.model]));
  text("host-bios", compact([host.bios?.manufacturer, host.bios?.version, host.bios?.secure_boot == null ? null : `安全启动 ${host.bios?.secure_boot ? "开启" : "关闭"}`]));
  text("host-cpu", compact([host.cpu?.model, host.cpu?.max_clock_mhz ? `${host.cpu.max_clock_mhz} MHz` : null]));
  text("host-cores", compact([host.cpu?.physical_cores == null ? null : `${host.cpu.physical_cores} 核`, host.cpu?.logical_processors == null ? null : `${host.cpu.logical_processors} 线程`]));
  text("host-gpu", (host.gpus || []).map((gpu) => compact([gpu.name, gpu.driver_version ? `驱动 ${gpu.driver_version}` : null])).join("\n") || "--");
  text("host-memory", formatBytes(host.memory?.total_bytes));
  const speeds = [...new Set((host.memory?.modules || []).map((module) => module.speed_mts).filter(Boolean))];
  text("host-memory-speed", speeds.length ? speeds.map((speed) => `${speed} MT/s`).join("、") : "--");
  renderHostStorage(host);
  text("host-addresses", (host.network?.addresses || []).join("\n") || "--");
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
  const hasFrame = stream?.state === "streaming" && Number.isInteger(stream?.sequence);
  elements.videoFrame.classList.toggle("visible", hasFrame); elements.noSignal.hidden = hasFrame;
  text("info-backend", source?.backend); text("info-source", source?.source_id); text("info-health", source?.health);
  text("info-format", modeLabel(source?.capabilities, "format"));
  text("info-resolution", modeLabel(source?.capabilities, "resolution")); text("info-fps", modeLabel(source?.capabilities, "fps"));
  text("info-error", source?.error || "无"); updateDevices(payload.v4l2); updateHidStatus(payload.hid); updateHostInfo(payload.controlled_host);
  if (elements.screenMenu.hidden) updateScreenOptions(payload);
}

function connectStream() {
  if (agentMode) return;
  elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false;
  elements.videoFrame.src = `/api/stream.mjpg?t=${Date.now()}`;
}

function disconnectStream() {
  elements.videoFrame.classList.remove("visible");
  elements.videoFrame.removeAttribute("src");
  elements.noSignal.hidden = false;
}

function requestVideoPause() {
  return new Promise((resolve, reject) => {
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
  } catch (error) { elements.noSignal.classList.add("unavailable"); text("info-error", error.message); }
}

function setPanel(open) {
  elements.panel.classList.toggle("open", open); elements.panel.setAttribute("aria-hidden", String(!open));
  elements.settingsButton.setAttribute("aria-expanded", String(open)); elements.backdrop.hidden = !open;
}
function setScreenMenu(open) {
  elements.screenMenu.hidden = !open; elements.screenButton.setAttribute("aria-expanded", String(open));
  if (open) { setKeyboard(false); setPanel(false); }
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
  elements.agentModelName.textContent = agentModelNames[selected];
  for (const option of elements.agentModelMenu.querySelectorAll("[data-model-option]")) {
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
elements.videoFrame.addEventListener("load", () => { elements.videoFrame.classList.add("visible"); elements.noSignal.hidden = true; });
elements.videoFrame.addEventListener("error", () => { elements.videoFrame.classList.remove("visible"); elements.noSignal.hidden = false; refreshStatus(); });
elements.screenButton.addEventListener("click", () => setScreenMenu(elements.screenMenu.hidden));
elements.keyboardButton.addEventListener("click", () => setKeyboard(elements.keyboard.hidden));
elements.closeKeyboard.addEventListener("click", () => setKeyboard(false));
elements.zoomOut.addEventListener("click", () => setZoom(zoomPercent - 10));
elements.zoomIn.addEventListener("click", () => setZoom(zoomPercent + 10));
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
elements.agentModelButton.addEventListener("click", () => setAgentModelMenu(elements.agentModelMenu.hidden));
elements.agentModelMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-model-option]");
  if (option) selectAgentModel(option.dataset.modelOption);
});
elements.resolutionSelect.addEventListener("change", () => fillRefreshRates(0));
elements.keyboardRows.addEventListener("click", (event) => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
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
  catch (error) { elements.screenMessage.textContent = error.message; }
  finally { elements.applyScreenSettings.disabled = videoModes.length === 0; }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#screen-menu") && !event.target.closest("#screen-button")) setScreenMenu(false);
  if (!event.target.closest("#agent-model-picker")) setAgentModelMenu(false);
  if (elements.agentApp.classList.contains("sidebar-open") && !event.target.closest("#agent-sidebar") && !event.target.closest("#agent-sidebar-toggle")) {
    elements.agentApp.classList.remove("sidebar-open");
    elements.agentSidebarToggle.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (agentMode) setAgentMode(false);
    else { setPanel(false); setScreenMenu(false); setKeyboard(false); }
  }
});

loadAgentSessions(); loadAgentModel(); renderAgentSessions(); renderAgentConversation();
setZoom(100); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000);
