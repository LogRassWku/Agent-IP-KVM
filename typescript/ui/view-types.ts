export interface Observation {
  frame?: { sha256: string };
  recognition?: { state?: string };
}
export interface PlanView {
  plan_id: string;
  summary: string;
  risk: string;
  status: string;
  approval_required: boolean;
  target: string;
  expected_result: string;
  recovery: string;
  digest: string;
  evidence?: Observation;
  actions: { type: string; key?: string; text?: string; seconds?: number }[];
  result: { result?: Observation; verification?: Observation }[];
}
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  recommended?: boolean;
}
export interface SetupTaskView {
  task_id: string;
  model: string;
  models_dir: string;
  install_dir: string;
  status: string;
  progress: number;
  message: string;
  events: { message: string }[];
}
export interface SetupView {
  catalog: {
    models: ModelOption[];
    locations: { models_dir: string; free_bytes: number | null }[];
  };
  task?: SetupTaskView | null;
  model: string;
  modelsDir: string;
  installDir: string;
}
export interface RemoteSetupView {
  catalog: { models: ModelOption[]; vision_models?: ModelOption[] };
  baseUrl: string;
  model: string;
  visionModel: string;
  configured: boolean;
  result: string;
}
export interface MessageView {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  plan?: PlanView;
  modelSetup?: SetupView;
  remoteModelSetup?: RemoteSetupView;
  remoteModel?: string;
  agentJobId?: string;
  remoteRequestId?: string;
  transient?: boolean;
}
export interface SessionView {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revision?: number;
  messages: MessageView[];
}
export interface ChatResult {
  response: { content: string; model: string };
  plans: PlanView[];
}
export interface RemoteJob {
  job_id: string;
  status: string;
  result?: ChatResult;
  error?: string;
}
