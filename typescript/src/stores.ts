import { hostSchema } from "./host-schema.js";
export { hostSchema } from "./host-schema.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { SESSION_MAX_BYTES } from "./contracts.js";
import {
  ApiError,
  atomicJson,
  equalSecret,
  id,
  now,
  object,
  readJson,
  type JsonObject,
} from "./common.js";

export class AuditLog {
  constructor(
    public path: string,
    private maxBytes = 4 * 1024 * 1024,
  ) {}
  record(event: string, fields: JsonObject = {}) {
    const entry = {
      timestamp: now(),
      monotonic_ns: Number(process.hrtime.bigint()),
      event,
      ...fields,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    if (
      existsSync(this.path) &&
      statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
    )
      renameSync(this.path, this.path + ".1");
    appendFileSync(this.path, line, { mode: 0o600 });
    return entry;
  }
  recent(limit = 50): JsonObject[] {
    // Read at most the bounded tail of each rotation, never the entire history.
    const tail = (path: string) => {
      if (!existsSync(path)) return "";
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
        readSync(fd, buffer, 0, buffer.length, size - buffer.length);
        const text = buffer.toString("utf8");
        return size > buffer.length ? text.slice(text.indexOf("\n") + 1) : text;
      } finally {
        closeSync(fd);
      }
    };
    return (tail(this.path + ".1") + tail(this.path))
      .trim()
      .split("\n")
      .slice(-Math.max(1, Math.min(limit, 200)))
      .flatMap((line) => {
        try {
          return [object.parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  }
}
export class PeerAuth {
  constructor(public path: string) {}
  token() {
    try {
      const t = readFileSync(this.path, "utf8").trim();
      return t.length >= 24 && t.length <= 256 ? t : "";
    } catch {
      return "";
    }
  }
  get enabled() {
    return !!this.token();
  }
  require(auth?: string) {
    const t = this.token();
    if (
      !t ||
      !auth ||
      !/^Bearer /i.test(auth) ||
      !equalSecret(t, auth.slice(7))
    )
      throw new ApiError("invalid PC Agent pairing token", 401);
  }
  bootstrapToken() {
    const t = this.token();
    if (!t) throw new ApiError("PC Agent pairing is not configured", 401);
    return t;
  }
}
export class HostStore {
  constructor(public path: string) {}
  update(payload: unknown) {
    atomicJson(this.path, hostSchema.parse(payload));
    return this.status();
  }
  status() {
    if (!existsSync(this.path))
      return {
        status: "unavailable",
        message: "尚未收到被控主机信息",
        updated_at: null,
        data: null,
      };
    const result = hostSchema.safeParse(readJson(this.path));
    if (!result.success)
      return {
        status: "error",
        message: "主机信息缓存不可读",
        updated_at: null,
        data: null,
      };
    return {
      status: "available",
      message: "已连接被控主机信息探针",
      updated_at: result.data.collected_at,
      data: result.data,
    };
  }
}
const suggestionSchema = z.object({
  objective: z.string().trim().min(1).max(1000),
  summary: z.string().trim().min(1).max(4000),
  steps: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sources: z.array(z.string().max(1000)).max(16).default([]),
});
export class SuggestionStore {
  constructor(public path: string) {}
  update(payload: unknown) {
    const data = {
      schema_version: 1,
      received_at: now(),
      ...suggestionSchema.parse(payload),
    };
    atomicJson(this.path, data);
    return data;
  }
  status() {
    const data = readJson(this.path);
    return data
      ? { status: "available", message: "已收到 PC Agent 建议", data }
      : {
          status: existsSync(this.path) ? "error" : "empty",
          message: "尚未收到 PC Agent 建议",
        };
  }
}
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20000).default(""),
  ...Object.fromEntries(
    [
      "id",
      "createdAt",
      "plan",
      "modelSetup",
      "remoteModelSetup",
      "remoteModel",
      "agentJobId",
      "remoteRequestId",
      "transient",
    ].map((k) => [k, z.unknown().optional()]),
  ),
});
export const sessionSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().trim().min(1).max(120),
    createdAt: z.number().optional(),
    updatedAt: z.number().default(0),
    revision: z.number().int().nonnegative().default(0),
    messages: z.array(messageSchema).max(300),
  })
  .transform((s) => ({ ...s, createdAt: s.createdAt ?? s.updatedAt }))
  .refine(
    (s) => Buffer.byteLength(JSON.stringify(s)) <= SESSION_MAX_BYTES,
    "单个会话不能超过 1 MB，请创建新会话",
  );
type Session = z.infer<typeof sessionSchema>;
export class SessionStore {
  private sessions = new Map<string, Session>();
  private deleted = new Map<string, number>();
  constructor(public path: string) {
    const data = z
      .object({
        sessions: z.array(z.unknown()).default([]),
        deleted: z
          .array(
            z.object({ id: z.string().min(1).max(120), deletedAt: z.number() }),
          )
          .default([]),
      })
      .safeParse(readJson(path));
    if (data.success) {
      for (const raw of data.data.sessions) {
        const s = sessionSchema.safeParse(raw);
        if (s.success) this.sessions.set(s.data.id, s.data);
      }
      for (const d of data.data.deleted) {
        this.deleted.set(d.id, d.deletedAt);
        this.sessions.delete(d.id);
      }
      this.trim();
    }
  }
  list() {
    return structuredClone([...this.sessions.values()]);
  }
  deletedIds() {
    return [...this.deleted.keys()];
  }
  upsert(raw: unknown) {
    const s = sessionSchema.parse(raw);
    if (this.deleted.has(s.id)) throw new ApiError("session was deleted");
    const current = this.sessions.get(s.id);
    // Lost responses may cause a retry with an old revision. Identical writes
    // are idempotent; all other edits must match the server's current revision.
    if (
      current &&
      JSON.stringify({ ...s, revision: 0 }) ===
        JSON.stringify({ ...current, revision: 0 })
    )
      return structuredClone(current);
    if (s.revision !== (current?.revision ?? 0))
      throw new ApiError("会话已被其他页面更新，请重新读取后合并", 409);
    s.revision++;
    this.sessions.set(s.id, s);
    this.trim();
    this.save();
    return structuredClone(s);
  }
  delete(value: string) {
    const key = z.string().min(1).max(120).parse(value);
    this.sessions.delete(key);
    this.deleted.set(key, Date.now());
    this.trim();
    this.save();
  }
  private trim() {
    this.sessions = new Map(
      [...this.sessions]
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 100),
    );
    this.deleted = new Map(
      [...this.deleted].sort((a, b) => b[1] - a[1]).slice(0, 500),
    );
  }
  private save() {
    atomicJson(this.path, {
      sessions: this.list(),
      deleted: [...this.deleted].map(([id, deletedAt]) => ({ id, deletedAt })),
    });
  }
}
interface Job {
  job_id: string;
  request_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  result?: unknown;
  error?: string;
}
export class JobStore {
  private jobs = new Map<string, Job>();
  private requests = new Map<string, string>();
  create(request: unknown, work: () => Promise<unknown>) {
    const request_id = z.string().trim().min(1).max(120).parse(request);
    const existing = this.requests.get(request_id);
    if (existing) return this.get(existing);
    for (const [key, job] of this.jobs) {
      if (this.jobs.size < 100) break;
      if (["completed", "failed"].includes(job.status)) {
        this.jobs.delete(key);
        this.requests.delete(job.request_id);
      }
    }
    if (this.jobs.size >= 100)
      throw new ApiError("too many active Agent jobs", 429);
    const job: Job = {
      job_id: id(),
      request_id,
      status: "queued",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.jobs.set(job.job_id, job);
    this.requests.set(request_id, job.job_id);
    void Promise.resolve().then(async () => {
      job.status = "running";
      try {
        job.result = await work();
        job.status = "completed";
      } catch (e) {
        job.status = "failed";
        job.error = String(e).slice(0, 1000);
      }
      job.updated_at = Date.now();
    });
    return structuredClone(job);
  }
  get(key: string) {
    const job = this.jobs.get(key);
    if (!job) throw new ApiError("Agent job not found", 404);
    return structuredClone(job);
  }
}
