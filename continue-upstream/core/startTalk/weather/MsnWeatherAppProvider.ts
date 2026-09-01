/**
 * App MSN El Tiempo — la voz.
 *
 * No está aquí como plan B de las APIs. Aporta dos cosas que ninguna API da:
 * la ubicación que el usuario YA tiene configurada, y una prosa redactada en
 * español ("Subirá hasta llegar a un pico de 31° a las 16:00") que es
 * exactamente lo que se quiere decir en voz alta en lugar de recitar números.
 *
 * A cambio cuesta entre 8 y 20 segundos y abre una ventana, así que el oráculo
 * solo la usa cuando se pide narrativa o cuando no queda otra.
 */
import { readLuminaEnv } from "../../luminaBridge/luminaEnv.js";
import { classifyConditionText } from "./conditions.js";
import type {
  WeatherBundle,
  WeatherCapability,
  WeatherDailyPoint,
  WeatherNarrativeCard,
  WeatherProvider,
  WeatherQuery,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_DAYS = 10;

const CAPABILITIES: ReadonlySet<WeatherCapability> = new Set<WeatherCapability>([
  "current",
  "daily",
  "narrative",
  "astronomy",
]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bridgeBaseUrl(): string {
  const configured =
    readLuminaEnv("LUMINA_WINDOWS_BRIDGE_URL") ??
    readLuminaEnv("LUMINA_BRIDGE_URL");
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  return `http://127.0.0.1:${readLuminaEnv("LUMINA_BRIDGE_PORT") ?? "8765"}`;
}

/** "28 °C" / "-3°" → -3. La app siempre publica métrico. */
export function parseTemperature(value: string): number | undefined {
  const match = /(-?\d+(?:[.,]\d+)?)/u.exec(value ?? "");
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * "viento 4 km/h", "humedad 58%", "Índice UV 3" → campos.
 * La app los publica como una tira de enlaces con el texto ya formado, que es
 * lo único estable entre versiones; los ids de esos elementos no lo son.
 */
export function parseMetricStrip(metrics: string[]): {
  humidity?: number;
  windKph?: number;
  feelsLikeC?: number;
  uvIndex?: number;
  pressureMb?: number;
  visibilityKm?: number;
} {
  const out: ReturnType<typeof parseMetricStrip> = {};
  for (const entry of metrics) {
    const value = parseTemperature(entry);
    if (value === undefined) continue;
    if (/humedad|humidity/iu.test(entry)) out.humidity = value;
    else if (/viento|wind/iu.test(entry)) out.windKph = value;
    else if (/sensaci|feels/iu.test(entry)) out.feelsLikeC = value;
    else if (/uv/iu.test(entry)) out.uvIndex = value;
    else if (/presi|pressure/iu.test(entry)) out.pressureMb = value;
    else if (/visibil/iu.test(entry)) out.visibilityKm = value;
  }
  return out;
}

/**
 * La app da la hora de observación como reloj local ("12:21 PM") y no la fecha.
 * Se ancla al día de hoy para poder compararla con el ISO de las APIs.
 */
export function resolveObservedAt(clock: string, now = new Date()): string {
  const match = /^(\d{1,2}):(\d{2})\s*([AaPp])?/u.exec(clock ?? "");
  if (!match) {
    return now.toISOString();
  }
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "p" && hours < 12) hours += 12;
  if (meridiem === "a" && hours === 12) hours = 0;
  const stamped = new Date(now);
  stamped.setHours(hours, minutes, 0, 0);
  // Un reloj por delante del ahora solo puede ser de ayer.
  if (stamped.getTime() - now.getTime() > 60_000) {
    stamped.setDate(stamped.getDate() - 1);
  }
  return stamped.toISOString();
}

export class MsnWeatherAppProvider implements WeatherProvider {
  readonly id = "msn-app" as const;
  readonly label = "MSN El Tiempo";
  readonly capabilities = CAPABILITIES;
  readonly typicalLatencyMs = 12_000;

  constructor(private readonly baseUrl = bridgeBaseUrl()) {}

  /** Solo existe en Windows y a través del puente local. */
  isConfigured(): boolean {
    return process.platform === "win32";
  }

  async fetch(query: WeatherQuery): Promise<WeatherBundle> {
    // La app lee la ubicación que tiene configurada; cambiarla exigiría teclear
    // en su buscador, así que una ciudad concreta no es cosa suya.
    if (query.location) {
      return { source: this.id, error: "app_reads_configured_location_only" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/weather/msn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          days: Math.max(1, Math.min(MAX_DAYS, query.days ?? 5)),
        }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok || data.ok !== true) {
        return {
          source: this.id,
          error: str(data.error) || `msn_app_http_${response.status}`,
        };
      }
      return this.toBundle(data);
    } catch (error) {
      return {
        source: this.id,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "msn_app_timeout"
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private toBundle(data: JsonRecord): WeatherBundle {
    const metrics = Array.isArray(data.metrics)
      ? data.metrics.filter((v): v is string => typeof v === "string")
      : [];
    const parsed = parseMetricStrip(metrics);
    const condition = str(data.condition);
    const temperature = parseTemperature(str(data.temperature));

    const bundle: WeatherBundle = {
      source: this.id,
      place: { name: str(data.location) },
      precipitationOutlook: str(data.precipitationOutlook) || undefined,
      narrative: this.toNarrative(data.details),
      daily: this.toDaily(data.forecast),
      alerts: [],
    };

    if (temperature !== undefined) {
      bundle.observation = {
        temperatureC: temperature,
        feelsLikeC: parsed.feelsLikeC,
        condition,
        conditionClass: classifyConditionText(condition),
        humidity: parsed.humidity,
        windKph: parsed.windKph,
        pressureMb: parsed.pressureMb,
        visibilityKm: parsed.visibilityKm,
        uvIndex: parsed.uvIndex,
        observedAt: resolveObservedAt(str(data.observedAt)),
        source: this.id,
      };
    }

    // La app publica amanecer y puesta dentro de su ficha "Sol".
    const sun = (bundle.narrative ?? []).find((card) =>
      /^sol$|^sun$/iu.test(card.label),
    );
    if (sun) {
      const times = sun.summary.match(/\d{1,2}:\d{2}\s*[AaPp]\.?\s?[Mm]\.?/gu) ?? [];
      if (times.length >= 2) {
        bundle.astronomy = { sunrise: times[0], sunset: times[1] };
      }
    }

    return bundle;
  }

  private toNarrative(value: unknown): WeatherNarrativeCard[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((raw) => {
        const card = asRecord(raw);
        return { label: str(card.label), summary: str(card.summary) };
      })
      .filter((card) => card.label && card.summary);
  }

  private toDaily(value: unknown): WeatherDailyPoint[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const days: WeatherDailyPoint[] = [];
    for (const raw of value) {
      const entry = asRecord(raw);
      const high = typeof entry.high === "number" ? entry.high : undefined;
      const low = typeof entry.low === "number" ? entry.low : undefined;
      if (high === undefined || low === undefined) {
        continue;
      }
      days.push({
        // La app solo da el número del día, no la fecha completa.
        date: "",
        label: str(entry.label) || undefined,
        highC: high,
        lowC: low,
        condition: "",
        conditionClass: "unknown",
        chanceOfRain: 0,
      });
    }
    return days;
  }
}
