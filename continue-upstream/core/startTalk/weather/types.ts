/**
 * Vocabulario común de clima para Start Talk.
 *
 * Tres fuentes muy distintas —dos APIs y la app de escritorio MSN El Tiempo—
 * hablan este mismo idioma, igual que OpenAI Realtime y Gemini Live hablan el
 * de `VoiceProvider`. Quien enruta (`WeatherOracle`) es el único que sabe de
 * proveedores: ni el modelo de voz ni las funciones expuestas los mencionan.
 */

/** Identificador estable de cada fuente; viaja con cada dato para poder citarlo. */
export type WeatherSourceId = "weatherapi" | "openweather" | "msn-app";

/** Qué sabe hacer una fuente. El oráculo enruta por esto, no por nombres. */
export type WeatherCapability =
  | "current"
  | "hourly"
  | "daily"
  | "alerts"
  | "astronomy"
  | "history"
  /** Redacta prosa lista para leer en voz alta (hoy solo la app MSN). */
  | "narrative"
  /** Acepta una ubicación arbitraria, no solo la que ya tiene configurada. */
  | "anyLocation";

/**
 * Qué quiere saber el usuario. El modelo de voz elige UNA de estas y nunca
 * elige fuente: si eligiera, lo haría distinto cada vez y acabaría abriendo una
 * app de escritorio para responder "¿hace frío?".
 */
export type WeatherIntent =
  | "now"
  | "narrative"
  | "hourly"
  | "daily"
  | "alerts"
  | "astronomy"
  | "history";

export interface WeatherQuery {
  intent: WeatherIntent;
  /** Ciudad dicha en la pregunta. Sin esto se usa la ubicación del usuario. */
  location?: string;
  /** Días de previsión pedidos (intent `daily`). */
  days?: number;
  /** Fecha ISO `YYYY-MM-DD` para `history`. */
  date?: string;
}

export interface WeatherPlace {
  name: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
}

/**
 * Clase de tiempo normalizada. Existe para poder comparar dos APIs que llaman
 * a lo mismo "Parcialmente nublado" y "scattered clouds": sin normalizar, todo
 * desacuerdo de texto parecería un desacuerdo de pronóstico.
 */
export type WeatherConditionClass =
  | "clear"
  | "cloudy"
  | "rain"
  | "snow"
  | "storm"
  | "fog"
  | "unknown";

export interface WeatherObservation {
  temperatureC: number;
  feelsLikeC?: number;
  /** Texto localizado tal cual lo da la fuente, para decirlo en voz alta. */
  condition: string;
  conditionClass: WeatherConditionClass;
  humidity?: number;
  windKph?: number;
  windDirection?: string;
  pressureMb?: number;
  visibilityKm?: number;
  uvIndex?: number;
  precipitationMm?: number;
  chanceOfRain?: number;
  /** ISO. Cuándo se MIDIÓ, no cuándo se pidió: sin esto se lee un dato rancio. */
  observedAt: string;
  source: WeatherSourceId;
}

export interface WeatherHourlyPoint {
  /** ISO local de la hora. */
  time: string;
  temperatureC: number;
  condition: string;
  conditionClass: WeatherConditionClass;
  chanceOfRain: number;
}

export interface WeatherDailyPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Etiqueta hablada cuando la fuente la da ("Hoy", "domingo"). */
  label?: string;
  highC: number;
  lowC: number;
  condition: string;
  conditionClass: WeatherConditionClass;
  chanceOfRain: number;
}

export interface WeatherAlert {
  /** Estable entre sondeos, para no anunciar dos veces la misma alerta. */
  id: string;
  headline: string;
  event?: string;
  severity?: string;
  areas?: string;
  effective?: string;
  expires?: string;
  description?: string;
  source: WeatherSourceId;
}

export interface WeatherAstronomy {
  sunrise?: string;
  sunset?: string;
  moonrise?: string;
  moonset?: string;
  moonPhase?: string;
  dayLength?: string;
}

/** Una ficha redactada por la fuente, lista para leerse tal cual. */
export interface WeatherNarrativeCard {
  label: string;
  summary: string;
}

/** Lo que devuelve un proveedor: siempre parcial, nunca lanza por lo que no sabe. */
export interface WeatherBundle {
  source: WeatherSourceId;
  place?: WeatherPlace;
  observation?: WeatherObservation;
  hourly?: WeatherHourlyPoint[];
  daily?: WeatherDailyPoint[];
  alerts?: WeatherAlert[];
  astronomy?: WeatherAstronomy;
  narrative?: WeatherNarrativeCard[];
  /** Texto corto de la fuente sobre precipitación inminente, si lo publica. */
  precipitationOutlook?: string;
  /** Presente cuando la consulta falló; el bundle llega vacío pero explicado. */
  error?: string;
}

export interface WeatherProvider {
  readonly id: WeatherSourceId;
  /** Nombre para citar en voz alta y en el panel de actividad. */
  readonly label: string;
  readonly capabilities: ReadonlySet<WeatherCapability>;
  /**
   * Latencia típica en ms. El oráculo la usa para ordenar candidatos: en una
   * conversación hablada, diez segundos de silencio es un fallo.
   */
  readonly typicalLatencyMs: number;
  /** Falso cuando falta su clave o su app: se salta sin intentarlo. */
  isConfigured(): boolean;
  fetch(query: WeatherQuery): Promise<WeatherBundle>;
}

/** Cuánto se fía el oráculo de lo que va a decir. */
export type WeatherConfidence = "high" | "medium" | "low";

export interface WeatherAnswer {
  /**
   * Una o dos frases YA redactadas. Existe porque a un modelo de voz que recibe
   * JSON pelado se le va la mano recitando campos; con la frase hecha, habla.
   */
  speak: string;
  confidence: WeatherConfidence;
  place?: WeatherPlace;
  observation?: WeatherObservation;
  hourly?: WeatherHourlyPoint[];
  daily?: WeatherDailyPoint[];
  alerts?: WeatherAlert[];
  astronomy?: WeatherAstronomy;
  narrative?: WeatherNarrativeCard[];
  /** Fuentes que aportaron algo, para poder citarlas. */
  sources: WeatherSourceId[];
  /** Cómo se resolvió un desacuerdo entre dos APIs, si lo hubo. */
  disagreement?: string;
  /** Qué se perdió por el camino (una fuente caída, un permiso bloqueado). */
  degraded?: string;
  error?: string;
}
