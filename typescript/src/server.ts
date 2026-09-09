import { createRequestHandler } from "./routes.js";
export { POST_ROUTES } from "./routes.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { AgentCoordinator } from "./agent.js";
import { HidController, SimulatedHid } from "./hid.js";
import { discoverV4l2, resolveEndpoints, UsbWake } from "./linux.js";
import { SetupService } from "./setup-service.js";
import { ModelSetupStore } from "./model-setup.js";
import { RemoteAgent, RemoteModel } from "./remote-model.js";
import {
  AuditLog,
  HostStore,
  JobStore,
  PeerAuth,
  SessionStore,
  SuggestionStore,
} from "./stores.js";
import {
  observe,
  VideoController,
  type Mode,
  type VideoConfig,
} from "./video.js";

export interface ServerOptions extends Partial<VideoConfig> {
  dataDir?: string;
  assetDir?: string;
  templateDir?: string;
  hidBackend?: "disabled" | "simulated" | "auto" | "linux";
  gadgetRoot?: string;
  callbackUrl?: string;
  files?: Partial<
    Record<
      | "host"
      | "audit"
      | "token"
      | "suggestion"
      | "setup"
      | "remote"
      | "sessions",
      string
    >
  >;
  hid?: HidController;
  video?: VideoController;
  remote?: RemoteModel;
}
export function resourcePaths() {
  const compiled = fileURLToPath(new URL("./templates/", import.meta.url));
  const templates = existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL("../templates/", import.meta.url));
  const assets = fileURLToPath(new URL("./web_assets/", import.meta.url));
  return {
    templates,
    assets: existsSync(assets)
      ? assets
      : fileURLToPath(new URL("../../dist/web_assets/", import.meta.url)),
  };
}
export function createKvmServer(options: ServerOptions = {}) {
  const resources = resourcePaths();
  const templates = options.templateDir ?? resources.templates;
  const assetDir = options.assetDir ?? resources.assets;
  const dir = resolve(options.dataDir ?? "data/typescript");
  const file = (
    name: keyof NonNullable<ServerOptions["files"]>,
    fallback: string,
  ) => options.files?.[name] ?? join(dir, fallback);
  const config: VideoConfig = {
    source: options.source ?? "synthetic",
    file: options.file,
    device: options.device ?? "/dev/video0",
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
    ffmpeg: options.ffmpeg,
    ffprobe: options.ffprobe,
  };
  const video = options.video ?? new VideoController(config);
  const backend =
    options.hidBackend ?? (process.platform === "linux" ? "auto" : "disabled");
  const gadget = options.gadgetRoot ?? "/sys/kernel/config/usb_gadget/g_comp";
  const hid =
    options.hid ??
    new HidController(
      backend === "simulated" ? new SimulatedHid() : undefined,
      backend === "auto" ? "linux-auto" : backend,
      ["auto", "linux"].includes(backend)
        ? () => resolveEndpoints(gadget)
        : undefined,
    );
  const power = new UsbWake(gadget),
    host = new HostStore(file("host", "controlled-host.json")),
    audit = new AuditLog(file("audit", "audit.jsonl")),
    peer = new PeerAuth(file("token", "pc-agent-token")),
    suggestions = new SuggestionStore(
      file("suggestion", "pc-agent-suggestion.json"),
    ),
    setup = new ModelSetupStore(
      file("setup", "model-setup-tasks.json"),
      join(templates, "pc_agent_install.ps1"),
    ),
    sessions = new SessionStore(file("sessions", "agent-sessions.json")),
    jobs = new JobStore();
  const remote =
    options.remote ??
    new RemoteModel(file("remote", "remote-model.json"), templates);
  const setupService = new SetupService(setup, hid, peer, audit);
  const agent = new AgentCoordinator(hid, () => observe(video), audit);
  const remoteAgent = new RemoteAgent(
    remote,
    agent,
    video,
    hid,
    host,
    audit,
    templates,
  );
  let discovery: Awaited<ReturnType<typeof discoverV4l2>> | undefined;
  let discoveryAt = 0;
  let discoveryJob: ReturnType<typeof discoverV4l2> | undefined;
  const discover = async () => {
    if (discovery && Date.now() - discoveryAt < 10000) return discovery;
    discoveryJob ??= discoverV4l2();
    try {
      discovery = await discoveryJob;
      discoveryAt = Date.now();
      return discovery;
    } finally {
      discoveryJob = undefined;
    }
  };
  const availableModes = async () =>
    config.source === "v4l2"
      ? (await discover()).devices
          .filter((d) => d.device_path === config.device)
          .flatMap((d) => d.capabilities)
          .filter((m) => ["MJPG", "MJPEG"].includes(m.pixel_format))
          .map((m) => ({ ...m, pixel_format: "MJPEG" as const }))
      : video.capabilities();
  async function status() {
    let capabilities: Mode[] = [];
    let error: string | null = null;
    try {
      capabilities = await video.capabilities();
    } catch (e) {
      error = String(e);
    }
    await hid.refresh();
    return {
      service: {
        name: "Agent IP KVM",
        version: "0.2.0",
        runtime: "typescript",
      },
      source: {
        backend: config.source,
        source_id:
          config.source === "synthetic"
            ? "synthetic:color-bars"
            : config.source +
              ":" +
              (config.source === "file" ? config.file : config.device),
        health: error ? "unavailable" : "available",
        capabilities,
        error,
      },
      stream: video.status(),
      v4l2: await discover(),
      hid: hid.status(),
      controlled_host: host.status(),
      pc_agent: { pairing_enabled: peer.enabled, ...suggestions.status() },
      model_setup: { latest: setup.latest() },
      remote_model: remote.public(),
      power: power.status(),
      hardware_validation: {
        typescript_rdk_x5: "unverified",
        platform: process.platform,
      },
    };
  }
  let callback = options.callbackUrl ?? "";
  const server = createServer(
    { requestTimeout: 15000, headersTimeout: 10000 },
    createRequestHandler({
      assetDir,
      callback: () => callback,
      status,
      availableModes,
      video,
      hid,
      power,
      host,
      audit,
      peer,
      suggestions,
      setup,
      setupService,
      sessions,
      jobs,
      remote,
      agent,
      remoteAgent,
    }),
  );
  return {
    server,
    video,
    hid,
    agent,
    host,
    peer,
    audit,
    setup,
    remote,
    sessions,
    jobs,
    status,
    async listen(port = 8080, hostName = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostName, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("invalid server address");
      callback ||= `http://${hostName.includes(":") ? "[" + hostName + "]" : hostName}:${address.port}`;
      return address;
    },
    async close() {
      await agent.stop().catch(() => {});
      await video.close();
      await hid.close().catch(() => {});
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
    },
  };
}
