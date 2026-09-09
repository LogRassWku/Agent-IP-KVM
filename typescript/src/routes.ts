import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "./common.js";
import { originGuard, readBody, send, httpFailure } from "./http.js";
import type { AgentCoordinator } from "./agent.js";
import type { HidController } from "./hid.js";
import type { UsbWake } from "./linux.js";
import type { ModelSetupStore } from "./model-setup.js";
import type { SetupService } from "./setup-service.js";
import type { RemoteAgent, RemoteModel } from "./remote-model.js";
import type {
  AuditLog,
  HostStore,
  JobStore,
  PeerAuth,
  SessionStore,
  SuggestionStore,
} from "./stores.js";
import type { Mode, VideoController } from "./video.js";
interface Services {
  assetDir: string;
  callback(): string;
  status(): Promise<unknown>;
  availableModes(): Promise<Mode[]>;
  video: VideoController;
  hid: HidController;
  power: UsbWake;
  host: HostStore;
  audit: AuditLog;
  peer: PeerAuth;
  suggestions: SuggestionStore;
  setup: ModelSetupStore;
  setupService: SetupService;
  sessions: SessionStore;
  jobs: JobStore;
  remote: RemoteModel;
  agent: AgentCoordinator;
  remoteAgent: RemoteAgent;
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
  "/api/model-setup/cancel",
  "/api/model-setup/progress",
  "/api/remote-model/config",
  "/api/remote-model/test",
  "/api/agent/chat",
  "/api/agent/chat/jobs",
  "/api/agent/sessions",
  "/api/hid/emergency-stop",
  "/api/hid/arm",
];
export function createRequestHandler(services: Services) {
  const {
    assetDir,
    callback,
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
  } = services;
  return (req: IncomingMessage, res: ServerResponse) => {
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
                decodeURIComponent(path.slice("/api/agent/chat/jobs/".length)),
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
              callback(),
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
          case "/api/model-setup/launch":
            result = {
              task: await setupService.launch(
                z.string().parse(p.task_id),
                callback(),
              ),
            };
            break;
          case "/api/model-setup/cancel":
            result = { task: setup.cancel(z.string().parse(p.task_id)) };
            break;
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
        const failure = httpFailure(e);
        if (failure.status >= 500) console.error("KVM request failed", e);
        send(res, { error: failure.error }, failure.status);
      }
    })();
  };
}
