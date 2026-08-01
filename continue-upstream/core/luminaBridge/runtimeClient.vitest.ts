import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchFunction } from "../index.js";
import { resetLuminaEnvCache } from "./luminaEnv.js";
import { callLuminaRuntime } from "./runtimeClient.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetLuminaEnvCache();
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("callLuminaRuntime", () => {
  it("sends Lumina Code chat through Core with the canonical user", async () => {
    vi.stubEnv("LUMINA_CORE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("LUMINA_CANONICAL_USER_ID", "lumina-user:owner");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: "ok" }));

    await callLuminaRuntime(fetchImpl as unknown as FetchFunction, {
      action: "chat",
      message: "Explain this file",
      context: { workspace: "test" },
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/lumina/chat");
    expect(JSON.parse(String(init.body))).toMatchObject({
      userId: "lumina-user:owner",
      channel: "vscode",
      message: "Explain this file",
      context: { userId: "lumina-user:owner", client: "lumina-code" },
    });
  });

  it("routes operational work through the shared Harness endpoint", async () => {
    vi.stubEnv("MODEL_ROUTER_URL", "http://127.0.0.1:4321");
    vi.stubEnv("LUMINA_CANONICAL_USER_ID", "lumina-user:owner");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await callLuminaRuntime(fetchImpl as unknown as FetchFunction, {
      action: "harness_task",
      message: "Open Chrome and verify it is visible",
      mode: "simulate",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/__lumina/harness/run");
    expect(JSON.parse(String(init.body))).toMatchObject({
      goal: "Open Chrome and verify it is visible",
      userId: "lumina-user:owner",
      mode: "simulate",
    });
  });
});
