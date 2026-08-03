/**
 * Lumina Claude Bridge — shared types.
 *
 * Tres destinos:
 *   - chat-app   → Claude App desktop (UI automation: focus + type + read)
 *   - code-cli   → Claude Code CLI (`claude -p "..."`) spawn directo
 *   - cowork     → Stub. Beta sin API pública estable.
 *
 * Filosofía de capabilities:
 *   Cada adapter expone qué soporta. El router rechaza requests que pidan
 *   algo que el target no puede dar y propone un fallback automático.
 */

export const CLAUDE_TARGETS = ["chat-app", "code-cli", "cowork"] as const;
export type ClaudeTarget = (typeof CLAUDE_TARGETS)[number];

export type AdapterCapabilities = {
  readonly streaming: boolean;
  readonly toolUse: boolean;
  readonly vision: boolean;
  readonly fileAttach: boolean;
  readonly structuredOutput: boolean;
};

export type RouteDecision = {
  readonly target: ClaudeTarget;
  readonly payload: string;
  readonly attachments?: ReadonlyArray<string>;
  /** Razón legible — útil para que el agente explique al user por qué fue al
   *  destino que fue. */
  readonly reasoning: string;
  /** Score 0..1 de confianza en la decisión. Bajo score = considera preguntar. */
  readonly confidence: number;
};

export type DispatchInput = {
  readonly transcript: string;
  readonly attachments?: ReadonlyArray<string>;
  /** Override del target si el caller ya sabe a dónde quiere ir. */
  readonly forceTarget?: ClaudeTarget;
  /** Hint del usuario sobre la naturaleza de la tarea. */
  readonly hint?: "chat" | "code" | "cowork";
};

export type DispatchResult =
  | {
      readonly ok: true;
      readonly target: ClaudeTarget;
      readonly reasoning: string;
      readonly response: string;
      readonly latencyMs: number;
      /** Metadatos del adapter — útil para audit / debug. */
      readonly meta?: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly target: ClaudeTarget | null;
      readonly error: string;
      readonly reason:
        | "router_no_match"
        | "capability_mismatch"
        | "target_unavailable"
        | "timeout"
        | "user_aborted"
        | "adapter_failed";
      readonly suggestedFallback?: ClaudeTarget;
    };

/** Interfaz que TODOS los adapters implementan. Permite swap en tests. */
export interface ClaudeAdapter {
  readonly target: ClaudeTarget;
  readonly capabilities: AdapterCapabilities;
  /** Verifica si el adapter puede operar AHORA (proceso vivo, CLI instalado, etc). */
  readonly available: () => Promise<boolean>;
  /** Ejecuta el request. Honra AbortSignal para cancelación por voz. */
  readonly send: (
    payload: string,
    attachments: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) => Promise<{ response: string; meta?: Record<string, unknown> }>;
}
