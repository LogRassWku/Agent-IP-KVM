#!/usr/bin/env node
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createKvmServer,
  resourcePaths,
  type ServerOptions,
} from "./server.js";
import {
  compositePlan,
  discoverV4l2,
  probeHid,
  recoveryBundle,
  resolveEndpoints,
} from "./linux.js";
import { LinuxGadgetHid } from "./hid.js";
import { makeSource, type VideoConfig } from "./video.js";
import { delay } from "./common.js";

async function main() {
  const booleans = [
    "help",
    "enable-hid",
    "discover-v4l2",
    "probe-hid",
    "plan-composite",
    "release-only",
  ];
  const strings = [
    "host",
    "port",
    "source",
    "file",
    "device",
    "width",
    "height",
    "fps",
    "data-dir",
    "hid-backend",
    "gadget-root",
    "gadget-name",
    "write-recovery-bundle",
    "configuration",
    "pc-agent-callback-url",
    "frames",
    "ffmpeg",
    "ffprobe",
    "host-info-file",
    "audit-file",
    "pc-agent-token-file",
    "pc-agent-suggestion-file",
    "model-setup-file",
    "remote-model-file",
    "agent-sessions-file",
  ];
  const { values: v } = parseArgs({
    options: {
      ...Object.fromEntries(
        booleans.map((k) => [k, { type: "boolean" as const }]),
      ),
      ...Object.fromEntries(
        strings.map((k) => [k, { type: "string" as const }]),
      ),
    },
    strict: true,
  });
  if (v.help) {
    console.log(
      "Agent IP KVM TypeScript\n  npm start -- --source synthetic --enable-hid --hid-backend simulated\n  --host 127.0.0.1 --port 8080 --data-dir data/typescript\n  --source file --file PATH | --source v4l2 --device /dev/video0\n  --width 1920 --height 1080 --fps 30\n  --frames N | --discover-v4l2 | --probe-hid | --plan-composite\n  --write-recovery-bundle DIR --configuration c.1\n  --release-only --gadget-root PATH\nLinux / RDK X5 TypeScript hardware paths: UNVERIFIED.",
    );
    return;
  }
  const config: VideoConfig = {
    source: z
      .enum(["synthetic", "file", "v4l2"])
      .parse(v.source ?? "synthetic"),
    file: v.file as string | undefined,
    device: String(v.device ?? "/dev/video0"),
    width: z.coerce
      .number()
      .int()
      .min(1)
      .max(8192)
      .parse(v.width ?? 1920),
    height: z.coerce
      .number()
      .int()
      .min(1)
      .max(8192)
      .parse(v.height ?? 1080),
    fps: z.coerce
      .number()
      .positive()
      .max(240)
      .parse(v.fps ?? 30),
    ffmpeg: v.ffmpeg as string | undefined,
    ffprobe: v.ffprobe as string | undefined,
  };
  if (v["discover-v4l2"]) {
    console.log(JSON.stringify(await discoverV4l2(), null, 2));
    return;
  }
  if (v["probe-hid"] || v["plan-composite"]) {
    const report = probeHid();
    if (!v["plan-composite"]) console.log(JSON.stringify(report, null, 2));
    else {
      const templates = resourcePaths().templates;
      const plan = compositePlan(
        report,
        templates,
        v["gadget-name"] as string | undefined,
      );
      console.log(
        JSON.stringify(
          v["write-recovery-bundle"]
            ? recoveryBundle(
                plan,
                String(v["write-recovery-bundle"]),
                templates,
                String(v.configuration ?? "c.1"),
              )
            : plan,
          null,
          2,
        ),
      );
    }
    return;
  }
  if (v["release-only"]) {
    const endpoints = resolveEndpoints(
      String(v["gadget-root"] ?? "/sys/kernel/config/usb_gadget/g_comp"),
    );
    if (!endpoints) throw new Error("no configured Linux HID endpoints");
    const hid = new LinuxGadgetHid(endpoints);
    try {
      await delay(2500);
      await hid.arm();
      await hid.release();
      console.log(
        JSON.stringify({ released: true, hardware_validation: "unverified" }),
      );
    } finally {
      await hid.close();
    }
    return;
  }
  if (config.source === "file" && !config.file)
    throw new Error("--file is required with --source file");
  if (v.frames) {
    const count = z.coerce.number().int().min(1).max(10000).parse(v.frames);
    const s = makeSource(config);
    try {
      const mode = await s.open();
      await s.start();
      const start = performance.now();
      let frame;
      for (let i = 0; i < count; i++) frame = await s.nextFrame();
      console.log(
        JSON.stringify(
          {
            source_id: s.sourceId,
            mode,
            frames: count,
            sequence: frame?.sequence,
            bytes: frame?.data.length,
            measured_fps: count / ((performance.now() - start) / 1000),
            health: s.health,
          },
          null,
          2,
        ),
      );
    } finally {
      await s.close();
    }
    return;
  }
  const requested = z
    .enum(["auto", "linux", "simulated", "disabled"])
    .parse(
      v["hid-backend"] ?? (process.platform === "linux" ? "auto" : "disabled"),
    );
  const files: NonNullable<ServerOptions["files"]> = {};
  for (const [key, flag] of Object.entries({
    host: "host-info-file",
    audit: "audit-file",
    token: "pc-agent-token-file",
    suggestion: "pc-agent-suggestion-file",
    setup: "model-setup-file",
    remote: "remote-model-file",
    sessions: "agent-sessions-file",
  }))
    if (v[flag]) files[key as keyof typeof files] = String(v[flag]);
  const app = createKvmServer({
    ...config,
    dataDir: v["data-dir"] as string | undefined,
    gadgetRoot: v["gadget-root"] as string | undefined,
    callbackUrl: v["pc-agent-callback-url"] as string | undefined,
    files,
    hidBackend:
      requested === "auto"
        ? requested
        : v["enable-hid"]
          ? requested
          : "disabled",
  });
  const host = String(v.host ?? "127.0.0.1");
  const address = await app.listen(
    z.coerce
      .number()
      .int()
      .min(0)
      .max(65535)
      .parse(v.port ?? 8080),
    host,
  );
  console.log(`Agent IP KVM TypeScript: http://${host}:${address.port}`);
  console.log(
    `Video: ${config.source}; HID: ${app.hid.backend}; Linux/RDK X5 hardware: UNVERIFIED`,
  );
  let closing = false;
  const stop = () => {
    if (!closing) {
      closing = true;
      void app.close().catch((e) => {
        console.error(e);
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch((e) => {
  console.error(
    e instanceof z.ZodError
      ? e.issues.map((i) => i.message).join("; ")
      : String(e),
  );
  process.exitCode = 1;
});
