import type { FetchFunction } from "../index.js";
import { readLuminaEnv, readLuminaEnvFirst } from "./luminaEnv.js";

export const DEFAULT_LUMINA_CORE_URL = "http://127.0.0.1:3000";
export const DEFAULT_LUMINA_ROUTER_URL = "http://127.0.0.1:4321";

export type LuminaRuntimeAction =
  | "health"
  | "chat"
  | "harness_task"
  | "memory_recent"
  | "memory_search";

export type LuminaRuntimeCallArgs = {
  action: LuminaRuntimeAction;
  message?: string;
  query?: string;
  context?: Record<string, unknown>;
  provider?: string;
  model?: string;
  mode?: "simulate" | "production";
  maxIterations?: number;
  preferBrowser?: boolean;
};

function normalizeServiceUrl(value: string, allowRemoteHttps: boolean): string {
  const parsed = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (!local && !(allowRemoteHttps && parsed.protocol === "https:")) {
    throw new Error(`Lumina service URL is not an allowed local/HTTPS endpoint: ${parsed.hostname}`);
  }
  if (!local && parsed.protocol !== "https:") {
    throw new Error("Remote Lumina Core endpoints must use HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

export function resolveLuminaCoreUrl(): string {
  return normalizeServiceUrl(
    readLuminaEnvFirst("LUMINA_CORE_URL", "LUMINA_SRC_BASE_URL", "APP_BASE_URL") ||
      DEFAULT_LUMINA_CORE_URL,
    true,
  );
}

export function resolveLuminaRouterUrl(): string {
  return normalizeServiceUrl(
    readLuminaEnvFirst("MODEL_ROUTER_URL", "LUMINA_MODEL_ROUTER_URL") ||
      DEFAULT_LUMINA_ROUTER_URL,
    false,
  );
}

export function resolveLuminaCanonicalUserId(): string {
  return readLuminaEnv("LUMINA_CANONICAL_USER_ID") || "lumina-user:owner";
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

export async function callLuminaRuntime(
  fetchImpl: FetchFunction,
  args: LuminaRuntimeCallArgs,
): Promise<unknown> {
  const coreUrl = resolveLuminaCoreUrl();
  const routerUrl = resolveLuminaRouterUrl();
  const userId = resolveLuminaCanonicalUserId();
  const adminToken = readLuminaEnv("I24D_ADMIN_TOKEN");
  const authHeaders = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};

  if (args.action === "health") {
    const [core, extension, router] = await Promise.allSettled([
      fetchImpl(`${coreUrl}/lumina/integrations/health`),
      fetchImpl(`${coreUrl}/lumina/extension/health`),
      fetchImpl(`${routerUrl}/health`),
    ]);
    const parse = async (entry: PromiseSettledResult<Response>, label: string) =>
      entry.status === "fulfilled"
        ? readJsonResponse(entry.value, label).catch((error) => ({ ok: false, error: String(error) }))
        : { ok: false, error: String(entry.reason) };
    return {
      ok: core.status === "fulfilled" && core.value.ok,
      userId,
      core: await parse(core, "Lumina Core health"),
      extensionContract: await parse(extension, "Lumina Code contract"),
      modelRouter: await parse(router, "Lumina Model Router health"),
    };
  }

  if (args.action === "chat") {
    const message = String(args.message || "").trim();
    if (!message) throw new Error("Lumina Runtime chat requires message.");
    const response = await fetchImpl(`${coreUrl}/lumina/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        userId,
        channel: "vscode",
        context: { ...(args.context || {}), userId, client: "lumina-code" },
        provider: args.provider,
        model: args.model,
      }),
    });
    return readJsonResponse(response, "Lumina Core chat");
  }

  if (args.action === "harness_task") {
    const goal = String(args.message || "").trim();
    if (!goal) throw new Error("Lumina Harness task requires message/goal.");
    const response = await fetchImpl(`${routerUrl}/__lumina/harness/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        source: "ui",
        userId,
        mode: args.mode,
        maxIterations: args.maxIterations,
        preferBrowser: args.preferBrowser,
      }),
    });
    return readJsonResponse(response, "Lumina Harness task");
  }

  const endpoint = args.action === "memory_recent" ? "/api/memory/recent" : "/api/memory/search";
  const url = new URL(`${coreUrl}${endpoint}`);
  url.searchParams.set("userId", userId);
  if (args.action === "memory_search") {
    const query = String(args.query || args.message || "").trim();
    if (!query) throw new Error("Lumina memory search requires query.");
    url.searchParams.set("query", query);
  }
  const response = await fetchImpl(url.toString(), { headers: authHeaders });
  return readJsonResponse(response, "Lumina shared memory");
}
