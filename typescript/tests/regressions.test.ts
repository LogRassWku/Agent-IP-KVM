import { ApiError } from "../src/common.js";
import { httpFailure } from "../src/http.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentCoordinator } from "../src/agent.js";
import { HidController, SimulatedHid } from "../src/hid.js";
import { AuditLog, SessionStore, sessionSchema } from "../src/stores.js";
import { createKvmServer, resourcePaths } from "../src/server.js";
import { RemoteModel } from "../src/remote-model.js";
import { ModelSetupStore } from "../src/model-setup.js";
import { SetupService } from "../src/setup-service.js";
import { PeerAuth } from "../src/stores.js";

const temp = () => mkdtempSync(join(tmpdir(), "agent-regression-"));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("API keys stay bound to their configured origin", async () => {
  const fakeKey = "review-only-fake-key-1234567890";
  let destination = "",
    authorization = "";
  const mockFetch: typeof fetch = async (url, init) => {
    destination = String(url);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  const remote = new RemoteModel(
    join(temp(), "remote.json"),
    resourcePaths().templates,
    mockFetch,
  );
  remote.save({ base_url: "https://original.example", api_key: fakeKey });
  remote.save({ model: "deepseek-v4-pro" });
  assert.equal(remote.public().base_url, "https://original.example");
  assert.throws(() =>
    remote.save({ base_url: "https://different.example", api_key: "" }),
  );
  await remote.chat([{ role: "user", content: "test" }]);
  assert.equal(destination, "https://original.example/chat/completions");
  assert.equal(authorization, "Bearer " + fakeKey);
  remote.save({
    base_url: "https://different.example",
    api_key: "new-test-key-123456789012345",
  });
  await remote.chat([{ role: "user", content: "test" }]);
  assert.equal(destination, "https://different.example/chat/completions");
  assert.equal(authorization, "Bearer new-test-key-123456789012345");
});

test(
  "whole-plan occupancy rejects concurrent plans and manual input",
  { timeout: 5000 },
  async (t) => {
    const adapter = new SimulatedHid();
    const hid = new HidController(adapter, "simulated");
    const entered = gate(),
      resume = gate();
    let blockVerification = false,
      blocked = false;
    const agent = new AgentCoordinator(
      hid,
      async () => {
        if (blockVerification && !blocked) {
          blocked = true;
          entered.release();
          await resume.promise;
        }
        return {};
      },
      new AuditLog(join(temp(), "audit")),
    );
    t.after(async () => {
      resume.release();
      await hid.close();
    });
    const first = await agent.create({
      objective: "plan A",
      actions: [
        { type: "key_tap", key: "a" },
        { type: "key_tap", key: "b" },
      ],
    });
    const second = await agent.create({
      objective: "plan B",
      actions: [{ type: "key_tap", key: "x" }],
    });
    agent.approve(first);
    agent.approve(second);
    blockVerification = true;
    const execution = agent.execute({ plan_id: first.plan_id });
    await entered.promise;
    await assert.rejects(
      agent.execute({ plan_id: second.plan_id }),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    assert.throws(
      () => hid.tap({ key: "x" }),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    resume.release();
    await execution;
    await agent.execute({ plan_id: second.plan_id });
    assert.deepEqual(
      adapter.events.filter((e) => e.kind === "key_down").map((e) => e.key),
      ["a", "b", "x"],
    );
  },
);

test(
  "emergency stop during final verification prevents a successful final status",
  { timeout: 5000 },
  async (t) => {
    const hid = new HidController(new SimulatedHid(), "simulated");
    const entered = gate(),
      resume = gate();
    let block = false;
    const audit = new AuditLog(join(temp(), "audit"));
    const agent = new AgentCoordinator(
      hid,
      async () => {
        if (block) {
          entered.release();
          await resume.promise;
        }
        return {};
      },
      audit,
    );
    t.after(async () => {
      resume.release();
      await hid.close();
    });
    const plan = await agent.create({
      objective: "tap",
      actions: [{ type: "key_tap", key: "a" }],
    });
    agent.approve(plan);
    block = true;
    const execution = assert.rejects(
      agent.execute({ plan_id: plan.plan_id }),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    await entered.promise;
    await agent.stop();
    resume.release();
    await execution;
    assert.ok(
      !audit.recent().some((e) => e.event === "plan_execution_completed"),
    );
    assert.ok(audit.recent().some((e) => e.event === "plan_execution_stopped"));
    assert.equal(hid.status().state, "stopped");
  },
);

test("session revisions reject stale updates and preserve newer messages on disk", () => {
  const path = join(temp(), "sessions.json");
  const sessions = new SessionStore(path);
  const session = { id: "same-session", title: "test", createdAt: 1 };
  sessions.upsert({
    ...session,
    updatedAt: 200,
    messages: [{ role: "user", content: "new message" }],
  });
  assert.throws(
    () => sessions.upsert({ ...session, updatedAt: 100, messages: [] }),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
  const restored = new SessionStore(path).list()[0];
  assert.equal(restored.updatedAt, 200);
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.revision, 1);
  assert.equal(
    sessions.upsert({
      ...session,
      updatedAt: 200,
      messages: [{ role: "user", content: "new message" }],
    }).revision,
    1,
  );
  assert.equal(sessions.upsert({ ...restored, title: "renamed" }).revision, 2);
});

test("HTTP persists a UTF-8 conversation larger than 64 KB", async (t) => {
  const app = createKvmServer({ dataDir: temp(), hidBackend: "simulated" });
  t.after(() => app.close());
  const { port } = await app.listen(0);
  const session = {
    id: "long-session",
    title: "test",
    updatedAt: 200,
    messages: Array.from({ length: 30 }, () => ({
      role: "assistant",
      content: "测".repeat(800),
    })),
  };
  assert.equal(sessionSchema.safeParse(session).success, true);
  const body = JSON.stringify({ session });
  assert.ok(Buffer.byteLength(body) > 65536);
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(app.sessions.list()[0].messages.length, 30);
});

test("setup progress is monotonic and completed tasks cannot launch again", () => {
  const setup = new ModelSetupStore(
    join(temp(), "setup.json"),
    join(resourcePaths().templates, "pc_agent_install.ps1"),
  );
  const task = setup.create({
    model: "qwen3.5:4b",
    install_dir: "C:\\Agent\\Runtime",
    models_dir: "C:\\Agent\\Models",
  });
  setup.starting(task.task_id);
  setup.update({
    task_id: task.task_id,
    status: "verifying",
    progress: 94,
    message: "verify",
  });
  assert.throws(() =>
    setup.update({
      task_id: task.task_id,
      status: "downloading_runtime",
      progress: 8,
      message: "old",
    }),
  );
  setup.update({
    task_id: task.task_id,
    status: "completed",
    progress: 100,
    message: "done",
  });
  assert.throws(
    () => setup.starting(task.task_id),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
  assert.throws(() =>
    setup.update({
      task_id: task.task_id,
      status: "failed",
      progress: 2,
      message: "old",
    }),
  );
  assert.equal(setup.get(task.task_id).status, "completed");
});

test("setup claims before input, preserves fast progress, rejects duplicate launch and old attempts", async () => {
  const root = temp();
  const setup = new ModelSetupStore(
    join(root, "setup.json"),
    join(resourcePaths().templates, "pc_agent_install.ps1"),
  );
  const task = setup.create({
    model: "qwen3.5:4b",
    install_dir: "C:\\Agent\\Runtime",
    models_dir: "C:\\Agent\\Models",
  });
  const adapter = new SimulatedHid();
  class FastHid extends HidController {
    override async typeText(text: unknown) {
      return super.typeText(text, 0);
    }
    override async tap(payload: unknown) {
      const result = await super.tap(payload);
      if (result.key === "enter")
        setup.update({
          task_id: task.task_id,
          status: "verifying",
          progress: 94,
          message: "fast PC",
        });
      return result;
    }
  }
  const hid = new FastHid(adapter, "simulated");
  const peer = new PeerAuth(join(root, "token"));
  writeFileSync(peer.path, "test-token-12345678901234567890");
  const service = new SetupService(
    setup,
    hid,
    peer,
    new AuditLog(join(root, "audit")),
  );
  try {
    const launch = service.launch(task.task_id, "http://127.0.0.1:8766");
    await assert.rejects(
      service.launch(task.task_id, "http://127.0.0.1:8766"),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    assert.equal((await launch).status, "verifying");
    const count = adapter.events.length;
    await assert.rejects(
      service.launch(task.task_id, "http://127.0.0.1:8766"),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    assert.equal(adapter.events.length, count);
    setup.update({
      task_id: task.task_id,
      status: "completed",
      progress: 100,
      message: "done",
    });
    assert.throws(() =>
      setup.update({
        task_id: task.task_id,
        status: "downloading_model",
        progress: 40,
        message: "late",
      }),
    );
  } finally {
    await hid.close();
  }
});

test("setup preflight failure sends no keys and can be cancelled before a fresh attempt", async () => {
  const root = temp();
  const setup = new ModelSetupStore(
    join(root, "setup.json"),
    join(resourcePaths().templates, "pc_agent_install.ps1"),
  );
  const params = {
    model: "qwen3.5:4b",
    install_dir: "C:\\Agent\\Runtime",
    models_dir: "C:\\Agent\\Models",
  };
  const task = setup.create(params);
  const adapter = new SimulatedHid(),
    hid = new HidController(adapter, "simulated");
  const service = new SetupService(
    setup,
    hid,
    new PeerAuth(join(root, "missing-token")),
    new AuditLog(join(root, "audit")),
  );
  await assert.rejects(service.launch(task.task_id, "http://127.0.0.1:8766"));
  assert.equal(adapter.events.filter((e) => e.kind === "key_down").length, 0);
  assert.equal(setup.get(task.task_id).status, "failed");
  setup.cancel(task.task_id);
  const fresh = setup.create(params);
  assert.notEqual(fresh.task_id, task.task_id);
  assert.throws(() =>
    setup.update({
      task_id: task.task_id,
      status: "completed",
      progress: 100,
      message: "old script",
    }),
  );
  assert.equal(setup.get(fresh.task_id).status, "awaiting_start");
  await hid.close();
});

test("audit rotation keeps recent events in order across the file boundary", () => {
  const log = new AuditLog(join(temp(), "audit.jsonl"), 600);
  for (let i = 0; i < 12; i++) log.record("test", { index: i });
  const recent = log.recent(4);
  assert.deepEqual(
    recent.map((e) => e.index),
    [8, 9, 10, 11],
  );
});

test("HTTP distinguishes conflicts, unavailable dependencies and internal errors", () => {
  assert.equal(httpFailure(new ApiError("busy", 409)).status, 409);
  assert.equal(
    httpFailure(Object.assign(new Error("device detail"), { code: "ENODEV" }))
      .status,
    503,
  );
  const internal = httpFailure(new Error("private implementation detail"));
  assert.equal(internal.status, 500);
  assert.ok(!internal.error.includes("private implementation detail"));
});
