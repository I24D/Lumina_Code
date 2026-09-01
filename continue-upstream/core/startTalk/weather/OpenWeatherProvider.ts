/**
 * OpenWeather — la segunda opinión.
 *
 * No está aquí por cobertura: WeatherAPI ya la tiene entera. Está porque es un
 * MODELO DISTINTO, y eso convierte el desacuerdo en información. Cuando las dos
 * coinciden, Lumina puede dar un número con seguridad; cuando no, debe decir un
 * rango o admitir la duda en vez de sonar segura por accidente.
 *
 * Todo el diseño funciona con esta fuente ausente: si falta la clave o no está
 * activada todavía, el consenso degrada a una sola fuente sin romper nada.
 */
import { readLuminaEnv } from "../../luminaBridge/luminaEnv.js";
import { classifyOpenWeatherCode } from "./conditions.js";
import type {
  WeatherBundle,
  WeatherCapability,
  WeatherDailyPoint,
  WeatherHourlyPoint,
  WeatherProvider,
  WeatherQuery,
} from "./types.js";

const BASE_URL = "https://api.openweathermap.org/data/2.5";
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_HOURLY = 24;

const CAPABILITIES: ReadonlySet<WeatherCapability> = new Set<WeatherCapability>([
  "current",
  "hourly",
  "daily",
  "anyLocation",
]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function weatherOf(node: JsonRecord): { text: string; code: number } {
  const list = node.weather;
  const first = asRecord(Array.isArray(list) ? list[0] : undefined);
  return { text: str(first.description), code: num(first.id) ?? -1 };
}

export class OpenWeatherProvider implements WeatherProvider {
  readonly id = "openweather" as const;
  readonly label = "OpenWeather";
  readonly capabilities = CAPABILITIES;
  readonly typicalLatencyMs = 400;

  isConfigured(): boolean {
    return Boolean(readLuminaEnv("OPENWEATHER_API_KEY"));
  }

  async fetch(query: WeatherQuery): Promise<WeatherBundle> {
    const key = readLuminaEnv("OPENWEATHER_API_KEY");
    if (!key) {
      return { source: this.id, error: "openweather_key_missing" };
    }
    const place = query.location?.trim();
    if (!place) {
      return { source: this.id, error: "location_required" };
    }

    try {
      // El plan gratuito no incluye One Call, así que se combinan los dos
      // endpoints que sí cubre: `weather` (actuales) y `forecast` (3 h / 5 d).
      const wantsForecast =
        query.intent === "hourly" || query.intent === "daily";
      const [current, forecast] = await Promise.all([
        this.request("weather", key, place),
        wantsForecast
          ? this.request("forecast", key, place).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      return this.toBundle(current, forecast);
    } catch (error) {
      return {
        source: this.id,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "openweather_timeout"
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }

  private async request(
    path: "weather" | "forecast",
    key: string,
    place: string,
  ): Promise<JsonRecord> {
    const params = new URLSearchParams({
      q: place,
      appid: key,
      units: "metric",
      lang: "es",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE_URL}/${path}?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        // Una clave recién creada tarda un par de horas en activarse y hasta
        // entonces responde 401. Se nombra para que el aviso sea accionable.
        if (response.status === 401) {
          throw new Error("openweather_key_not_active");
        }
        throw new Error(str(data.message) || `openweather_http_${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toBundle(
    current: JsonRecord,
    forecast: JsonRecord | undefined,
  ): WeatherBundle {
    const main = asRecord(current.main);
    const wind = asRecord(current.wind);
    const sys = asRecord(current.sys);
    const { text, code } = weatherOf(current);
    const observedAtEpoch = num(current.dt);

    const bundle: WeatherBundle = {
      source: this.id,
      place: {
        name: str(current.name),
        country: str(sys.country) || undefined,
        latitude: num(asRecord(current.coord).lat),
        longitude: num(asRecord(current.coord).lon),
      },
      observation: {
        temperatureC: num(main.temp) ?? 0,
        feelsLikeC: num(main.feels_like),
        condition: text,
        conditionClass: classifyOpenWeatherCode(code),
        humidity: num(main.humidity),
        windKph:
          num(wind.speed) === undefined
            ? undefined
            : Math.round((num(wind.speed) as number) * 3.6 * 10) / 10,
        pressureMb: num(main.pressure),
        visibilityKm:
          num(current.visibility) === undefined
            ? undefined
            : (num(current.visibility) as number) / 1000,
        observedAt: observedAtEpoch
          ? new Date(observedAtEpoch * 1000).toISOString()
          : new Date().toISOString(),
        source: this.id,
      },
    };

    const list = forecast ? forecast.list : undefined;
    if (Array.isArray(list)) {
      bundle.hourly = this.toHourly(list);
      bundle.daily = this.toDaily(list);
    }
    return bundle;
  }

  private toHourly(list: unknown[]): WeatherHourlyPoint[] {
    return list.slice(0, MAX_HOURLY / 3).map((raw) => {
      const slot = asRecord(raw);
      const { text, code } = weatherOf(slot);
      return {
        time: str(slot.dt_txt),
        temperatureC: num(asRecord(slot.main).temp) ?? 0,
        condition: text,
        conditionClass: classifyOpenWeatherCode(code),
        chanceOfRain: Math.round((num(slot.pop) ?? 0) * 100),
      };
    });
  }

  /** Los tramos de 3 h se pliegan a días para poder comparar máximas y mínimas. */
  private toDaily(list: unknown[]): WeatherDailyPoint[] {
    const byDate = new Map<string, WeatherDailyPoint>();
    for (const raw of list) {
      const slot = asRecord(raw);
      const stamp = str(slot.dt_txt);
      const date = stamp.slice(0, 10);
      if (!date) continue;
      const temp = num(asRecord(slot.main).temp) ?? 0;
      const { text, code } = weatherOf(slot);
      const chance = Math.round((num(slot.pop) ?? 0) * 100);
      const existing = byDate.get(date);
      if (!existing) {
        byDate.set(date, {
          date,
          highC: temp,
          lowC: temp,
          condition: text,
          conditionClass: classifyOpenWeatherCode(code),
          chanceOfRain: chance,
        });
        continue;
      }
      existing.highC = Math.max(existing.highC, temp);
      existing.lowC = Math.min(existing.lowC, temp);
      existing.chanceOfRain = Math.max(existing.chanceOfRain, chance);
    }
    return Array.from(byDate.values());
  }
}
