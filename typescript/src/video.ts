import sharp from "sharp";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { ApiError, delay, hash, Mutex } from "./common.js";

export interface Mode {
  width: number;
  height: number;
  fps: number;
  pixel_format: "RGB24" | "MJPEG";
}
export interface Frame {
  width: number;
  height: number;
  pixel_format: Mode["pixel_format"];
  data: Buffer;
  sequence: number;
  timestamp_ns: number;
}
export type Health = "closed" | "ready" | "streaming" | "ended" | "error";
export class EndOfStream extends ApiError {}
export interface VideoSource {
  sourceId: string;
  health: Health;
  capabilities(): Promise<Mode[]>;
  open(): Promise<Mode>;
  start(): Promise<void>;
  nextFrame(): Promise<Frame>;
  close(): Promise<void>;
}
export interface VideoConfig {
  source: "synthetic" | "file" | "v4l2";
  file?: string;
  device: string;
  width: number;
  height: number;
  fps: number;
  ffmpeg?: string;
  ffprobe?: string;
}
export function validateFrame(frame: Frame) {
  if (
    !Number.isInteger(frame.width) ||
    frame.width < 1 ||
    !Number.isInteger(frame.height) ||
    frame.height < 1
  )
    throw new ApiError("invalid frame dimensions");
  if (
    frame.pixel_format === "RGB24" &&
    frame.data.length !== frame.width * frame.height * 3
  )
    throw new ApiError("invalid RGB24 frame size");
  if (
    frame.pixel_format === "MJPEG" &&
    (!frame.data.subarray(0, 2).equals(Buffer.from([255, 216])) ||
      !frame.data.subarray(-2).equals(Buffer.from([255, 217])))
  )
    throw new ApiError("invalid JPEG frame");
}
export class SyntheticSource implements VideoSource {
  sourceId = "synthetic:color-bars";
  health: Health = "closed";
  private sequence = 0;
  private pixels = Buffer.alloc(0);
  private deadline = 0;
  constructor(private realtime = true) {}
  async capabilities(): Promise<Mode[]> {
    return [{ width: 1280, height: 720, fps: 30, pixel_format: "RGB24" }];
  }
  async open() {
    const mode = (await this.capabilities())[0];
    const colors = [
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
      [0, 255, 0],
      [255, 0, 255],
      [255, 0, 0],
      [0, 0, 255],
      [0, 0, 0],
    ];
    this.pixels = Buffer.alloc(mode.width * mode.height * 3);
    for (let y = 0; y < mode.height; y++)
      for (let x = 0; x < mode.width; x++) {
        const c = colors[Math.floor((x * 8) / mode.width)];
        this.pixels.set(c, (y * mode.width + x) * 3);
      }
    this.health = "ready";
    this.sequence = 0;
    return mode;
  }
  async start() {
    if (this.health !== "ready")
      throw new ApiError("source must be open before start");
    this.health = "streaming";
    this.deadline = performance.now();
  }
  async nextFrame() {
    if (this.health !== "streaming")
      throw new ApiError("source is not streaming");
    if (this.realtime)
      await delay(Math.max(0, this.deadline - performance.now()));
    if (this.health !== "streaming") throw new ApiError("source is closed");
    this.deadline = performance.now() + 1000 / 30;
    return {
      width: 1280,
      height: 720,
      pixel_format: "RGB24" as const,
      data: this.pixels,
      sequence: this.sequence++,
      timestamp_ns: Number(process.hrtime.bigint()),
    };
  }
  async close() {
    this.health = "closed";
    this.pixels = Buffer.alloc(0);
  }
}
const exec = promisify(execFile);
export function parseProbe(raw: string): Mode {
  const p = JSON.parse(raw);
  const s = p.streams?.find(
    (s: { codec_type?: string }) => !s.codec_type || s.codec_type === "video",
  );
  if (!s) throw new ApiError("file has no video stream");
  const [n, d] = String(s.avg_frame_rate || s.r_frame_rate)
    .split("/")
    .map(Number);
  const fps = d === undefined ? n : n / d;
  z.object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    fps: z.number().positive().max(240),
  }).parse({ width: s.width, height: s.height, fps });
  return { width: s.width, height: s.height, fps, pixel_format: "MJPEG" };
}
/** Incremental JPEG framing, including split markers. Bounded to reject broken streams. */
export class JpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const start = this.buffer.indexOf(Buffer.from([255, 216]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(-1);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(Buffer.from([255, 217]), 2);
      if (end < 0) break;
      frames.push(Buffer.from(this.buffer.subarray(0, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
    if (this.buffer.length > 16_000_000)
      throw new ApiError("MJPEG frame exceeded 16 MB");
    return frames;
  }
}
/** FFmpeg V4L2 uses MJPEG copy: no decode/encode. Hardware behavior is UNVERIFIED. */
export class FFmpegSource implements VideoSource {
  health: Health = "closed";
  sourceId: string;
  private mode?: Mode;
  private process?: ChildProcessWithoutNullStreams;
  private queue: Buffer[] = [];
  private wake = new EventEmitter();
  private failure?: Error;
  private ended = false;
  private sequence = 0;
  constructor(private config: VideoConfig) {
    this.sourceId =
      config.source === "file"
        ? "file:" + config.file
        : "v4l2:" + config.device;
  }
  async capabilities() {
    if (this.config.source === "v4l2") {
      if (process.platform !== "linux")
        throw new ApiError("V4L2 capture is only available on Linux");
      return [
        {
          width: this.config.width,
          height: this.config.height,
          fps: this.config.fps,
          pixel_format: "MJPEG" as const,
        },
      ];
    }
    if (!this.config.file || !statSync(this.config.file).isFile())
      throw new ApiError("file source requires an existing local file");
    const { stdout } = await exec(
      this.config.ffprobe || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_streams",
        "-of",
        "json",
        this.config.file,
      ],
      { timeout: 10000, maxBuffer: 1_000_000 },
    );
    return [parseProbe(stdout)];
  }
  async open() {
    this.mode = (await this.capabilities())[0];
    this.health = "ready";
    this.queue = [];
    this.failure = undefined;
    this.ended = false;
    this.sequence = 0;
    return this.mode;
  }
  async start() {
    if (this.health !== "ready" || !this.mode)
      throw new ApiError("source must be open before start");
    const c = this.config;
    const input =
      c.source === "file"
        ? ["-re", "-i", c.file!]
        : [
            "-f",
            "v4l2",
            "-input_format",
            "mjpeg",
            "-video_size",
            `${c.width}x${c.height}`,
            "-framerate",
            String(c.fps),
            "-i",
            c.device,
          ];
    const output =
      c.source === "file"
        ? ["-an", "-c:v", "mjpeg", "-q:v", "3"]
        : ["-an", "-c:v", "copy"];
    const proc = spawn(
      c.ffmpeg || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...input,
        ...output,
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.process = proc;
    this.health = "streaming";
    const parser = new JpegParser();
    let stderr = "";
    proc.stderr.on(
      "data",
      (b) => (stderr = (stderr + b.toString()).slice(-2000)),
    );
    proc.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const jpeg of parser.push(chunk)) {
          this.queue.push(jpeg);
          // Live capture favors freshness. File playback must preserve every
          // frame, even when FFmpeg delivers several JPEGs in one pipe read.
          if (c.source !== "file" && this.queue.length > 2) this.queue.shift();
        }
        if (c.source === "file" && this.queue.length >= 4) proc.stdout.pause();
        this.wake.emit("frame");
      } catch (e) {
        this.failure = e as Error;
        proc.kill();
        this.wake.emit("frame");
      }
    });
    proc.on("error", (e) => {
      this.failure = e;
      this.health = "error";
      this.wake.emit("frame");
    });
    proc.on("close", (code) => {
      this.ended = true;
      if (code && this.health !== "closed")
        this.failure = new ApiError(stderr || "FFmpeg capture failed");
      this.wake.emit("frame");
    });
  }
  async nextFrame() {
    if (this.health !== "streaming" || !this.mode)
      throw new ApiError("source is not streaming");
    const deadline = performance.now() + 5000;
    while (!this.queue.length) {
      if (this.failure) {
        this.health = "error";
        throw this.failure;
      }
      if (this.ended) {
        this.health = "ended";
        throw new EndOfStream("end of stream");
      }
      if (performance.now() > deadline)
        throw new ApiError("capture timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.wake.off("frame", done);
          resolve();
        };
        const timer = setTimeout(done, 100);
        this.wake.once("frame", done);
      });
    }
    const data = this.queue.shift()!;
    if (this.config.source === "file" && this.queue.length < 2)
      this.process?.stdout.resume();
    return {
      ...this.mode,
      data,
      sequence: this.sequence++,
      timestamp_ns: Number(process.hrtime.bigint()),
    };
  }
  async close() {
    this.health = "closed";
    this.ended = true;
    this.wake.emit("frame");
    const p = this.process;
    this.process = undefined;
    if (p && p.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          p.kill("SIGKILL");
          resolve();
        }, 1000);
        p.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        p.kill();
      });
    }
    this.queue = [];
  }
}
export const makeSource = (c: VideoConfig): VideoSource =>
  c.source === "synthetic" ? new SyntheticSource() : new FFmpegSource(c);
export interface Snapshot {
  jpeg: Buffer;
  metadata: {
    source_id: string;
    width: number;
    height: number;
    sequence: number;
    timestamp_ns: number;
    bytes: number;
    sha256: string;
    on_demand: boolean;
  };
}
export class VideoController {
  private state = "idle";
  private message = "等待浏览器连接";
  private error: string | null = null;
  private source?: VideoSource;
  private pump?: Promise<void>;
  private generation = 0;
  private latest?: Snapshot;
  private listeners = new Set<(frame?: Snapshot) => void>();
  private lock = new Mutex();
  private stopped = false;
  constructor(
    public config: VideoConfig,
    private factory: (config: VideoConfig) => VideoSource = makeSource,
  ) {}
  status() {
    return {
      state: this.state,
      message: this.message,
      sequence: this.latest?.metadata.sequence ?? null,
      error: this.error,
    };
  }
  async capabilities() {
    const s = this.factory(this.config);
    try {
      return await s.capabilities();
    } finally {
      await s.close();
    }
  }
  private async encode(source: VideoSource): Promise<Snapshot> {
    const f = await source.nextFrame();
    validateFrame(f);
    const jpeg =
      f.pixel_format === "MJPEG"
        ? f.data
        : await sharp(f.data, {
            raw: { width: f.width, height: f.height, channels: 3 },
          })
            .jpeg({ quality: 85 })
            .toBuffer();
    return {
      jpeg,
      metadata: {
        source_id: source.sourceId,
        width: f.width,
        height: f.height,
        sequence: f.sequence,
        timestamp_ns: f.timestamp_ns,
        bytes: jpeg.length,
        sha256: hash(jpeg),
        on_demand: false,
      },
    };
  }
  async snapshot(): Promise<Snapshot> {
    return this.lock.run(async () => {
      if (this.stopped) throw new ApiError("video controller is closed");
      if (this.pump && !this.latest) {
        const deadline = performance.now() + 5000;
        while (
          Boolean(this.pump) &&
          !this.latest &&
          performance.now() < deadline
        )
          await delay(5);
        if (Boolean(this.pump) && !this.latest)
          throw new ApiError("capture timed out waiting for a frame");
      }
      if (this.latest && this.state === "streaming")
        return {
          jpeg: this.latest.jpeg,
          metadata: { ...this.latest.metadata, on_demand: false },
        };
      const s = this.factory(this.config);
      try {
        await s.open();
        await s.start();
        const shot = await this.encode(s);
        shot.metadata.on_demand = true;
        return shot;
      } finally {
        await s.close();
      }
    });
  }
  subscribe(listener: (frame?: Snapshot) => void) {
    let cancelled = false;
    void this.lock.run(async () => {
      if (cancelled) return;
      if (this.stopped) {
        listener();
        return;
      }
      // Register after any pending cleanup has finished, so an old viewer's
      // disconnect cannot close a newly arriving viewer's response.
      this.listeners.add(listener);
      if (this.pump) {
        if (this.latest) listener(this.latest);
        return;
      }
      const generation = this.generation;
      this.pump = this.produce(generation);
    });
    return () => {
      if (cancelled) return;
      cancelled = true;
      const removed = this.listeners.delete(listener);
      if (removed && this.listeners.size === 0) void this.pause();
    };
  }
  private async produce(generation: number) {
    const s = this.factory(this.config);
    this.source = s;
    this.state = "starting";
    this.error = null;
    try {
      await s.open();
      await s.start();
      while (generation === this.generation && !this.stopped) {
        const shot = await this.encode(s);
        if (generation !== this.generation) break;
        this.latest = shot;
        this.state = "streaming";
        this.message = "视频流已连接";
        for (const cb of this.listeners) cb(shot);
      }
    } catch (e) {
      if (generation === this.generation) {
        this.state = e instanceof EndOfStream ? "ended" : "error";
        this.error = String(e);
        this.message =
          e instanceof EndOfStream ? "视频文件已结束" : "No Signal";
      }
    } finally {
      await s.close();
      if (generation === this.generation) {
        this.source = undefined;
        this.pump = undefined;
        this.latest = undefined;
        for (const cb of [...this.listeners]) cb();
        this.listeners.clear();
      }
    }
  }
  pause() {
    return this.lock.run(async () => {
      this.generation++;
      await this.source?.close();
      await this.pump;
      this.source = undefined;
      this.pump = undefined;
      this.latest = undefined;
      this.state = "idle";
      this.message = "Agent 模式已释放视频采集";
      this.error = null;
      const listeners = [...this.listeners];
      this.listeners.clear();
      for (const cb of listeners) cb();
    });
  }
  async updateMode(payload: unknown, available: Mode[]) {
    const p = z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps: z.number().positive(),
      })
      .parse(payload);
    if (
      !available.some(
        (m) =>
          m.width === p.width &&
          m.height === p.height &&
          Math.abs(m.fps - p.fps) < 0.01,
      )
    )
      throw new ApiError("unsupported video mode");
    await this.pause();
    Object.assign(this.config, p);
    return {
      ...p,
      pixel_format: this.config.source === "synthetic" ? "RGB24" : "MJPEG",
    };
  }
  async close() {
    this.stopped = true;
    await this.pause();
    this.state = "stopped";
  }
}
export async function observe(video: VideoController) {
  const { metadata } = await video.snapshot();
  return {
    frame: metadata,
    recognition:
      video.config.source === "synthetic"
        ? {
            state: "test_pattern",
            confidence: 1,
            evidence: ["deterministic synthetic color-bar source"],
          }
        : {
            state: "unknown",
            confidence: 0,
            evidence: ["frame captured; semantic recognizer is not configured"],
          },
  };
}
