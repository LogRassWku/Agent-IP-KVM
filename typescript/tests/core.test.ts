import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { delay } from "../src/common.js";
import { AgentCoordinator } from "../src/agent.js";
import {
  HidController,
  LinuxGadgetHid,
  SimulatedHid,
  type ReportWriter,
} from "../src/hid.js";
import {
  AuditLog,
  HostStore,
  JobStore,
  PeerAuth,
  SessionStore,
  SuggestionStore,
  hostSchema,
} from "../src/stores.js";
import {
  JpegParser,
  SyntheticSource,
  VideoController,
  parseProbe,
  type VideoConfig,
  EndOfStream,
  type VideoSource,
} from "../src/video.js";
import {
  compositePlan,
  parseDeviceInfo,
  parseFormats,
  probeHid,
  recoveryBundle,
} from "../src/linux.js";
import { ModelSetupStore } from "../src/model-setup.js";
import { resourcePaths } from "../src/server.js";

const temp = () => mkdtempSync(join(tmpdir(), "agent-kvm-ts-"));
const config: VideoConfig = {
  source: "synthetic",
  device: "/dev/video0",
  width: 1280,
  height: 720,
  fps: 30,
};
test("synthetic source lifecycle, exact Python color bars, sequential complete frames", async () => {
  const s = new SyntheticSource(false);
  await assert.rejects(s.nextFrame());
  const mode = await s.open();
  assert.deepEqual(mode, {
    width: 1280,
    height: 720,
    fps: 30,
    pixel_format: "RGB24",
  });
  await s.start();
  const a = await s.nextFrame(),
    b = await s.nextFrame();
  assert.equal(a.data.length, 1280 * 720 * 3);
  assert.equal(a.sequence, 0);
  assert.equal(b.sequence, 1);
  assert.deepEqual([...a.data.subarray(160 * 3, 160 * 3 + 3)], [255, 255, 0]);
  assert.deepEqual([...a.data.subarray(-3)], [0, 0, 0]);
  await s.close();
  assert.equal(s.health, "closed");
  await assert.rejects(s.nextFrame());
});
test("snapshot decodes to 720p JPEG, closes on-demand source and pause supports reconnect", async () => {
  const video = new VideoController(config);
  const shot = await video.snapshot();
  assert.equal(shot.metadata.on_demand, true);
  assert.equal(shot.metadata.sha256.length, 64);
  const image = await sharp(shot.jpeg).metadata();
  assert.equal(image.width, 1280);
  assert.equal(image.height, 720);
  assert.equal(video.status().state, "idle");
  const first = await new Promise<number>((resolve) => {
    video.subscribe((s) => {
      if (s) resolve(s.metadata.sequence);
    });
  });
  assert.equal(first, 0);
  await video.pause();
  assert.equal(video.status().sequence, null);
  const next = await video.snapshot();
  assert.equal(next.metadata.on_demand, true);
  await new Promise<void>((resolve) =>
    video.subscribe((s) => {
      if (s) resolve();
    }),
  );
  await video.close();
  assert.equal(video.status().state, "stopped");
});
test("shared stream opens one source, terminates cleanly at EOF and encodes no MJPEG twice", async () => {
  let opens = 0;
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const factory = (): VideoSource => {
    let seq = 0;
    return {
      sourceId: "test:file",
      health: "closed",
      async capabilities() {
        return [{ width: 8, height: 8, fps: 30, pixel_format: "MJPEG" }];
      },
      async open() {
        opens++;
        return (await this.capabilities())[0];
      },
      async start() {},
      async nextFrame() {
        await delay(10);
        if (seq === 2) throw new EndOfStream("end of stream");
        return {
          width: 8,
          height: 8,
          pixel_format: "MJPEG",
          data: jpeg,
          sequence: seq++,
          timestamp_ns: 1,
        };
      },
      async close() {},
    };
  };
  const v = new VideoController(config, factory);
  const frames: Buffer[] = [];
  await Promise.all([
    new Promise<void>((r) =>
      v.subscribe((s) => (s ? frames.push(s.jpeg) : r())),
    ),
    new Promise<void>((r) =>
      v.subscribe((s) => {
        if (!s) r();
      }),
    ),
  ]);
  assert.equal(opens, 1);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], jpeg);
  assert.equal(v.status().state, "ended");
  await v.close();
});
test(
  "a viewer arriving during last-viewer cleanup receives a new stream",
  { timeout: 5000 },
  async (t) => {
    let releaseClose!: () => void;
    let closingStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      closingStarted = resolve;
    });
    let sources = 0;
    class SlowClosingSource extends SyntheticSource {
      private firstClose = true;
      override async close() {
        await super.close();
        if (this.firstClose) {
          this.firstClose = false;
          closingStarted();
          await closeGate;
        }
      }
    }
    const video = new VideoController(config, () =>
      sources++ === 0 ? new SlowClosingSource() : new SyntheticSource(),
    );
    t.after(async () => {
      releaseClose();
      await video.close();
    });
    let unsubscribe!: () => void;
    await new Promise<void>((resolve) => {
      unsubscribe = video.subscribe((frame) => {
        if (frame) resolve();
      });
    });
    unsubscribe();
    await closing;
    const reconnected = new Promise<boolean>((resolve) => {
      video.subscribe((frame) => resolve(Boolean(frame)));
    });
    releaseClose();
    assert.equal(
      await reconnected,
      true,
      "cleanup must not end the incoming viewer's response",
    );
    assert.equal(sources, 2);
  },
);

test("a subscription cancelled before registration never starts capture", async () => {
  let sources = 0;
  const video = new VideoController(config, () => {
    sources++;
    return new SyntheticSource();
  });
  let callbacks = 0;
  video.subscribe(() => {
    callbacks++;
  })();
  // Flush pending registration and cleanup through the controller's lock.
  await video.pause();
  assert.equal(sources, 0);
  assert.equal(callbacks, 0);
  await video.close();
});
test("MJPEG parser accepts arbitrarily split markers and multiple frames", () => {
  const p = new JpegParser();
  assert.deepEqual(p.push(Buffer.from([0, 255])), []);
  assert.deepEqual(p.push(Buffer.from([216, 1, 255])), []);
  const frames = p.push(Buffer.from([217, 255, 216, 2, 255, 217]));
  assert.deepEqual(frames, [
    Buffer.from([255, 216, 1, 255, 217]),
    Buffer.from([255, 216, 2, 255, 217]),
  ]);
});
test("ffprobe validates rational rates and rejects invalid tracks", () => {
  assert.equal(
    parseProbe(
      JSON.stringify({
        streams: [{ width: 320, height: 240, avg_frame_rate: "30000/1001" }],
      }),
    ).fps,
    30000 / 1001,
  );
  for (const rate of ["0/0", "1/0", "-30/1"])
    assert.throws(() =>
      parseProbe(
        JSON.stringify({
          streams: [{ width: 320, height: 240, avg_frame_rate: rate }],
        }),
      ),
    );
  assert.throws(() => parseProbe('{"streams":[]}'));
});
test("HID validates all input before output; taps modifiers, ASCII, relative splitting and absolute bounds", async () => {
  const a = new SimulatedHid(),
    h = new HidController(a, "simulated");
  assert.throws(() => h.tap({ key: "shell" }));
  assert.throws(() => h.tap({ key: "a", modifiers: ["ctrl", "ctrl"] }));
  assert.throws(() => h.typeText("中文"));
  assert.equal(a.events.length, 0);
  await h.tap({ key: "a", modifiers: ["ctrl"] });
  assert.equal(a.keys.size, 0);
  await h.tap({ key: "win" });
  await h.typeText('A !"\\{}?', 0);
  assert.equal(a.keys.size, 0);
  await h.move({ delta_x: 300, delta_y: -300, wheel: -1 });
  const moves = a.events.filter((e) => e.kind === "mouse_move");
  assert.deepEqual(
    moves.map((e) => e.delta_x),
    [127, 127, 46, 0],
  );
  await h.position({ x: 32767, y: 0 });
  await h.click({ button: "right", x: 12, y: 25 });
  assert.equal(a.buttons.size, 0);
  for (const v of [true, -1, 32768, 0.5])
    assert.throws(() => h.position({ x: v, y: 0 }));
  await h.close();
});
test("emergency stop interrupts text and blocks rearming through normal input", async () => {
  const a = new SimulatedHid(),
    h = new HidController(a, "simulated");
  const typing = h.typeText("abcdefghijklmnop", 10);
  const failure = assert.rejects(typing, /emergency stop/);
  await delay(20);
  await h.emergencyStop();
  await failure;
  assert.equal(a.keys.size, 0);
  await assert.rejects(h.tap({ key: "a" }), /emergency stop/);
  await h.arm();
  await h.tap({ key: "a" });
  await h.close();
});
test("Linux reports match boot keyboard, relative mouse and absolute pointer protocols", async () => {
  const reports: Record<string, Buffer[]> = { k: [], m: [], p: [] };
  const factory = async (path: string): Promise<ReportWriter> => ({
    async write(r) {
      reports[path].push(Buffer.from(r));
    },
    async close() {},
  });
  const a = new LinuxGadgetHid(
    { keyboard: "k", mouse: "m", pointer: "p" },
    factory,
  );
  await a.arm();
  await a.keyDown("ctrl");
  await a.keyDown("a");
  assert.deepEqual([...reports.k.at(-1)!], [1, 0, 4, 0, 0, 0, 0, 0]);
  await a.move(-127, 127, -1);
  assert.deepEqual([...reports.m.at(-1)!], [0, 129, 127, 255]);
  await a.position(32767, 256, -1);
  assert.deepEqual([...reports.p.at(-1)!], [0, 255, 127, 0, 1, 255]);
  await a.buttonDown("left");
  await a.release();
  assert.deepEqual([...reports.k.at(-1)!], Array(8).fill(0));
  assert.deepEqual([...reports.m.at(-1)!], Array(4).fill(0));
  assert.equal(reports.p.at(-1)![0], 0);
  await a.close();
});
test("Linux release attempts every endpoint after write failure and closes handles", async () => {
  const writes: string[] = [];
  const closes: string[] = [];
  let fail = false;
  const a = new LinuxGadgetHid({ keyboard: "k", mouse: "m" }, async (path) => ({
    async write() {
      writes.push(path);
      if (path === "k" && fail) throw new Error("disconnected");
    },
    async close() {
      closes.push(path);
    },
  }));
  await a.arm();
  fail = true;
  await assert.rejects(a.close(), /release/);
  assert.equal(writes.at(-1), "m");
  assert.deepEqual(closes.sort(), ["k", "m"]);
  assert.equal(a.state, "closed");
});
test("Agent approvals bind digest, reject replay, elevate risk, and verify after input", async () => {
  const root = temp(),
    a = new SimulatedHid(),
    h = new HidController(a, "simulated");
  let observations = 0;
  const agent = new AgentCoordinator(
    h,
    async () => ({ frame: { sha256: "a".repeat(64) }, count: ++observations }),
    new AuditLog(join(root, "audit")),
  );
  const read = await agent.create({ objective: "看看画面" });
  assert.equal(read.approval_required, false);
  await agent.execute({ plan_id: read.plan_id });
  const plan = await agent.create({ objective: "按下回车" });
  assert.equal(plan.status, "pending_approval");
  await assert.rejects(agent.execute({ plan_id: plan.plan_id }), /status/);
  assert.equal(a.events.length, 0);
  assert.throws(
    () => agent.approve({ plan_id: plan.plan_id, digest: "bad" }),
    /digest/,
  );
  agent.approve({ plan_id: plan.plan_id, digest: plan.digest });
  const done = await agent.execute({ plan_id: plan.plan_id });
  assert.equal(done.status, "completed");
  assert.ok(done.result[0].verification);
  await assert.rejects(agent.execute({ plan_id: plan.plan_id }), /status/);
  assert.equal((await agent.create({ objective: "BIOS 重启" })).risk, "high");
  assert.equal(
    (await agent.create({ objective: "刷写固件" })).risk,
    "critical",
  );
  await assert.rejects(
    agent.create({
      objective: "bad",
      actions: [{ type: "shell", command: "whoami" }],
    }),
  );
  await h.close();
});
test("Agent expires approvals, prevents mutation of stored actions and releases after failure", async () => {
  const h = new HidController(new SimulatedHid(), "simulated"),
    audit = new AuditLog(join(temp(), "audit"));
  const a = new AgentCoordinator(h, async () => ({}), audit, 1);
  const p = await a.create({ objective: "按下回车" });
  p.actions[0] = { type: "type_text", text: "bad" };
  await delay(5);
  assert.throws(
    () => a.approve({ plan_id: p.plan_id, digest: p.digest }),
    /expired/,
  );
  const agent = new AgentCoordinator(
    h,
    async () => {
      throw new Error("no signal");
    },
    audit,
  );
  const read = await agent.create({ objective: "observe" });
  await assert.rejects(agent.execute({ plan_id: read.plan_id }), /no signal/);
  assert.equal((h.adapter as SimulatedHid).keys.size, 0);
});
test("host inventory schema matches nested disks and partitions; rejects booleans as integers", () => {
  const store = new HostStore(join(temp(), "host.json"));
  const host = {
    schema_version: 1,
    collected_at: "2026-09-08",
    hostname: "test",
    os: { name: "Windows" },
    disks: [
      {
        model: "NVMe",
        partitions: [{ number: 1, is_boot: true, size_bytes: 1024 }],
      },
    ],
  };
  const saved = store.update(host);
  assert.equal(saved.data?.disks[0].partitions[0].is_boot, true);
  assert.equal(saved.data?.bios.secure_boot, null);
  assert.throws(() =>
    hostSchema.parse({ ...host, cpu: { physical_cores: true } }),
  );
  assert.throws(() =>
    hostSchema.parse({ ...host, gpus: Array(33).fill({ name: "GPU" }) }),
  );
  writeFileSync(store.path, "broken");
  assert.equal(store.status().status, "error");
});
test("pairing and PC suggestions cannot grant input or expose token", () => {
  const root = temp();
  const auth = new PeerAuth(join(root, "token"));
  assert.throws(() => auth.require("Bearer test"));
  writeFileSync(auth.path, "p".repeat(32));
  assert.equal(auth.enabled, true);
  assert.throws(() => auth.require("Bearer wrong"));
  auth.require("Bearer " + "p".repeat(32));
  const s = new SuggestionStore(join(root, "s.json"));
  const result = s.update({
    objective: "test",
    summary: "read only",
    actions: [{ type: "shell" }],
  });
  assert.equal("actions" in result, false);
});
test("sessions survive reload and tombstones prevent resurrection; unknown metadata stripped", () => {
  const path = join(temp(), "sessions.json");
  const s = new SessionStore(path);
  s.upsert({
    id: "one",
    title: " Test ",
    updatedAt: 10,
    messages: [
      {
        role: "assistant",
        content: "ok",
        plan: { status: "pending_approval" },
        secret: "bad",
      },
    ],
  });
  const next = new SessionStore(path);
  assert.equal(next.list()[0].title, "Test");
  assert.equal("secret" in next.list()[0].messages[0], false);
  next.delete("one");
  assert.throws(
    () => next.upsert({ id: "one", title: "old", messages: [] }),
    /deleted/,
  );
  assert.deepEqual(new SessionStore(path).deletedIds(), ["one"]);
  assert.equal(new SessionStore(path).list().length, 0);
});
test("jobs deduplicate request IDs and keep result for reconnect, failures are bounded", async () => {
  const j = new JobStore();
  let calls = 0;
  const one = j.create("request", async () => {
    calls++;
    await delay(10);
    return { ok: true };
  });
  assert.equal(
    j.create("request", async () => {
      throw new Error("must not run");
    }).job_id,
    one.job_id,
  );
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(j.get(one.job_id).status, "completed");
  const bad = j.create("bad", async () => {
    throw new Error("x".repeat(2000));
  });
  await delay(5);
  assert.equal(j.get(bad.job_id).error?.length, 1000);
  assert.throws(() => j.get("missing"));
});
test("setup persists tasks, keeps secrets private and quotes bootstrap without BOM", () => {
  const root = temp();
  const s = new ModelSetupStore(
    join(root, "setup.json"),
    join(resourcePaths().templates, "pc_agent_install.ps1"),
  );
  const p = {
    model: "qwen3.5:9b",
    install_dir: "C:\\AgentIPKVM\\Runtime",
    models_dir: "D:\\AgentIPKVM\\Models",
  };
  const t = s.create(p);
  assert.equal("secret" in t, false);
  const path = s.bootstrapPath(t.task_id);
  const secret = path.split("/").at(-1)!.slice(0, -4);
  assert.throws(() =>
    s.bootstrap(t.task_id, "bad", "http://localhost", "token"),
  );
  const script = s.bootstrap(
    t.task_id,
    secret,
    "http://localhost",
    "token'quoted",
  );
  assert.ok(script.includes("'token''quoted'"));
  assert.equal(script.charCodeAt(0) === 0xfeff, false);
  assert.ok(!script.includes("__MODEL__"));
  s.starting(t.task_id);
  assert.equal(
    s.update({
      task_id: t.task_id,
      status: "completed",
      progress: 100,
      message: "done",
    }).status,
    "completed",
  );
  assert.throws(() => s.create({ ...p, install_dir: "relative" }));
  assert.throws(() => s.create({ ...p, models_dir: "C:\\..\\Windows" }));
  assert.equal(
    new ModelSetupStore(
      s.path,
      join(resourcePaths().templates, "pc_agent_install.ps1"),
    ).latest()?.status,
    "completed",
  );
});
test("V4L2 parsing distinguishes metadata node and discrete modes", () => {
  const info =
    "Driver name : uvcvideo\nCard type : UVC\nBus info : usb-1\nCapabilities : 0xff\n\tVideo Capture\nDevice Caps : 0x8\n\tMetadata Capture";
  assert.equal(parseDeviceInfo(info).node_kind, "metadata_capture");
  assert.equal(
    parseDeviceInfo(info.replace("Metadata Capture", "Video Capture"))
      .supports_video_capture,
    true,
  );
  const raw =
    "[0]: 'MJPG'\n Size: Discrete 1920x1080\n Interval: Discrete 0.033s (30.000 fps)";
  assert.deepEqual(parseFormats(raw), [
    { width: 1920, height: 1080, fps: 30, pixel_format: "MJPG" },
  ]);
  assert.equal(probeHid("win32").status, "unsupported_platform");
});
test("offline composite plan preserves management functions; recovery defaults to dry-run", () => {
  const report = {
    ...probeHid("win32"),
    status: "in_use",
    hid_kernel_support: true,
    udcs: [
      {
        name: "test.udc",
        state: "configured",
        current_speed: "high-speed",
        maximum_speed: "high-speed",
      },
    ],
    gadgets: [
      {
        name: "g_comp",
        udc: "test.udc",
        functions: ["ecm.usb0", "rndis.usb0", "mass_storage.usb0"],
        carries_management_network: true,
      },
    ],
  };
  const templates = resourcePaths().templates;
  const plan = compositePlan(report, templates);
  assert.equal(plan.requires_local_recovery, true);
  assert.equal(plan.hid_functions.length, 4);
  assert.ok(plan.planned_functions.includes("rndis.usb0"));
  const output = join(temp(), "bundle");
  recoveryBundle(plan, output, templates);
  const script = readFileSync(join(output, "temporary-apply.sh"), "utf8");
  assert.ok(script.includes('MODE="${1:---dry-run}"'));
  assert.ok(
    script.indexOf("nohup sh") <
      script.indexOf("printf '\\n' > \"$GADGET/UDC\""),
  );
  assert.ok(!script.includes("__GADGET__"));
  assert.throws(() => recoveryBundle(plan, output, templates), /empty/);
  assert.equal(
    readFileSync(join(output, "keyboard-report-desc.bin")).length,
    plan.hid_functions[0].report_descriptor_size,
  );
});
