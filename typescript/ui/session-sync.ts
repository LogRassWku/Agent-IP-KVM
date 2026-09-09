import { SESSION_MAX_BYTES, type AgentSession } from "../src/contracts.js";
import { fetchJson, HttpError, postJson } from "./api.js";

interface Hooks {
  find(id: string): AgentSession | undefined;
  saved(id: string, revision: number): void;
  conflict(local: AgentSession, remote?: AgentSession, deleted?: boolean): void;
  status(id: string, message: string): void;
}
const signature = (session: AgentSession) =>
  JSON.stringify({ ...session, revision: 0 });
export class SessionSynchronizer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private dirty = new Set<string>();
  private acknowledged = new Map<string, string>();
  private cancelled = new Set<string>();
  constructor(private hooks: Hooks) {}
  isDirty(id: string) {
    return this.dirty.has(id) || this.running.has(id);
  }
  queue(session: AgentSession) {
    if (this.cancelled.has(session.id)) return;
    if (this.acknowledged.get(session.id) === signature(session)) return;
    this.dirty.add(session.id);
    clearTimeout(this.timers.get(session.id));
    this.timers.set(
      session.id,
      setTimeout(() => void this.flush(session.id), 150),
    );
  }
  cancel(id: string) {
    this.cancelled.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
  }
  private async flush(id: string) {
    this.timers.delete(id);
    if (this.running.has(id) || this.cancelled.has(id)) return;
    const live = this.hooks.find(id);
    if (!live) return;
    const snapshot = structuredClone({ ...live, revision: live.revision ?? 0 });
    const sent = signature(snapshot);
    if (
      new TextEncoder().encode(JSON.stringify(snapshot)).length >
      SESSION_MAX_BYTES
    ) {
      this.hooks.status(
        id,
        "未同步：此会话超过 1 MB，请保留当前内容并创建新会话。",
      );
      return;
    }
    this.running.add(id);
    this.dirty.delete(id);
    let retry = false;
    try {
      const { session } = await postJson<{ session: AgentSession }>(
        "/api/agent/sessions",
        { session: snapshot },
      );
      if (
        !session ||
        session.id !== id ||
        !Number.isInteger(session.revision) ||
        session.revision < 1
      )
        throw new Error("服务返回了无效的会话版本");
      if (this.cancelled.has(id)) return;
      this.acknowledged.set(id, sent);
      this.hooks.saved(id, session.revision);
      this.hooks.status(id, "");
      const current = this.hooks.find(id);
      retry = !!current && signature(current) !== sent;
    } catch (error) {
      if (this.cancelled.has(id)) return;
      this.dirty.add(id);
      this.hooks.status(
        id,
        `未同步：${error instanceof Error ? error.message : String(error)}`,
      );
      if (
        error instanceof HttpError &&
        (error.status === 409 ||
          (error.status === 400 && error.message === "session was deleted"))
      ) {
        try {
          const data = await fetchJson<{
            sessions: AgentSession[];
            deleted_session_ids: string[];
          }>("/api/agent/sessions");
          const current = this.hooks.find(id);
          if (current && !this.cancelled.has(id)) {
            this.dirty.delete(id);
            this.hooks.conflict(
              current,
              data.sessions.find((s) => s.id === id),
              data.deleted_session_ids.includes(id),
            );
          }
        } catch {
          /* Keep the local version dirty for a later retry. */
        }
      }
    } finally {
      this.running.delete(id);
      if (!this.cancelled.has(id) && (retry || this.dirty.has(id))) {
        clearTimeout(this.timers.get(id));
        this.timers.set(
          id,
          setTimeout(() => void this.flush(id), retry ? 150 : 5000),
        );
      }
    }
  }
}
