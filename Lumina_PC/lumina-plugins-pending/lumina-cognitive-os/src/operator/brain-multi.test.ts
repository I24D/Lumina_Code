import { afterEach, describe, expect, it, vi } from "vitest";
import { createMultiProviderBrain } from "./brain-multi.js";
import type { ThinkParams } from "./brain-gemini.js";

const baseParams: ThinkParams = {
  goal: "open YouTube",
  iteration: 1,
  maxIterations: 4,
  observation: {
    foregroundProcess: "chrome.exe",
    isBrowser: true,
    interactables: [{ name: "Search", role: "textbox", bbox: { x: 1, y: 2, w: 3, h: 4 } }],
    windowTitles: ["Chrome"],
  },
  screenshotPath: null,
  history: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(body: unknown): typeof fetch {
  return vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
}

describe("createMultiProviderBrain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes an explicit OpenAI request through chat completions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = mockFetch({
      choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({
      ...baseParams,
      brainProvider: "openai",
      brainModel: "gpt-test",
    });

    expect(result.action).toMatchObject({ kind: "done", summary: "ok" });
    expect(result.brainProvider).toBe("openai");
    expect(result.brainModel).toBe("gpt-test");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gpt-test",
      response_format: { type: "json_object" },
      max_completion_tokens: 900,
    });
    // Newer OpenAI models reject the legacy max_tokens; must not send it.
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("routes an explicit Anthropic request through messages", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    const fetchImpl = mockFetch({
      content: [{ type: "text", text: '{"kind":"done","summary":"ok"}' }],
      usage: { input_tokens: 20, output_tokens: 4 },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({
      ...baseParams,
      brainProvider: "anthropic",
      brainModel: "claude-test",
    });

    expect(result.action).toMatchObject({ kind: "done", summary: "ok" });
    expect(result.brainProvider).toBe("anthropic");
    expect(result.brainModel).toBe("claude-test");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes an explicit Ollama request through /api/chat", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-test-key");
    const fetchImpl = mockFetch({
      message: { content: '{"kind":"done","summary":"ok"}' },
      prompt_eval_count: 9,
      eval_count: 2,
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({
      ...baseParams,
      brainProvider: "ollama",
      brainModel: "gemma4:31b",
    });

    expect(result.action).toMatchObject({ kind: "done", summary: "ok" });
    expect(result.brainProvider).toBe("ollama");
    expect(result.brainModel).toBe("gemma4:31b");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ollama.com/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("infers Ollama from a Gemma model when provider is auto", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("OLLAMA_API_KEY", "ollama-test-key");
    const fetchImpl = mockFetch({
      message: { content: '{"kind":"done","summary":"ok"}' },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({
      ...baseParams,
      brainProvider: "auto",
      brainModel: "gemma4:31b",
    });

    expect(result.brainProvider).toBe("ollama");
    expect(result.brainModel).toBe("gemma4:31b");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ollama.com/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses OLLAMA_CLOUD_API_KEY + BASE_URL + MODEL when set", async () => {
    vi.stubEnv("OLLAMA_CLOUD_API_KEY", "ollama-cloud-key");
    vi.stubEnv("OLLAMA_CLOUD_BASE_URL", "https://cloud.ollama.example");
    vi.stubEnv("OLLAMA_CLOUD_MODEL", "qwen3-coder:480b-cloud");
    const fetchImpl = mockFetch({
      message: { content: '{"kind":"done","summary":"ok"}' },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({
      ...baseParams,
      brainProvider: "ollama",
    });

    expect(result.brainProvider).toBe("ollama");
    expect(result.brainModel).toBe("qwen3-coder:480b-cloud");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cloud.ollama.example/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to OpenAI at runtime when Gemini throws and provider is auto", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      call += 1;
      const target = typeof url === "string" ? url : url.toString();
      if (target.includes("generativelanguage")) {
        return new Response("rate limit", { status: 429 });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    const result = await brain.think({ ...baseParams, brainProvider: "auto" });

    expect(call).toBeGreaterThanOrEqual(2);
    expect(result.brainProvider).toBe("openai");
    expect(result.action).toMatchObject({ kind: "done" });
  });

  it("does NOT fall back when provider is explicitly pinned", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = vi.fn(
      async () => new Response("rate limit", { status: 429 }),
    ) as unknown as typeof fetch;

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    await expect(
      brain.think({ ...baseParams, brainProvider: "gemini" }),
    ).rejects.toThrow();
    // exactly one call — no cascade to openai
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("exhausts the chain and reports every provider tried", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    const fetchImpl = vi.fn(
      async () => new Response("upstream down", { status: 503 }),
    ) as unknown as typeof fetch;

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    await expect(brain.think({ ...baseParams, brainProvider: "auto" })).rejects.toThrow(
      /fallback chain exhausted/i,
    );
  });

  it("skips a 429 provider immediately and does not wait for the timeout", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target.includes("generativelanguage")) {
        return new Response("rate limit", { status: 429 });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const brain = createMultiProviderBrain({
      fetchImpl,
      envPath: "C:/missing/.env",
      // A generous timeout on purpose — if 429 is not treated as
      // transient the test would hang against this budget.
      perProviderTimeoutMs: 60_000,
    });
    const t0 = Date.now();
    const result = await brain.think({ ...baseParams, brainProvider: "auto" });
    const dt = Date.now() - t0;

    expect(result.brainProvider).toBe("openai");
    // Should switch on the SAME event loop turn — measured well under 1 s.
    expect(dt).toBeLessThan(2_000);
  });

  it("routes an o-series model (gpt-5) without temperature and with developer role", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = mockFetch({
      choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    await brain.think({ ...baseParams, brainProvider: "openai", brainModel: "gpt-5-mini" });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string }>;
      temperature?: unknown;
      max_completion_tokens: number;
    };
    // Reasoning family: no temperature, developer role instead of system.
    expect(body).not.toHaveProperty("temperature");
    expect(body.messages[0]?.role).toBe("developer");
    expect(body.messages[1]?.role).toBe("user");
    expect(body.max_completion_tokens).toBe(900);
  });

  it("treats point-release gpt-5.X (5.1..5.5) as reasoning too", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = mockFetch({
      choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });

    const brain = createMultiProviderBrain({ fetchImpl, envPath: "C:/missing/.env" });
    // gpt-5.4 caused the runtime failure we hit in production; capture it
    // in the test so a future rename does not regress the detector.
    await brain.think({ ...baseParams, brainProvider: "openai", brainModel: "gpt-5.4" });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string }>;
      temperature?: unknown;
    };
    expect(body).not.toHaveProperty("temperature");
    expect(body.messages[0]?.role).toBe("developer");
  });

  it("respects the configured perProviderTimeoutMs (aborts slow provider)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target.includes("generativelanguage")) {
        // Simulate a stalled provider — wait longer than the timeout,
        // but respect the abort signal.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const abortError = new Error("aborted");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"kind":"done","summary":"ok"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const brain = createMultiProviderBrain({
      fetchImpl,
      envPath: "C:/missing/.env",
      perProviderTimeoutMs: 200,
    });
    const t0 = Date.now();
    const result = await brain.think({ ...baseParams, brainProvider: "auto" });
    const dt = Date.now() - t0;

    expect(result.brainProvider).toBe("openai");
    expect(dt).toBeLessThan(1_500);
  });
});
