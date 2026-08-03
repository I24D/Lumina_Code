/**
 * bridge-client.ts — Tiny typed HTTP client for the Lumina Windows Bridge.
 *
 * The Bridge runs locally on Windows (default http://127.0.0.1:8765) and
 * exposes /screenshot, /input_control, /window_control, /processes, etc.
 * Multiple cognitive-os tools (smart_click, pc_observe, pc_scroll, pc_drag)
 * talk to it the same way — this helper centralizes:
 *
 *   - URL composition (trailing slash safety)
 *   - AbortController-based timeouts
 *   - JSON encode/decode with offline-safe nulls
 *   - Injectable `fetchImpl` for tests (no monkey-patching of global fetch)
 *
 * It is intentionally minimal. No retries, no caching — those are concerns
 * of the calling tool, not the transport.
 */

export type BridgeClient = {
  readonly bridgeUrl: string;
  post<T = unknown>(path: string, body?: unknown, timeoutMs?: number): Promise<T | null>;
  get<T = unknown>(path: string, timeoutMs?: number): Promise<T | null>;
};

export type BridgeClientOptions = {
  readonly bridgeUrl: string;
  readonly fetchImpl?: typeof fetch;
};

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const f = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  const base = options.bridgeUrl.replace(/\/+$/, "");

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T | null> {
    if (!f) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { method, signal: controller.signal };
      if (method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body ?? {});
      }
      const response = await f(`${base}${path}`, init);
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    bridgeUrl: base,
    post: <T>(path: string, body?: unknown, timeoutMs = 6_000) =>
      call<T>("POST", path, body, timeoutMs),
    get: <T>(path: string, timeoutMs = 4_000) => call<T>("GET", path, undefined, timeoutMs),
  };
}
