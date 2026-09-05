const elements = {
  noSignal: document.querySelector("#no-signal"),
  videoFrame: document.querySelector("#video-frame"),
  panel: document.querySelector("#settings-panel"),
  backdrop: document.querySelector("#panel-backdrop"),
  settingsButton: document.querySelector("#settings-button"),
  closeSettings: document.querySelector("#close-settings"),
  refreshButton: document.querySelector("#refresh-button"),
  screenButton: document.querySelector("#screen-button"),
  screenMenu: document.querySelector("#screen-menu"),
  resolutionSelect: document.querySelector("#resolution-select"),
  refreshRateSelect: document.querySelector("#refresh-rate-select"),
  screenMessage: document.querySelector("#screen-message"),
  applyScreenSettings: document.querySelector("#apply-screen-settings"),
  videoShell: document.querySelector("#video-shell"),
  v4l2Message: document.querySelector("#v4l2-message"),
  deviceCount: document.querySelector("#device-count"),
  deviceList: document.querySelector("#device-list"),
};

let videoModes = [];

function text(id, value) {
  document.querySelector(`#${id}`).textContent = value ?? "--";
}

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
    const card = document.createElement("article");
    card.className = "device-card";
    const name = document.createElement("strong");
    name.textContent = device.display_name;
    const path = document.createElement("span");
    path.textContent = `${device.device_path} · ${device.node_kind}`;
    const detail = document.createElement("span");
    detail.textContent = `${device.driver ?? "未知驱动"} · ${device.capabilities.length} 种模式`;
    card.append(name, path, detail);
    elements.deviceList.append(card);
  }
}

function fillRefreshRates(selectedFps) {
  const [width, height] = elements.resolutionSelect.value.split("x").map(Number);
  const rates = [...new Set(videoModes
    .filter((mode) => mode.width === width && mode.height === height)
    .map((mode) => Number(mode.fps)))]
    .sort((a, b) => b - a);
  elements.refreshRateSelect.replaceChildren();
  for (const rate of rates) {
    const option = document.createElement("option");
    option.value = String(rate);
    option.textContent = `${rate} Hz`;
    option.selected = Math.abs(rate - selectedFps) < 0.01;
    elements.refreshRateSelect.append(option);
  }
}

function updateScreenOptions(payload) {
  const sourceMode = payload.source?.capabilities?.[0];
  const captureDevice = payload.v4l2?.devices?.find(
    (device) => device.device_path === payload.source?.source_id?.replace("v4l2:", "")
      && device.supports_video_capture,
  );
  videoModes = (captureDevice?.capabilities ?? []).filter(
    (mode) => mode.pixel_format === "MJPG" || mode.pixel_format === "MJPEG",
  );
  const resolutions = [...new Map(
    videoModes.map((mode) => [`${mode.width}x${mode.height}`, mode]),
  ).values()].sort((a, b) => (b.width * b.height) - (a.width * a.height));

  elements.resolutionSelect.replaceChildren();
  for (const mode of resolutions) {
    const option = document.createElement("option");
    option.value = `${mode.width}x${mode.height}`;
    option.textContent = `${mode.width} × ${mode.height}`;
    option.selected = mode.width === sourceMode?.width && mode.height === sourceMode?.height;
    elements.resolutionSelect.append(option);
  }
  const supported = resolutions.length > 0;
  elements.resolutionSelect.disabled = !supported;
  elements.refreshRateSelect.disabled = !supported;
  elements.applyScreenSettings.disabled = !supported;
  elements.screenMessage.textContent = supported ? "" : "当前视频源不支持调整";
  if (supported) fillRefreshRates(Number(sourceMode?.fps ?? 0));
}

function updateStatus(payload) {
  const source = payload.source;
  const stream = payload.stream;
  const available = source?.health === "available" && stream?.state !== "error" && stream?.state !== "ended";
  elements.noSignal.classList.toggle("unavailable", !available);
  const hasFrame = stream?.state === "streaming" && Number.isInteger(stream?.sequence);
  elements.videoFrame.classList.toggle("visible", hasFrame);
  elements.noSignal.hidden = hasFrame;

  text("info-backend", source?.backend);
  text("info-source", source?.source_id);
  text("info-health", source?.health);
  text("info-format", modeLabel(source?.capabilities, "format"));
  text("info-resolution", modeLabel(source?.capabilities, "resolution"));
  text("info-fps", modeLabel(source?.capabilities, "fps"));
  text("info-error", source?.error || "无");
  updateDevices(payload.v4l2);
  if (elements.screenMenu.hidden) updateScreenOptions(payload);
}

function connectStream() {
  elements.videoFrame.classList.remove("visible");
  elements.noSignal.hidden = false;
  elements.videoFrame.src = `/api/stream.mjpg?t=${Date.now()}`;
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    updateStatus(await response.json());
  } catch (error) {
    elements.noSignal.classList.add("unavailable");
    text("info-error", error.message);
  }
}

function setPanel(open) {
  elements.panel.classList.toggle("open", open);
  elements.panel.setAttribute("aria-hidden", String(!open));
  elements.settingsButton.setAttribute("aria-expanded", String(open));
  elements.backdrop.hidden = !open;
}

function setScreenMenu(open) {
  elements.screenMenu.hidden = !open;
  elements.screenButton.setAttribute("aria-expanded", String(open));
  if (open) setPanel(false);
}

elements.settingsButton.addEventListener("click", () => {
  setScreenMenu(false);
  setPanel(true);
});
elements.closeSettings.addEventListener("click", () => setPanel(false));
elements.backdrop.addEventListener("click", () => setPanel(false));
elements.refreshButton.addEventListener("click", () => {
  connectStream();
  refreshStatus();
});
elements.videoFrame.addEventListener("load", () => {
  elements.videoFrame.classList.add("visible");
  elements.noSignal.hidden = true;
});
elements.videoFrame.addEventListener("error", () => {
  elements.videoFrame.classList.remove("visible");
  elements.noSignal.hidden = false;
  refreshStatus();
});
elements.screenButton.addEventListener("click", () => {
  setScreenMenu(elements.screenMenu.hidden);
});
elements.resolutionSelect.addEventListener("change", () => fillRefreshRates(0));
elements.applyScreenSettings.addEventListener("click", async () => {
  const [width, height] = elements.resolutionSelect.value.split("x").map(Number);
  const fps = Number(elements.refreshRateSelect.value);
  elements.applyScreenSettings.disabled = true;
  elements.screenMessage.textContent = "正在应用";
  try {
    const response = await fetch("/api/video-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width, height, fps }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    setScreenMenu(false);
    connectStream();
    await refreshStatus();
  } catch (error) {
    elements.screenMessage.textContent = error.message;
  } finally {
    elements.applyScreenSettings.disabled = videoModes.length === 0;
  }
});
document.addEventListener("click", (event) => {
  if (!elements.screenMenu.hidden && !event.target.closest(".tool-menu")) setScreenMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setPanel(false);
    setScreenMenu(false);
  }
});

connectStream();
refreshStatus();
setInterval(refreshStatus, 5000);
