import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
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
  constructor(public path: string) {}
  record(event: string, fields: JsonObject = {}) {
    const entry = {
      timestamp: now(),
      monotonic_ns: Number(process.hrtime.bigint()),
      event,
      ...fields,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  }
  recent(limit = 50): JsonObject[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
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
const txt = z
  .string()
  .trim()
  .max(512)
  .nullish()
  .transform((v) => v || null);
const required = z.string().trim().min(1).max(512);
const num = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? null);
const bool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);
const list = <T extends z.ZodType>(schema: T) =>
  z
    .array(schema)
    .max(32)
    .nullish()
    .transform((v) => v ?? []);
const partition = z.object({
  number: num,
  name: txt,
  label: txt,
  filesystem: txt,
  type: txt,
  size_bytes: num,
  free_bytes: num,
  is_boot: bool,
  is_system: bool,
  is_hidden: bool,
});
const volume = z.object({
  name: required,
  label: txt,
  filesystem: txt,
  size_bytes: num,
  free_bytes: num,
});
export const hostSchema = z.object({
  schema_version: z.literal(1),
  collected_at: required,
  hostname: required,
  os: z.object({
    name: required,
    version: txt,
    build: txt,
    architecture: txt,
    last_boot: txt,
  }),
  system: z.object({ manufacturer: txt, model: txt }).prefault({}),
  bios: z
    .object({
      manufacturer: txt,
      version: txt,
      release_date: txt,
      secure_boot: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === "boolean" ? v : null)),
    })
    .prefault({}),
  cpu: z
    .object({
      model: txt,
      physical_cores: num,
      logical_processors: num,
      max_clock_mhz: num,
    })
    .prefault({}),
  memory: z
    .object({
      total_bytes: num,
      modules: list(
        z.object({
          capacity_bytes: num,
          speed_mts: num,
          manufacturer: txt,
          part_number: txt,
        }),
      ),
    })
    .prefault({}),
  gpus: list(
    z.object({ name: required, driver_version: txt, memory_bytes: num }),
  ),
  disks: list(
    z.object({
      number: num,
      model: required,
      interface: txt,
      partition_style: txt,
      health: txt,
      operational_status: txt,
      size_bytes: num,
      allocated_bytes: num,
      partitions: list(partition),
    }),
  ),
  volumes: list(volume),
  network: z.object({ addresses: list(required) }).prefault({}),
});
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
    messages: z.array(messageSchema).max(300),
  })
  .transform((s) => ({ ...s, createdAt: s.createdAt ?? s.updatedAt }));
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
