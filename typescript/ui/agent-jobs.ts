import type {
  MessageView,
  SessionView,
  RemoteJob,
  ChatResult,
} from "./view-types.js";
import { postJson, fetchJson } from "./api.js";
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function createAgentJobs(view: {
  save(): void;
  renderConversation(): void;
  renderSessions(): void;
  activeId(): string;
  sessions(): SessionView[];
}) {
  const activeAgentJobRequests = new Set<string>();
  function remoteMessagesBefore(
    session: SessionView,
    progressMessage: MessageView,
  ) {
    const end = session.messages.indexOf(progressMessage);
    const messages =
      end >= 0 ? session.messages.slice(0, end) : session.messages;
    return messages
      .filter(
        (item) =>
          (item.role === "user" || item.role === "assistant") &&
          !item.modelSetup &&
          !item.remoteModelSetup &&
          !item.transient,
      )
      .slice(-20)
      .map((item) => ({
        role: item.role,
        content: String(item.content ?? ""),
      }));
  }

  function setAgentJobProgress(
    session: SessionView,
    message: MessageView,
    content: string,
    jobId = message.agentJobId,
  ) {
    if (!session.messages.includes(message)) return;
    const changed = message.content !== content || message.agentJobId !== jobId;
    message.content = content;
    message.agentJobId = jobId || "";
    if (!changed) return;
    session.updatedAt = Date.now();
    view.save();
    if (session.id === view.activeId()) view.renderConversation();
  }

  async function createRemoteAgentJob(
    messages: { role: "user" | "assistant"; content: string }[],
    requestId: string,
  ) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return (
          await postJson<{ job: RemoteJob }>(
            "/api/agent/chat/jobs",
            { messages, request_id: requestId },
            { timeoutMs: 12000 },
          )
        ).job;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function waitForRemoteAgentJob(
    initialJob: RemoteJob,
    session: SessionView,
    progressMessage: MessageView,
  ) {
    let job = initialJob;
    const startedAt = Date.now();
    let failedPolls = 0;
    while (Date.now() - startedAt < 140000) {
      if (job?.status === "completed") {
        if (!job.result) throw new Error("任务结果为空");
        return job.result;
      }
      if (job?.status === "failed")
        throw new Error(job.error || "Agent 后台任务失败");
      const elapsed = Date.now() - startedAt;
      const stage =
        failedPolls > 0
          ? "网络短暂中断，正在重新获取后台结果…"
          : elapsed >= 60000
            ? "远程模型仍在处理，完成后会自动取回结果…"
            : elapsed >= 20000
              ? "正在识别屏幕并准备安全操作…"
              : "正在分析环境并规划操作…";
      setAgentJobProgress(session, progressMessage, stage, job?.job_id);
      await sleep(1500);
      try {
        job = (
          await fetchJson<{ job: RemoteJob }>(
            `/api/agent/chat/jobs/${encodeURIComponent(job.job_id)}`,
            { timeoutMs: 8000 },
          )
        ).job;
        failedPolls = 0;
      } catch (_) {
        failedPolls += 1;
      }
    }
    throw new Error("Agent 后台任务超过 140 秒仍未返回，请重试");
  }

  async function runRemoteAgentJob(
    session: SessionView,
    progressMessage: MessageView,
  ) {
    const requestId = progressMessage.remoteRequestId;
    if (!requestId) throw new Error("missing request id");
    if (activeAgentJobRequests.has(requestId)) return null;
    activeAgentJobRequests.add(requestId);
    try {
      const messages = remoteMessagesBefore(session, progressMessage);
      setAgentJobProgress(session, progressMessage, "正在连接开发板…");
      let job;
      if (progressMessage.agentJobId) {
        try {
          job = (
            await fetchJson<{ job: RemoteJob }>(
              `/api/agent/chat/jobs/${encodeURIComponent(progressMessage.agentJobId)}`,
              { timeoutMs: 8000 },
            )
          ).job;
        } catch (_) {
          /* The service may have restarted; the request ID makes recreation idempotent. */
        }
      }
      if (!job) job = await createRemoteAgentJob(messages, requestId);
      setAgentJobProgress(
        session,
        progressMessage,
        "正在分析环境并规划操作…",
        job.job_id,
      );
      return await waitForRemoteAgentJob(job, session, progressMessage);
    } finally {
      activeAgentJobRequests.delete(requestId);
    }
  }

  function applyRemoteAgentResult(
    session: SessionView,
    progressMessage: MessageView,
    response: ChatResult,
  ) {
    const jobId = progressMessage.agentJobId;
    session.messages = session.messages.filter(
      (item) =>
        item !== progressMessage && !(jobId && item.agentJobId === jobId),
    );
    if (String(response?.response?.content ?? "").trim()) {
      session.messages.push({
        role: "assistant",
        content: response.response.content,
        createdAt: Date.now(),
        remoteModel: response.response.model,
        agentJobId: jobId,
      });
    }
    for (const plan of response?.plans ?? []) {
      session.messages.push({
        role: "assistant",
        content: plan.summary,
        plan,
        createdAt: Date.now(),
        remoteModel: response.response.model,
        agentJobId: jobId,
      });
    }
  }

  async function resumeRemoteAgentJob(
    session: SessionView,
    progressMessage: MessageView,
  ) {
    if (
      !progressMessage?.remoteRequestId ||
      activeAgentJobRequests.has(progressMessage.remoteRequestId)
    )
      return;
    try {
      const response = await runRemoteAgentJob(session, progressMessage);
      if (response) applyRemoteAgentResult(session, progressMessage, response);
    } catch (error) {
      session.messages = session.messages.filter(
        (item) => item !== progressMessage,
      );
      session.messages.push({
        role: "assistant",
        content: `无法处理：${error instanceof Error ? error.message : String(error)}`,
        createdAt: Date.now(),
      });
    } finally {
      session.updatedAt = Date.now();
      view.save();
      view.renderSessions();
      if (session.id === view.activeId()) view.renderConversation();
    }
  }

  function resumePendingAgentJobs() {
    for (const session of view.sessions()) {
      for (const message of session.messages) {
        if (message?.transient && message.remoteRequestId)
          resumeRemoteAgentJob(session, message);
      }
    }
  }

  return {
    runRemoteAgentJob,
    applyRemoteAgentResult,
    resumeRemoteAgentJob,
    resumePendingAgentJobs,
  };
}
