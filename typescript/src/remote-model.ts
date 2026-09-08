import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import {
  ApiError,
  atomicJson,
  now,
  object,
  readJson,
  type JsonObject,
} from "./common.js";
import { AgentCoordinator, type Plan } from "./agent.js";
import { AuditLog, HostStore } from "./stores.js";
import { HidController } from "./hid.js";
import { VideoController } from "./video.js";

const configSchema = z.object({
  base_url: z.string(),
  model: z.string(),
  vision_model: z.string().default("deepseek-v4-flash-vision-exp"),
  api_key: z.string(),
  updated_at: z.string(),
});
const callSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    arguments: z.string().max(12000),
  }),
});
const callsSchema = z
  .array(callSchema)
  .max(8)
  .nullish()
  .transform((v) => v ?? []);
const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable(),
    tool_calls: callsSchema.optional(),
    tool_call_id: z.string().min(1).max(128).optional(),
  })
  .superRefine((m, ctx) => {
    const max = ["system", "tool"].includes(m.role) ? 32000 : 12000;
    if (
      (m.content?.length ?? 0) > max ||
      (!m.content?.trim() &&
        !(m.role === "assistant" && m.tool_calls?.length)) ||
      (m.role === "tool" && !m.tool_call_id)
    )
      ctx.addIssue({
        code: "custom",
        message: "invalid message content or tool call",
      });
  });
type Message = z.infer<typeof messageSchema>;
export function validBaseUrl(value: string) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
      return false;
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    const h = u.hostname;
    if (["localhost", "127.0.0.1", "[::1]"].includes(h)) return true;
    return (
      isIP(h) === 4 &&
      (h.startsWith("10.") ||
        h.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h))
    );
  } catch {
    return false;
  }
}
export class RemoteModel {
  private config?: z.infer<typeof configSchema>;
  private catalogData: {
    models: { id: string; name: string; description: string }[];
    vision_models: { id: string; name: string; description: string }[];
  };
  constructor(
    public path: string,
    templateDir: string,
    private requestFetch: typeof fetch = fetch,
  ) {
    const result = configSchema.safeParse(readJson(path));
    if (result.success) this.config = result.data;
    this.catalogData = JSON.parse(
      readFileSync(join(templateDir, "remote-catalog.json"), "utf8"),
    );
  }
  public() {
    return {
      provider: "DeepSeek",
      base_url: this.config?.base_url ?? "https://api.deepseek.com",
      model: this.config?.model ?? "deepseek-v4-flash",
      vision_model: this.config?.vision_model ?? "deepseek-v4-flash-vision-exp",
      ...this.catalogData,
      configured: !!this.config?.api_key,
      updated_at: this.config?.updated_at ?? null,
    };
  }
  save(payload: unknown) {
    const p = z
      .object({
        base_url: z.string().trim().default("https://api.deepseek.com"),
        model: z.string().default("deepseek-v4-flash"),
        vision_model: z.string().nullish(),
        api_key: z.string().nullish(),
      })
      .parse(payload);
    const base = p.base_url.replace(/\/+$/, "");
    if (!validBaseUrl(base))
      throw new ApiError(
        "base_url must use HTTPS (or HTTP for a private LAN endpoint)",
      );
    const vision =
      p.vision_model?.trim() ||
      this.config?.vision_model ||
      "deepseek-v4-flash-vision-exp";
    if (
      !this.catalogData.models.some((m) => m.id === p.model) ||
      !this.catalogData.vision_models.some((m) => m.id === vision)
    )
      throw new ApiError("unsupported remote model");
    const key = p.api_key?.trim() || this.config?.api_key;
    if (!key || !/^[A-Za-z0-9._-]{20,256}$/.test(key))
      throw new ApiError("api_key must be a non-empty provider key");
    this.config = {
      base_url: base,
      model: p.model,
      vision_model: vision,
      api_key: key,
      updated_at: now(),
    };
    atomicJson(this.path, this.config);
    return this.public();
  }
  private async request(
    payload: unknown,
    timeout: number,
  ): Promise<JsonObject> {
    if (!this.config?.api_key)
      throw new ApiError("remote model is not configured");
    let response: Response;
    try {
      response = await this.requestFetch(
        this.config.base_url + "/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.config.api_key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeout),
          redirect: "error",
        },
      );
    } catch {
      throw new ApiError("remote API connection failed or timed out");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError("remote API returned HTTP " + response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError("remote API returned empty response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000)
          throw new ApiError("remote API response exceeded 2 MB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return object.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new ApiError("remote API returned invalid JSON");
    }
  }
  async chat(messages: unknown, tools?: unknown[], timeout = 90000) {
    const clean = z.array(messageSchema).min(1).max(48).parse(messages);
    if (
      tools &&
      (tools.length < 1 ||
        tools.length > 16 ||
        JSON.stringify(tools).length > 64000)
    )
      throw new ApiError("invalid tool definitions");
    const result = await this.request(
      {
        model: this.config?.model,
        messages: clean,
        stream: false,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      },
      timeout,
    );
    const envelope = z
      .object({
        choices: z
          .array(
            z.object({
              message: z.object({
                content: z.string().nullable().optional(),
                tool_calls: callsSchema,
              }),
            }),
          )
          .min(1),
        model: z.string().optional(),
        usage: z.unknown().optional(),
      })
      .parse(result);
    const m = envelope.choices[0].message;
    if (!m.content?.trim() && !m.tool_calls.length)
      throw new ApiError(
        "remote API response contains neither text nor tool calls",
      );
    const message: Message = {
      role: "assistant",
      content: m.content ?? null,
      ...(m.tool_calls.length ? { tool_calls: m.tool_calls } : {}),
    };
    return {
      content: m.content ?? "",
      model: envelope.model ?? this.config!.model,
      usage: envelope.usage ?? null,
      tool_calls: m.tool_calls,
      message,
    };
  }
  async analyzeImage(jpeg: Buffer, purpose: string, timeout = 35000) {
    if (
      jpeg.length > 8_000_000 ||
      !jpeg.subarray(0, 2).equals(Buffer.from([255, 216]))
    )
      throw new ApiError("vision input must be a JPEG no larger than 8 MB");
    z.string().trim().min(1).max(200).parse(purpose);
    const result = await this.request(
      {
        model: this.config?.vision_model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "你是 Agent IP KVM 的只读屏幕观察器。只描述截图中直接可见的事实，不推断隐藏内容，不规划或执行操作。返回 JSON 对象：screen_type、summary（中文）、visible_text（最多30条）、interactive_elements（最多30项 label/type/x/y，坐标0到1）、confidence（0到1）、safety_notes。本次目的：" +
                  purpose,
              },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/jpeg;base64," + jpeg.toString("base64"),
                },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        stream: false,
      },
      timeout,
    );
    const r = z
      .object({
        choices: z
          .array(
            z.object({ message: z.object({ content: z.string().max(64000) }) }),
          )
          .min(1),
        model: z.string().optional(),
        usage: z.unknown().optional(),
      })
      .parse(result);
    const content = r.choices[0].message.content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const analysis = object.parse(JSON.parse(content));
    return {
      model: r.model ?? this.config!.vision_model,
      analysis,
      usage: r.usage ?? null,
    };
  }
}
export class RemoteAgent {
  private tools: unknown[];
  constructor(
    private remote: RemoteModel,
    private agent: AgentCoordinator,
    private video: VideoController,
    private hid: HidController,
    private host: HostStore,
    private audit: AuditLog,
    templates: string,
  ) {
    this.tools = JSON.parse(
      readFileSync(join(templates, "remote-tools.json"), "utf8"),
    );
  }
  async chat(payload: unknown) {
    const p = z
      .object({
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().trim().min(1).max(12000),
            }),
          )
          .min(1)
          .max(40),
      })
      .parse(payload);
    const system = `你是 Agent IP KVM 的远程规划模型。当前服务运行于 ${process.platform}，视频后端 ${this.video.config.source}，HID 后端 ${this.hid.backend}。模拟模式不能控制真实电脑。KVM 负责采集、HID、审批和审计，PC Agent 只报告信息。问硬件事实必须 get_controlled_host_info；问屏幕必须 capture_screen，仅以 vision.analysis 为依据，不猜测。问连接必须 get_kvm_status。操作必须 propose_hid_actions，pending_approval 仅表示等待批准，绝不声称已经执行。没有 Shell、磁盘直写或绕过审批的权限。看不到画面、身份未知、低置信度或动作结果异常时停止。缓存信息：${JSON.stringify(this.host.status().data).slice(0, 24000)}。默认简洁中文，区分缓存、实时结果、建议、待批准、已执行。`;
    const transcript: Message[] = [
      { role: "system", content: system },
      ...p.messages,
    ];
    const plans: Plan[] = [];
    const tool_events: JsonObject[] = [];
    for (let round = 0; round < 3; round++) {
      const response = await this.remote.chat(transcript, this.tools, 25000);
      const finish = (content = response.content) => ({
        response: {
          content,
          model: response.model,
          usage: response.usage,
          tool_count: tool_events.length,
        },
        plans,
        tool_events,
      });
      if (!response.tool_calls.length) return finish();
      transcript.push(response.message);
      for (const call of response.tool_calls) {
        const name = call.function.name;
        let result: JsonObject;
        try {
          const args = object.parse(JSON.parse(call.function.arguments));
          switch (name) {
            case "get_controlled_host_info":
              z.object({}).strict().parse(args);
              result = { ok: true, controlled_host: this.host.status() };
              break;
            case "get_kvm_status":
              z.object({}).strict().parse(args);
              result = {
                ok: true,
                video: this.video.status(),
                hid: this.hid.status(),
              };
              break;
            case "capture_screen": {
              const { purpose } = z
                .object({
                  purpose: z
                    .string()
                    .trim()
                    .min(1)
                    .max(200)
                    .default("读取当前屏幕"),
                })
                .strict()
                .parse(args);
              const { jpeg, metadata } = await this.video.snapshot();
              const vision = await this.remote.analyzeImage(jpeg, purpose);
              result = { ok: true, frame: metadata, vision };
              this.audit.record("remote_agent_screen_analyzed", {
                frame_sha256: metadata.sha256,
                vision_model: vision.model,
                confidence: vision.analysis.confidence,
              });
              break;
            }
            case "propose_hid_actions": {
              let plan = await this.agent.create({
                ...args,
                model: "remote-api",
              });
              if (!plan.approval_required)
                plan = await this.agent.execute({ plan_id: plan.plan_id });
              plans.push(plan);
              result = {
                ok: true,
                plan_id: plan.plan_id,
                status: plan.status,
                risk: plan.risk,
                summary: plan.summary,
                approval_required: plan.approval_required,
              };
              break;
            }
            default:
              throw new ApiError("unknown remote Agent tool: " + name);
          }
        } catch (e) {
          result = { ok: false, error: String(e) };
        }
        const event = {
          tool: name,
          ok: !!result.ok,
          plan_id: result.plan_id ?? null,
        };
        this.audit.record("remote_agent_tool_called", event);
        tool_events.push(event);
        transcript.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 30000),
        });
      }
      if (plans.some((p) => p.status === "pending_approval"))
        return finish("操作计划已准备好，请在下方审阅并决定是否执行。");
    }
    throw new ApiError(
      "remote Agent exceeded the maximum of three tool rounds",
    );
  }
}
