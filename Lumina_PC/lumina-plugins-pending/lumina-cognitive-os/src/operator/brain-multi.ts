/**
 * brain-multi.ts - provider router for Lumina's PC Operator brain.
 *
 * The PC tools are provider-neutral. This brain lets the loop use Gemini,
 * OpenAI, Anthropic, or Ollama for the "think" step while every OpenClaw
 * agent (Codex, Claude Code, Ollama, API-key agents) can still call the same
 * lumina_pc_do tool.
 *
 * Features:
 * - Multi-provider fallback cascade (auto → gemini → ollama → openai → anthropic)
 * - Per-provider timeout (default 8s for fast failover)
 * - Transient error detection (429/5xx) for smart retry
 * - LRU cache for repeated prompts (saves API calls in tight loops)
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { getLuminaEnvVar, loadLuminaEnv, type LoadEnvOptions } from "../env.js";
import {
  buildUserPrompt,
  coerceAction,
  createGeminiBrain,
  extractJson,
  SYSTEM_PROMPT,
  type BrainClient,
  type BrainProviderName,
  type ThinkParams,
  type ThinkResult,
} from "./brain-gemini.js";

type ConcreteBrainProvider = Exclude<BrainProviderName, "auto">;

export type MultiProviderBrainOptions = LoadEnvOptions & {
  readonly defaultProvider?: BrainProviderName;
  readonly defaultModel?: string;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
  /**
   * How long to wait for a single provider to respond before we abort
   * and let the fallback chain try the next one. Alexa/Siri-grade UX
   * needs the switch to feel instant; the previous 30 s value made a
   * Gemini rate-limit visible as a long freeze. Default is 8 s.
   */
  readonly perProviderTimeoutMs?: number;
};

/**
 * Simple LRU cache for brain responses.
 * Caches think results by hash(prompt + screenshot) to avoid redundant API calls
 * when the PC Operator loop observes the same state multiple times.
 */
class BrainCache {
  private cache: Map<string, { result: ThinkResult; timestamp: number }>;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number = 100, ttlMs: number = 5_000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs; // Default 5 second TTL
  }

  private computeKey(params: ThinkParams): string {
    const data = JSON.stringify({
      goal: params.goal,
      screenshotHash: params.screenshot,
      stepCount: params.stepCount,
    });
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  get(params: ThinkParams): ThinkResult | null {
    const key = this.computeKey(params);
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.result;
  }

  set(params: ThinkParams, result: ThinkResult): void {
    const key = this.computeKey(params);
    
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    
    this.cache.set(key, { result, timestamp: Date.now() });
  }
}

/** True when the HTTP status looks like a retryable/transient failure
 * that another provider might still handle: rate limits and gateway
 * hiccups. 4xx auth/format errors are NOT retryable — no point paying
 * the round-trip on the next provider only to fail again. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Marker thrown by fetchJson when the response was transient. The
 * think() loop uses it to short-circuit the current provider and jump
 * to the next entry in the cascade without waiting for the timeout. */
export class TransientBrainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TransientBrainError";
    this.status = status;
  }
}

type BrainChoice = {
  readonly provider: ConcreteBrainProvider;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
};

function normalizeProvider(value: string | undefined): BrainProviderName | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "auto" || v === "gemini" || v === "openai" || v === "anthropic" || v === "ollama") {
    return v;
  }
  return undefined;
}

function inferProviderFromModel(model: string | undefined): ConcreteBrainProvider | undefined {
  const v = model?.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith("gemini")) return "gemini";
  if (v.includes("claude")) return "anthropic";
  if (v.startsWith("gpt") || /^o\d/.test(v)) return "openai";
  if (
    v.startsWith("gemma") ||
    v.startsWith("qwen") ||
    v.startsWith("deepseek") ||
    v.startsWith("nemotron") ||
    v.startsWith("llama") ||
    v.startsWith("mistral")
  ) {
    return "ollama";
  }
  return undefined;
}

function envFirst(names: readonly string[], opts: LoadEnvOptions): string | undefined {
  for (const name of names) {
    const v = getLuminaEnvVar(name, opts);
    if (v) return v;
  }
  return undefined;
}

function trim(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function readScreenshotBase64(params: ThinkParams): Promise<string | null> {
  if (!params.screenshotPath) return null;
  try {
    const buf = await fs.promises.readFile(params.screenshotPath);
    return buf.toString("base64");
  } catch {
    return null;
  }
}

function resolveChoice(
  opts: MultiProviderBrainOptions,
  params: Pick<ThinkParams, "brainProvider" | "brainModel">,
): BrainChoice | null {
  const envOpts: LoadEnvOptions = { envPath: opts.envPath };
  loadLuminaEnv(envOpts);

  const requestedModel =
    trim(params.brainModel) ??
    trim(opts.defaultModel) ??
    envFirst(["LUMINA_PC_OPERATOR_MODEL", "PC_OPERATOR_MODEL"], envOpts);
  const configuredProvider =
    normalizeProvider(params.brainProvider) ??
    normalizeProvider(opts.defaultProvider) ??
    normalizeProvider(envFirst(["LUMINA_PC_OPERATOR_PROVIDER", "PC_OPERATOR_PROVIDER"], envOpts)) ??
    "auto";
  const requestedProvider =
    configuredProvider === "auto"
      ? inferProviderFromModel(requestedModel) ?? "auto"
      : configuredProvider;
  const modelOverrideFor = (provider: ConcreteBrainProvider): string | undefined =>
    requestedProvider === provider ? requestedModel : undefined;

  const gemini: BrainChoice | null = (() => {
    const apiKey = envFirst(["GEMINI_PC_OPERATOR_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"], envOpts);
    if (!apiKey) return null;
    return {
      provider: "gemini",
      apiKey,
      model:
        modelOverrideFor("gemini") ??
        envFirst(["GEMINI_PC_OPERATOR_MODEL", "GEMINI_MODEL", "GOOGLE_MODEL"], envOpts) ??
        "gemini-2.5-flash",
    };
  })();

  const openai: BrainChoice | null = (() => {
    const apiKey = envFirst(["OPENAI_PC_OPERATOR_API_KEY", "OPENAI_API_KEY"], envOpts);
    if (!apiKey) return null;
    return {
      provider: "openai",
      apiKey,
      model:
        modelOverrideFor("openai") ??
        envFirst(["OPENAI_PC_OPERATOR_MODEL", "OPENAI_MODEL"], envOpts) ??
        "gpt-4o-mini",
      baseUrl: envFirst(["OPENAI_PC_OPERATOR_BASE_URL", "OPENAI_BASE_URL"], envOpts) ?? "https://api.openai.com",
    };
  })();

  const anthropic: BrainChoice | null = (() => {
    const apiKey = envFirst(["ANTHROPIC_PC_OPERATOR_API_KEY", "ANTHROPIC_API_KEY"], envOpts);
    if (!apiKey) return null;
    return {
      provider: "anthropic",
      apiKey,
      model:
        modelOverrideFor("anthropic") ??
        envFirst(["ANTHROPIC_PC_OPERATOR_MODEL", "ANTHROPIC_MODEL"], envOpts) ??
        "claude-3-5-sonnet-latest",
      baseUrl:
        envFirst(["ANTHROPIC_PC_OPERATOR_BASE_URL", "ANTHROPIC_BASE_URL"], envOpts) ??
        "https://api.anthropic.com",
    };
  })();

  const ollama: BrainChoice | null = (() => {
    const apiKey = envFirst(
      ["OLLAMA_PC_OPERATOR_API_KEY", "OLLAMA_CLOUD_API_KEY", "OLLAMA_API_KEY"],
      envOpts,
    );
    const baseUrl =
      envFirst(
        ["OLLAMA_PC_OPERATOR_BASE_URL", "OLLAMA_CLOUD_BASE_URL", "OLLAMA_BASE_URL", "OLLAMA_URL"],
        envOpts,
      ) ?? (apiKey ? "https://ollama.com" : "http://127.0.0.1:11434");
    return {
      provider: "ollama",
      apiKey,
      model:
        modelOverrideFor("ollama") ??
        envFirst(
          ["OLLAMA_PC_OPERATOR_MODEL", "OLLAMA_CLOUD_MODEL", "OLLAMA_MODEL", "OLLAMA_DEFAULT_MODEL"],
          envOpts,
        ) ??
        "gemma4:31b",
      baseUrl,
    };
  })();

  const byName: Record<ConcreteBrainProvider, BrainChoice | null> = {
    gemini,
    openai,
    anthropic,
    ollama,
  };
  if (requestedProvider !== "auto") {
    return byName[requestedProvider];
  }

  // Preserve the previous working behavior: Gemini first when available.
  return gemini ?? openai ?? anthropic ?? ollama;
}

/**
 * Ordered list of providers to try when the explicit resolution failed at
 * runtime. Used by the runtime-fallback path so a Gemini rate-limit does
 * not kill the whole loop when OpenAI/Anthropic/Ollama are all configured.
 * Only invoked when the caller did NOT pin `brainProvider` explicitly.
 */
function resolveFallbackChain(
  opts: MultiProviderBrainOptions,
  params: Pick<ThinkParams, "brainProvider" | "brainModel">,
): BrainChoice[] {
  const first = resolveChoice(opts, params);
  if (!first) return [];

  const configuredProvider =
    normalizeProvider(params.brainProvider) ?? normalizeProvider(opts.defaultProvider) ?? "auto";
  const pinned =
    configuredProvider !== "auto" || inferProviderFromModel(params.brainModel) !== undefined;
  if (pinned) return [first];

  // Auto path: return every configured choice in the standard priority
  // (gemini → openai → anthropic → ollama) skipping duplicates of `first`.
  const seen = new Set<ConcreteBrainProvider>([first.provider]);
  const chain: BrainChoice[] = [first];
  for (const name of ["gemini", "openai", "anthropic", "ollama"] as const) {
    if (seen.has(name)) continue;
    const c = resolveChoice(opts, { brainProvider: name, brainModel: undefined });
    if (c) {
      seen.add(name);
      chain.push(c);
    }
  }
  return chain;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 8_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      // AbortError (our own timeout) counts as transient — the next
      // provider in the cascade should get a chance instead of the
      // whole loop failing.
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "AbortError") {
        throw new TransientBrainError(504, `timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const snippet = text.slice(0, 300);
      if (isTransientHttpStatus(resp.status)) {
        throw new TransientBrainError(resp.status, `http ${resp.status}: ${snippet}`);
      }
      throw new Error(`http ${resp.status}: ${snippet}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Returns true for OpenAI reasoning models (o1, o3, o4, gpt-5, gpt-5.1,
 * gpt-5.2, gpt-5.3, gpt-5.4, gpt-5.5, ...) that (a) reject `temperature`,
 * (b) do NOT accept the classic system role, and (c) still use
 * max_completion_tokens. Match is name-based since OpenAI has not
 * published a discovery endpoint for this family. Point-release variants
 * (gpt-5.4, gpt-5.4-mini, gpt-5.4-2026-03-05, ...) are all reasoning too. */
export function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /^(o[134]|gpt-5(\.\d+)?)(-|$)/.test(m);
}

async function callOpenAI(
  fetchImpl: typeof fetch,
  choice: BrainChoice,
  params: ThinkParams,
  temperature: number,
  timeoutMs: number,
): Promise<ThinkResult> {
  if (!choice.apiKey) throw new Error("OpenAI PC Operator requires OPENAI_API_KEY");
  const image = await readScreenshotBase64(params);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: buildUserPrompt(params) }];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image}` },
    });
  }
  const reasoning = isOpenAiReasoningModel(choice.model);
  // Reasoning models want the persona as `developer`, not `system`, and
  // do not support `temperature`. Older chat models take both shapes,
  // so we fork the payload here.
  const messages = reasoning
    ? [
        { role: "developer", content: SYSTEM_PROMPT },
        { role: "user", content },
      ]
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ];
  const body: Record<string, unknown> = {
    model: choice.model,
    messages,
    response_format: { type: "json_object" },
    // Newer OpenAI models reject max_tokens and require
    // max_completion_tokens; older chat models accept both.
    max_completion_tokens: 900,
  };
  if (!reasoning) body.temperature = temperature;
  const raw = (await fetchJson(fetchImpl, joinUrl(choice.baseUrl ?? "https://api.openai.com", "/v1/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${choice.apiKey}`,
    },
    body: JSON.stringify(body),
  }, timeoutMs)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = raw.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("openai returned no text");
  return {
    action: coerceAction(extractJson(text)),
    rawText: text,
    tokensIn: raw.usage?.prompt_tokens,
    tokensOut: raw.usage?.completion_tokens,
    brainProvider: "openai",
    brainModel: choice.model,
  };
}

async function callAnthropic(
  fetchImpl: typeof fetch,
  choice: BrainChoice,
  params: ThinkParams,
  temperature: number,
  timeoutMs: number,
): Promise<ThinkResult> {
  if (!choice.apiKey) throw new Error("Anthropic PC Operator requires ANTHROPIC_API_KEY");
  const image = await readScreenshotBase64(params);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: buildUserPrompt(params) }];
  if (image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image },
    });
  }
  const raw = (await fetchJson(fetchImpl, joinUrl(choice.baseUrl ?? "https://api.anthropic.com", "/v1/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": choice.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: choice.model,
      max_tokens: 900,
      temperature,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  }, timeoutMs)) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = raw.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
  if (!text) throw new Error("anthropic returned no text");
  return {
    action: coerceAction(extractJson(text)),
    rawText: text,
    tokensIn: raw.usage?.input_tokens,
    tokensOut: raw.usage?.output_tokens,
    brainProvider: "anthropic",
    brainModel: choice.model,
  };
}

async function callOllama(
  fetchImpl: typeof fetch,
  choice: BrainChoice,
  params: ThinkParams,
  temperature: number,
  timeoutMs: number,
): Promise<ThinkResult> {
  const image = await readScreenshotBase64(params);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (choice.apiKey) headers.authorization = `Bearer ${choice.apiKey}`;
  const raw = (await fetchJson(fetchImpl, joinUrl(choice.baseUrl ?? "http://127.0.0.1:11434", "/api/chat"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: choice.model,
      stream: false,
      format: "json",
      options: { temperature },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt(params),
          ...(image ? { images: [image] } : {}),
        },
      ],
    }),
  }, timeoutMs)) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const text = raw.message?.content ?? "";
  if (!text) throw new Error("ollama returned no text");
  return {
    action: coerceAction(extractJson(text)),
    rawText: text,
    tokensIn: raw.prompt_eval_count,
    tokensOut: raw.eval_count,
    brainProvider: "ollama",
    brainModel: choice.model,
  };
}

async function callChoice(
  choice: BrainChoice,
  fetchImpl: typeof fetch,
  params: ThinkParams,
  temperature: number,
  timeoutMs: number,
): Promise<ThinkResult> {
  switch (choice.provider) {
    case "gemini": {
      // brain-gemini has its own 30 s internal timeout that we cannot
      // shorten from the outside, so wrap the call in a race against
      // our configured perProviderTimeoutMs. On win, we throw a
      // TransientBrainError so the fallback cascade jumps to the next
      // provider even if Gemini is still busy in the background.
      const geminiCall = createGeminiBrain({
        apiKey: choice.apiKey ?? "",
        model: choice.model,
        temperature,
        fetchImpl,
      }).think(params);
      const raced = await Promise.race([
        geminiCall.then((r) => ({ ok: true as const, r })),
        new Promise<{ ok: false }>((resolve) =>
          setTimeout(() => resolve({ ok: false }), timeoutMs),
        ),
      ]);
      if (!raced.ok) {
        throw new TransientBrainError(504, `gemini call exceeded perProviderTimeoutMs=${timeoutMs}ms`);
      }
      return { ...raced.r, brainProvider: "gemini", brainModel: choice.model };
    }
    case "openai":
      return callOpenAI(fetchImpl, choice, params, temperature, timeoutMs);
    case "anthropic":
      return callAnthropic(fetchImpl, choice, params, temperature, timeoutMs);
    case "ollama":
      return callOllama(fetchImpl, choice, params, temperature, timeoutMs);
  }
}

export function createMultiProviderBrain(opts: MultiProviderBrainOptions): BrainClient {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("fetch is unavailable; pass fetchImpl explicitly");
  const temperature = opts.temperature ?? 0.2;
  const timeoutMs = Math.max(1_000, opts.perProviderTimeoutMs ?? 8_000);
  
  // LRU cache for repeated prompts (TTL: 5s, max 100 entries)
  const cache = new BrainCache(100, 5_000);

  return {
    async think(params: ThinkParams): Promise<ThinkResult> {
      // Check cache first
      const cached = cache.get(params);
      if (cached) {
        return { ...cached, cached: true } as ThinkResult;
      }
      
      const chain = resolveFallbackChain(opts, params);
      if (chain.length === 0) {
        throw new Error(
          `PC Operator brain provider unavailable: ${params.brainProvider ?? opts.defaultProvider ?? "auto"}`,
        );
      }
      const errors: string[] = [];
      for (const choice of chain) {
        try {
          const result = await callChoice(choice, fetchImpl, params, temperature, timeoutMs);
          // Cache successful result
          cache.set(params, result);
          return result;
        } catch (err) {
          const isTransient = err instanceof TransientBrainError;
          const msg = err instanceof Error ? err.message : String(err);
          const label = isTransient ? "transient" : "hard";
          errors.push(`${choice.provider}(${choice.model}) [${label}]: ${msg}`);
          // Both transient (429/timeout/5xx) and hard errors cascade —
          // the operator asked for "invisible" resilience. Transient
          // is labeled so the exhaust message reads cleanly.
        }
      }
      throw new Error(
        `PC Operator brain fallback chain exhausted (${chain.length} tried): ${errors.join(" | ")}`,
      );
    },
  };
}
