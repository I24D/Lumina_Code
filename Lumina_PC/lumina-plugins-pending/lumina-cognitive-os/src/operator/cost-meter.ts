/**
 * cost-meter.ts — Token + dollar accounting for the PC Operator brain.
 *
 * Each iteration of `lumina_pc_do` makes ONE multimodal LLM call. We
 * track per-step `tokensIn`/`tokensOut` (returned by the brain) and
 * multiply by the per-provider price (USD per million tokens) to get a
 * cost estimate. Accumulated in-memory for the lifetime of the process,
 * surfaced via `lumina_pc_do_cost_summary`.
 *
 * Pricing data is conservative (input + output prices as of late 2025).
 * If Dal switches to a more expensive model, the budget warning still
 * fires — we just under-count by a few cents until the table is updated.
 *
 * NOT persisted across restarts on purpose: this is "what did this dev
 * session burn?", not a billing system.
 */
import type { ActionLogStore } from "../memory/action-log.js";

export type Provider = "gemini" | "openai" | "anthropic" | "ollama";

export type Pricing = {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
};

// USD per million tokens, as of 2025-11. Conservative upper bounds.
// Update via env LUMINA_PC_OPERATOR_PRICING_<PROVIDER>_<MODEL>_IN/OUT if needed.
const DEFAULT_PRICING: Record<Provider, Record<string, Pricing>> = {
  gemini: {
    "gemini-2.5-flash":     { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    "gemini-2.5-flash-lite":{ inputPerMillion: 0.0375, outputPerMillion: 0.15 },
    "gemini-2.5-pro":       { inputPerMillion: 1.25,  outputPerMillion: 5.00 },
    "gemini-2.0-flash":     { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    "gemini-flash-latest":  { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    "gemini-pro-latest":    { inputPerMillion: 1.25,  outputPerMillion: 5.00 },
  },
  openai: {
    "gpt-4o":               { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
    "gpt-4o-mini":          { inputPerMillion: 0.15,  outputPerMillion: 0.60 },
    "gpt-4.1":              { inputPerMillion: 2.00,  outputPerMillion: 8.00 },
    "gpt-4.1-mini":         { inputPerMillion: 0.40,  outputPerMillion: 1.60 },
    "o1-mini":              { inputPerMillion: 3.00,  outputPerMillion: 12.00 },
    "o3-mini":              { inputPerMillion: 1.10,  outputPerMillion: 4.40 },
  },
  anthropic: {
    "claude-3-5-sonnet-latest": { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
    "claude-3-5-haiku-latest":  { inputPerMillion: 0.80,  outputPerMillion: 4.00 },
    "claude-opus-4-7":          { inputPerMillion: 15.00, outputPerMillion: 75.00 },
    "claude-opus-4-8":          { inputPerMillion: 15.00, outputPerMillion: 75.00 },
    "claude-sonnet-4-6":        { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  },
  ollama: {
    // Local Ollama is free; Ollama Cloud charges per token but the official
    // catalog pricing is bundled into subscriptions. Treat as 0 by default.
    "*": { inputPerMillion: 0, outputPerMillion: 0 },
  },
};

export type CostEntry = {
  readonly atISO: string;
  readonly runId: string;
  readonly iteration: number;
  readonly provider: Provider | "unknown";
  readonly model: string | "unknown";
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
};

export type ProviderTotals = {
  readonly provider: Provider | "unknown";
  readonly model: string | "unknown";
  readonly callCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
};

export type CostSummary = {
  readonly totalCalls: number;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly totalUsd: number;
  readonly byProvider: ProviderTotals[];
  readonly windowSinceISO: string;
  readonly recent: CostEntry[];
};

function lookupPricing(provider: string, model: string): Pricing {
  const table = (DEFAULT_PRICING as Record<string, Record<string, Pricing>>)[provider];
  if (!table) {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }
  if (table[model]) return table[model]!;
  // Loose prefix match (e.g. gemini-2.5-flash-image → gemini-2.5-flash)
  const prefix = Object.keys(table).find((k) => model.startsWith(k));
  if (prefix) return table[prefix]!;
  if (table["*"]) return table["*"]!;
  return { inputPerMillion: 0, outputPerMillion: 0 };
}

export class CostMeter {
  private entries: CostEntry[] = [];
  private readonly startedAtISO = new Date().toISOString();
  private readonly cap = 2_000;
  private readonly log: ActionLogStore | null;

  constructor(opts: { log?: ActionLogStore | null } = {}) {
    this.log = opts.log ?? null;
  }

  record(params: {
    runId: string;
    iteration: number;
    provider?: Provider | string | null;
    model?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
  }): CostEntry {
    const provider = (params.provider as Provider) ?? "unknown";
    const model = params.model ?? "unknown";
    const tokensIn = Math.max(0, params.tokensIn ?? 0);
    const tokensOut = Math.max(0, params.tokensOut ?? 0);
    const pricing = lookupPricing(provider, model);
    const usd = (tokensIn / 1_000_000) * pricing.inputPerMillion +
                (tokensOut / 1_000_000) * pricing.outputPerMillion;
    const entry: CostEntry = {
      atISO: new Date().toISOString(),
      runId: params.runId,
      iteration: params.iteration,
      provider: provider as Provider | "unknown",
      model: model as string,
      tokensIn,
      tokensOut,
      usd: Number(usd.toFixed(6)),
    };
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    this.log?.append({
      action: "pc_operator.cost",
      target: params.runId,
      result: "ok",
      detail: `iter ${params.iteration}: ${tokensIn} in + ${tokensOut} out = $${entry.usd.toFixed(6)} (${provider}/${model})`,
      source: "pc-operator-cost-meter",
      extra: {
        iteration: params.iteration,
        provider,
        model,
        tokensIn,
        tokensOut,
        usd: entry.usd,
      },
    });
    return entry;
  }

  summary(params: { windowSeconds?: number; limit?: number } = {}): CostSummary {
    const windowSeconds = params.windowSeconds ?? Number.POSITIVE_INFINITY;
    const cutoff = Date.now() - windowSeconds * 1_000;
    const filtered = Number.isFinite(windowSeconds)
      ? this.entries.filter((e) => Date.parse(e.atISO) >= cutoff)
      : this.entries.slice();

    const byKey = new Map<string, ProviderTotals>();
    let totalCalls = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalUsd = 0;
    for (const e of filtered) {
      const k = `${e.provider}|${e.model}`;
      const prev = byKey.get(k) ?? {
        provider: e.provider,
        model: e.model,
        callCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
      };
      byKey.set(k, {
        provider: e.provider,
        model: e.model,
        callCount: prev.callCount + 1,
        tokensIn: prev.tokensIn + e.tokensIn,
        tokensOut: prev.tokensOut + e.tokensOut,
        usd: Number((prev.usd + e.usd).toFixed(6)),
      });
      totalCalls += 1;
      totalTokensIn += e.tokensIn;
      totalTokensOut += e.tokensOut;
      totalUsd += e.usd;
    }
    const limit = params.limit ?? 20;
    return {
      totalCalls,
      totalTokensIn,
      totalTokensOut,
      totalUsd: Number(totalUsd.toFixed(6)),
      byProvider: Array.from(byKey.values()).sort((a, b) => b.usd - a.usd),
      windowSinceISO: Number.isFinite(windowSeconds)
        ? new Date(cutoff).toISOString()
        : this.startedAtISO,
      recent: filtered.slice(-limit).reverse(),
    };
  }
}
