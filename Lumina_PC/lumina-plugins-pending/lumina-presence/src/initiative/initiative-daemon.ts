import type { PresenceLogger } from "../services/presence-engine.js";

export type InitiativePriority = "normal" | "high" | "critical";
export type InitiativeKind =
  | "task.completed"
  | "error.important"
  | "task.blocked"
  | "risk.detected";

export type InitiativeCandidate = {
  readonly kind: InitiativeKind;
  readonly priority: InitiativePriority;
  readonly dedupeKey: string;
  readonly summary: string;
  readonly detail?: string;
  readonly sessionKey?: string;
};

export type InitiativeDaemonConfig = {
  readonly enabled: boolean;
  readonly defaultSessionKey?: string;
  readonly cooldownMs: number;
  readonly dedupeWindowMs: number;
  readonly maxInitiativesPerHour: number;
  readonly quietHoursStart: number;
  readonly quietHoursEnd: number;
};

type ScheduleSessionTurn = (params: {
  sessionKey: string;
  message: string;
  delayMs: number;
  deleteAfterRun: boolean;
  deliveryMode: "announce";
  name: string;
  tag: string;
}) => Promise<unknown | undefined>;

export type InitiativeSnapshot = {
  readonly enabled: boolean;
  readonly lastSessionKey: string | null;
  readonly lastInitiativeAtISO: string | null;
  readonly initiativesLastHour: number;
  readonly suppressed: number;
};

export class InitiativeDaemon {
  private lastSessionKey: string | null;
  private lastInitiativeAtMs = 0;
  private readonly recentInitiativesMs: number[] = [];
  private readonly lastByDedupeKey = new Map<string, number>();
  private suppressed = 0;

  constructor(
    private readonly config: InitiativeDaemonConfig,
    private readonly scheduleSessionTurn: ScheduleSessionTurn,
    private readonly logger: PresenceLogger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lastSessionKey = config.defaultSessionKey?.trim() || null;
  }

  rememberSession(sessionKey: string | undefined): void {
    const normalized = sessionKey?.trim();
    if (normalized) this.lastSessionKey = normalized;
  }

  async consider(candidate: InitiativeCandidate): Promise<boolean> {
    if (!this.config.enabled) return false;
    this.rememberSession(candidate.sessionKey);
    const sessionKey = candidate.sessionKey?.trim() || this.lastSessionKey;
    if (!sessionKey) return this.suppress("no-session", candidate);

    const now = this.now();
    const nowMs = now.getTime();
    this.prune(nowMs);

    if (candidate.priority !== "critical" && this.isQuietHour(now.getHours())) {
      return this.suppress("quiet-hours", candidate);
    }
    if (
      this.lastInitiativeAtMs > 0 &&
      nowMs - this.lastInitiativeAtMs < this.config.cooldownMs
    ) {
      return this.suppress("cooldown", candidate);
    }
    const duplicateAt = this.lastByDedupeKey.get(candidate.dedupeKey);
    if (duplicateAt !== undefined && nowMs - duplicateAt < this.config.dedupeWindowMs) {
      return this.suppress("duplicate", candidate);
    }
    if (this.recentInitiativesMs.length >= this.config.maxInitiativesPerHour) {
      return this.suppress("hourly-limit", candidate);
    }

    const handle = await this.scheduleSessionTurn({
      sessionKey,
      message: buildInitiativePrompt(candidate),
      delayMs: 750,
      deleteAfterRun: true,
      deliveryMode: "announce",
      name: "Lumina initiative",
      tag: "lumina-initiative",
    });
    if (!handle) return this.suppress("scheduler-unavailable", candidate);

    this.lastInitiativeAtMs = nowMs;
    this.lastByDedupeKey.set(candidate.dedupeKey, nowMs);
    this.recentInitiativesMs.push(nowMs);
    this.logger.info("[lumina-presence] initiative scheduled", {
      kind: candidate.kind,
      priority: candidate.priority,
      sessionKey,
    });
    return true;
  }

  snapshot(): InitiativeSnapshot {
    const nowMs = this.now().getTime();
    this.prune(nowMs);
    return {
      enabled: this.config.enabled,
      lastSessionKey: this.lastSessionKey,
      lastInitiativeAtISO:
        this.lastInitiativeAtMs > 0 ? new Date(this.lastInitiativeAtMs).toISOString() : null,
      initiativesLastHour: this.recentInitiativesMs.length,
      suppressed: this.suppressed,
    };
  }

  private isQuietHour(hour: number): boolean {
    const start = this.config.quietHoursStart;
    const end = this.config.quietHoursEnd;
    if (start === end) return false;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - 60 * 60_000;
    while (this.recentInitiativesMs[0] !== undefined && this.recentInitiativesMs[0] < cutoff) {
      this.recentInitiativesMs.shift();
    }
    for (const [key, at] of this.lastByDedupeKey) {
      if (nowMs - at >= this.config.dedupeWindowMs) this.lastByDedupeKey.delete(key);
    }
  }

  private suppress(reason: string, candidate: InitiativeCandidate): false {
    this.suppressed += 1;
    this.logger.info("[lumina-presence] initiative suppressed", {
      reason,
      kind: candidate.kind,
      priority: candidate.priority,
    });
    return false;
  }
}

function buildInitiativePrompt(candidate: InitiativeCandidate): string {
  const detail = sanitizeDetail(candidate.detail);
  return [
    "[Lumina Initiative]",
    "Inicia una sola actualización proactiva para Dal en español.",
    `Motivo: ${candidate.summary}`,
    detail ? `Contexto seguro: ${detail}` : "",
    "Sé breve, humana y útil. No leas JSON, logs, stack traces ni rutas completas.",
    "Si no hay una acción concreta o el dato ya no es relevante, responde NO_REPLY.",
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeDetail(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[ruta]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
