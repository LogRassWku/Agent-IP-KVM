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
  mouseMessage: document.querySelector("#mouse-message"), mouseCapture: document.querySelector("#mouse-capture"),
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
let pendingMouseX = 0;
let pendingMouseY = 0;
let pendingWheel = 0;
let mouseRequestActive = false;
let mouseControlMode = "off";
let fallbackMousePosition = null;

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
  elements.mouseMessage.textContent = mouseControlMode === "fallback" && hidEnabled ? "区域鼠标控制中" : statusText;
  elements.mouseCapture.disabled = !hidEnabled;
  elements.releaseKeys.disabled = !hidEnabled;
  for (const key of elements.keyboardRows.querySelectorAll("button")) key.disabled = !hidEnabled;
  if (!hidEnabled) {
    clearModifiers();
    stopMouseControl();
  }
}

function updateStatus(payload) {
  const source = payload.source; const stream = payload.stream;
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

async function flushMouseMovement() {
  if (mouseRequestActive || mouseControlMode === "off" || !hidEnabled) return;
  const deltaX = Math.max(-4096, Math.min(4096, Math.round(pendingMouseX)));
  const deltaY = Math.max(-4096, Math.min(4096, Math.round(pendingMouseY)));
  const wheel = Math.max(-127, Math.min(127, Math.round(pendingWheel)));
  if (!deltaX && !deltaY && !wheel) return;
  pendingMouseX -= deltaX; pendingMouseY -= deltaY; pendingWheel -= wheel;
  mouseRequestActive = true;
  try {
    await postJson("/api/hid/mouse-move", { delta_x: deltaX, delta_y: deltaY, wheel });
  } catch (error) {
    elements.mouseMessage.textContent = error.message;
    await stopMouseControl();
    await refreshStatus();
  } finally {
    mouseRequestActive = false;
    if (pendingMouseX || pendingMouseY || pendingWheel) requestAnimationFrame(flushMouseMovement);
  }
}

async function clickMouse(buttonNumber) {
  const names = { 0: "left", 1: "middle", 2: "right" };
  const button = names[buttonNumber];
  if (!button || !hidEnabled) return;
  try { await postJson("/api/hid/mouse-click", { button }); }
  catch (error) { elements.mouseMessage.textContent = error.message; await stopMouseControl(); await refreshStatus(); }
}

function setMouseControlMode(mode) {
  mouseControlMode = mode;
  fallbackMousePosition = null;
  pendingMouseX = 0; pendingMouseY = 0; pendingWheel = 0;
  const active = mode !== "off";
  elements.videoShell.classList.toggle("mouse-control-active", active);
  elements.mouseCapture.textContent = active ? "停止控制" : "开始控制";
  if (mode === "fallback") elements.mouseMessage.textContent = "区域鼠标控制中";
}

async function stopMouseControl() {
  const wasActive = mouseControlMode !== "off";
  setMouseControlMode("off");
  if (document.pointerLockElement === elements.videoShell) document.exitPointerLock();
  if (wasActive && hidEnabled) {
    try { await postJson("/api/hid/release", {}); }
    catch (error) { elements.mouseMessage.textContent = error.message; }
  }
}

function startFallbackMouseControl() {
  if (document.pointerLockElement === elements.videoShell) return;
  setMouseControlMode("fallback");
}

async function startMouseControl() {
  if (!hidEnabled) return;
  setMouseMenu(false);
  if (typeof elements.videoShell.requestPointerLock !== "function") {
    startFallbackMouseControl();
    return;
  }
  try {
    const request = elements.videoShell.requestPointerLock();
    if (request && typeof request.catch === "function") await request;
    window.setTimeout(() => {
      if (document.pointerLockElement !== elements.videoShell && mouseControlMode === "off") startFallbackMouseControl();
    }, 250);
  } catch (error) {
    startFallbackMouseControl();
  }
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
elements.mouseCapture.addEventListener("click", async () => {
  if (mouseControlMode === "off") await startMouseControl(); else await stopMouseControl();
});
document.addEventListener("pointerlockchange", async () => {
  const captured = document.pointerLockElement === elements.videoShell;
  if (captured) setMouseControlMode("locked");
  else if (mouseControlMode === "locked") await stopMouseControl();
});
document.addEventListener("pointerlockerror", startFallbackMouseControl);
document.addEventListener("mousemove", (event) => {
  if (mouseControlMode === "locked") {
    pendingMouseX += event.movementX; pendingMouseY += event.movementY;
  } else if (mouseControlMode === "fallback") {
    if (!elements.videoShell.contains(event.target) || event.target.closest(".zoom-buttons")) {
      fallbackMousePosition = null;
      return;
    }
    if (fallbackMousePosition) {
      pendingMouseX += event.clientX - fallbackMousePosition.x;
      pendingMouseY += event.clientY - fallbackMousePosition.y;
    }
    fallbackMousePosition = { x: event.clientX, y: event.clientY };
  } else return;
  requestAnimationFrame(flushMouseMovement);
});
document.addEventListener("mousedown", (event) => {
  const onVideo = elements.videoShell.contains(event.target) && !event.target.closest(".zoom-buttons");
  if (mouseControlMode === "off" || (mouseControlMode === "fallback" && !onVideo)) return;
  event.preventDefault(); clickMouse(event.button);
});
document.addEventListener("wheel", (event) => {
  const onVideo = elements.videoShell.contains(event.target) && !event.target.closest(".zoom-buttons");
  if (mouseControlMode === "off" || (mouseControlMode === "fallback" && !onVideo)) return;
  event.preventDefault(); pendingWheel += Math.sign(-event.deltaY); requestAnimationFrame(flushMouseMovement);
}, { passive: false });
elements.videoShell.addEventListener("contextmenu", (event) => {
  if (mouseControlMode !== "off" && !event.target.closest(".zoom-buttons")) event.preventDefault();
});
elements.videoShell.addEventListener("mouseleave", () => { fallbackMousePosition = null; });
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
  if (event.key === "Escape") { stopMouseControl(); setPanel(false); setScreenMenu(false); setMouseMenu(false); setKeyboard(false); }
});

setZoom(100); setCursorSize("medium"); connectStream(); refreshStatus(); setInterval(refreshStatus, 5000);
