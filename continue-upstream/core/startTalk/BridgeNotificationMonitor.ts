import type {
  StartTalkNotification,
  StartTalkNotificationAccess,
} from "./types.js";
import { enrichPhoneLinkNotification } from "./PhoneLinkNotificationPolicy.js";

// AMSI-safe replacement for the PowerShell UserNotificationListener monitor.
// It polls the Windows Bridge (Python WinRT listener at /notifications/live),
// which opens no window and steals no focus, and reports notifications that
// arrive after the monitor starts, plus a short catch-up window on the first
// poll (see BASELINE_CATCH_UP_MS).

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_SEEN = 400;
const MAX_NOTIFICATION_TEXT_LENGTH = 1_000;
const ERROR_STATUS_AFTER = 3;
/**
 * En el primer sondeo el Centro de actividades ya contiene todo lo que llegó
 * mientras Start Talk estaba cerrado. Leerlo entero sería recitar días de
 * atrasos, pero descartarlo entero — que es lo que se hacía — deja sin
 * mencionar NUNCA un mensaje recibido justo antes de abrir el orbe, que es
 * precisamente el que interesa. Se recupera solo lo que sigue siendo reciente.
 */
const BASELINE_CATCH_UP_MS = 5 * 60_000;
/** Tope de esa recuperación, para que abrir el orbe no dispare una parrafada. */
const MAX_BASELINE_CATCH_UP = 5;

function bridgeBaseUrl(explicit?: string): string {
  const configured =
    explicit?.trim() ||
    process.env.LUMINA_WINDOWS_BRIDGE_URL?.trim() ||
    process.env.LUMINA_BRIDGE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  const port = process.env.LUMINA_BRIDGE_PORT?.trim() || "8765";
  return `http://127.0.0.1:${port}`;
}

function trimStr(value: unknown): string {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_NOTIFICATION_TEXT_LENGTH)
    : "";
}

export interface BridgeNotificationMonitorOptions {
  onNotification: (notification: StartTalkNotification) => void;
  onStatus: (status: StartTalkNotificationAccess, message?: string) => void;
  onError?: (error: Error) => void;
  bridgeUrl?: string;
  pollIntervalMs?: number;
}

export class BridgeNotificationMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private baseline = true;
  private lastStatus?: StartTalkNotificationAccess;
  private consecutiveErrors = 0;
  private readonly seen = new Set<string>();
  private readonly base: string;
  private readonly intervalMs: number;

  constructor(private readonly options: BridgeNotificationMonitorOptions) {
    this.base = bridgeBaseUrl(options.bridgeUrl);
    this.intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    if (process.platform !== "win32") {
      this.options.onStatus(
        "unsupported",
        "Las notificaciones de Start Talk solo estan disponibles en Windows.",
      );
      return;
    }
    this.emitStatusOnce("checking");
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.seen.clear();
  }

  private emitStatusOnce(
    status: StartTalkNotificationAccess,
    message?: string,
  ): void {
    if (this.lastStatus === status) {
      return;
    }
    this.lastStatus = status;
    this.options.onStatus(status, message);
  }

  private registerError(error: Error): void {
    this.consecutiveErrors += 1;
    // A single dropped poll (bridge restart, transient) is normal; only surface
    // an error after several consecutive failures so the orb does not flicker.
    if (this.consecutiveErrors >= ERROR_STATUS_AFTER) {
      this.emitStatusOnce("error", error.message);
      this.options.onError?.(error);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.base}/notifications/live`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      if (this.stopped) {
        return;
      }
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        notifications?: unknown[];
      };
      if (!response.ok || data.ok === false) {
        if (data.error === "notification_access_denied") {
          this.emitStatusOnce(
            "denied",
            "Windows no permite leer las notificaciones.",
          );
          return;
        }
        this.registerError(new Error(data.error || `HTTP ${response.status}`));
        return;
      }

      this.consecutiveErrors = 0;
      this.emitStatusOnce("allowed");

      const list = Array.isArray(data.notifications) ? data.notifications : [];
      const currentIds = new Set<string>();
      const fresh: StartTalkNotification[] = [];
      for (const raw of list) {
        const notification = this.toNotification(raw);
        if (!notification) {
          continue;
        }
        currentIds.add(notification.id);
        if (!this.seen.has(notification.id)) {
          fresh.push(notification);
        }
      }
      for (const id of currentIds) {
        this.seen.add(id);
      }
      this.trimSeen(currentIds);

      if (this.baseline) {
        // First successful poll: lo viejo se da por visto y solo se recupera lo
        // que acaba de llegar, de lo más antiguo a lo más nuevo.
        this.baseline = false;
        for (const notification of this.selectBaselineCatchUp(fresh)) {
          if (this.stopped) {
            return;
          }
          this.options.onNotification(notification);
        }
        return;
      }
      for (const notification of fresh) {
        if (this.stopped) {
          return;
        }
        this.options.onNotification(notification);
      }
    } catch (error) {
      if (!this.stopped) {
        this.registerError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      clearTimeout(timeout);
      this.polling = false;
    }
  }

  /**
   * Las notificaciones del Centro de actividades que todavía cuentan como
   * "recién llegadas" al abrir la sesión, en orden cronológico.
   */
  private selectBaselineCatchUp(
    notifications: StartTalkNotification[],
  ): StartTalkNotification[] {
    const cutoff = Date.now() - BASELINE_CATCH_UP_MS;
    return notifications
      .map((notification) => ({
        notification,
        at: Date.parse(notification.createdAt),
      }))
      .filter(({ at }) => Number.isFinite(at) && at >= cutoff)
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_BASELINE_CATCH_UP)
      .map(({ notification }) => notification);
  }

  private trimSeen(currentIds: Set<string>): void {
    if (this.seen.size <= MAX_SEEN) {
      return;
    }
    // Keep only what is currently present so the set stays bounded; anything
    // dropped is gone from Windows too and will not re-announce.
    this.seen.clear();
    for (const id of currentIds) {
      this.seen.add(id);
    }
  }

  private toNotification(raw: unknown): StartTalkNotification | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const id = trimStr(record.id) || trimStr(record.notificationId);
    if (!id) {
      return undefined;
    }
    const textElements = Array.isArray(record.textElements)
      ? record.textElements.map(trimStr).filter(Boolean).slice(0, 8)
      : [];
    const title = trimStr(record.title);
    const body = trimStr(record.body) || undefined;
    if (!title && !body && textElements.length === 0) {
      return undefined;
    }
    return enrichPhoneLinkNotification({
      id,
      appName: trimStr(record.appName) || "Notificación",
      appUserModelId: trimStr(record.appUserModelId) || undefined,
      title,
      body,
      createdAt: trimStr(record.createdAt) || new Date().toISOString(),
      textElements,
      sourceKind: "windows",
    });
  }
}
