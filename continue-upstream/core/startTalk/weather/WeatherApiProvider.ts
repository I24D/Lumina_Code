/**
 * WeatherAPI.com — la fuente rápida y completa.
 *
 * Es la única que cubre todo el catálogo con una sola llamada: actuales, por
 * horas, diario hasta 14 días, calidad del aire, astronomía, historial y las
 * alertas oficiales. Responde en ~300 ms, así que es la que sostiene el
 * presupuesto de latencia: la app de escritorio nunca debe estar en el camino
 * crítico de "¿cómo está el clima?".
 */
import { readLuminaEnv } from "../../luminaBridge/luminaEnv.js";
import { classifyWeatherApiCode } from "./conditions.js";
import type {
  WeatherAlert,
  WeatherBundle,
  WeatherCapability,
  WeatherDailyPoint,
  WeatherHourlyPoint,
  WeatherProvider,
  WeatherQuery,
} from "./types.js";

const BASE_URL = "https://api.weatherapi.com/v1";
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_HOURLY = 24;
const MAX_DAILY = 14;

const CAPABILITIES: ReadonlySet<WeatherCapability> = new Set<WeatherCapability>([
  "current",
  "hourly",
  "daily",
  "alerts",
  "astronomy",
  "history",
  "anyLocation",
]);

function apiKey(): string | undefined {
  return readLuminaEnv("WEATHERAPI_KEY");
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function conditionOf(node: unknown): { text: string; code: number } {
  const condition = asRecord(asRecord(node).condition);
  return { text: str(condition.text), code: num(condition.code) ?? -1 };
}

function mapHourly(hours: unknown[]): WeatherHourlyPoint[] {
  return hours.slice(0, MAX_HOURLY).map((raw) => {
    const hour = asRecord(raw);
    const { text, code } = conditionOf(hour);
    return {
      time: str(hour.time),
      temperatureC: num(hour.temp_c) ?? 0,
      condition: text,
      conditionClass: classifyWeatherApiCode(code),
      chanceOfRain: num(hour.chance_of_rain) ?? 0,
    };
  });
}

function mapDaily(days: unknown[]): WeatherDailyPoint[] {
  return days.slice(0, MAX_DAILY).map((raw) => {
    const entry = asRecord(raw);
    const day = asRecord(entry.day);
    const { text, code } = conditionOf(day);
    return {
      date: str(entry.date),
      highC: num(day.maxtemp_c) ?? 0,
      lowC: num(day.mintemp_c) ?? 0,
      condition: text,
      conditionClass: classifyWeatherApiCode(code),
      chanceOfRain: num(day.daily_chance_of_rain) ?? 0,
    };
  });
}

function mapAlerts(payload: unknown): WeatherAlert[] {
  const list = asRecord(payload).alert;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((raw) => {
    const alert = asRecord(raw);
    const headline = str(alert.headline) || str(alert.event) || "Aviso meteorológico";
    const effective = str(alert.effective);
    return {
      // La API no da id; se compone uno estable para que el monitor no
      // vuelva a anunciar la misma alerta en cada sondeo.
      id: `weatherapi:${str(alert.event)}:${effective}:${headline}`.slice(0, 200),
      headline,
      event: str(alert.event) || undefined,
      severity: str(alert.severity) || undefined,
      areas: str(alert.areas) || undefined,
      effective: effective || undefined,
      expires: str(alert.expires) || undefined,
      description: str(alert.desc).slice(0, 600) || undefined,
      source: "weatherapi" as const,
    };
  });
}

export class WeatherApiProvider implements WeatherProvider {
  readonly id = "weatherapi" as const;
  readonly label = "WeatherAPI";
  readonly capabilities = CAPABILITIES;
  readonly typicalLatencyMs = 350;

  isConfigured(): boolean {
    return Boolean(apiKey());
  }

  async fetch(query: WeatherQuery): Promise<WeatherBundle> {
    const key = apiKey();
    if (!key) {
      return { source: this.id, error: "weatherapi_key_missing" };
    }
    const place = query.location?.trim();
    if (!place) {
      return { source: this.id, error: "location_required" };
    }

    try {
      const payload = await this.request(key, place, query);
      return this.toBundle(payload);
    } catch (error) {
      return {
        source: this.id,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "weatherapi_timeout"
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }

  private async request(
    key: string,
    place: string,
    query: WeatherQuery,
  ): Promise<JsonRecord> {
    const params = new URLSearchParams({ key, q: place, lang: "es" });
    let path = "forecast.json";

    if (query.intent === "history" && query.date) {
      path = "history.json";
      params.set("dt", query.date);
    } else if (query.intent === "astronomy") {
      path = "astronomy.json";
      params.set("dt", query.date ?? new Date().toISOString().slice(0, 10));
    } else {
      // Un solo `forecast.json` ya trae actuales, horas, días y alertas: pedir
      // `current.json` aparte sería una llamada de más para el mismo dato.
      const days = Math.max(1, Math.min(MAX_DAILY, query.days ?? 3));
      params.set("days", String(days));
      params.set("alerts", "yes");
      params.set("aqi", "yes");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE_URL}/${path}?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        const message = str(asRecord(data.error).message);
        throw new Error(message || `weatherapi_http_${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toBundle(payload: JsonRecord): WeatherBundle {
    const location = asRecord(payload.location);
    const current = asRecord(payload.current);
    const forecastDays = asRecord(payload.forecast).forecastday;
    const days = Array.isArray(forecastDays) ? forecastDays : [];
    const firstDay = asRecord(days[0]);
    const astro = asRecord(firstDay.astro);

    const bundle: WeatherBundle = {
      source: this.id,
      place: {
        name: str(location.name),
        region: str(location.region) || undefined,
        country: str(location.country) || undefined,
        latitude: num(location.lat),
        longitude: num(location.lon),
        timeZone: str(location.tz_id) || undefined,
      },
      alerts: mapAlerts(payload.alerts),
    };

    if (Object.keys(current).length > 0) {
      const { text, code } = conditionOf(current);
      const epoch = num(current.last_updated_epoch);
      bundle.observation = {
        temperatureC: num(current.temp_c) ?? 0,
        feelsLikeC: num(current.feelslike_c),
        condition: text,
        conditionClass: classifyWeatherApiCode(code),
        humidity: num(current.humidity),
        windKph: num(current.wind_kph),
        windDirection: str(current.wind_dir) || undefined,
        pressureMb: num(current.pressure_mb),
        visibilityKm: num(current.vis_km),
        uvIndex: num(current.uv),
        precipitationMm: num(current.precip_mm),
        observedAt: epoch
          ? new Date(epoch * 1000).toISOString()
          : new Date().toISOString(),
        source: this.id,
      };
    }

    const hours = asRecord(days[0]).hour;
    if (Array.isArray(hours)) {
      bundle.hourly = mapHourly(hours);
    }
    if (days.length > 0) {
      bundle.daily = mapDaily(days);
    }
    if (Object.keys(astro).length > 0) {
      bundle.astronomy = {
        sunrise: str(astro.sunrise) || undefined,
        sunset: str(astro.sunset) || undefined,
        moonrise: str(astro.moonrise) || undefined,
        moonset: str(astro.moonset) || undefined,
        moonPhase: str(astro.moon_phase) || undefined,
      };
    }
    // `astronomy.json` devuelve el bloque en otra rama del documento.
    const standaloneAstro = asRecord(asRecord(payload.astronomy).astro);
    if (!bundle.astronomy && Object.keys(standaloneAstro).length > 0) {
      bundle.astronomy = {
        sunrise: str(standaloneAstro.sunrise) || undefined,
        sunset: str(standaloneAstro.sunset) || undefined,
        moonrise: str(standaloneAstro.moonrise) || undefined,
        moonset: str(standaloneAstro.moonset) || undefined,
        moonPhase: str(standaloneAstro.moon_phase) || undefined,
      };
    }

    return bundle;
  }
}
