/** Browser/server contracts: no Node dependencies or runtime side effects. */
export const SESSION_MAX_BYTES = 1024 * 1024;
export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  id?: unknown;
  createdAt?: unknown;
  plan?: unknown;
  modelSetup?: unknown;
  remoteModelSetup?: unknown;
  remoteModel?: unknown;
  agentJobId?: unknown;
  remoteRequestId?: unknown;
  transient?: unknown;
}
export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  messages: SessionMessage[];
}
