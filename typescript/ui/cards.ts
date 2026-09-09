import type { MessageView, PlanView } from "./view-types.js";
import { formatBytes } from "./formatting.js";
const modelSetupStatusNames: Record<string, string> = {
  awaiting_start: "等待启动",
  starting: "正在启动",
  downloading_runtime: "下载运行环境",
  installing_runtime: "安装运行环境",
  downloading_model: "下载模型",
  verifying: "正在校验",
  completed: "配置完成",
  failed: "配置失败",
  cancelled: "已取消",
};
export function renderModelSetup(message: MessageView) {
  const setup = message.modelSetup!;
  const card = document.createElement("section");
  card.className = "model-setup-card";
  card.dataset.setupMessageId = message.id ?? "";
  const title = document.createElement("h2");
  title.textContent = "配置被控电脑模型";
  const description = document.createElement("p");
  description.textContent =
    "由开发板通过 USB 键盘启动安装器；安装进度会持续记录在此会话。";
  card.append(title, description);

  if (!setup.task) {
    const fields = document.createElement("div");
    fields.className = "model-setup-fields";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "模型";
    const modelSelect = document.createElement("select");
    modelSelect.dataset.setupField = "model";
    for (const model of setup.catalog.models ?? []) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = `${model.name}${model.recommended ? " · 推荐" : ""}`;
      option.selected = model.id === setup.model;
      modelSelect.append(option);
    }
    modelLabel.append(modelSelect);
    const locationLabel = document.createElement("label");
    locationLabel.textContent = "模型位置";
    const locationSelect = document.createElement("select");
    locationSelect.dataset.setupField = "models_dir";
    for (const location of setup.catalog.locations ?? []) {
      const option = document.createElement("option");
      option.value = location.models_dir;
      option.textContent = `${location.models_dir} · ${formatBytes(location.free_bytes)} 可用`;
      option.selected = location.models_dir === setup.modelsDir;
      locationSelect.append(option);
    }
    locationLabel.append(locationSelect);
    const installLabel = document.createElement("label");
    installLabel.className = "wide";
    installLabel.textContent = "Ollama 安装位置";
    const installInput = document.createElement("input");
    installInput.dataset.setupField = "install_dir";
    installInput.value = setup.installDir;
    installInput.autocomplete = "off";
    installInput.spellcheck = false;
    installLabel.append(installInput);
    fields.append(modelLabel, locationLabel, installLabel);
    card.append(fields);
    const start = document.createElement("button");
    start.className = "model-setup-start";
    start.type = "button";
    start.dataset.setupAction = "start";
    start.textContent = "开始配置";
    card.append(start);
    return card;
  }

  const task = setup.task;
  const status = document.createElement("div");
  status.className = "model-setup-status";
  const state = document.createElement("strong");
  state.textContent = modelSetupStatusNames[task.status] ?? task.status;
  const percent = document.createElement("span");
  percent.textContent = `${task.progress}%`;
  status.append(state, percent);
  const progress = document.createElement("div");
  progress.className = "model-setup-progress";
  progress.style.setProperty("--progress", `${task.progress}%`);
  progress.append(document.createElement("span"));
  const messageText = document.createElement("p");
  messageText.textContent = task.message;
  const details = document.createElement("p");
  details.textContent = `${task.model} · ${task.models_dir}`;
  const events = document.createElement("ol");
  events.className = "model-setup-events";
  for (const event of task.events ?? []) {
    const item = document.createElement("li");
    item.textContent = event.message;
    events.append(item);
  }
  card.append(status, progress, messageText, details, events);
  if (["awaiting_start", "failed"].includes(task.status)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.setupAction = "start";
    retry.textContent = "检查后重试";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.setupAction = "cancel";
    cancel.textContent = "取消配置";
    card.append(retry, cancel);
  }
  return card;
}

export function renderRemoteModelSetup(message: MessageView) {
  const setup = message.remoteModelSetup!;
  const card = document.createElement("section");
  card.className = "model-setup-card remote-model-setup";
  card.dataset.remoteSetupMessageId = message.id ?? "";
  const title = document.createElement("h2");
  title.textContent = "配置远程 API";
  const description = document.createElement("p");
  description.textContent =
    "兼容 OpenAI 格式的接口。密钥只保存在开发板，不会回显到网页。";
  card.append(title, description);
  const fields = document.createElement("div");
  fields.className = "model-setup-fields";
  const baseLabel = document.createElement("label");
  baseLabel.textContent = "接口地址";
  const baseInput = document.createElement("input");
  baseInput.dataset.remoteField = "base_url";
  baseInput.value = setup.baseUrl || "https://api.deepseek.com";
  baseInput.setAttribute("autocomplete", "url");
  baseLabel.append(baseInput);
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "模型";
  const modelSelect = document.createElement("select");
  modelSelect.dataset.remoteField = "model";
  for (const model of setup.catalog?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    option.title = model.description ?? "";
    option.selected = model.id === (setup.model || "deepseek-v4-flash");
    modelSelect.append(option);
  }
  modelLabel.append(modelSelect);
  const visionLabel = document.createElement("label");
  visionLabel.textContent = "屏幕视觉";
  const visionSelect = document.createElement("select");
  visionSelect.dataset.remoteField = "vision_model";
  const visionModels =
    Array.isArray(setup.catalog?.vision_models) &&
    setup.catalog.vision_models.length
      ? setup.catalog.vision_models
      : [
          {
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek V4 Flash Vision Exp",
            description: "按需理解 KVM 截图",
          },
        ];
  for (const model of visionModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    option.title = model.description ?? "";
    option.selected =
      model.id === (setup.visionModel || "deepseek-v4-flash-vision-exp");
    visionSelect.append(option);
  }
  visionLabel.append(visionSelect);
  const keyLabel = document.createElement("label");
  keyLabel.className = "wide";
  keyLabel.textContent = "API 密钥";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.dataset.remoteField = "api_key";
  keyInput.placeholder = setup.configured
    ? "已配置，输入新密钥可替换"
    : "粘贴 DeepSeek API 密钥";
  keyInput.autocomplete = "new-password";
  keyLabel.append(keyInput);
  fields.append(baseLabel, modelLabel, visionLabel, keyLabel);
  card.append(fields);
  const actions = document.createElement("div");
  actions.className = "model-setup-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "model-setup-start";
  save.dataset.remoteSetupAction = "save";
  save.textContent = "保存配置";
  actions.append(save);
  if (setup.configured) {
    const test = document.createElement("button");
    test.type = "button";
    test.className = "model-setup-test";
    test.dataset.remoteSetupAction = "test";
    test.textContent = "测试连接";
    actions.append(test);
  }
  card.append(actions);
  if (setup.result) {
    const result = document.createElement("p");
    result.className = "model-setup-result";
    result.textContent = setup.result;
    card.append(result);
  }
  return card;
}

export function renderAgentPlan(plan: PlanView) {
  const card = document.createElement("section");
  card.className = `agent-plan risk-${plan.risk}`;
  card.dataset.planId = plan.plan_id;
  const header = document.createElement("div");
  header.className = "agent-plan-header";
  const risk = document.createElement("span");
  risk.className = "risk-badge";
  risk.textContent =
    (
      {
        read_only: "只读",
        low: "低风险",
        high: "高风险",
        critical: "极高风险",
      } as Record<string, string>
    )[plan.risk] ?? plan.risk;
  const status = document.createElement("span");
  status.className = "plan-status";
  status.textContent =
    (
      {
        ready: "可执行",
        pending_approval: "等待批准",
        approved: "已批准",
        executing: "执行中",
        completed: "已完成",
        rejected: "已拒绝",
        failed: "失败",
        expired: "已过期",
        stopped: "已停止",
      } as Record<string, string>
    )[plan.status] ?? plan.status;
  header.append(risk, status);
  card.append(header);

  const actions = document.createElement("ol");
  actions.className = "agent-plan-actions";
  for (const action of plan.actions ?? []) {
    const item = document.createElement("li");
    if (action.type === "observe") item.textContent = "截取一帧并识别画面状态";
    else if (action.type === "key_tap")
      item.textContent = `按下并释放 ${action.key}`;
    else if (action.type === "type_text")
      item.textContent = `输入文本：${action.text}`;
    else if (action.type === "wait")
      item.textContent = `等待 ${action.seconds} 秒`;
    else item.textContent = "释放全部 HID 输入";
    actions.append(item);
  }
  card.append(actions);

  if (plan.approval_required) {
    const details = document.createElement("dl");
    details.className = "agent-plan-details";
    const rows = [
      ["目标", plan.target],
      ["预期", plan.expected_result],
      ["异常处理", plan.recovery],
      [
        "画面证据",
        plan.evidence?.frame?.sha256
          ? String(plan.evidence.frame.sha256).slice(0, 12)
          : "未取得",
      ],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value ?? "--";
      row.append(term, detail);
      details.append(row);
    }
    card.append(details);
  }

  if (plan.result?.length) {
    const result = document.createElement("div");
    result.className = "agent-plan-result";
    const observation = plan.result
      .flatMap((item) => [item.result, item.verification])
      .find((item) => item?.frame);
    result.textContent = observation
      ? `画面：${observation.recognition?.state ?? "unknown"} · 帧校验 ${String(observation.frame?.sha256 ?? "").slice(0, 12)}`
      : "动作已经执行并记录审计。";
    card.append(result);
  }
  if (plan.status === "pending_approval") {
    const digest = document.createElement("code");
    digest.className = "plan-digest";
    digest.textContent = `计划校验 ${String(plan.digest).slice(0, 12)}`;
    card.append(digest);
    const controls = document.createElement("div");
    controls.className = "agent-plan-controls";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.dataset.planAction = "reject";
    reject.textContent = "拒绝";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approve";
    approve.dataset.planAction = "approve";
    approve.textContent = "批准并执行";
    controls.append(reject, approve);
    card.append(controls);
  }
  return card;
}
