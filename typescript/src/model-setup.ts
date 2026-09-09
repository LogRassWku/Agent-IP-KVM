import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ApiError, atomicJson, equalSecret, now, readJson } from "./common.js";

// Catalog is preserved from the Python baseline; availability requires provider validation.
export const MODEL_CATALOG = [
  {
    id: "qwen3.5:9b",
    name: "Qwen3.5 9B",
    description: "推荐：视觉、工具调用与复杂任务，约 6.6 GB",
    size_bytes: 6_600_000_000,
    recommended: true,
  },
  {
    id: "qwen3.5:4b",
    name: "Qwen3.5 4B",
    description: "轻量：显存压力更低，约 3.4 GB",
    size_bytes: 3_400_000_000,
    recommended: false,
  },
];
const pathSchema = z
  .string()
  .trim()
  .max(240)
  .regex(/^[A-Za-z]:\\[^\r\n"'|<>?*]*$/)
  .refine((p) => !p.split("\\").includes(".."), "path cannot contain traversal")
  .transform((p) => p.replace(/\\+$/, ""));
const states = z.enum([
  "awaiting_start",
  "starting",
  "downloading_runtime",
  "installing_runtime",
  "downloading_model",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
const taskSchema = z.object({
  task_id: z.string(),
  secret: z.string(),
  model: z.enum(["qwen3.5:9b", "qwen3.5:4b"]),
  install_dir: pathSchema,
  models_dir: pathSchema,
  status: states,
  progress: z.number().int().min(0).max(100),
  message: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  events: z.array(
    z.object({ at: z.string(), status: states, message: z.string() }),
  ),
});
type Task = z.infer<typeof taskSchema>;
export class ModelSetupStore {
  private tasks = new Map<string, Task>();
  constructor(
    public path: string,
    private templatePath: string,
  ) {
    const data = z
      .object({ tasks: z.array(z.unknown()) })
      .safeParse(readJson(path));
    if (data.success)
      for (const raw of data.data.tasks) {
        const t = taskSchema.safeParse(raw);
        if (t.success) this.tasks.set(t.data.task_id, t.data);
      }
  }
  catalog(host: unknown) {
    const result = z
      .object({
        data: z.object({
          volumes: z.array(
            z.object({ name: z.string(), free_bytes: z.number().nullable() }),
          ),
        }),
      })
      .safeParse(host);
    const locations = result.success
      ? result.data.data.volumes
          .filter((v) => /^[A-Za-z]:$/.test(v.name))
          .map((v) => ({
            drive: v.name.toUpperCase(),
            models_dir: v.name.toUpperCase() + "\\AgentIPKVM\\Models",
            free_bytes: v.free_bytes,
          }))
      : [];
    return {
      models: MODEL_CATALOG,
      locations: locations.length
        ? locations
        : [
            {
              drive: "C:",
              models_dir: "C:\\AgentIPKVM\\Models",
              free_bytes: null,
            },
          ],
    };
  }
  create(payload: unknown) {
    const p = z
      .object({
        model: z.enum(["qwen3.5:9b", "qwen3.5:4b"]),
        install_dir: pathSchema,
        models_dir: pathSchema,
      })
      .parse(payload);
    const t: Task = {
      ...p,
      task_id: randomUUID(),
      secret: randomBytes(24).toString("base64url"),
      status: "awaiting_start",
      progress: 0,
      message: "等待向被控电脑发送安装指令",
      created_at: now(),
      updated_at: now(),
      events: [
        { at: now(), status: "awaiting_start", message: "配置任务已创建" },
      ],
    };
    this.tasks.set(t.task_id, t);
    this.save();
    return this.public(t);
  }
  private task(id: string) {
    const t = this.tasks.get(id);
    if (!t) throw new ApiError("unknown model setup task", 404);
    return t;
  }
  private public(t: Task) {
    const { secret, ...publicTask } = t;
    return structuredClone(publicTask);
  }
  get(id: string) {
    return this.public(this.task(id));
  }
  latest() {
    const t = [...this.tasks.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    return t ? this.public(t) : null;
  }
  update(payload: unknown) {
    const p = z
      .object({
        task_id: z.string(),
        status: states,
        progress: z.number().int().min(0).max(100),
        message: z.string().trim().min(1).max(500),
      })
      .parse(payload);
    const t = this.task(p.task_id);
    const order = [
      "awaiting_start",
      "starting",
      "downloading_runtime",
      "installing_runtime",
      "downloading_model",
      "verifying",
      "completed",
    ];
    if (["completed", "failed", "cancelled"].includes(t.status)) {
      if (t.status === p.status && t.progress === p.progress)
        return this.public(t);
      throw new ApiError("配置任务已结束，不能由旧请求改变状态", 409);
    }
    if (
      t.status === "awaiting_start" ||
      p.status === "awaiting_start" ||
      p.status === "starting" ||
      p.status === "cancelled"
    )
      throw new ApiError("配置任务尚未启动或状态转换无效", 409);
    if (
      p.status !== "failed" &&
      (order.indexOf(p.status) < order.indexOf(t.status) ||
        p.progress < t.progress)
    )
      throw new ApiError("已忽略过期的配置进度", 409);
    if (p.status === "completed" && p.progress !== 100)
      throw new ApiError("完成状态必须为 100%", 400);
    Object.assign(t, p, { updated_at: now() });
    t.events.push({ at: t.updated_at, status: t.status, message: t.message });
    t.events = t.events.slice(-100);
    this.save();
    return this.public(t);
  }
  starting(id: string) {
    const t = this.task(id);
    if (t.status !== "awaiting_start")
      throw new ApiError("配置任务已经启动，请勿重复发送安装指令", 409);
    return this.transition(t, "starting", 2, "正在被控电脑上启动配置程序");
  }
  failLaunch(id: string, message: string) {
    const t = this.task(id);
    if (["awaiting_start", "starting"].includes(t.status))
      return this.transition(t, "failed", t.progress, message.slice(0, 500));
    return this.public(t);
  }
  cancel(id: string) {
    const t = this.task(id);
    if (t.status === "cancelled") return this.public(t);
    if (!["awaiting_start", "failed"].includes(t.status))
      throw new ApiError(
        "安装已启动，不能通过关闭配置卡停止电脑上的安装程序",
        409,
      );
    return this.transition(t, "cancelled", t.progress, "配置已取消");
  }
  private transition(
    t: Task,
    status: Task["status"],
    progress: number,
    message: string,
  ) {
    Object.assign(t, { status, progress, message, updated_at: now() });
    t.events.push({ at: t.updated_at, status, message });
    t.events = t.events.slice(-100);
    this.save();
    return this.public(t);
  }
  bootstrapPath(id: string) {
    const t = this.task(id);
    return `/api/model-setup/bootstrap/${id}/${t.secret}.ps1`;
  }
  bootstrap(id: string, secret: string, url: string, token: string) {
    const t = this.task(id);
    if (!equalSecret(t.secret, secret))
      throw new ApiError("invalid or expired bootstrap address", 404);
    let script = readFileSync(this.templatePath, "utf8").replace(/^\uFEFF/, "");
    const values: Record<string, string> = {
      __KVM_URL__: url,
      __PAIRING_TOKEN__: token,
      __TASK_ID__: id,
      __MODEL__: t.model,
      __INSTALL_DIR__: t.install_dir,
      __MODELS_DIR__: t.models_dir,
    };
    for (const [k, v] of Object.entries(values))
      script = script.replaceAll(k, "'" + v.replaceAll("'", "''") + "'");
    return script;
  }
  private save() {
    atomicJson(this.path, { tasks: [...this.tasks.values()] });
  }
}
