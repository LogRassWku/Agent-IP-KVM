import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { release } from "node:os";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError, atomicJson, Mutex } from "./common.js";
import { DeviceWriter, type Endpoints } from "./hid.js";

const names = (path: string) => {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
};
const text = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};
export function parseDeviceInfo(raw: string) {
  const label = (name: string) =>
    raw.match(new RegExp("^\\s*" + name + "\\s*:\\s*(.+)$", "m"))?.[1].trim() ??
    null;
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^\s*Device Caps\s*:/.test(l));
  let caps = raw;
  if (start >= 0) {
    const indent = lines[start].search(/\S/);
    const children: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!l.trim()) continue;
      if (l.search(/\S/) <= indent) break;
      children.push(l);
    }
    caps = children.join("\n");
  }
  const node_kind = /^\s*Video Capture(?: Multiplanar)?\s*$/m.test(caps)
    ? "video_capture"
    : /^\s*Metadata Capture\s*$/m.test(caps)
      ? "metadata_capture"
      : "other";
  return {
    display_name: label("Card type"),
    driver: label("Driver name"),
    bus_info: label("Bus info"),
    node_kind,
    supports_video_capture: node_kind === "video_capture",
  };
}
export function parseFormats(raw: string) {
  let format = "",
    width = 0,
    height = 0;
  const modes: {
    width: number;
    height: number;
    fps: number;
    pixel_format: string;
  }[] = [];
  for (const line of raw.split("\n")) {
    let match = line.match(/^\s*\[\d+\]:\s*'([^']+)'/);
    if (match) {
      format = match[1];
      width = height = 0;
      continue;
    }
    match = line.match(/Size:\s*Discrete\s+(\d+)x(\d+)/);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
      continue;
    }
    match = line.match(/Interval:\s*Discrete.*\(([0-9.]+)\s+fps\)/);
    if (match && format && width && height) {
      const m = { width, height, fps: Number(match[1]), pixel_format: format };
      if (!modes.some((x) => JSON.stringify(x) === JSON.stringify(m)))
        modes.push(m);
    }
  }
  return modes;
}
const exec = promisify(execFile);
export async function discoverV4l2(
  platform = process.platform,
  devRoot = "/dev",
) {
  if (platform !== "linux")
    return {
      status: "unsupported_platform",
      message: "V4L2 discovery is only available on Linux",
      devices: [],
    };
  const devices = [];
  for (const name of names(devRoot).filter((n) => /^video\d+$/.test(n))) {
    const path = join(devRoot, name);
    try {
      const info = await exec("v4l2-ctl", ["--device", path, "--info"], {
        timeout: 4000,
        maxBuffer: 1_000_000,
      });
      const parsed = parseDeviceInfo(info.stdout);
      const formats = parsed.supports_video_capture
        ? await exec("v4l2-ctl", ["--device", path, "--list-formats-ext"], {
            timeout: 4000,
            maxBuffer: 1_000_000,
          })
        : { stdout: "" };
      devices.push({
        source_id: "v4l2:" + path,
        device_path: path,
        ...parsed,
        capabilities: parseFormats(formats.stdout),
        error: null,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return {
          status: "tool_missing",
          message: "v4l2-ctl is not installed",
          devices: [],
        };
      devices.push({
        source_id: "v4l2:" + path,
        device_path: path,
        display_name: name,
        driver: null,
        bus_info: null,
        node_kind: "unknown",
        supports_video_capture: false,
        capabilities: [],
        error: String(e),
      });
    }
  }
  return {
    status: devices.length ? "ok" : "no_devices",
    message: devices.length
      ? "V4L2 devices discovered"
      : "no video devices found",
    devices,
  };
}
/** Match ConfigFS dev major/minor to character devices, never assume hidg ordering. */
export function resolveHidg(functionDir: string, devRoot = "/dev") {
  const value = text(join(functionDir, "dev"));
  if (!/^\d+:\d+$/.test(value))
    throw new ApiError("invalid ConfigFS HID device number");
  const [major, minor] = value.split(":").map(BigInt);
  for (const n of names(devRoot).filter((n) => /^hidg\d+$/.test(n))) {
    const path = join(devRoot, n);
    const s = statSync(path, { bigint: true });
    if (!s.isCharacterDevice()) continue;
    const dev = s.rdev;
    const actualMajor = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const actualMinor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    if (major === actualMajor && minor === actualMinor) {
      accessSync(path, constants.W_OK);
      return path;
    }
  }
  throw new ApiError("no writable /dev/hidg node matches " + value);
}
export function resolveEndpoint(
  gadgetRoot: string,
  fn: string,
  devRoot = "/dev",
  sysRoot = "/sys",
) {
  const udc = text(join(gadgetRoot, "UDC"));
  if (
    !udc ||
    text(join(sysRoot, "class", "udc", udc, "state")) !== "configured"
  )
    throw new ApiError("USB HID endpoint is not configured by the host");
  const linked = names(join(gadgetRoot, "configs")).some((c) => {
    try {
      return lstatSync(join(gadgetRoot, "configs", c, fn)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!linked) throw new ApiError("USB HID endpoint is not installed");
  return resolveHidg(join(gadgetRoot, "functions", fn), devRoot);
}
export function resolveEndpoints(
  gadgetRoot: string,
  functions = {
    keyboard: "hid.keyboard",
    mouse: "hid.mouse",
    pointer: "hid.pointer",
  },
): Endpoints | undefined {
  if (process.platform !== "linux") return;
  try {
    const keyboard = resolveEndpoint(gadgetRoot, functions.keyboard);
    let mouse: string | undefined, pointer: string | undefined;
    try {
      mouse = resolveEndpoint(gadgetRoot, functions.mouse);
    } catch {}
    try {
      pointer = resolveEndpoint(gadgetRoot, functions.pointer);
    } catch {}
    if (!mouse && !pointer) return;
    return {
      keyboard,
      ...(mouse ? { mouse } : {}),
      ...(pointer ? { pointer } : {}),
    };
  } catch {
    return;
  }
}
export class UsbWake {
  private lock = new Mutex();
  constructor(private gadgetRoot: string) {}
  status() {
    try {
      if (process.platform !== "linux")
        throw new ApiError("USB wake HID is only available on Linux");
      resolveEndpoint(this.gadgetRoot, "hid.power");
      return {
        available: true,
        mode: "usb-wake",
        message: "USB 唤醒接口已就绪",
      };
    } catch (e) {
      return { available: false, mode: "usb-wake", message: String(e) };
    }
  }
  wake(payload: { action?: unknown }) {
    if ((payload.action ?? "wake") !== "wake")
      throw new ApiError("unsupported power action");
    return this.lock.run(async () => {
      if (process.platform !== "linux")
        throw new ApiError("USB wake HID is only available on Linux");
      const writer = await DeviceWriter.create(
        resolveEndpoint(this.gadgetRoot, "hid.power"),
      );
      try {
        await writer.write(Buffer.from([4]));
      } finally {
        try {
          await writer.write(Buffer.from([0]));
        } finally {
          await writer.close();
        }
      }
      return { action: "wake", transport: "usb-hid-system-control" };
    });
  }
}
export function probeHid(
  platform = process.platform,
  sysRoot = "/sys",
  procRoot = "/proc",
  bootRoot = "/boot",
) {
  const udcs =
    platform === "linux"
      ? names(join(sysRoot, "class", "udc")).map((name) => ({
          name,
          state: text(join(sysRoot, "class", "udc", name, "state")) || null,
          current_speed:
            text(join(sysRoot, "class", "udc", name, "current_speed")) || null,
          maximum_speed:
            text(join(sysRoot, "class", "udc", name, "maximum_speed")) || null,
        }))
      : [];
  const root = join(sysRoot, "kernel", "config", "usb_gadget");
  const gadgets =
    platform === "linux"
      ? names(root).map((name) => {
          const udc = text(join(root, name, "UDC")) || null;
          const functions = names(join(root, name, "functions"));
          return {
            name,
            udc,
            functions,
            carries_management_network:
              !!udc && functions.some((f) => /^(rndis|ecm|ncm)\./.test(f)),
          };
        })
      : [];
  const mounted =
    platform === "linux" &&
    text(join(procRoot, "mounts"))
      .split("\n")
      .some((l) => l.split(/\s+/)[2] === "configfs");
  let config = text(join(bootRoot, "config-" + release()));
  try {
    config = gunzipSync(readFileSync(join(procRoot, "config.gz"))).toString();
  } catch {}
  const flag = config.match(/^CONFIG_USB_CONFIGFS_F_HID=(.+)$/m)?.[1];
  const support = flag === undefined ? null : ["y", "m"].includes(flag);
  const status =
    platform !== "linux"
      ? "unsupported_platform"
      : !udcs.length
        ? "no_udc"
        : !mounted || !existsSync(root)
          ? "configfs_unavailable"
          : gadgets.some((g) => g.udc)
            ? "in_use"
            : "ready";
  return {
    status,
    message:
      status === "in_use"
        ? "An active USB gadget may carry management networking"
        : status,
    configfs_mounted: mounted,
    hid_kernel_support: support,
    safe_to_modify_now: status === "ready" && support !== false,
    udcs,
    gadgets,
  };
}
export type HidProbe = ReturnType<typeof probeHid>;
interface HidFunction {
  name: string;
  role: string;
  protocol: number;
  subclass: number;
  report_length: number;
  report_descriptor_hex: string;
  report_descriptor_size: number;
  report_descriptor_sha256: string;
}
export function compositePlan(
  report: HidProbe,
  templates: string,
  gadgetName?: string,
) {
  if (
    !["ready", "in_use"].includes(report.status) ||
    report.hid_kernel_support === false
  )
    throw new ApiError(report.message);
  if (!gadgetName && report.gadgets.length > 1)
    throw new ApiError("multiple gadgets found; select one by name");
  const gadget = gadgetName
    ? report.gadgets.find((g) => g.name === gadgetName)
    : report.gadgets[0];
  if (gadgetName && !gadget) throw new ApiError("gadget was not found");
  const hid_functions: HidFunction[] = JSON.parse(
    readFileSync(join(templates, "hid-functions.json"), "utf8"),
  );
  const existing = gadget?.functions ?? [];
  const rebind = !!gadget?.udc;
  const network = !!gadget?.carries_management_network;
  return {
    generated_only: true,
    gadget_name: gadget?.name ?? "agent_ip_kvm",
    udc: gadget?.udc ?? report.udcs[0].name,
    existing_functions: existing,
    planned_functions: [
      ...new Set([...existing, ...hid_functions.map((f) => f.name)]),
    ],
    hid_functions,
    retains_management_network: network,
    requires_rebind: rebind,
    requires_local_recovery: rebind && network,
    warnings: [
      ...(report.hid_kernel_support === null
        ? ["kernel HID support could not be confirmed"]
        : []),
      ...(rebind
        ? ["applying this plan requires USB disconnect and re-enumeration"]
        : []),
      ...(network
        ? [
            "the active gadget carries management networking; prepare local recovery first",
          ]
        : []),
    ],
  };
}
export function recoveryBundle(
  plan: ReturnType<typeof compositePlan>,
  output: string,
  templates: string,
  configuration = "c.1",
) {
  const safe = (s: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..")
      throw new ApiError("unsafe ConfigFS name");
    return s;
  };
  [
    plan.gadget_name,
    plan.udc,
    configuration,
    ...plan.existing_functions,
  ].forEach(safe);
  const directory = resolve(output);
  if (existsSync(directory) && readdirSync(directory).length)
    throw new ApiError("output directory must be empty");
  mkdirSync(directory, { recursive: true });
  atomicJson(join(directory, "manifest.json"), {
    schema_version: 1,
    generated_only: true,
    configuration_name: configuration,
    plan,
  });
  for (const name of [
    "preflight.sh",
    "rollback.sh",
    "temporary-apply.sh",
    "LOCAL_RECOVERY.md",
  ]) {
    let template = readFileSync(join(templates, name), "utf8");
    template = template
      .replaceAll(
        "'__EXISTING__'",
        plan.existing_functions.map((f) => "'" + f + "'").join(" "),
      )
      .replaceAll("__EXISTING__", plan.existing_functions.join(", "))
      .replaceAll("__GADGET__", plan.gadget_name)
      .replaceAll("__UDC__", plan.udc)
      .replaceAll("__CONFIG__", configuration);
    writeFileSync(join(directory, name), template, {
      mode: name.endsWith(".sh") ? 0o755 : 0o600,
    });
  }
  for (const f of plan.hid_functions)
    writeFileSync(
      join(directory, f.name.slice(4) + "-report-desc.bin"),
      Buffer.from(f.report_descriptor_hex, "hex"),
    );
  return {
    directory,
    manifest: join(directory, "manifest.json"),
    generated_only: true,
  };
}
