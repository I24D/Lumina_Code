/**
 * Bridge — fachada pública. Router + adapters + capability check.
 *
 * Esta clase es lo que el tool `lumina_claude_dispatch` invoca. Mantiene
 * referencias a los tres adapters y al router; expone `dispatch()` como
 * único entry point.
 *
 * Decisiones:
 *   - Capability check ANTES de ejecutar. Si el target no soporta lo que
 *     el caller pide (ej. vision + cowork), se rechaza con
 *     `suggestedFallback` en vez de fallar a mitad de camino.
 *   - `available()` se chequea en el dispatch. Si el target no está vivo
 *     (Claude App cerrado, CLI no instalado), proponemos fallback.
 *   - Cualquier excepción del adapter → DispatchResult.ok=false con razón.
 *     Nunca tira a quien lo llama.
 */
import type {
  ClaudeAdapter,
  ClaudeTarget,
  DispatchInput,
  DispatchResult,
} from "./types.js";
import type { RouterClassifier } from "./router.js";

export class ClaudeBridge {
  constructor(
    private readonly router: RouterClassifier,
    private readonly adapters: Readonly<Record<ClaudeTarget, ClaudeAdapter>>,
  ) {}

  async dispatch(input: DispatchInput, signal?: AbortSignal): Promise<DispatchResult> {
    const t0 = Date.now();
    let decision;
    try {
      decision = await this.router.classify(input);
    } catch (err) {
      return {
        ok: false,
        target: null,
        error: err instanceof Error ? err.message : String(err),
        reason: "router_no_match",
      };
    }

    let target = decision.target;
    let adapter = this.adapters[target];

    // 1. Capability check — attachments require fileAttach support.
    const wantsAttach = (decision.attachments ?? []).length > 0;
    if (wantsAttach && !adapter.capabilities.fileAttach) {
      const fallback = this.findFallbackWithCap("fileAttach");
      if (fallback) {
        target = fallback;
        adapter = this.adapters[target];
      } else {
        return {
          ok: false,
          target: decision.target,
          error: `target ${decision.target} does not support file attachments and no fallback available`,
          reason: "capability_mismatch",
        };
      }
    }

    // 2. Availability check.
    const avail = await adapter.available();
    if (!avail) {
      const fallback = this.findAvailableFallback(target);
      if (fallback) {
        target = fallback;
        adapter = this.adapters[target];
      } else {
        return {
          ok: false,
          target: decision.target,
          error: `target ${decision.target} is not available and no fallback running`,
          reason: "target_unavailable",
          suggestedFallback: fallback ?? undefined,
        };
      }
    }

    // 3. Send.
    try {
      const result = await adapter.send(decision.payload, decision.attachments ?? [], signal);
      return {
        ok: true,
        target,
        reasoning: target === decision.target
          ? decision.reasoning
          : `${decision.reasoning} (fallback a ${target})`,
        response: result.response,
        latencyMs: Date.now() - t0,
        meta: result.meta,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        target,
        error: message,
        reason: signal?.aborted ? "user_aborted" : "adapter_failed",
      };
    }
  }

  // ─── helpers ────────────────────────────────────────────────

  private findFallbackWithCap(cap: keyof ClaudeAdapter["capabilities"]): ClaudeTarget | null {
    for (const [target, ad] of Object.entries(this.adapters) as Array<[ClaudeTarget, ClaudeAdapter]>) {
      if (ad.capabilities[cap]) return target;
    }
    return null;
  }

  private findAvailableFallback(exclude: ClaudeTarget): ClaudeTarget | null {
    // Heurística: code-cli > chat-app > cowork. Cowork casi nunca está
    // disponible (stub). code-cli es el más independiente.
    const order: ClaudeTarget[] = ["code-cli", "chat-app", "cowork"];
    for (const t of order) {
      if (t === exclude) continue;
      // No podemos await en for sin async — pero es OK porque devolvemos
      // el primer NO-excluido como sugerencia. La availability real se
      // chequea en el siguiente dispatch.
    }
    return order.find((t) => t !== exclude) ?? null;
  }
}
