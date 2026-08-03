/**
 * Minimal OpenAI-compatible chat-completions client used by the narrator.
 *
 * We do not depend on the OpenAI SDK because we want a single small file
 * and zero supply-chain surface. The narrator only needs a one-shot
 * completion with a tight token cap, no streaming, no tool calls.
 */

export type LlmClientOptions = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
};

export type LlmRequest = {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
};

export type LlmResponse = {
  readonly ok: boolean;
  readonly text: string;
  readonly latencyMs: number;
  readonly error?: string;
};

export class LlmClient {
  constructor(private readonly opts: LlmClientOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();
    const body = {
      model: this.opts.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens ?? 80,
      temperature: req.temperature ?? 0.4,
      stream: false,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    try {
      const res = await fetch(this.opts.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          text: "",
          latencyMs: Date.now() - start,
          error: `HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = String(json.choices?.[0]?.message?.content ?? "").trim();
      return { ok: true, text, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        text: "",
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
