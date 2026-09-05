const elements = {
  noSignal: document.querySelector("#no-signal"), videoFrame: document.querySelector("#video-frame"),
  videoShell: document.querySelector("#video-shell"), panel: document.querySelector("#settings-panel"),
  backdrop: document.querySelector("#panel-backdrop"), settingsButton: document.querySelector("#settings-button"),
  closeSettings: document.querySelector("#close-settings"), refreshButton: document.querySelector("#refresh-button"),
  screenButton: document.querySelector("#screen-button"), screenMenu: document.querySelector("#screen-menu"),
  powerButton: document.querySelector("#power-button"), powerMenu: document.querySelector("#power-menu"),
  powerMessage: document.querySelector("#power-message"), powerAction: document.querySelector("#power-action"),
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
let selectedAgentModel = "qwen2.5-1.5b";
let modelSetupPollActive = false;
const pendingSessionSync = new Map();

const modelSetupStatusNames = {
  awaiting_start: "等待启动", starting: "正在启动", downloading_runtime: "下载运行环境",
  installing_runtime: "安装运行环境", downloading_model: "下载模型", verifying: "正在校验",
  completed: "配置完成", failed: "配置失败",
};

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
  updatePowerStatus(payload.power);
  if (elements.screenMenu.hidden) updateScreenOptions(payload);
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

function newSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeAgentSession() {
  const now = Date.now();
  return { id: newSessionId(), title: "新会话", createdAt: now, updatedAt: now, messages: [] };
}

function saveAgentSessions(sync = true) {
  try {
    localStorage.setItem(agentStorageKey, JSON.stringify({ activeId: activeAgentSessionId, sessions: agentSessions }));
  } catch (_) { /* The interface remains usable if local storage is unavailable. */ }
  if (sync) for (const session of agentSessions) queueSessionSync(session);
}

function queueSessionSync(session) {
  if (!session?.id) return;
  const oldTimer = pendingSessionSync.get(session.id);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = window.setTimeout(async () => {
    pendingSessionSync.delete(session.id);
    try { await postJson("/api/agent/sessions", { session }); }
    catch (_) { /* Keep the local copy and retry on the next refresh. */ }
  }, 150);
  pendingSessionSync.set(session.id, timer);
}

function queueSessionDelete(sessionId) {
  window.fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => { });
}

async function syncAgentSessionsFromBoard() {
  try {
    const result = await fetchJson("/api/agent/sessions");
    const remote = Array.isArray(result.sessions) ? result.sessions : [];
    const byId = new Map(agentSessions.map((session) => [session.id, session]));
    for (const session of remote) {
      const local = byId.get(session.id);
      if (!local || Number(session.updatedAt) >= Number(local.updatedAt)) byId.set(session.id, session);
    }
    for (const session of agentSessions) {
      if (!remote.some((item) => item.id === session.id)) queueSessionSync(session);
    }
    agentSessions = [...byId.values()].filter((session) => session && typeof session.id === "string");
    if (agentSessions.length === 0) agentSessions.push(makeAgentSession());
    if (!agentSessions.some((session) => session.id === activeAgentSessionId)) activeAgentSessionId = agentSessions[0].id;
    saveAgentSessions(false); renderAgentSessions(); renderAgentConversation();
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
  selectedAgentModel = selected;
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
  if (message.plan) content.append(renderAgentPlan(message.plan));
  if (message.modelSetup) content.append(renderModelSetup(message));
  if (message.remoteModelSetup) content.append(renderRemoteModelSetup(message));
  article.append(content);
  return article;
}

function renderModelSetup(message) {
  const setup = message.modelSetup;
  const card = document.createElement("section");
  card.className = "model-setup-card";
  card.dataset.setupMessageId = message.id;
  const title = document.createElement("h2"); title.textContent = "配置被控电脑模型";
  const description = document.createElement("p");
  description.textContent = "由开发板通过 USB 键盘启动安装器；安装进度会持续记录在此会话。";
  card.append(title, description);

  if (!setup.task) {
    const fields = document.createElement("div"); fields.className = "model-setup-fields";
    const modelLabel = document.createElement("label"); modelLabel.textContent = "模型";
    const modelSelect = document.createElement("select"); modelSelect.dataset.setupField = "model";
    for (const model of setup.catalog.models ?? []) {
      const option = document.createElement("option"); option.value = model.id;
      option.textContent = `${model.name}${model.recommended ? " · 推荐" : ""}`;
      option.selected = model.id === setup.model; modelSelect.append(option);
    }
    modelLabel.append(modelSelect);
    const locationLabel = document.createElement("label"); locationLabel.textContent = "模型位置";
    const locationSelect = document.createElement("select"); locationSelect.dataset.setupField = "models_dir";
    for (const location of setup.catalog.locations ?? []) {
      const option = document.createElement("option"); option.value = location.models_dir;
      option.textContent = `${location.models_dir} · ${formatBytes(location.free_bytes)} 可用`;
      option.selected = location.models_dir === setup.modelsDir; locationSelect.append(option);
    }
    locationLabel.append(locationSelect);
    const installLabel = document.createElement("label"); installLabel.className = "wide"; installLabel.textContent = "Ollama 安装位置";
    const installInput = document.createElement("input"); installInput.dataset.setupField = "install_dir"; installInput.value = setup.installDir;
    installInput.autocomplete = "off"; installInput.spellcheck = false; installLabel.append(installInput);
    fields.append(modelLabel, locationLabel, installLabel); card.append(fields);
    const start = document.createElement("button"); start.className = "model-setup-start"; start.type = "button";
    start.dataset.setupAction = "start"; start.textContent = "开始配置"; card.append(start);
    return card;
  }

  const task = setup.task;
  const status = document.createElement("div"); status.className = "model-setup-status";
  const state = document.createElement("strong"); state.textContent = modelSetupStatusNames[task.status] ?? task.status;
  const percent = document.createElement("span"); percent.textContent = `${task.progress}%`;
  status.append(state, percent);
  const progress = document.createElement("div"); progress.className = "model-setup-progress";
  progress.style.setProperty("--progress", `${task.progress}%`); progress.append(document.createElement("span"));
  const messageText = document.createElement("p"); messageText.textContent = task.message;
  const details = document.createElement("p"); details.textContent = `${task.model} · ${task.models_dir}`;
  const events = document.createElement("ol"); events.className = "model-setup-events";
  for (const event of task.events ?? []) { const item = document.createElement("li"); item.textContent = event.message; events.append(item); }
  card.append(status, progress, messageText, details, events);
  return card;
}

function renderRemoteModelSetup(message) {
  const setup = message.remoteModelSetup;
  const card = document.createElement("section");
  card.className = "model-setup-card remote-model-setup";
  card.dataset.remoteSetupMessageId = message.id;
  const title = document.createElement("h2"); title.textContent = "配置远程 API";
  const description = document.createElement("p");
  description.textContent = "兼容 OpenAI 格式的接口。密钥只保存在开发板，不会回显到网页。";
  card.append(title, description);
  const fields = document.createElement("div"); fields.className = "model-setup-fields";
  const baseLabel = document.createElement("label"); baseLabel.textContent = "接口地址";
  const baseInput = document.createElement("input"); baseInput.dataset.remoteField = "base_url";
  baseInput.value = setup.baseUrl || "https://api.deepseek.com"; baseInput.autocomplete = "url";
  baseLabel.append(baseInput);
  const modelLabel = document.createElement("label"); modelLabel.textContent = "模型";
  const modelSelect = document.createElement("select"); modelSelect.dataset.remoteField = "model";
  for (const model of setup.catalog?.models ?? []) {
    const option = document.createElement("option"); option.value = model.id;
    option.textContent = model.name; option.title = model.description;
    option.selected = model.id === (setup.model || "deepseek-v4-flash"); modelSelect.append(option);
  }
  modelLabel.append(modelSelect);
  const keyLabel = document.createElement("label"); keyLabel.className = "wide"; keyLabel.textContent = "API 密钥";
  const keyInput = document.createElement("input"); keyInput.type = "password"; keyInput.dataset.remoteField = "api_key";
  keyInput.placeholder = setup.configured ? "已配置，输入新密钥可替换" : "粘贴 DeepSeek API 密钥";
  keyInput.autocomplete = "new-password"; keyLabel.append(keyInput);
  fields.append(baseLabel, modelLabel, keyLabel); card.append(fields);
  const actions = document.createElement("div"); actions.className = "model-setup-actions";
  const save = document.createElement("button"); save.type = "button"; save.className = "model-setup-start";
  save.dataset.remoteSetupAction = "save"; save.textContent = "保存配置"; actions.append(save);
  if (setup.configured) {
    const test = document.createElement("button"); test.type = "button"; test.className = "model-setup-test";
    test.dataset.remoteSetupAction = "test"; test.textContent = "测试连接"; actions.append(test);
  }
  card.append(actions);
  if (setup.result) { const result = document.createElement("p"); result.className = "model-setup-result"; result.textContent = setup.result; card.append(result); }
  return card;
}

function renderAgentPlan(plan) {
  const card = document.createElement("section");
  card.className = `agent-plan risk-${plan.risk}`;
  card.dataset.planId = plan.plan_id;
  const header = document.createElement("div"); header.className = "agent-plan-header";
  const risk = document.createElement("span"); risk.className = "risk-badge";
  risk.textContent = ({ read_only: "只读", low: "低风险", high: "高风险", critical: "极高风险" })[plan.risk] ?? plan.risk;
  const status = document.createElement("span"); status.className = "plan-status";
  status.textContent = ({ ready: "可执行", pending_approval: "等待批准", approved: "已批准", executing: "执行中", completed: "已完成", rejected: "已拒绝", failed: "失败", expired: "已过期" })[plan.status] ?? plan.status;
  header.append(risk, status); card.append(header);

  const actions = document.createElement("ol"); actions.className = "agent-plan-actions";
  for (const action of plan.actions ?? []) {
    const item = document.createElement("li");
    if (action.type === "observe") item.textContent = "截取一帧并识别画面状态";
    else if (action.type === "key_tap") item.textContent = `按下并释放 ${action.key}`;
    else if (action.type === "wait") item.textContent = `等待 ${action.seconds} 秒`;
    else item.textContent = "释放全部 HID 输入";
    actions.append(item);
  }
  card.append(actions);

  if (plan.approval_required) {
    const details = document.createElement("dl"); details.className = "agent-plan-details";
    const rows = [
      ["目标", plan.target],
      ["预期", plan.expected_result],
      ["异常处理", plan.recovery],
      ["画面证据", plan.evidence?.frame?.sha256 ? String(plan.evidence.frame.sha256).slice(0, 12) : "未取得"],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const term = document.createElement("dt"); term.textContent = label;
      const detail = document.createElement("dd"); detail.textContent = value ?? "--";
      row.append(term, detail); details.append(row);
    }
    card.append(details);
  }

  if (plan.result?.length) {
    const result = document.createElement("div"); result.className = "agent-plan-result";
    const observation = plan.result.flatMap((item) => [item.result, item.verification]).find((item) => item?.frame);
    result.textContent = observation
      ? `画面：${observation.recognition?.state ?? "unknown"} · 帧校验 ${String(observation.frame.sha256 ?? "").slice(0, 12)}`
      : "动作已经执行并记录审计。";
    card.append(result);
  }
  if (plan.status === "pending_approval") {
    const digest = document.createElement("code"); digest.className = "plan-digest";
    digest.textContent = `计划校验 ${String(plan.digest).slice(0, 12)}`; card.append(digest);
    const controls = document.createElement("div"); controls.className = "agent-plan-controls";
    const reject = document.createElement("button"); reject.type = "button"; reject.dataset.planAction = "reject"; reject.textContent = "拒绝";
    const approve = document.createElement("button"); approve.type = "button"; approve.className = "approve"; approve.dataset.planAction = "approve"; approve.textContent = "批准并执行";
    controls.append(reject, approve); card.append(controls);
  }
  return card;
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
  queueSessionDelete(sessionId);
  saveAgentSessions();
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
  try {
    if (selectedAgentModel === "remote-api") {
      const messages = session.messages
        .filter((item) => (item.role === "user" || item.role === "assistant") && !item.modelSetup && !item.remoteModelSetup)
        .slice(-20).map((item) => ({ role: item.role, content: String(item.content ?? "") }));
      const response = await postJson("/api/agent/chat", { messages });
      session.messages.push({ role: "assistant", content: response.response.content, createdAt: Date.now(), remoteModel: response.response.model });
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
    session.messages.push({ role: "assistant", content: `无法处理：${error.message}`, createdAt: Date.now() });
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
    window.alert(`无法读取模型配置：${error.message}`);
    return;
  }
  const locations = catalog.locations ?? [];
  const preferred = locations.find((item) => item.drive === "D:") ?? locations[0];
  const session = makeAgentSession();
  session.title = "配置 PC Agent 模型";
  const task = latest.task && !["completed", "failed"].includes(latest.task.status) ? latest.task : null;
  session.messages.push({
    id: newSessionId(), role: "assistant", content: task ? "已找到最近的模型配置任务。" : "请选择模型和安装位置。",
    createdAt: Date.now(), modelSetup: {
      catalog, model: "qwen3.5:9b", modelsDir: preferred?.models_dir ?? "D:\\AgentIPKVM\\Models",
      installDir: `${preferred?.drive ?? "D:"}\\AgentIPKVM\\Ollama`, task,
    },
  });
  agentSessions.push(session); activeAgentSessionId = session.id;
  saveAgentSessions(); renderAgentSessions(); renderAgentConversation();
  if (task && !["completed", "failed"].includes(task.status)) pollModelSetupTasks();
}

async function openRemoteModelSetup() {
  setAgentModelMenu(false);
  let catalog;
  let current;
  try {
    [catalog, current] = await Promise.all([fetchJson("/api/remote-model/catalog"), fetchJson("/api/remote-model/config")]);
  } catch (error) {
    window.alert(`无法读取远程 API 配置：${error.message}`); return;
  }
  const session = makeAgentSession(); session.title = "配置远程 API";
  session.messages.push({
    id: newSessionId(), role: "assistant", content: current.configured ? "远程 API 已配置，可以替换密钥或测试连接。" : "请选择 DeepSeek 模型并填写 API 密钥。",
    createdAt: Date.now(), remoteModelSetup: {
      catalog, baseUrl: current.base_url, model: current.model, configured: current.configured, result: "",
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
  const apiKey = card.querySelector("[data-remote-field='api_key']").value.trim();
  try {
    const saved = await postJson("/api/remote-model/config", { base_url: baseUrl, model, api_key: apiKey });
    message.remoteModelSetup = { ...message.remoteModelSetup, baseUrl: saved.remote_model.base_url, model: saved.remote_model.model, configured: true, result: "配置已保存。点击“测试连接”确认服务可用。" };
    selectAgentModel("remote-api");
  } catch (error) { message.remoteModelSetup.result = `保存失败：${error.message}`; }
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
  } catch (error) { message.remoteModelSetup.result = `连接失败：${error.message}`; }
  session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
}

async function startModelSetup(card) {
  const session = activeAgentSession();
  const message = session.messages.find((item) => item.id === card.dataset.setupMessageId);
  if (!message?.modelSetup || message.modelSetup.task) return;
  const button = card.querySelector("[data-setup-action='start']"); button.disabled = true;
  const model = card.querySelector("[data-setup-field='model']").value;
  const modelsDir = card.querySelector("[data-setup-field='models_dir']").value;
  const installDir = card.querySelector("[data-setup-field='install_dir']").value.trim();
  try {
    const created = await postJson("/api/model-setup/tasks", { model, models_dir: modelsDir, install_dir: installDir });
    message.modelSetup.task = created.task; message.content = "模型配置任务已经创建。";
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation();
    const launched = await postJson("/api/model-setup/launch", { task_id: created.task.task_id });
    message.modelSetup.task = launched.task; message.content = "安装指令已发送到被控电脑。";
    session.updatedAt = Date.now(); saveAgentSessions(); renderAgentConversation(); pollModelSetupTasks();
  } catch (error) {
    message.content = `无法启动配置：${error.message}`;
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
        if (!task || ["completed", "failed"].includes(task.status)) continue;
        pending = true;
        try { message.modelSetup.task = (await fetchJson(`/api/model-setup/tasks/${task.task_id}`)).task; }
        catch (_) { /* Keep the latest visible state during a transient disconnect. */ }
      }
    }
    saveAgentSessions(); renderAgentConversation();
    if (pending) window.setTimeout(pollModelSetupTasks, 2000);
  } finally { modelSetupPollActive = false; }
}

async function handleAgentPlanAction(button) {
  const card = button.closest("[data-plan-id]");
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
    message.content = `${message.content}\n无法完成：${error.message}`;
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

async function postJson(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
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
elements.powerButton.addEventListener("click", () => setPowerMenu(elements.powerMenu.hidden));
elements.powerAction.addEventListener("click", async () => {
  elements.powerAction.disabled = true;
  elements.powerMessage.textContent = "正在发送唤醒信号";
  try {
    await postJson("/api/power", { action: "wake" });
    elements.powerMessage.textContent = "唤醒信号已发送";
  } catch (error) {
    elements.powerMessage.textContent = error.message;
  } finally {
    elements.powerAction.disabled = false;
  }
});
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
elements.agentConversation.addEventListener("click", (event) => {
  const setupButton = event.target.closest("[data-setup-action]");
  if (setupButton) { startModelSetup(setupButton.closest("[data-setup-message-id]")); return; }
  const remoteSetupButton = event.target.closest("[data-remote-setup-action]");
  if (remoteSetupButton) {
    const card = remoteSetupButton.closest("[data-remote-setup-message-id]");
    if (remoteSetupButton.dataset.remoteSetupAction === "save") saveRemoteModelSetup(card);
    if (remoteSetupButton.dataset.remoteSetupAction === "test") testRemoteModelSetup(card);
    return;
  }
  const button = event.target.closest("[data-plan-action]");
  if (button) handleAgentPlanAction(button);
});
elements.agentModelButton.addEventListener("click", () => setAgentModelMenu(elements.agentModelMenu.hidden));
elements.agentModelMenu.addEventListener("click", (event) => {
  const configure = event.target.closest("[data-config-model]");
  if (configure && !configure.disabled) {
    if (configure.dataset.configModel === "remote-api") openRemoteModelSetup();
    else openPcAgentSetup();
    return;
  }
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
  if (!event.target.closest("#power-menu") && !event.target.closest("#power-button")) setPowerMenu(false);
  if (!event.target.closest("#agent-model-picker")) setAgentModelMenu(false);
  if (elements.agentApp.classList.contains("sidebar-open") && !event.target.closest("#agent-sidebar") && !event.target.closest("#agent-sidebar-toggle")) {
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

loadAgentSessions(); loadAgentModel(); renderAgentSessions(); renderAgentConversation(); pollModelSetupTasks(); syncAgentSessionsFromBoard();
setZoom(100); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000); setInterval(syncAgentSessionsFromBoard, 5000);
