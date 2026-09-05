const elements = {
  noSignal: document.querySelector("#no-signal"),
  videoFrame: document.querySelector("#video-frame"),
  panel: document.querySelector("#settings-panel"),
  backdrop: document.querySelector("#panel-backdrop"),
  settingsButton: document.querySelector("#settings-button"),
  closeSettings: document.querySelector("#close-settings"),
  refreshButton: document.querySelector("#refresh-button"),
  screenButton: document.querySelector("#screen-button"),
  videoShell: document.querySelector("#video-shell"),
  v4l2Message: document.querySelector("#v4l2-message"),
  deviceCount: document.querySelector("#device-count"),
  deviceList: document.querySelector("#device-list"),
};

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

elements.settingsButton.addEventListener("click", () => setPanel(true));
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
elements.screenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await elements.videoShell.requestFullscreen();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setPanel(false);
});

connectStream();
refreshStatus();
setInterval(refreshStatus, 5000);
