export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const result = await response.json();
    if (!response.ok)
      throw new HttpError(
        String(result.error || `HTTP ${response.status}`),
        response.status,
      );
    return result as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(
        `请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待`,
      );
    throw new Error("无法读取服务响应，请检查连接后重试");
  } finally {
    clearTimeout(timer);
  }
}
// Legacy UI callers are progressively migrated; feature services use explicit T.
export function postJson<T = any>(
  path: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options.timeoutMs,
  );
}
export function fetchJson<T = any>(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return request<T>(path, { cache: "no-store" }, options.timeoutMs);
}
