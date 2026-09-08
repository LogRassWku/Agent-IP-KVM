import { z } from "zod";
import {
  ApiError,
  canonical,
  delay,
  equalSecret,
  hash,
  id,
  now,
  type JsonObject,
} from "./common.js";
import { HidController, tapSchema } from "./hid.js";
import { AuditLog } from "./stores.js";

export const actionsSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("observe") }).strict(),
      z.object({ type: z.literal("release_all") }).strict(),
      z.object({ type: z.literal("key_tap"), ...tapSchema.shape }).strict(),
      z
        .object({
          type: z.literal("type_text"),
          text: z
            .string()
            .min(1)
            .max(512)
            .regex(/^[\x20-\x7e]+$/),
        })
        .strict(),
      z
        .object({ type: z.literal("wait"), seconds: z.number().min(0).max(2) })
        .strict(),
    ]),
  )
  .min(1)
  .max(16);
type Action = z.infer<typeof actionsSchema>[number];
export interface Plan {
  plan_id: string;
  objective: string;
  model: string;
  risk: string;
  actions: Action[];
  summary: string;
  target: string;
  evidence: JsonObject;
  expected_result: string;
  recovery: string;
  digest: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  approval_required: boolean;
  result: JsonObject[];
}
export class AgentCoordinator {
  private plans = new Map<string, { plan: Plan; expires: number }>();
  private stopGeneration = 0;
  constructor(
    private hid: HidController,
    private observe: () => Promise<JsonObject>,
    private audit: AuditLog,
    private approvalMs = 300_000,
  ) {}
  async create(payload: unknown) {
    const p = z
      .object({
        objective: z.string().trim().min(1).max(2000),
        model: z.string().trim().min(1).max(80).default("board-agent"),
        target: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .default("当前已连接的被控主机"),
        actions: actionsSchema.optional(),
      })
      .parse(payload);
    let actions: Action[] = p.actions ?? [{ type: "observe" }];
    let summary = p.actions
      ? "执行经过结构校验的 Agent 动作计划"
      : "取得一张按需截图并识别当前画面状态";
    const compact = p.objective.toLowerCase().replaceAll(" ", "");
    if (
      !p.actions &&
      ["按下win", "开始菜单", "windows键"].some((w) => compact.includes(w))
    ) {
      actions = [{ type: "key_tap", key: "win", modifiers: [] }];
      summary = "按下并释放 Win 键";
    } else if (
      !p.actions &&
      ["按下enter", "按下回车", "回车键"].some((w) => compact.includes(w))
    ) {
      actions = [{ type: "key_tap", key: "enter", modifiers: [] }];
      summary = "按下并释放 Enter 键";
    }
    const objective = p.objective.toLowerCase();
    const risk = [
      "刷写",
      "flash firmware",
      "固件",
      "清盘",
      "wipe",
      "erase disk",
    ].some((w) => objective.includes(w))
      ? "critical"
      : [
            "bios",
            "uefi",
            "secure boot",
            "安全启动",
            "启动项",
            "启动顺序",
            "重启",
            "reboot",
            "安装",
            "install",
            "分区",
            "partition",
            "格式化",
            "format",
          ].some((w) => objective.includes(w))
        ? "high"
        : actions.some((a) => ["key_tap", "type_text"].includes(a.type))
          ? "low"
          : "read_only";
    const evidence = risk === "read_only" ? {} : await this.observe();
    const core = {
      objective: p.objective,
      model: p.model,
      risk,
      actions,
      target: p.target,
      evidence,
      expected_result: summary,
      recovery: "出现异常时停止计划并释放全部 HID 输入",
    };
    const plan: Plan = {
      ...core,
      plan_id: id(),
      summary,
      digest: hash(canonical(core)),
      status: risk === "read_only" ? "ready" : "pending_approval",
      created_at: now(),
      approved_at: null,
      approval_required: risk !== "read_only",
      result: [],
    };
    for (const [key, entry] of this.plans)
      if (
        entry.expires < performance.now() &&
        entry.plan.status !== "executing"
      )
        this.plans.delete(key);
    if (this.plans.size >= 1000)
      throw new ApiError("too many active plans", 429);
    this.plans.set(plan.plan_id, {
      plan,
      expires: performance.now() + this.approvalMs,
    });
    this.audit.record("plan_created", {
      plan_id: plan.plan_id,
      plan_digest: plan.digest,
      risk,
      model: p.model,
      action_types: actions.map((a) => a.type),
    });
    return structuredClone(plan);
  }
  private lookup(payload: unknown, allowed: string[]) {
    const p = z.object({ plan_id: z.string() }).parse(payload);
    const entry = this.plans.get(p.plan_id);
    if (!entry) throw new ApiError("unknown Agent plan");
    if (performance.now() > entry.expires) {
      entry.plan.status = "expired";
      throw new ApiError(
        "plan approval expired; create and review a new plan",
        409,
      );
    }
    if (!allowed.includes(entry.plan.status))
      throw new ApiError(
        "plan cannot be used while status is " + entry.plan.status,
        409,
      );
    return entry.plan;
  }
  approve(payload: unknown) {
    const p = z
      .object({ plan_id: z.string(), digest: z.string() })
      .parse(payload);
    const plan = this.lookup(p, ["pending_approval"]);
    if (!equalSecret(plan.digest, p.digest))
      throw new ApiError(
        "plan digest changed; review the current plan again",
        409,
      );
    plan.status = "approved";
    plan.approved_at = now();
    this.audit.record("plan_approved", {
      plan_id: plan.plan_id,
      plan_digest: plan.digest,
      risk: plan.risk,
    });
    return structuredClone(plan);
  }
  reject(payload: unknown) {
    const plan = this.lookup(payload, [
      "pending_approval",
      "approved",
      "ready",
    ]);
    plan.status = "rejected";
    this.audit.record("plan_rejected", {
      plan_id: plan.plan_id,
      plan_digest: plan.digest,
    });
    return structuredClone(plan);
  }
  async stop() {
    this.stopGeneration++;
    for (const { plan } of this.plans.values())
      if (["ready", "pending_approval", "approved"].includes(plan.status))
        plan.status = "stopped";
    await this.hid.emergencyStop();
    this.audit.record("emergency_stop");
  }
  async execute(payload: unknown) {
    const plan = this.lookup(payload, ["ready", "approved"]);
    if (plan.approval_required && plan.status !== "approved")
      throw new ApiError("plan requires approval", 409);
    plan.status = "executing";
    const generation = this.stopGeneration;
    this.audit.record("plan_execution_started", {
      plan_id: plan.plan_id,
      plan_digest: plan.digest,
    });
    try {
      for (const [index, action] of plan.actions.entries()) {
        if (generation !== this.stopGeneration)
          throw new ApiError("emergency stop is active");
        let result: JsonObject;
        switch (action.type) {
          case "observe":
            result = await this.observe();
            break;
          case "key_tap":
            result = await this.hid.tap(action);
            break;
          case "type_text":
            result = await this.hid.typeText(action.text);
            break;
          case "wait":
            await delay(action.seconds * 1000);
            result = { seconds: action.seconds };
            break;
          case "release_all":
            await this.hid.release();
            result = { released: true };
        }
        if (generation !== this.stopGeneration)
          throw new ApiError("emergency stop is active");
        const entry: JsonObject = { index, type: action.type, result };
        if (!["observe", "wait"].includes(action.type))
          entry.verification = await this.observe();
        plan.result.push(entry);
        this.audit.record("agent_action_completed", {
          plan_id: plan.plan_id,
          plan_digest: plan.digest,
          action_index: index,
          action_type: action.type,
        });
      }
      plan.status = "completed";
      this.audit.record("plan_execution_completed", {
        plan_id: plan.plan_id,
        plan_digest: plan.digest,
      });
    } catch (e) {
      try {
        await this.hid.release();
      } catch {}
      plan.status = "failed";
      plan.result.push({ error: String(e) });
      this.audit.record("plan_execution_failed", {
        plan_id: plan.plan_id,
        plan_digest: plan.digest,
        error: String(e),
      });
      throw new ApiError("Agent action failed: " + String(e));
    }
    return structuredClone(plan);
  }
}
