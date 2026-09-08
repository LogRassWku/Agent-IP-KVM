import { open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { ApiError, delay, Mutex, type JsonObject } from "./common.js";

export const KEY_USAGES: Record<string, number> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCharCode(97 + i), 4 + i]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [String(i + 1), 0x1e + i]),
  ),
  "0": 0x27,
  enter: 0x28,
  escape: 0x29,
  esc: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  "-": 0x2d,
  "=": 0x2e,
  "[": 0x2f,
  "]": 0x30,
  "\\": 0x31,
  ";": 0x33,
  "'": 0x34,
  "`": 0x35,
  ",": 0x36,
  ".": 0x37,
  "/": 0x38,
  capslock: 0x39,
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => ["f" + (i + 1), 0x3a + i]),
  ),
  delete: 0x4c,
  home: 0x4a,
  pageup: 0x4b,
  end: 0x4d,
  pagedown: 0x4e,
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
};
const MODIFIERS: Record<string, number> = {
  ctrl: 1,
  left_ctrl: 1,
  shift: 2,
  left_shift: 2,
  alt: 4,
  left_alt: 4,
  win: 8,
  meta: 8,
  left_meta: 8,
  right_ctrl: 16,
  right_shift: 32,
  right_alt: 64,
  right_meta: 128,
};
const BUTTONS = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
export type Button = keyof typeof BUTTONS;
export type HidState = "closed" | "ready" | "stopped" | "error";
export interface HidAdapter {
  state: HidState;
  arm(): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  move(x: number, y: number, wheel?: number): Promise<void>;
  position(x: number, y: number, wheel?: number): Promise<void>;
  buttonDown(button: Button): Promise<void>;
  buttonUp(button: Button): Promise<void>;
  release(): Promise<void>;
  emergencyStop(): Promise<void>;
  close(): Promise<void>;
}
export interface ReportWriter {
  write(report: Buffer): Promise<void>;
  close(): Promise<void>;
}
export class DeviceWriter implements ReportWriter {
  private constructor(private file: FileHandle) {}
  static async create(path: string) {
    return new DeviceWriter(
      await open(path, constants.O_WRONLY | constants.O_NONBLOCK),
    );
  }
  async write(report: Buffer) {
    const deadline = performance.now() + 350;
    let offset = 0;
    while (offset < report.length) {
      try {
        const { bytesWritten } = await this.file.write(
          report,
          offset,
          report.length - offset,
          null,
        );
        if (!bytesWritten) throw new ApiError("HID write made no progress");
        offset += bytesWritten;
      } catch (e) {
        if (
          !["EAGAIN", "EWOULDBLOCK"].includes(
            (e as NodeJS.ErrnoException).code || "",
          ) ||
          performance.now() >= deadline
        )
          throw e;
        await delay(5);
      }
    }
  }
  async close() {
    await this.file.close();
  }
}
export class SimulatedHid implements HidAdapter {
  state: HidState = "closed";
  readonly keys = new Set<string>();
  readonly buttons = new Set<Button>();
  readonly events: ({ kind: string } & JsonObject)[] = [];
  protected record(kind: string, values: JsonObject = {}) {
    this.events.push({ kind, ...values });
    if (this.events.length > 4096) this.events.shift();
  }
  protected ready() {
    if (this.state !== "ready")
      throw new ApiError("HID is not ready: " + this.state);
  }
  async arm() {
    this.state = "ready";
    this.record("armed");
  }
  async keyDown(key: string) {
    this.ready();
    if (!(key in KEY_USAGES || key in MODIFIERS))
      throw new ApiError("unsupported key");
    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.record("key_down", { key });
    }
  }
  async keyUp(key: string) {
    this.ready();
    if (this.keys.delete(key)) this.record("key_up", { key });
  }
  async move(x: number, y: number, wheel = 0) {
    this.ready();
    axis.parse(x);
    axis.parse(y);
    axis.parse(wheel);
    this.record("mouse_move", { delta_x: x, delta_y: y, wheel });
  }
  async position(x: number, y: number, wheel = 0) {
    this.ready();
    absolute.parse(x);
    absolute.parse(y);
    axis.parse(wheel);
    this.record("mouse_position", { x, y, wheel });
  }
  async buttonDown(button: Button) {
    this.ready();
    if (!(button in BUTTONS)) throw new ApiError("unsupported mouse button");
    this.buttons.add(button);
    this.record("button_down", { button });
  }
  async buttonUp(button: Button) {
    this.ready();
    this.buttons.delete(button);
    this.record("button_up", { button });
  }
  async release() {
    this.keys.clear();
    this.buttons.clear();
    this.record("release_all");
  }
  async emergencyStop() {
    try {
      await this.release();
    } finally {
      this.state = "stopped";
      this.record("emergency_stop");
    }
  }
  async close() {
    await this.release();
    this.state = "closed";
    this.record("closed");
  }
}
export interface Endpoints {
  keyboard: string;
  mouse?: string;
  pointer?: string;
}
/** Linux ConfigFS backend. Protocol tests pass with injected writers; RDK X5 hardware UNVERIFIED. */
export class LinuxGadgetHid extends SimulatedHid {
  private writers: Partial<Record<keyof Endpoints, ReportWriter>> = {};
  private px = 16384;
  private py = 16384;
  private known = false;
  constructor(
    readonly endpoints: Endpoints,
    private factory: (
      path: string,
    ) => Promise<ReportWriter> = DeviceWriter.create,
  ) {
    super();
  }
  override async arm() {
    if (this.state === "ready") return;
    try {
      for (const [kind, path] of Object.entries(this.endpoints))
        this.writers[kind as keyof Endpoints] ??= await this.factory(path);
      this.state = "ready";
      await this.release();
    } catch (e) {
      await this.closeWriters();
      this.state = "error";
      throw e;
    }
  }
  private async write(kind: keyof Endpoints, report: Buffer) {
    const writer = this.writers[kind];
    if (!writer) throw new ApiError(kind + " HID device is not configured");
    try {
      await writer.write(report);
    } catch (e) {
      this.state = "error";
      throw e;
    }
  }
  private mask() {
    return [...this.buttons].reduce((a, b) => a | BUTTONS[b], 0);
  }
  private async keyboard() {
    const keys = [...this.keys]
      .filter((k) => k in KEY_USAGES)
      .map((k) => KEY_USAGES[k]);
    const mods = [...this.keys].reduce((a, k) => a | (MODIFIERS[k] || 0), 0);
    const report = Buffer.alloc(8);
    report[0] = mods;
    keys.forEach((k, i) => (report[i + 2] = k));
    await this.write("keyboard", report);
  }
  private async pointer(wheel = 0) {
    const report = Buffer.alloc(6);
    report[0] = this.mask();
    report.writeUInt16LE(this.px, 1);
    report.writeUInt16LE(this.py, 3);
    report[5] = wheel & 255;
    await this.write("pointer", report);
  }
  override async keyDown(key: string) {
    if (
      !(key in MODIFIERS) &&
      !this.keys.has(key) &&
      [...this.keys].filter((k) => k in KEY_USAGES).length >= 6
    )
      throw new ApiError("boot keyboard supports at most six held keys");
    await super.keyDown(key);
    await this.keyboard();
  }
  override async keyUp(key: string) {
    await super.keyUp(key);
    await this.keyboard();
  }
  override async move(x: number, y: number, wheel = 0) {
    await super.move(x, y, wheel);
    await this.write(
      "mouse",
      Buffer.from([this.mask(), x & 255, y & 255, wheel & 255]),
    );
  }
  override async position(x: number, y: number, wheel = 0) {
    await super.position(x, y, wheel);
    this.px = x;
    this.py = y;
    this.known = true;
    await this.pointer(wheel);
  }
  private async buttonReport() {
    if (this.writers.mouse)
      await this.write("mouse", Buffer.from([this.mask(), 0, 0, 0]));
    else {
      if (!this.known)
        throw new ApiError(
          "set absolute pointer position before pressing a button",
        );
      await this.pointer();
    }
  }
  override async buttonDown(button: Button) {
    await super.buttonDown(button);
    await this.buttonReport();
  }
  override async buttonUp(button: Button) {
    await super.buttonUp(button);
    await this.buttonReport();
  }
  override async release() {
    await super.release();
    const errors: unknown[] = [];
    for (const kind of ["keyboard", "mouse", "pointer"] as const) {
      if (!this.writers[kind] || (kind === "pointer" && !this.known)) continue;
      try {
        if (kind === "pointer") await this.pointer();
        else await this.write(kind, Buffer.alloc(kind === "keyboard" ? 8 : 4));
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length)
      throw new ApiError(
        "failed to release HID input: " + errors.map(String).join("; "),
      );
  }
  private async closeWriters() {
    await Promise.allSettled(Object.values(this.writers).map((w) => w.close()));
    this.writers = {};
  }
  override async close() {
    try {
      await this.release();
    } finally {
      await this.closeWriters();
      this.state = "closed";
    }
  }
}
const axis = z.number().int().min(-127).max(127),
  absolute = z.number().int().min(0).max(32767);
export const tapSchema = z.object({
  key: z
    .string()
    .refine(
      (k) =>
        Object.hasOwn(KEY_USAGES, k) ||
        ["ctrl", "shift", "alt", "win"].includes(k),
      "unsupported key",
    ),
  modifiers: z
    .array(z.enum(["ctrl", "shift", "alt", "win"]))
    .max(4)
    .default([])
    .refine((a) => new Set(a).size === a.length, "duplicate modifier"),
});
const shifted: Record<string, string> = Object.fromEntries(
  [...'!@#$%^&*()_+{}|:"~<>?'].map((c, i) => [
    c,
    [..."1234567890-=[]\\;'`,./"][i],
  ]),
);
export class HidController {
  private mutex = new Mutex();
  private stopped = false;
  constructor(
    public adapter: HidAdapter | undefined,
    public backend = "disabled",
    private resolver?: () => Endpoints | undefined,
  ) {}
  async sync() {
    if (!this.resolver) return;
    const paths = this.resolver();
    if (
      this.adapter &&
      (!paths ||
        this.adapter.state === "error" ||
        JSON.stringify((this.adapter as LinuxGadgetHid).endpoints) !==
          JSON.stringify(paths))
    ) {
      try {
        await this.adapter.close();
      } catch {}
      this.adapter = undefined;
    }
    if (!this.adapter && paths) this.adapter = new LinuxGadgetHid(paths);
  }
  refresh() {
    return this.mutex.run(async () => {
      await this.sync();
      return this.status();
    });
  }
  status() {
    return {
      enabled: !!this.adapter,
      backend: this.backend,
      state: this.stopped
        ? "stopped"
        : (this.adapter?.state ??
          (this.backend === "disabled" ? "disabled" : "disconnected")),
    };
  }
  private async ready() {
    if (this.stopped) throw new ApiError("emergency stop is active");
    await this.sync();
    if (!this.adapter)
      throw new ApiError("HID output is not enabled on this server");
    if (this.adapter.state === "closed") await this.adapter.arm();
    if (this.adapter.state !== "ready")
      throw new ApiError("HID is not ready: " + this.adapter.state);
    return this.adapter;
  }
  private async stroke(a: HidAdapter, p: z.infer<typeof tapSchema>) {
    for (const m of p.modifiers) await a.keyDown(m);
    await a.keyDown(p.key);
    await a.keyUp(p.key);
    for (const m of [...p.modifiers].reverse()) await a.keyUp(m);
  }
  tap(payload: unknown) {
    const p = tapSchema.parse(payload);
    return this.mutex.run(async () => {
      const a = await this.ready();
      try {
        await this.stroke(a, p);
      } finally {
        await a.release();
      }
      return p;
    });
  }
  typeText(text: unknown, keyDelay = 8) {
    const value = z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x20-\x7e]+$/)
      .parse(text);
    const strokes = [...value].map((c) => ({
      key: c === " " ? "space" : shifted[c] || c.toLowerCase(),
      modifiers: shifted[c] || /[A-Z]/.test(c) ? ["shift" as const] : [],
    }));
    return this.mutex.run(async () => {
      const a = await this.ready();
      try {
        for (const s of strokes) {
          if (this.stopped) throw new ApiError("emergency stop is active");
          await this.stroke(a, s);
          if (keyDelay) await delay(keyDelay);
        }
      } finally {
        await a.release();
      }
      return { characters: value.length };
    });
  }
  move(payload: unknown) {
    const p = z
      .object({
        delta_x: z.number().int().min(-4096).max(4096).default(0),
        delta_y: z.number().int().min(-4096).max(4096).default(0),
        wheel: axis.default(0),
      })
      .parse(payload);
    return this.mutex.run(async () => {
      const a = await this.ready();
      let x = p.delta_x,
        y = p.delta_y;
      while (x || y) {
        const dx = Math.max(-127, Math.min(127, x)),
          dy = Math.max(-127, Math.min(127, y));
        await a.move(dx, dy);
        x -= dx;
        y -= dy;
      }
      if (p.wheel) await a.move(0, 0, p.wheel);
      return p;
    });
  }
  position(payload: unknown) {
    const p = z
      .object({ x: absolute, y: absolute, wheel: axis.default(0) })
      .parse(payload);
    return this.mutex.run(async () => {
      const a = await this.ready();
      await a.position(p.x, p.y, p.wheel);
      return p;
    });
  }
  click(payload: unknown) {
    const p = z
      .object({
        button: z.enum(["left", "right", "middle"]),
        x: absolute.optional(),
        y: absolute.optional(),
      })
      .refine(
        (p) => (p.x === undefined) === (p.y === undefined),
        "both x and y are required",
      )
      .parse(payload);
    return this.mutex.run(async () => {
      const a = await this.ready();
      try {
        if (p.x !== undefined) await a.position(p.x, p.y!);
        await a.buttonDown(p.button);
        await a.buttonUp(p.button);
      } finally {
        await a.release();
      }
      return { button: p.button };
    });
  }
  release() {
    return this.mutex.run(async () => {
      if (this.adapter) await this.adapter.release();
    });
  }
  emergencyStop() {
    this.stopped = true;
    return this.mutex.run(async () => {
      await this.adapter?.emergencyStop();
    });
  }
  arm() {
    return this.mutex.run(async () => {
      await this.adapter?.arm();
      this.stopped = false;
    });
  }
  close() {
    this.stopped = true;
    return this.mutex.run(async () => {
      await this.adapter?.close();
    });
  }
}
