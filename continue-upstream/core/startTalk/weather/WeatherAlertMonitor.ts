/**
 * Vigilancia de avisos meteorológicos oficiales.
 *
 * Calcado de `BridgeNotificationMonitor`: sondea, recuerda lo ya visto y solo
 * emite lo NUEVO. La diferencia importante es el arranque: al conectar, los
 * avisos que ya estaban activos no se anuncian —el usuario lleva horas con
 * ellos— pero sí se recuerdan, para que si aparece uno distinto se cante.
 *
 * Solo WeatherAPI publica avisos oficiales, así que si su clave falta el
 * monitor no arranca en vez de sondear en vano.
 */
import type { WeatherAlert } from "./types.js";
import type { WeatherOracle } from "./WeatherOracle.js";

const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;
const MAX_REMEMBERED = 60;

export interface WeatherAlertMonitorOptions {
  oracle: WeatherOracle;
  onAlerts: (alerts: WeatherAlert[]) => void;
  onError?: (error: Error) => void;
  /** Ubicación a vigilar. Sin ella se usa la que resuelva el oráculo. */
  location?: string;
  pollIntervalMs?: number;
}

export class WeatherAlertMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private baseline = true;
  private readonly seen = new Set<string>();

  constructor(private readonly options: WeatherAlertMonitorOptions) {}

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    void this.poll();
    this.timer = setInterval(
      () => void this.poll(),
      this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.seen.clear();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const answer = await this.options.oracle.answer({
        intent: "alerts",
        location: this.options.location,
      });
      if (this.stopped) {
        return;
      }
      if (answer.error) {
        this.options.onError?.(new Error(answer.error));
        return;
      }

      const alerts = answer.alerts ?? [];
      const fresh = alerts.filter((alert) => !this.seen.has(alert.id));
      for (const alert of alerts) {
        this.seen.add(alert.id);
      }
      this.trim(alerts);

      if (this.baseline) {
        // Lo que ya estaba activo al conectar no se canta: el usuario lo sabe.
        this.baseline = false;
        return;
      }
      if (fresh.length > 0) {
        this.options.onAlerts(fresh);
      }
    } catch (error) {
      if (!this.stopped) {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      this.polling = false;
    }
  }

  private trim(current: WeatherAlert[]): void {
    if (this.seen.size <= MAX_REMEMBERED) {
      return;
    }
    // Se conserva solo lo vigente; lo caducado tampoco puede repetirse.
    this.seen.clear();
    for (const alert of current) {
      this.seen.add(alert.id);
    }
  }
}
