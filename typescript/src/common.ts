import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const now = () => new Date().toISOString();
export const id = () => randomUUID().replaceAll("-", "");
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const object = z.record(z.string(), z.unknown());
export type JsonObject = Record<string, unknown>;
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + id() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const job = this.tail.then(work);
    this.tail = job.catch(() => {});
    return job;
  }
}
