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
};

let videoModes = [];
let hidEnabled = false;
let zoomPercent = 100;
const activeModifiers = new Set();
let videoWidth = 16;
let videoHeight = 9;
let lastVideoPointer = null;
let latestVideoPointer = null;
let pendingDeltaX = 0;
let pendingDeltaY = 0;
let pendingWheel = 0;
let relativeRequestActive = false;
let relativeSyncActive = false;
let relativeSynced = false;
const HID_MOUSE_STEP = 100;
const HID_MOUSE_STEP_DELAY_MS = 8;

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
  elements.mouseMessage.textContent = hidEnabled ? "HID 已连接 · 移入画面后自动校准鼠标" : statusText;
  elements.releaseKeys.disabled = !hidEnabled;
  for (const key of elements.keyboardRows.querySelectorAll("button")) key.disabled = !hidEnabled;
  if (!hidEnabled) {
    clearModifiers();
    lastVideoPointer = null;
    latestVideoPointer = null;
    pendingDeltaX = 0;
    pendingDeltaY = 0;
    pendingWheel = 0;
    relativeSynced = false;
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

function pause(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function sendRelativeDistance(deltaX, deltaY, wheel = 0) {
  let remainingX = Math.round(deltaX);
  let remainingY = Math.round(deltaY);
  while (remainingX || remainingY) {
    const stepX = Math.max(-HID_MOUSE_STEP, Math.min(HID_MOUSE_STEP, remainingX));
    const stepY = Math.max(-HID_MOUSE_STEP, Math.min(HID_MOUSE_STEP, remainingY));
    await postJson("/api/hid/mouse-move", { delta_x: stepX, delta_y: stepY, wheel: 0 });
    remainingX -= stepX;
    remainingY -= stepY;
    if (remainingX || remainingY) await pause(HID_MOUSE_STEP_DELAY_MS);
  }
  if (wheel) await postJson("/api/hid/mouse-move", { delta_x: 0, delta_y: 0, wheel });
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

function videoPointerFromEvent(event) {
  if (event.target.closest?.(".zoom-buttons")) return null;
  const rect = videoContentRect();
  const insideShell = event.clientX >= rect.shell.left && event.clientX <= rect.shell.right
    && event.clientY >= rect.shell.top && event.clientY <= rect.shell.bottom;
  const insideVideo = event.clientX >= rect.left && event.clientX <= rect.left + rect.width
    && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
  if (!insideShell || !insideVideo) return null;
  const normalisedX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const normalisedY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    width: rect.width,
    height: rect.height,
    targetX: Math.round(normalisedX * Math.max(0, videoWidth - 1)),
    targetY: Math.round(normalisedY * Math.max(0, videoHeight - 1)),
  };
}

async function synchroniseRelativePointer() {
  if (relativeSyncActive || !hidEnabled || latestVideoPointer === null) return;
  relativeSyncActive = true;
  pendingDeltaX = 0;
  pendingDeltaY = 0;
  elements.mouseMessage.textContent = "正在校准鼠标位置";
  try {
    await sendRelativeDistance(-4096, -4096);
    const pointer = latestVideoPointer;
    await sendRelativeDistance(pointer.targetX, pointer.targetY);
    lastVideoPointer = pointer;
    relativeSynced = true;
    elements.mouseMessage.textContent = "HID 已连接 · 鼠标已校准";
  } catch (error) {
    elements.mouseMessage.textContent = error.message;
    await refreshStatus();
  } finally {
    relativeSyncActive = false;
    if (relativeSynced && (pendingDeltaX || pendingDeltaY || pendingWheel)) requestAnimationFrame(flushRelativeMovement);
  }
}

function queueRelativeMovement(pointer) {
  latestVideoPointer = pointer;
  if (!relativeSynced) {
    synchroniseRelativePointer();
    return;
  }
  if (lastVideoPointer !== null) {
    pendingDeltaX += (pointer.clientX - lastVideoPointer.clientX) * videoWidth / pointer.width;
    pendingDeltaY += (pointer.clientY - lastVideoPointer.clientY) * videoHeight / pointer.height;
  }
  lastVideoPointer = pointer;
  requestAnimationFrame(flushRelativeMovement);
}

async function flushRelativeMovement() {
  if (relativeRequestActive || relativeSyncActive || !hidEnabled || !relativeSynced) return;
  const deltaX = Math.max(-HID_MOUSE_STEP, Math.min(HID_MOUSE_STEP, Math.round(pendingDeltaX)));
  const deltaY = Math.max(-HID_MOUSE_STEP, Math.min(HID_MOUSE_STEP, Math.round(pendingDeltaY)));
  const wheel = Math.max(-127, Math.min(127, Math.round(pendingWheel)));
  if (!deltaX && !deltaY && !wheel) return;
  pendingDeltaX -= deltaX;
  pendingDeltaY -= deltaY;
  pendingWheel -= wheel;
  relativeRequestActive = true;
  try {
    await postJson("/api/hid/mouse-move", { delta_x: deltaX, delta_y: deltaY, wheel });
  } catch (error) {
    elements.mouseMessage.textContent = error.message;
    await refreshStatus();
  } finally {
    relativeRequestActive = false;
    if (pendingDeltaX || pendingDeltaY || pendingWheel) requestAnimationFrame(flushRelativeMovement);
  }
}

async function clickMouse(buttonNumber) {
  const names = { 0: "left", 1: "middle", 2: "right" };
  const button = names[buttonNumber];
  if (!button || !hidEnabled) return;
  try { await postJson("/api/hid/mouse-click", { button }); }
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
  if (!hidEnabled) return;
  const pointer = elements.videoShell.contains(event.target) ? videoPointerFromEvent(event) : null;
  if (pointer === null) {
    lastVideoPointer = null;
    latestVideoPointer = null;
    relativeSynced = false;
    return;
  }
  queueRelativeMovement(pointer);
});
document.addEventListener("mousedown", (event) => {
  if (!hidEnabled || !elements.videoShell.contains(event.target)) return;
  const pointer = videoPointerFromEvent(event);
  if (pointer === null) return;
  event.preventDefault();
  latestVideoPointer = pointer;
  if (!relativeSynced) {
    synchroniseRelativePointer();
    return;
  }
  clickMouse(event.button);
});
document.addEventListener("wheel", (event) => {
  if (!hidEnabled || !elements.videoShell.contains(event.target)) return;
  const pointer = videoPointerFromEvent(event);
  if (pointer === null) return;
  event.preventDefault();
  latestVideoPointer = pointer;
  pendingWheel += Math.sign(-event.deltaY);
  if (!relativeSynced) synchroniseRelativePointer();
  else requestAnimationFrame(flushRelativeMovement);
}, { passive: false });
elements.videoShell.addEventListener("contextmenu", (event) => {
  if (hidEnabled && videoPointerFromEvent(event) !== null) event.preventDefault();
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
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { setPanel(false); setScreenMenu(false); setMouseMenu(false); setKeyboard(false); }
});

setZoom(100); setCursorSize("medium"); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000);
