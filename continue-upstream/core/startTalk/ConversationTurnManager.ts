/**
 * Deterministic conversation state and adaptive endpointing for Start Talk.
 *
 * Audio energy still belongs to VoiceActivityGate. This class adds the context
 * that an energy-only VAD cannot know: whether the partial sentence looks
 * unfinished, how long this user normally pauses, and which phase the runtime
 * is actually in. It deliberately has no provider or UI dependency.
 */

export type VoiceRuntimeState =
  | "IDLE"
  | "LISTENING"
  | "USER_SPEAKING"
  | "THINKING"
  | "ASSISTANT_SPEAKING"
  | "INTERRUPTED"
  | "TOOL_EXECUTION"
  | "RECONNECTING"
  | "ERROR";

export interface VoiceRuntimeSnapshot {
  state: VoiceRuntimeState;
  turnId: number;
  changedAt: number;
  reason?: string;
}

export interface AdaptiveEndpointProfile {
  /** Median pause observed inside a spoken turn. */
  averagePauseMs: number;
  /** Approximate speaking rate learned from completed turns. */
  speechRateWpm?: number;
  observedPauses: number;
  completedTurns: number;
}

export interface EndpointContext {
  baseSilenceMs: number;
  crowded: boolean;
  turnMs: number;
}

const MAX_SAMPLES = 24;
const MIN_ENDPOINT_MS = 420;
const MAX_ENDPOINT_MS = 1_600;
const SEMANTIC_GRACE_MS = 420;

const BACKCHANNELS = new Set([
  "aha",
  "ajá",
  "aja",
  "claro",
  "entiendo",
  "mhm",
  "mm",
  "ok",
  "okay",
  "sí",
  "si",
  "ya",
  "yes",
  "right",
  "got it",
  "uh huh",
]);

const TRAILING_CONTINUATIONS = new Set([
  "a",
  "además",
  "al",
  "and",
  "aunque",
  "because",
  "but",
  "con",
  "de",
  "del",
  "eh",
  "el",
  "entonces",
  "este",
  "for",
  "if",
  "la",
  "las",
  "los",
  "o",
  "or",
  "para",
  "pero",
  "porque",
  "que",
  "si",
  "sin",
  "so",
  "the",
  "to",
  "uh",
  "um",
  "with",
  "without",
  "y",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizedSpeech(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

/** True for short acknowledgements that normally should not steal the turn. */
export function isVoiceBackchannel(value: string): boolean {
  const clean = normalizedSpeech(value).replace(/[.!?,;:]+$/gu, "").trim();
  return BACKCHANNELS.has(clean);
}

/**
 * Cheap semantic endpoint signal. It never tries to understand the request;
 * it only recognises strong evidence that the speaker has not finished yet.
 */
export function looksLikeIncompleteUtterance(value: string): boolean {
  const clean = normalizedSpeech(value);
  if (!clean) {
    return false;
  }
  if (/[,:;\u2026-]$/u.test(clean) || /\.{2,}$/u.test(clean)) {
    return true;
  }

  const opens = (clean.match(/[([{]/gu) ?? []).length;
  const closes = (clean.match(/[)\]}]/gu) ?? []).length;
  if (opens > closes) {
    return true;
  }

  const lastWord = clean
    .replace(/[^\p{L}\p{N}'-]+$/gu, "")
    .split(" ")
    .at(-1);
  return Boolean(lastWord && TRAILING_CONTINUATIONS.has(lastWord));
}

export class ConversationTurnManager {
  private state: VoiceRuntimeState = "IDLE";
  private turnId = 0;
  private changedAt: number;
  private partialTranscript = "";
  private speechStartedAt?: number;
  private readonly pauses: number[] = [];
  private readonly speechRates: number[] = [];
  private completedTurns = 0;

  constructor(
    private readonly onChange?: (snapshot: VoiceRuntimeSnapshot) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.changedAt = this.now();
  }

  snapshot(): VoiceRuntimeSnapshot {
    return {
      state: this.state,
      turnId: this.turnId,
      changedAt: this.changedAt,
    };
  }

  profile(): AdaptiveEndpointProfile {
    const averagePauseMs = median(this.pauses) ?? 0;
    const speechRateWpm = median(this.speechRates);
    return {
      averagePauseMs: Math.round(averagePauseMs),
      ...(speechRateWpm !== undefined
        ? { speechRateWpm: Math.round(speechRateWpm) }
        : {}),
      observedPauses: this.pauses.length,
      completedTurns: this.completedTurns,
    };
  }

  onConnected(capturing: boolean): void {
    this.transition(capturing ? "LISTENING" : "IDLE");
  }

  onListening(): void {
    this.transition("LISTENING");
  }

  onUserSpeechStart(): void {
    this.turnId += 1;
    this.partialTranscript = "";
    this.speechStartedAt = this.now();
    this.transition("USER_SPEAKING");
  }

  onTranscript(text: string): void {
    const clean = String(text ?? "").trim();
    if (clean) {
      this.partialTranscript = clean;
    }
  }

  observePause(pauseMs: number): void {
    if (!Number.isFinite(pauseMs) || pauseMs < 80 || pauseMs > 2_500) {
      return;
    }
    this.pauses.push(Math.round(pauseMs));
    if (this.pauses.length > MAX_SAMPLES) {
      this.pauses.shift();
    }
  }

  onUserSpeechEnd(): void {
    if (this.speechStartedAt !== undefined) {
      const durationMs = Math.max(1, this.now() - this.speechStartedAt);
      const words = this.partialTranscript.split(/\s+/u).filter(Boolean).length;
      if (words >= 2 && durationMs >= 250) {
        this.speechRates.push((words * 60_000) / durationMs);
        if (this.speechRates.length > MAX_SAMPLES) {
          this.speechRates.shift();
        }
      }
    }
    this.completedTurns += 1;
    this.speechStartedAt = undefined;
    this.transition("THINKING");
  }

  onToolStart(name?: string): void {
    this.transition("TOOL_EXECUTION", name);
  }

  onAssistantAudio(): void {
    this.transition("ASSISTANT_SPEAKING");
  }

  onInterrupted(reason = "barge-in"): void {
    this.transition("INTERRUPTED", reason);
  }

  onTurnComplete(capturing: boolean): void {
    this.partialTranscript = "";
    this.speechStartedAt = undefined;
    this.transition(capturing ? "LISTENING" : "IDLE");
  }

  onReconnecting(reason?: string): void {
    this.transition("RECONNECTING", reason);
  }

  onError(reason?: string): void {
    this.transition("ERROR", reason);
  }

  onStopped(): void {
    this.partialTranscript = "";
    this.speechStartedAt = undefined;
    this.transition("IDLE");
  }

  /**
   * Computes the silence needed for this endpoint. Pauses learned from this
   * speaker protect slow speech; a visibly unfinished partial sentence gets a
   * small semantic grace period. The result stays tightly bounded so a stale
   * or bad transcript can never leave a turn hanging indefinitely.
   */
  endpointSilenceMs(context: EndpointContext): number {
    const learnedPause = median(this.pauses) ?? 0;
    let required = Math.max(
      context.baseSilenceMs,
      learnedPause > 0 ? learnedPause * 1.35 : 0,
    );

    if (looksLikeIncompleteUtterance(this.partialTranscript)) {
      required += SEMANTIC_GRACE_MS;
    } else if (
      /[.!?]$/u.test(this.partialTranscript.trim()) &&
      context.turnMs >= 500
    ) {
      required -= 80;
    }

    if (context.crowded) {
      required = Math.max(required, context.baseSilenceMs);
    }
    return Math.round(clamp(required, MIN_ENDPOINT_MS, MAX_ENDPOINT_MS));
  }

  private transition(state: VoiceRuntimeState, reason?: string): void {
    if (this.state === state && !reason) {
      return;
    }
    this.state = state;
    this.changedAt = this.now();
    this.onChange?.({
      state,
      turnId: this.turnId,
      changedAt: this.changedAt,
      ...(reason ? { reason } : {}),
    });
  }
}
