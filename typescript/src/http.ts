import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, object } from "./common.js";
import { SESSION_MAX_BYTES } from "./contracts.js";
import { z } from "zod";

export function httpFailure(error: unknown) {
  if (error instanceof ApiError)
    return { status: error.status, error: error.message };
  if (error instanceof z.ZodError)
    return {
      status: 400,
      error: error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; "),
    };
  if (error instanceof URIError)
    return { status: 400, error: "invalid URL encoding" };
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (
    code &&
    ["ENOENT", "EACCES", "EIO", "EBUSY", "ENODEV", "ETIMEDOUT"].includes(code)
  )
    return { status: 503, error: "服务依赖或硬件暂不可用，请检查服务日志" };
  return { status: 500, error: "服务内部错误，请检查服务日志" };
}
export function originGuard(req: IncomingMessage) {
  if (req.headers.origin) {
    let origin: URL;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      throw new ApiError("cross-origin control requests are not allowed", 403);
    }
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.host !== req.headers.host
    )
      throw new ApiError("cross-origin control requests are not allowed", 403);
  }
}
export async function readBody(req: IncomingMessage, path: string) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new ApiError("Content-Type must be application/json", 415);
  const max =
    path === "/api/agent/sessions"
      ? SESSION_MAX_BYTES + 1024
      : [
            "/api/host-info",
            "/api/pc-agent/suggestions",
            "/api/model-setup/progress",
            "/api/agent/chat",
            "/api/agent/chat/jobs",
            "/api/agent/sessions",
          ].includes(path)
        ? 65536
        : path.startsWith("/api/agent/")
          ? 32768
          : 4096;
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isInteger(length) || length < 0 || length > max)
    throw new ApiError("invalid request body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ApiError("invalid request body");
    chunks.push(chunk);
  }
  if (!size) {
    if (["/api/hid/release", "/api/video/pause"].includes(path)) return {};
    throw new ApiError("invalid request body");
  }
  try {
    return object.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new ApiError("request body must be a valid JSON object");
  }
}
export function send(res: ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}
