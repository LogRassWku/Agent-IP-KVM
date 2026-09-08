import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ApiError, delay, object } from "./common.js";
import { AgentCoordinator } from "./agent.js";
import { HidController, SimulatedHid } from "./hid.js";
import { discoverV4l2, resolveEndpoints, UsbWake } from "./linux.js";
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
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  ...Object.fromEntries(
    ["small", "medium", "large"].map((size) => [
      "/cursor-" + size + ".svg",
      ["cursor-" + size + ".svg", "image/svg+xml"],
    ]),
  ),
};
export const POST_ROUTES = [
  "/api/video-settings",
  "/api/video/pause",
  "/api/power",
  "/api/host-info",
  "/api/hid/key",
  "/api/hid/mouse-move",
  "/api/hid/mouse-position",
  "/api/hid/mouse-click",
  "/api/hid/release",
  "/api/agent/plans",
  "/api/agent/approve",
  "/api/agent/reject",
  "/api/agent/execute",
  "/api/pc-agent/suggestions",
  "/api/model-setup/tasks",
  "/api/model-setup/launch",
  "/api/model-setup/progress",
  "/api/remote-model/config",
  "/api/remote-model/test",
  "/api/agent/chat",
  "/api/agent/chat/jobs",
  "/api/agent/sessions",
  "/api/hid/emergency-stop",
  "/api/hid/arm",
];
function originGuard(req: IncomingMessage) {
  if (req.headers.origin) {
    let origin: URL;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      throw new ApiError("cross-origin control requests are not allowed", 403);
    }
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.host !== req.headers.host
    )
      throw new ApiError("cross-origin control requests are not allowed", 403);
  }
}
async function readBody(req: IncomingMessage, path: string) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new ApiError("Content-Type must be application/json", 415);
  const max = [
    "/api/host-info",
    "/api/pc-agent/suggestions",
    "/api/model-setup/progress",
    "/api/agent/chat",
    "/api/agent/chat/jobs",
    "/api/agent/sessions",
  ].includes(path)
    ? 65536
    : path.startsWith("/api/agent/")
      ? 32768
      : 4096;
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isInteger(length) || length < 0 || length > max)
    throw new ApiError("invalid request body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ApiError("invalid request body");
    chunks.push(chunk);
  }
  if (!size) {
    if (["/api/hid/release", "/api/video/pause"].includes(path)) return {};
    throw new ApiError("invalid request body");
  }
  try {
    return object.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new ApiError("request body must be a valid JSON object");
  }
}
function send(res: ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
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
    (req, res) => {
      void (async () => {
        try {
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          if (req.method === "GET") {
            if (assets[path]) {
              const [name, type] = assets[path];
              res.writeHead(200, {
                "Content-Type": type,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              });
              res.end(readFileSync(join(assetDir, name)));
              return;
            }
            switch (path) {
              case "/api/status":
                send(res, await status());
                return;
              case "/api/agent/audit":
                send(res, { events: audit.recent() });
                return;
              case "/api/pc-agent/status":
                send(res, {
                  pairing_enabled: peer.enabled,
                  ...suggestions.status(),
                });
                return;
              case "/api/model-setup/catalog":
                send(res, setup.catalog(host.status()));
                return;
              case "/api/model-setup/tasks/latest":
                send(res, { task: setup.latest() });
                return;
              case "/api/remote-model/catalog":
              case "/api/remote-model/config":
                send(res, remote.public());
                return;
              case "/api/agent/sessions":
                send(res, {
                  sessions: sessions.list(),
                  deleted_session_ids: sessions.deletedIds(),
                });
                return;
              case "/api/video/snapshot.jpg": {
                const shot = await video.snapshot();
                res.writeHead(200, {
                  "Content-Type": "image/jpeg",
                  "Cache-Control": "no-store",
                  "X-Frame-SHA256": shot.metadata.sha256,
                  "X-Frame-Sequence": String(shot.metadata.sequence),
                });
                res.end(shot.jpeg);
                return;
              }
              case "/api/stream.mjpg": {
                res.writeHead(200, {
                  "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                  "Cache-Control": "no-store",
                  Connection: "close",
                });
                res.flushHeaders();
                let blocked = false;
                res.on("drain", () => (blocked = false));
                const unsubscribe = video.subscribe((shot) => {
                  if (res.destroyed) return;
                  if (!shot) {
                    res.end("--frame--\r\n");
                    return;
                  }
                  if (blocked) return;
                  const header = Buffer.from(
                    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${shot.jpeg.length}\r\nX-Sequence: ${shot.metadata.sequence}\r\n\r\n`,
                  );
                  blocked = !res.write(
                    Buffer.concat([header, shot.jpeg, Buffer.from("\r\n")]),
                  );
                });
                res.on("close", unsubscribe);
                return;
              }
            }
            if (path.startsWith("/api/agent/chat/jobs/")) {
              send(res, {
                job: jobs.get(
                  decodeURIComponent(
                    path.slice("/api/agent/chat/jobs/".length),
                  ),
                ),
              });
              return;
            }
            if (path.startsWith("/api/model-setup/tasks/")) {
              send(res, {
                task: setup.get(
                  decodeURIComponent(
                    path.slice("/api/model-setup/tasks/".length),
                  ),
                ),
              });
              return;
            }
            const bootstrap = path.match(
              /^\/api\/model-setup\/bootstrap\/([^/]+)\/([^/]+)\.ps1$/,
            );
            if (bootstrap) {
              const script = setup.bootstrap(
                bootstrap[1],
                bootstrap[2],
                callback,
                peer.bootstrapToken(),
              );
              res.writeHead(200, {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
              });
              res.end(script);
              return;
            }
          }
          if (
            req.method === "DELETE" &&
            path.startsWith("/api/agent/sessions/")
          ) {
            originGuard(req);
            const sessionId = decodeURIComponent(
              path.slice("/api/agent/sessions/".length),
            );
            sessions.delete(sessionId);
            audit.record("agent_session_deleted", { session_id: sessionId });
            send(res, { deleted: sessionId });
            return;
          }
          if (req.method !== "POST" || !POST_ROUTES.includes(path))
            throw new ApiError("not found", 404);
          originGuard(req);
          const p = await readBody(req, path);
          let result: unknown;
          switch (path) {
            case "/api/video-settings":
              result = {
                video: await video.updateMode(p, await availableModes()),
              };
              break;
            case "/api/video/pause":
              await video.pause();
              result = { video: video.status() };
              break;
            case "/api/power":
              result = { power: await power.wake(p) };
              audit.record("power_request_sent", {
                action: "wake",
                transport: "usb-hid-system-control",
              });
              break;
            case "/api/host-info":
              if (peer.enabled) peer.require(req.headers.authorization);
              result = { controlled_host: host.update(p) };
              audit.record("controlled_host_updated");
              break;
            case "/api/hid/key":
              result = { hid: await hid.tap(p) };
              break;
            case "/api/hid/mouse-move":
              result = { hid: await hid.move(p) };
              break;
            case "/api/hid/mouse-position":
              result = { hid: await hid.position(p) };
              break;
            case "/api/hid/mouse-click":
              result = { hid: await hid.click(p) };
              break;
            case "/api/hid/release":
              await hid.release();
              result = { hid: hid.status() };
              break;
            case "/api/hid/emergency-stop":
              await agent.stop();
              result = { hid: hid.status() };
              break;
            case "/api/hid/arm":
              await hid.arm();
              result = { hid: hid.status() };
              break;
            case "/api/agent/plans":
              result = { plan: await agent.create(p) };
              break;
            case "/api/agent/approve":
              result = { plan: agent.approve(p) };
              break;
            case "/api/agent/reject":
              result = { plan: agent.reject(p) };
              break;
            case "/api/agent/execute":
              result = { plan: await agent.execute(p) };
              break;
            case "/api/pc-agent/suggestions":
              peer.require(req.headers.authorization);
              result = { suggestion: suggestions.update(p) };
              audit.record("pc_agent_suggestion_received", {
                objective: p.objective,
              });
              break;
            case "/api/model-setup/tasks":
              result = { task: setup.create(p) };
              audit.record("model_setup_created");
              break;
            case "/api/model-setup/launch": {
              const taskId = z.string().parse(p.task_id);
              const url = new URL(callback);
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.pathname !== "/" ||
                url.search ||
                url.hash ||
                /[^\x21-\x7e]|["'`$]/.test(callback)
              )
                throw new ApiError("invalid PC Agent callback URL");
              peer.bootstrapToken();
              const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iex (irm '${callback}${setup.bootstrapPath(taskId)}')"`;
              if (command.length > 1024)
                throw new ApiError("bootstrap command is too long");
              await hid.tap({ key: "r", modifiers: ["win"] });
              await delay(600);
              await hid.typeText(command);
              await hid.tap({ key: "enter" });
              result = { task: setup.starting(taskId) };
              audit.record("model_setup_launched", { task_id: taskId });
              break;
            }
            case "/api/model-setup/progress":
              peer.require(req.headers.authorization);
              result = { task: setup.update(p) };
              audit.record("model_setup_progress", {
                task_id: p.task_id,
                status: p.status,
                progress: p.progress,
              });
              break;
            case "/api/remote-model/config":
              result = { remote_model: remote.save(p) };
              audit.record("remote_model_configured", {
                model: remote.public().model,
                base_url: remote.public().base_url,
              });
              break;
            case "/api/remote-model/test": {
              const r = await remote.chat(
                [{ role: "user", content: "Reply with exactly OK." }],
                undefined,
                30000,
              );
              result = {
                remote_model: {
                  ok: true,
                  model: r.model,
                  reply: r.content.slice(0, 200),
                },
              };
              audit.record("remote_model_tested", { model: r.model });
              break;
            }
            case "/api/agent/chat":
              result = await remoteAgent.chat(p);
              break;
            case "/api/agent/chat/jobs":
              result = {
                job: jobs.create(p.request_id, () => remoteAgent.chat(p)),
              };
              break;
            case "/api/agent/sessions":
              result = { session: sessions.upsert(p.session) };
              break;
          }
          send(res, result);
        } catch (e) {
          if (res.headersSent) {
            res.end();
            return;
          }
          send(
            res,
            {
              error:
                e instanceof z.ZodError
                  ? e.issues
                      .map((i) => i.path.join(".") + ": " + i.message)
                      .join("; ")
                  : e instanceof Error
                    ? e.message
                    : "request failed",
            },
            e instanceof ApiError ? e.status : 400,
          );
        }
      })();
    },
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
