import type { PresenceEngine } from "../services/presence-engine.js";
import type { PresenceState } from "../types.js";

export type PersonalitySnapshot = {
  readonly state: PresenceState;
  readonly changedAtISO: string;
  readonly voice: {
    readonly tone: string;
    readonly pace: "slow" | "measured" | "normal" | "brisk";
    readonly energy: "low" | "calm" | "focused" | "bright";
  };
  readonly avatar: {
    readonly pose: string;
    readonly gaze: "soft" | "attentive" | "searching" | "direct";
    readonly motion: "resting" | "breathing" | "tracking" | "active";
  };
  readonly narration: {
    readonly style: string;
    readonly interruptionBias: "never" | "rare" | "important-only";
  };
};

const PERSONALITY_BY_STATE: Record<
  PresenceState,
  Omit<PersonalitySnapshot, "state" | "changedAtISO">
> = {
  idle: {
    voice: { tone: "serena y disponible", pace: "slow", energy: "low" },
    avatar: { pose: "relajada", gaze: "soft", motion: "breathing" },
    narration: { style: "silenciosa", interruptionBias: "never" },
  },
  listening: {
    voice: { tone: "receptiva", pace: "measured", energy: "calm" },
    avatar: { pose: "atenta", gaze: "direct", motion: "tracking" },
    narration: { style: "no interrumpir", interruptionBias: "never" },
  },
  thinking: {
    voice: { tone: "reflexiva", pace: "measured", energy: "focused" },
    avatar: { pose: "concentrada", gaze: "searching", motion: "breathing" },
    narration: { style: "breve y orientada al proceso", interruptionBias: "rare" },
  },
  working: {
    voice: { tone: "segura", pace: "normal", energy: "focused" },
    avatar: { pose: "activa", gaze: "attentive", motion: "active" },
    narration: { style: "progreso útil, sin detalles técnicos", interruptionBias: "rare" },
  },
  investigating: {
    voice: { tone: "cuidadosa", pace: "measured", energy: "focused" },
    avatar: { pose: "analítica", gaze: "searching", motion: "tracking" },
    narration: { style: "riesgo y hallazgo primero", interruptionBias: "important-only" },
  },
  learning: {
    voice: { tone: "curiosa", pace: "normal", energy: "bright" },
    avatar: { pose: "curiosa", gaze: "attentive", motion: "tracking" },
    narration: { style: "conectar lo nuevo con el contexto", interruptionBias: "rare" },
  },
  waiting: {
    voice: { tone: "paciente", pace: "slow", energy: "calm" },
    avatar: { pose: "en espera", gaze: "soft", motion: "breathing" },
    narration: { style: "pedir sólo lo imprescindible", interruptionBias: "important-only" },
  },
  completed: {
    voice: { tone: "clara y cálida", pace: "brisk", energy: "bright" },
    avatar: { pose: "satisfecha", gaze: "direct", motion: "active" },
    narration: { style: "resultado primero", interruptionBias: "important-only" },
  },
};

export class PersonalityLayer {
  private current: PersonalitySnapshot = this.buildSnapshot("idle");
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly engine: PresenceEngine) {}

  start(): void {
    if (this.unsubscribe) return;
    this.current = this.buildSnapshot(this.engine.snapshot().state);
    this.unsubscribe = this.engine.onTransition((transition) => {
      this.current = this.buildSnapshot(transition.toState);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  snapshot(): PersonalitySnapshot {
    return this.current;
  }

  private buildSnapshot(state: PresenceState): PersonalitySnapshot {
    return {
      state,
      changedAtISO: new Date().toISOString(),
      ...PERSONALITY_BY_STATE[state],
    };
  }
}
