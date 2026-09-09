import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createKvmServer, POST_ROUTES, resourcePaths } from "../src/server.js";
import { RemoteModel, validBaseUrl } from "../src/remote-model.js";
import { delay } from "../src/common.js";
import { SimulatedHid } from "../src/hid.js";

// Frozen expectations from the legacy commit, independent of current TS assets/routes.
const baseline: {
  assetSha256: Record<string, string>;
  postRoutes: string[];
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/python-baseline.json", import.meta.url),
    "utf8",
  ),
);

const temp = () => mkdtempSync(join(tmpdir(), "agent-kvm-api-"));
const setup = async (remote?: RemoteModel) => {
  const app = createKvmServer({
    dataDir: temp(),
    hidBackend: "simulated",
    remote,
  });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const post = (
    path: string,
    payload: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  return { app, base, post };
};
test("HTTP preserves original assets, routes, status fields and real multipart JPEG stream", async (t) => {
  const { app, base, post } = await setup();
  t.after(() => app.close());
  assert.equal(Object.keys(baseline.assetSha256).length, 5);
  for (const [path, expectedHash] of Object.entries(baseline.assetSha256)) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200);
    const actualHash = createHash("sha256")
      .update(Buffer.from(await r.arrayBuffer()))
      .digest("hex");
    assert.equal(actualHash, expectedHash, path);
  }
  const status = await (await fetch(base + "/api/status")).json();
  assert.equal(status.source.backend, "synthetic");
  assert.equal(status.hid.backend, "simulated");
  assert.equal(status.hid.enabled, true);
  assert.equal(status.hardware_validation.typescript_rdk_x5, "unverified");
  assert.equal(status.remote_model.configured, false);
  const shot = await fetch(base + "/api/video/snapshot.jpg");
  assert.equal(shot.headers.get("x-frame-sha256")?.length, 64);
  assert.equal(
    (await sharp(Buffer.from(await shot.arrayBuffer())).metadata()).width,
    1280,
  );
  const abort = new AbortController();
  const stream = await fetch(base + "/api/stream.mjpg", {
    signal: abort.signal,
  });
  assert.ok(stream.headers.get("content-type")?.includes("boundary=frame"));
  const reader = stream.body!.getReader();
  const { value } = await reader.read();
  assert.ok(
    Buffer.from(value!).includes(Buffer.from("Content-Type: image/jpeg")),
  );
  abort.abort();
  await reader.cancel().catch(() => {});
  await delay(50);
  assert.equal((await post("/api/video/pause")).status, 200);
  assert.equal(
    (await post("/api/video-settings", { width: 1280, height: 720, fps: 30 }))
      .status,
    200,
  );
  assert.equal(
    (await post("/api/video-settings", { width: 1920, height: 1080, fps: 60 }))
      .status,
    400,
  );
  assert.equal((await fetch(base + "/missing")).status, 404);
});
test("HTTP control rejects cross-origin POST/DELETE, malformed bodies, unknown keys and large payloads", async (t) => {
  const { app, base, post } = await setup();
  t.after(() => app.close());
  assert.equal(
    (
      await post(
        "/api/hid/key",
        { key: "a" },
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/hid/key", { key: "a" }, { Origin: "null" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/agent/sessions/a", {
        method: "DELETE",
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/hid/key", { key: "a" }, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await post("/api/hid/key", [])).status, 400);
  assert.equal(
    (
      await fetch(base + "/api/hid/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("/api/hid/key", { key: "a", extra: "x".repeat(5000) })).status,
    400,
  );
  assert.equal(
    (await post("/api/hid/key", { key: "constructor" })).status,
    400,
  );
  assert.equal((app.hid.adapter as SimulatedHid).events.length, 0);
  assert.equal(
    (await post("/api/hid/key", { key: "a" }, { Origin: base })).status,
    200,
  );
  assert.equal((app.hid.adapter as SimulatedHid).keys.size, 0);
});
test("HTTP Agent approval, reject, audit, emergency stop and single-use execution", async (t) => {
  const { app, base, post } = await setup();
  t.after(() => app.close());
  const plan = (
    await (await post("/api/agent/plans", { objective: "按下回车" })).json()
  ).plan;
  assert.equal(
    (await post("/api/agent/execute", { plan_id: plan.plan_id })).status,
    409,
  );
  assert.equal(
    (await post("/api/agent/approve", { plan_id: plan.plan_id, digest: "bad" }))
      .status,
    409,
  );
  assert.equal(
    (
      await post("/api/agent/approve", {
        plan_id: plan.plan_id,
        digest: plan.digest,
      })
    ).status,
    200,
  );
  const results = await Promise.all([
    post("/api/agent/execute", { plan_id: plan.plan_id }),
    post("/api/agent/execute", { plan_id: plan.plan_id }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const rejected = (
    await (await post("/api/agent/plans", { objective: "按下win" })).json()
  ).plan;
  await post("/api/agent/reject", { plan_id: rejected.plan_id });
  assert.equal(
    (await post("/api/agent/execute", { plan_id: rejected.plan_id })).status,
    409,
  );
  const events = (await (await fetch(base + "/api/agent/audit")).json()).events;
  assert.ok(events.some((e: { event: string }) => e.event === "plan_approved"));
  await post("/api/hid/emergency-stop");
  assert.equal((await post("/api/hid/key", { key: "a" })).status, 400);
  await post("/api/hid/arm");
  assert.equal((await post("/api/hid/key", { key: "a" })).status, 200);
});
test("PC pairing, bootstrap secret status, installation flow simulation and session tombstones", async (t) => {
  const { app, base, post } = await setup();
  t.after(() => app.close());
  writeFileSync(app.peer.path, "t".repeat(32));
  const headers = { Authorization: "Bearer " + "t".repeat(32) };
  const host = {
    schema_version: 1,
    collected_at: "now",
    hostname: "Windows test",
    os: { name: "Windows 11" },
  };
  assert.equal((await post("/api/host-info", host)).status, 401);
  assert.equal((await post("/api/host-info", host, headers)).status, 200);
  assert.equal(
    (
      await post(
        "/api/pc-agent/suggestions",
        { objective: "test", summary: "read only" },
        headers,
      )
    ).status,
    200,
  );
  const task = (
    await (
      await post("/api/model-setup/tasks", {
        model: "qwen3.5:4b",
        install_dir: "C:\\AgentIPKVM\\Runtime",
        models_dir: "C:\\AgentIPKVM\\Models",
      })
    ).json()
  ).task;
  assert.ok(!JSON.stringify(task).includes("secret"));
  assert.equal(
    (await fetch(base + `/api/model-setup/bootstrap/${task.task_id}/wrong.ps1`))
      .status,
    404,
  );
  const script = await (
    await fetch(base + app.setup.bootstrapPath(task.task_id))
  ).text();
  assert.ok(script.includes("$Model = 'qwen3.5:4b'"));
  assert.equal(
    (await post("/api/model-setup/launch", { task_id: task.task_id })).status,
    200,
  );
  assert.equal(app.setup.get(task.task_id).status, "starting");
  assert.equal(
    (
      await post(
        "/api/model-setup/progress",
        {
          task_id: task.task_id,
          status: "completed",
          progress: 100,
          message: "done",
        },
        headers,
      )
    ).status,
    200,
  );
  assert.equal((app.hid.adapter as SimulatedHid).keys.size, 0);
  const session = {
    id: "session",
    title: "test",
    messages: [{ role: "user", content: "hello" }],
  };
  assert.equal((await post("/api/agent/sessions", { session })).status, 200);
  assert.equal(
    (await fetch(base + "/api/agent/sessions/session", { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await post("/api/agent/sessions", { session })).status, 400);
  assert.ok(
    (
      await (await fetch(base + "/api/agent/sessions")).json()
    ).deleted_session_ids.includes("session"),
  );
});
function fakeRemote(responses: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (!responses.length) throw new Error("unexpected remote call");
    return new Response(JSON.stringify(responses.shift()), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const remote = new RemoteModel(
    join(temp(), "remote.json"),
    resourcePaths().templates,
    fetcher,
  );
  remote.save({ api_key: "k".repeat(32) });
  return { remote, requests };
}
const response = (content: string | null, calls: unknown[] = []) => ({
  choices: [{ message: { role: "assistant", content, tool_calls: calls } }],
  model: "deepseek-v4-flash",
});
const call = (name: string, args: unknown, id = "call-1") => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
test("remote config validates URLs, preserves keys and never exposes secrets", async () => {
  for (const url of [
    "http://example.com",
    "http://10.attacker.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?secret=1",
  ])
    assert.equal(validBaseUrl(url), false, url);
  for (const url of [
    "https://api.deepseek.com",
    "http://127.0.0.1:8000",
    "http://192.168.1.2:1234",
  ])
    assert.equal(validBaseUrl(url), true, url);
  const { remote } = fakeRemote([response("OK")]);
  assert.ok(!JSON.stringify(remote.public()).includes("k".repeat(32)));
  remote.save({ model: "deepseek-v4-pro" });
  assert.equal(remote.public().model, "deepseek-v4-pro");
  assert.equal(
    (await remote.chat([{ role: "user", content: "test" }])).content,
    "OK",
  );
  assert.throws(() => remote.save({ model: "anything" }));
  assert.throws(() => remote.save({ base_url: "http://example.com" }));
});
test("remote Agent tool proposal returns approval immediately and cannot directly send input", async (t) => {
  const { remote, requests } = fakeRemote([
    response(null, [
      call("propose_hid_actions", {
        objective: "按下回车",
        actions: [{ type: "key_tap", key: "enter" }],
      }),
    ]),
  ]);
  const { app, post } = await setup(remote);
  t.after(() => app.close());
  const r = await post("/api/agent/chat", {
    messages: [{ role: "user", content: "按下回车" }],
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.plans[0].status, "pending_approval");
  assert.equal(requests.length, 1);
  assert.equal((app.hid.adapter as SimulatedHid).events.length, 0);
  assert.equal((requests[0].tools as unknown[]).length, 4);
});
test("remote Agent reads actual host cache and single JPEG vision through tools", async (t) => {
  const { remote, requests } = fakeRemote([
    response(null, [
      call("get_controlled_host_info", {}),
      call("capture_screen", { purpose: "read screen" }, "call-2"),
    ]),
    {
      choices: [
        {
          message: {
            content: JSON.stringify({
              screen_type: "application",
              summary: "test screen",
              confidence: 0.9,
            }),
          },
        },
      ],
      model: "deepseek-v4-flash-vision-exp",
    },
    response("test result"),
  ]);
  const { app, post } = await setup(remote);
  t.after(() => app.close());
  app.host.update({
    schema_version: 1,
    collected_at: "now",
    hostname: "real cached host",
    os: { name: "Windows" },
  });
  const result = await (
    await post("/api/agent/chat", {
      messages: [{ role: "user", content: "看一下" }],
    })
  ).json();
  assert.equal(result.response.content, "test result");
  assert.equal(result.tool_events.length, 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].model, "deepseek-v4-flash-vision-exp");
  assert.ok(
    JSON.stringify(requests[1]).includes("data:image/jpeg;base64,/9j/"),
  );
  assert.ok(JSON.stringify(requests[2]).includes("real cached host"));
});
test("remote unknown tools and malformed arguments return errors without input; background jobs deduplicate", async (t) => {
  const { remote, requests } = fakeRemote([
    response(null, [call("execute_shell", { command: "bad" })]),
    response("cannot do that"),
  ]);
  const { app, base, post } = await setup(remote);
  t.after(() => app.close());
  const request = {
    request_id: "same",
    messages: [{ role: "user", content: "test" }],
  };
  const a = (await (await post("/api/agent/chat/jobs", request)).json()).job;
  const b = (await (await post("/api/agent/chat/jobs", request)).json()).job;
  assert.equal(a.job_id, b.job_id);
  let job;
  for (let i = 0; i < 50; i++) {
    job = (
      await (await fetch(base + "/api/agent/chat/jobs/" + a.job_id)).json()
    ).job;
    if (job.status === "completed") break;
    await delay(10);
  }
  assert.equal(job.status, "completed");
  assert.equal(job.result.tool_events[0].ok, false);
  assert.equal(requests.length, 2);
  assert.equal((app.hid.adapter as SimulatedHid).events.length, 0);
});
test("every original POST endpoint exists and rejects unsupported operations with structured errors", async (t) => {
  const { app, post } = await setup();
  t.after(() => app.close());
  const paths = baseline.postRoutes;
  assert.ok(paths.length >= 22);
  for (const path of paths) {
    assert.ok(POST_ROUTES.includes(path), path);
    const r = await post(path, {});
    assert.notEqual(r.status, 404, path);
    assert.ok(r.headers.get("content-type")?.includes("application/json"));
  }
});
