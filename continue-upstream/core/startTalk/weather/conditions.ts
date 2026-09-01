/**
 * Normalización de la condición meteorológica a una clase comparable.
 *
 * Sin esto no se puede saber si dos fuentes se contradicen: WeatherAPI dice
 * "Parcialmente nublado", OpenWeather "scattered clouds" y la app MSN
 * "Soleado", y comparar cadenas daría desacuerdo siempre. La clase es lo que
 * de verdad le importa a quien pregunta: ¿me mojo o no?
 */
import type { WeatherConditionClass } from "./types.js";

/** Códigos de WeatherAPI.com (`current.condition.code`). */
export function classifyWeatherApiCode(code: number): WeatherConditionClass {
  if (code === 1000) return "clear";
  if ([1003, 1006, 1009].includes(code)) return "cloudy";
  if ([1030, 1135, 1147].includes(code)) return "fog";
  if ([1087, 1273, 1276, 1279, 1282].includes(code)) return "storm";
  if (code >= 1210 && code <= 1264) return "snow";
  if ([1066, 1069, 1114, 1117, 1204, 1207].includes(code)) return "snow";
  if (code >= 1063 && code <= 1201) return "rain";
  return "unknown";
}

/** Códigos de OpenWeather (`weather[0].id`). */
export function classifyOpenWeatherCode(code: number): WeatherConditionClass {
  if (code >= 200 && code < 300) return "storm";
  if (code >= 300 && code < 400) return "rain";
  if (code >= 500 && code < 600) return "rain";
  if (code >= 600 && code < 700) return "snow";
  if (code >= 700 && code < 800) return "fog";
  if (code === 800) return "clear";
  if (code > 800 && code < 900) return "cloudy";
  return "unknown";
}

const TEXT_RULES: ReadonlyArray<[RegExp, WeatherConditionClass]> = [
  [/tormenta|thunder|electric/iu, "storm"],
  [/nieve|nevad|snow|sleet|granizo|hail/iu, "snow"],
  [/lluvia|llovizna|lloviendo|chubasco|rain|drizzle|shower/iu, "rain"],
  [/niebla|neblina|bruma|fog|mist|haze/iu, "fog"],
  [/despejad|solead|sol\b|clear|sunny/iu, "clear"],
  [/nublad|nubes|cubierto|cloud|overcast/iu, "cloudy"],
];

/**
 * Clasificación por texto, para la app MSN, que no publica ningún código.
 * El orden importa: "tormenta eléctrica con lluvia" es tormenta, no lluvia.
 */
export function classifyConditionText(text: string): WeatherConditionClass {
  const value = text ?? "";
  for (const [pattern, className] of TEXT_RULES) {
    if (pattern.test(value)) {
      return className;
    }
  }
  return "unknown";
}

/** Clases que implican mojarse. Se tratan de forma asimétrica al comparar. */
export function isWetClass(value: WeatherConditionClass): boolean {
  return value === "rain" || value === "snow" || value === "storm";
}
