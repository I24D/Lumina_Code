/**
 * Composición de la frase que Lumina dirá.
 *
 * El oráculo devuelve el texto ya redactado en vez de JSON pelado por una razón
 * medida en el trabajo de notificaciones: a un modelo de voz que recibe una
 * estructura se le va la mano recitando campos, y una respuesta de clima se
 * convierte en un parte de tres párrafos. Con la frase hecha, habla.
 *
 * Funciones puras: no tocan red, reloj ni proveedores.
 */
import { isWetClass } from "./conditions.js";
import type { ConsensusResult } from "./consensus.js";
import type {
  WeatherAlert,
  WeatherAstronomy,
  WeatherDailyPoint,
  WeatherHourlyPoint,
  WeatherNarrativeCard,
  WeatherPlace,
} from "./types.js";

/** Umbral a partir del cual una probabilidad merece mencionarse en voz alta. */
export const RAIN_MENTION_THRESHOLD = 40;
/** Pasado este tiempo, un dato deja de poder presentarse como "ahora mismo". */
export const STALE_OBSERVATION_MS = 90 * 60_000;

/**
 * Distingue una frase redactada de una tira de lecturas.
 *
 * La app compone las dos y solo la primera se puede leer en voz alta: las de
 * valores llegan unidas por " · " ("19 · % · Amanecer") y suenan a listado.
 */
export function isProse(summary: string): boolean {
  const value = (summary ?? "").trim();
  return (
    value.length >= 30 &&
    !value.includes(" · ") &&
    value.split(/\s+/u).length >= 6
  );
}

export function placeName(place: WeatherPlace | undefined): string {
  if (!place?.name) {
    return "";
  }
  // "Greeneville, Tennessee, Estados Unidos" en voz alta es un trabalenguas:
  // basta la ciudad salvo que no la haya.
  return place.name.split(",")[0].trim();
}

function degrees(value: number): string {
  return `${Math.round(value)} grados`;
}

/** "entre 19 y 34 grados": repetir la unidad en los dos extremos suena a robot. */
function degreeRange(low: number, high: number): string {
  const a = Math.round(low);
  const b = Math.round(high);
  return a === b ? degrees(a) : `entre ${a} y ${b} grados`;
}

/** WeatherAPI no traduce la fase lunar, y se lee en voz alta en español. */
const MOON_PHASES_ES: Record<string, string> = {
  "new moon": "luna nueva",
  "waxing crescent": "luna creciente",
  "first quarter": "cuarto creciente",
  "waxing gibbous": "gibosa creciente",
  "full moon": "luna llena",
  "waning gibbous": "gibosa menguante",
  "last quarter": "cuarto menguante",
  "third quarter": "cuarto menguante",
  "waning crescent": "luna menguante",
};

export function moonPhaseEs(phase: string): string {
  return MOON_PHASES_ES[phase.trim().toLowerCase()] ?? phase.toLowerCase();
}

/** Frase de una alerta activa. Siempre va primero: es lo único urgente. */
export function composeAlertLead(alerts: WeatherAlert[] | undefined): string {
  if (!alerts || alerts.length === 0) {
    return "";
  }
  const first = alerts[0];
  const rest = alerts.length - 1;
  const headline = first.headline.replace(/\s+/gu, " ").trim();
  const tail = rest > 0 ? ` Hay ${rest} aviso${rest === 1 ? "" : "s"} más.` : "";
  return `Atención: ${headline}.${tail}`;
}

export function composeNow(
  consensus: ConsensusResult,
  place: WeatherPlace | undefined,
  options: { observedAgeMs?: number; alerts?: WeatherAlert[] } = {},
): string {
  const where = placeName(place);
  const condition = consensus.observation.condition
    ? `, ${consensus.observation.condition.toLowerCase()}`
    : "";
  const prefix = where ? `En ${where}` : "Ahora mismo";

  const parts = [`${prefix}, ${consensus.temperaturePhrase}${condition}.`];

  const feels = consensus.observation.feelsLikeC;
  if (
    typeof feels === "number" &&
    Math.abs(feels - consensus.observation.temperatureC) >= 3
  ) {
    parts.push(`Sensación de ${degrees(feels)}.`);
  }

  if (consensus.wetRisk && !isWetClass(consensus.observation.conditionClass)) {
    parts.push("Puede caer algo de agua.");
  }
  if (consensus.disagreement) {
    parts.push("No es un dato firme.");
  }
  if (
    options.observedAgeMs !== undefined &&
    options.observedAgeMs > STALE_OBSERVATION_MS
  ) {
    parts.push("La medición no es de ahora mismo.");
  }

  const lead = composeAlertLead(options.alerts);
  return [lead, parts.join(" ")].filter(Boolean).join(" ");
}

/**
 * Narrativa: la app ya redactó las fichas, así que se eligen las dos que
 * responden a "¿cómo va el día?" y se leen tal cual.
 */
export function composeNarrative(
  cards: WeatherNarrativeCard[],
  place: WeatherPlace | undefined,
  alerts?: WeatherAlert[],
): string {
  const preferred = ["temperatura", "precipitaciones", "cubierta de nubes"];
  const picked: string[] = [];
  for (const label of preferred) {
    const card = cards.find((entry) => entry.label.toLowerCase() === label);
    if (card && isProse(card.summary)) {
      picked.push(card.summary);
    }
    if (picked.length === 2) {
      break;
    }
  }
  if (picked.length === 0) {
    // Ninguna de las preferidas trae frase: vale cualquier otra que sí la
    // tenga. Leer una tarjeta de valores sueltos ("19 · %") no dice nada.
    const fallback = cards.find((entry) => isProse(entry.summary));
    if (fallback) {
      picked.push(fallback.summary);
    }
  }
  if (picked.length === 0) {
    return "";
  }

  const where = placeName(place);
  const lead = composeAlertLead(alerts);
  const head = where ? `En ${where}: ` : "";
  return [lead, `${head}${picked.join(" ")}`].filter(Boolean).join(" ").trim();
}

/** Primera hora con agua a la vista, que es lo que se pregunta de verdad. */
export function composeHourly(
  hours: WeatherHourlyPoint[],
  place: WeatherPlace | undefined,
  alerts?: WeatherAlert[],
): string {
  const where = placeName(place);
  const prefix = where ? `En ${where}` : "Hoy";
  const lead = composeAlertLead(alerts);

  const wet = hours.find(
    (hour) =>
      hour.chanceOfRain >= RAIN_MENTION_THRESHOLD || isWetClass(hour.conditionClass),
  );
  if (!wet) {
    const temps = hours.map((hour) => hour.temperatureC);
    const body = temps.length
      ? `${prefix} no se espera lluvia en las próximas horas; ${degreeRange(Math.min(...temps), Math.max(...temps))}.`
      : `${prefix} no hay datos por horas.`;
    return [lead, body].filter(Boolean).join(" ");
  }

  const clock = wet.time.includes(" ") ? wet.time.split(" ")[1] : wet.time;
  return [
    lead,
    `${prefix}, hacia las ${clock} hay ${wet.chanceOfRain}% de probabilidad de agua (${wet.condition.toLowerCase()}).`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function composeDaily(
  days: WeatherDailyPoint[],
  place: WeatherPlace | undefined,
  alerts?: WeatherAlert[],
): string {
  const where = placeName(place);
  const lead = composeAlertLead(alerts);
  if (days.length === 0) {
    return [lead, "No tengo la previsión por días."].filter(Boolean).join(" ");
  }

  const head = days[0];
  const prefix = where ? `En ${where}` : "";
  const parts = [
    `${prefix ? `${prefix}, hoy` : "Hoy"} ${degreeRange(head.lowC, head.highC)}${head.condition ? `, ${head.condition.toLowerCase()}` : ""}.`,
  ];

  const rainy = days.find(
    (day, index) => index > 0 && day.chanceOfRain >= RAIN_MENTION_THRESHOLD,
  );
  if (rainy) {
    parts.push(
      `${rainy.label ?? rainy.date} es el día con más probabilidad de lluvia, un ${rainy.chanceOfRain}%.`,
    );
  } else if (days.length > 1) {
    const highs = days.map((day) => day.highC);
    parts.push(
      `Los próximos días se mueven ${degreeRange(Math.min(...highs), Math.max(...highs))} de máxima, sin lluvia destacable.`,
    );
  }

  return [lead, parts.join(" ")].filter(Boolean).join(" ");
}

export function composeAstronomy(
  astronomy: WeatherAstronomy,
  place: WeatherPlace | undefined,
): string {
  const where = placeName(place);
  const prefix = where ? `En ${where}, ` : "";
  const parts: string[] = [];
  if (astronomy.sunrise) parts.push(`amanece a las ${astronomy.sunrise}`);
  if (astronomy.sunset) parts.push(`anochece a las ${astronomy.sunset}`);
  if (parts.length === 0) {
    return "No tengo los horarios de sol.";
  }
  const moon = astronomy.moonPhase
    ? ` La luna está en ${moonPhaseEs(astronomy.moonPhase)}.`
    : "";
  return `${prefix}${parts.join(" y ")}.${moon}`;
}

export function composeAlerts(
  alerts: WeatherAlert[],
  place: WeatherPlace | undefined,
): string {
  const where = placeName(place);
  if (alerts.length === 0) {
    return where
      ? `No hay ningún aviso meteorológico activo en ${where}.`
      : "No hay ningún aviso meteorológico activo.";
  }
  return composeAlertLead(alerts);
}

export function composeHistory(
  day: WeatherDailyPoint | undefined,
  place: WeatherPlace | undefined,
  date: string,
): string {
  if (!day) {
    return `No tengo el registro del ${date}.`;
  }
  const where = placeName(place);
  const prefix = where ? `En ${where}, el` : "El";
  return `${prefix} ${day.date || date} la máxima fue de ${degrees(day.highC)} y la mínima de ${degrees(day.lowC)}${day.condition ? `, ${day.condition.toLowerCase()}` : ""}.`;
}
