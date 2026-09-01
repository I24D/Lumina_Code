import { describe, expect, it } from "vitest";

import {
  classifyConditionText,
  classifyOpenWeatherCode,
  classifyWeatherApiCode,
} from "./conditions.js";
import { reconcileObservations } from "./consensus.js";
import {
  parseMetricStrip,
  parseTemperature,
  resolveObservedAt,
} from "./MsnWeatherAppProvider.js";
import {
  composeHourly,
  composeNarrative,
  composeNow,
  isProse,
  moonPhaseEs,
  placeName,
} from "./speech.js";
import { WeatherCache, WEATHER_TTL_MS } from "./WeatherCache.js";
import { WeatherOracle } from "./WeatherOracle.js";
import type {
  WeatherBundle,
  WeatherCapability,
  WeatherObservation,
  WeatherProvider,
  WeatherQuery,
  WeatherSourceId,
} from "./types.js";

function observation(
  source: WeatherSourceId,
  temperatureC: number,
  extra: Partial<WeatherObservation> = {},
): WeatherObservation {
  return {
    temperatureC,
    condition: "Despejado",
    conditionClass: "clear",
    observedAt: "2026-08-29T16:00:00.000Z",
    source,
    ...extra,
  };
}

describe("clasificación de condiciones", () => {
  it("mapea los códigos de las dos APIs a la misma clase", () => {
    // Sin esto, "Parcialmente nublado" y "scattered clouds" parecerían un
    // desacuerdo de pronóstico en vez de dos formas de decir lo mismo.
    expect(classifyWeatherApiCode(1003)).toBe("cloudy");
    expect(classifyOpenWeatherCode(802)).toBe("cloudy");
    expect(classifyWeatherApiCode(1000)).toBe("clear");
    expect(classifyOpenWeatherCode(800)).toBe("clear");
    expect(classifyWeatherApiCode(1195)).toBe("rain");
    expect(classifyOpenWeatherCode(502)).toBe("rain");
  });

  it("prefiere tormenta sobre lluvia cuando el texto trae las dos", () => {
    expect(classifyConditionText("Tormenta eléctrica con lluvia")).toBe("storm");
    expect(classifyConditionText("Soleado")).toBe("clear");
    expect(classifyConditionText("Parcialmente nublado")).toBe("cloudy");
  });
});

describe("consenso entre fuentes", () => {
  it("una sola fuente nunca da confianza alta", () => {
    // No hay nada que la corrobore, por mucho que el número parezca preciso.
    const result = reconcileObservations([observation("weatherapi", 29)]);
    expect(result?.confidence).toBe("medium");
    expect(result?.temperaturePhrase).toBe("29 grados");
  });

  it("dos fuentes que coinciden dan un número con confianza alta", () => {
    const result = reconcileObservations([
      observation("weatherapi", 29.2),
      observation("openweather", 28.6),
    ]);
    expect(result?.confidence).toBe("high");
    expect(result?.temperaturePhrase).toBe("29 grados");
    expect(result?.disagreement).toBeUndefined();
  });

  it("una diferencia moderada se dice como rango, no como número", () => {
    const result = reconcileObservations([
      observation("weatherapi", 28),
      observation("openweather", 30.5),
    ]);
    expect(result?.confidence).toBe("medium");
    expect(result?.temperaturePhrase).toBe("entre 28 y 31 grados");
  });

  it("una diferencia grande se admite en vez de promediarse", () => {
    const result = reconcileObservations([
      observation("weatherapi", 22),
      observation("openweather", 30),
    ]);
    expect(result?.confidence).toBe("low");
    expect(result?.disagreement).toContain("difieren");
  });

  it("si una fuente ve agua se marca riesgo aunque gane la seca", () => {
    // Asimetría deliberada: mandar a alguien sin paraguas cuesta más que
    // mencionar una lluvia que no cae.
    const result = reconcileObservations([
      observation("weatherapi", 20, { conditionClass: "clear" }),
      observation("openweather", 20.5, {
        conditionClass: "rain",
        condition: "Lluvia ligera",
      }),
    ]);
    expect(result?.wetRisk).toBe(true);
    expect(result?.confidence).toBe("low");
    expect(result?.disagreement).toContain("agua");
  });

  it("con desacuerdo se queda con la medición más reciente", () => {
    const result = reconcileObservations([
      observation("weatherapi", 22, { observedAt: "2026-08-29T15:00:00.000Z" }),
      observation("openweather", 30, { observedAt: "2026-08-29T16:00:00.000Z" }),
    ]);
    expect(result?.observation.source).toBe("openweather");
  });
});

describe("frase hablada", () => {
  it("dice solo la ciudad, no la dirección postal entera", () => {
    expect(
      placeName({ name: "Greeneville, Tennessee, Estados Unidos" }),
    ).toBe("Greeneville");
  });

  it("antepone la alerta a todo lo demás", () => {
    const consensus = reconcileObservations([observation("weatherapi", 29)]);
    const speech = composeNow(consensus!, { name: "Greeneville" }, {
      alerts: [
        {
          id: "a1",
          headline: "Aviso por tormentas severas",
          source: "weatherapi",
        },
      ],
    });
    expect(speech.startsWith("Atención: Aviso por tormentas severas.")).toBe(true);
    expect(speech).toContain("29 grados");
  });

  it("avisa cuando la medición ya no es de ahora", () => {
    const consensus = reconcileObservations([observation("weatherapi", 29)]);
    const speech = composeNow(consensus!, undefined, {
      observedAgeMs: 3 * 60 * 60_000,
    });
    expect(speech).toContain("no es de ahora mismo");
  });

  it("por horas responde con la primera hora de lluvia", () => {
    const speech = composeHourly(
      [
        {
          time: "2026-08-29 14:00",
          temperatureC: 30,
          condition: "Soleado",
          conditionClass: "clear",
          chanceOfRain: 5,
        },
        {
          time: "2026-08-29 17:00",
          temperatureC: 27,
          condition: "Lluvia ligera",
          conditionClass: "rain",
          chanceOfRain: 70,
        },
      ],
      { name: "Greeneville" },
    );
    expect(speech).toContain("17:00");
    expect(speech).toContain("70%");
  });
});

describe("narrativa de la app", () => {
  it("distingue una frase redactada de una tira de lecturas", () => {
    // La app compone las dos y solo la primera se puede leer en voz alta.
    expect(isProse("Subirá hasta llegar a un pico de 31° a la(s) 16:00.")).toBe(
      true,
    );
    expect(isProse("97 · % · Fase de la luna · Siguiente luna llena")).toBe(false);
    expect(isProse("Soleado")).toBe(false);
  });

  it("no lee una tarjeta de valores aunque sea la preferida", () => {
    const speech = composeNarrative(
      [
        { label: "Temperatura", summary: "19 · % · Amanecer" },
        {
          label: "Viento",
          summary: "Estable con medias de 3 km/h y rachas de 11 desde el sur.",
        },
      ],
      { name: "Greeneville" },
    );
    expect(speech).toContain("Estable con medias");
    expect(speech).not.toContain("·");
  });

  it("devuelve vacío cuando ninguna ficha trae frase, para poder degradar", () => {
    expect(
      composeNarrative([{ label: "Sol", summary: "7:00 · AM · Amanecer" }], undefined),
    ).toBe("");
  });

  it("traduce la fase lunar, que la API entrega en inglés", () => {
    expect(moonPhaseEs("Waning Gibbous")).toBe("gibosa menguante");
    expect(moonPhaseEs("Full Moon")).toBe("luna llena");
  });
});

describe("caché", () => {
  it("caduca según el TTL de cada intención", () => {
    let now = 1_000;
    const cache = new WeatherCache(10, () => now);
    const key = WeatherCache.key("weatherapi", "now", "London");
    cache.set(key, "now", { source: "weatherapi" });

    expect(cache.get(key)).toBeDefined();
    now += WEATHER_TTL_MS.now + 1;
    expect(cache.get(key)).toBeUndefined();
  });

  it("la astronomía vive mucho más que las condiciones actuales", () => {
    expect(WEATHER_TTL_MS.astronomy).toBeGreaterThan(WEATHER_TTL_MS.now * 10);
  });

  it("nunca cachea un fallo, para que la siguiente pregunta reintente", () => {
    const cache = new WeatherCache();
    const key = WeatherCache.key("weatherapi", "now", "London");
    cache.set(key, "now", { source: "weatherapi", error: "timeout" });
    expect(cache.get(key)).toBeUndefined();
  });
});

class FakeProvider implements WeatherProvider {
  calls = 0;
  constructor(
    readonly id: WeatherSourceId,
    readonly capabilities: ReadonlySet<WeatherCapability>,
    private readonly result: WeatherBundle,
    readonly typicalLatencyMs = 100,
  ) {}
  get label(): string {
    return this.id;
  }
  isConfigured(): boolean {
    return true;
  }
  async fetch(_query: WeatherQuery): Promise<WeatherBundle> {
    this.calls += 1;
    return this.result;
  }
}

const CURRENT_ONLY: ReadonlySet<WeatherCapability> = new Set<WeatherCapability>([
  "current",
  "anyLocation",
]);
const APP_CAPS: ReadonlySet<WeatherCapability> = new Set<WeatherCapability>([
  "current",
  "narrative",
]);

describe("enrutado del oráculo", () => {
  it("no abre la app de escritorio para una pregunta simple", async () => {
    // Es la regla que sostiene todo el diseño: 12 segundos de silencio en una
    // conversación hablada es un fallo, no una respuesta lenta.
    const api = new FakeProvider("weatherapi", CURRENT_ONLY, {
      source: "weatherapi",
      place: { name: "Greeneville" },
      observation: observation("weatherapi", 29),
    });
    const app = new FakeProvider("msn-app", APP_CAPS, {
      source: "msn-app",
      observation: observation("msn-app", 29),
    });
    const oracle = new WeatherOracle({ providers: [api, app] });

    const answer = await oracle.answer({ intent: "now", location: "Greeneville" });

    expect(answer.speak).toContain("29 grados");
    expect(app.calls).toBe(0);
  });

  it("cae a la app solo cuando todas las APIs fallan", async () => {
    const api = new FakeProvider("weatherapi", CURRENT_ONLY, {
      source: "weatherapi",
      error: "weatherapi_timeout",
    });
    const app = new FakeProvider("msn-app", APP_CAPS, {
      source: "msn-app",
      place: { name: "Greeneville" },
      observation: observation("msn-app", 27),
    });
    const oracle = new WeatherOracle({ providers: [api, app] });

    const answer = await oracle.answer({ intent: "now" });

    expect(app.calls).toBe(1);
    expect(answer.speak).toContain("27 grados");
    expect(answer.degraded).toContain("weatherapi_timeout");
  });

  it("descarta la app cuando se pregunta por otra ciudad", async () => {
    // La app solo sabe leer la ubicación que tiene configurada.
    const app = new FakeProvider("msn-app", APP_CAPS, {
      source: "msn-app",
      observation: observation("msn-app", 27),
    });
    const oracle = new WeatherOracle({ providers: [app] });

    const answer = await oracle.answer({ intent: "now", location: "Madrid" });

    expect(app.calls).toBe(0);
    expect(answer.error).toBeTruthy();
  });

  it("respeta el permiso por fuente", async () => {
    const api = new FakeProvider("weatherapi", CURRENT_ONLY, {
      source: "weatherapi",
      observation: observation("weatherapi", 29),
    });
    const oracle = new WeatherOracle({
      providers: [api],
      isSourceAllowed: () => false,
    });

    const answer = await oracle.answer({ intent: "now", location: "Madrid" });

    expect(api.calls).toBe(0);
    expect(answer.error).toBeTruthy();
  });

  it("la caché evita repetir la llamada", async () => {
    const api = new FakeProvider("weatherapi", CURRENT_ONLY, {
      source: "weatherapi",
      observation: observation("weatherapi", 29),
    });
    const oracle = new WeatherOracle({ providers: [api] });

    await oracle.answer({ intent: "now", location: "Madrid" });
    await oracle.answer({ intent: "now", location: "Madrid" });

    expect(api.calls).toBe(1);
  });

  it("deja de intentar la app tras dos fallos seguidos", async () => {
    // Si actualizan la app y se mueven los ids, sin cortacircuitos cada
    // pregunta costaría veinte segundos para acabar fallando igual.
    const app = new FakeProvider("msn-app", APP_CAPS, {
      source: "msn-app",
      error: "msn_app_timeout",
    });
    const oracle = new WeatherOracle({ providers: [app] });

    await oracle.answer({ intent: "narrative" });
    await oracle.answer({ intent: "narrative" });
    const third = await oracle.answer({ intent: "narrative" });

    expect(app.calls).toBe(2);
    expect(third.degraded).toContain("MSN El Tiempo");
  });
});

describe("lectura de la app MSN", () => {
  it("extrae la temperatura del texto que publica la app", () => {
    expect(parseTemperature("28 °C")).toBe(28);
    expect(parseTemperature("-3°")).toBe(-3);
    expect(parseTemperature("sin datos")).toBeUndefined();
  });

  it("reparte la tira de lecturas en campos", () => {
    const parsed = parseMetricStrip([
      "viento 4 km/h",
      "humedad 58%",
      "Sensación térmica 34°",
      "Índice UV 3",
    ]);
    expect(parsed).toMatchObject({
      windKph: 4,
      humidity: 58,
      feelsLikeC: 34,
      uvIndex: 3,
    });
  });

  it("ancla el reloj de la app a una fecha comparable con las APIs", () => {
    const now = new Date("2026-08-29T18:00:00.000Z");
    const iso = resolveObservedAt("12:21 PM", now);
    expect(new Date(iso).getHours()).toBe(12);
    expect(new Date(iso).getMinutes()).toBe(21);
  });

  it("un reloj por delante del ahora solo puede ser de ayer", () => {
    const now = new Date("2026-08-29T06:00:00.000Z");
    now.setHours(6, 0, 0, 0);
    const iso = resolveObservedAt("11:30 PM", now);
    expect(new Date(iso).getTime()).toBeLessThan(now.getTime());
  });
});
