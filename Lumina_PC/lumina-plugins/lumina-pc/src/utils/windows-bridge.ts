export type BridgeJson = Record<string, unknown>;

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";
const DEFAULT_BRIDGE_TIMEOUT_MS = 25_000;

export function isWindowsBridgeMode(): boolean {
  // The Windows Bridge (Python UIA, :8765) is the canonical PC-muscle layer.
  // On WSL/Linux we MUST bridge to reach the Windows host. On native Windows we
  // ALSO force the bridge by default: the alternative in-process PowerShell UIA
  // path is blocked by Bitdefender AMSI (see memory project_windows_uia_amsi),
  // so spawning PowerShell from the gateway is dead here. Routing every muscle
  // call through the Python Bridge keeps it AMSI-safe on both platforms.
  // Escape hatch: LUMINA_FORCE_WINDOWS_BRIDGE=0 restores the platform-native path.
  const forced = process.env.LUMINA_FORCE_WINDOWS_BRIDGE?.trim();
  if (forced) {
    return forced === "1" || forced.toLowerCase() === "true";
  }
  return true;
}

export function windowsBridgeUrl(): string {
  return (
    process.env.LUMINA_WINDOWS_BRIDGE_URL ??
    process.env.LUMINA_BRIDGE_URL ??
    `http://127.0.0.1:${process.env.LUMINA_BRIDGE_PORT ?? "8765"}`
  ).replace(/\/+$/u, "") || DEFAULT_BRIDGE_URL;
}

export function windowsBridgeTimeoutMs(): number {
  const raw =
    process.env.LUMINA_WINDOWS_BRIDGE_TIMEOUT_MS ??
    process.env.LUMINA_BRIDGE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1_000), 120_000);
}

export async function bridgeGet(path: string): Promise<BridgeJson> {
  return bridgeRequest("GET", path);
}

export async function bridgePost(
  path: string,
  body: BridgeJson = {},
  timeoutMs?: number,
): Promise<BridgeJson> {
  return bridgeRequest("POST", path, body, timeoutMs);
}

export function windowsPathToWslPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

async function bridgeRequest(
  method: "GET" | "POST",
  path: string,
  body?: BridgeJson,
  requestedTimeoutMs?: number,
): Promise<BridgeJson> {
  const controller = new AbortController();
  const timeoutMs = requestedTimeoutMs ?? windowsBridgeTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${windowsBridgeUrl()}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? `windows_bridge_timeout_after_${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
      path,
      method,
    };
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let parsed: BridgeJson;
  try {
    parsed = text ? (JSON.parse(text) as BridgeJson) : {};
  } catch {
    parsed = { ok: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`,
      ...parsed,
    };
  }
  return parsed;
}
