import { ApiError, delay } from "./common.js";
import type { HidController } from "./hid.js";
import type { ModelSetupStore } from "./model-setup.js";
import type { AuditLog, PeerAuth } from "./stores.js";

export class SetupService {
  constructor(
    private setup: ModelSetupStore,
    private hid: HidController,
    private peer: PeerAuth,
    private audit: AuditLog,
  ) {}
  async launch(taskId: string, callback: string) {
    // Occupancy is acquired before claiming a task or sending any input.
    return this.hid.exclusive(async () => {
      this.setup.starting(taskId);
      try {
        const url = new URL(callback);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash ||
          /[^\x21-\x7e]|["'`$]/.test(callback)
        )
          throw new ApiError("invalid PC Agent callback URL");
        this.peer.bootstrapToken();
        const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iex (irm '${callback}${this.setup.bootstrapPath(taskId)}')"`;
        if (command.length > 1024)
          throw new ApiError("bootstrap command is too long");
        await this.hid.tap({ key: "r", modifiers: ["win"] });
        await delay(600);
        await this.hid.typeText(command);
        await this.hid.tap({ key: "enter" });
        this.audit.record("model_setup_launched", { task_id: taskId });
        // A fast PC may already have reported progress. Never overwrite it.
        return this.setup.get(taskId);
      } catch (error) {
        await this.hid.release().catch(() => {});
        this.setup.failLaunch(
          taskId,
          "启动未完成，请检查被控电脑状态后重试：" + String(error),
        );
        throw error;
      }
    });
  }
}
