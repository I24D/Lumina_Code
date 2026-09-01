/**
 * WeatherOracle — quien decide de dónde sale cada respuesta.
 *
 * El modelo de voz elige QUÉ quiere saber (una `WeatherIntent`) y nunca de qué
 * fuente. Si eligiera, lo haría distinto cada vez y acabaría abriendo una app
 * de escritorio de veinte segundos para responder "¿hace frío?".
 *
 * Tres reglas gobiernan el enrutado:
 *
 *   1. Presupuesto de latencia. Caché (<50 ms) → API (<500 ms) → app (8-20 s).
 *      La app solo entra cuando se pide narrativa o cuando no queda otra.
 *   2. Cada fuente para lo suyo. Las APIs son los hechos; la app es la voz.
 *   3. Degradar en voz alta. Perder una fuente cambia la respuesta, no la mata,
 *      y lo perdido se cuenta en `degraded` en vez de fingir que no pasó.
 */
import { reconcileObservations } from "./consensus.js";
import { MsnWeatherAppProvider } from "./MsnWeatherAppProvider.js";
import { OpenWeatherProvider } from "./OpenWeatherProvider.js";
import {
  composeAlerts,
  composeAstronomy,
  composeDaily,
  composeHistory,
  composeHourly,
  composeNarrative,
  composeNow,
} from "./speech.js";
import { WeatherApiProvider } from "./WeatherApiProvider.js";
import { WeatherCache } from "./WeatherCache.js";
import type {
  WeatherAnswer,
  WeatherBundle,
  WeatherCapability,
  WeatherIntent,
  WeatherObservation,
  WeatherProvider,
  WeatherQuery,
  WeatherSourceId,
} from "./types.js";

/** Fallos seguidos de la app tras los que se deja de intentar en esta sesión. */
const APP_FAILURE_BUDGET = 2;

/** Qué capacidad exige cada intención y en qué orden se prueban las fuentes. */
const ROUTES: Record<
  WeatherIntent,
  { capability: WeatherCapability; order: WeatherSourceId[] }
> = {
  now: { capability: "current", order: ["weatherapi", "openweather", "msn-app"] },
  // La prosa es el producto aquí: la app primero, cueste lo que cueste.
  narrative: { capability: "narrative", order: ["msn-app", "weatherapi"] },
  hourly: { capability: "hourly", order: ["weatherapi", "openweather"] },
  daily: { capability: "daily", order: ["weatherapi", "openweather", "msn-app"] },
  alerts: { capability: "alerts", order: ["weatherapi"] },
  astronomy: { capability: "astronomy", order: ["weatherapi", "msn-app"] },
  history: { capability: "history", order: ["weatherapi"] },
};

export interface WeatherOracleOptions {
  providers?: WeatherProvider[];
  cache?: WeatherCache;
  /**
   * Ubicación del usuario cuando la pregunta no nombra ninguna. La inyecta
   * StartTalkManager desde el contexto de Windows; la app usa la suya propia.
   */
  resolveDefaultLocation?: () => string | undefined;
  /**
   * Puerta de privacidad por fuente. Leer la app es estado local; llamar a las
   * APIs saca la ubicación del equipo hacia terceros, así que no son la misma
   * concesión y no se pueden gobernar con un solo permiso. Se consulta en cada
   * pregunta para que revocar un permiso surta efecto sin reiniciar la sesión.
   */
  isSourceAllowed?: (source: WeatherSourceId) => boolean;
  now?: () => number;
}

export class WeatherOracle {
  private readonly providers: Map<WeatherSourceId, WeatherProvider>;
  private readonly cache: WeatherCache;
  private readonly now: () => number;
  private appFailures = 0;
  private appDisabledReason?: string;
  /** La ubicación configurada en la app, aprendida en la primera lectura. */
  private learnedLocation?: string;

  constructor(private readonly options: WeatherOracleOptions = {}) {
    const list = options.providers ?? [
      new WeatherApiProvider(),
      new OpenWeatherProvider(),
      new MsnWeatherAppProvider(),
    ];
    this.providers = new Map(list.map((provider) => [provider.id, provider]));
    this.cache = options.cache ?? new WeatherCache();
    this.now = options.now ?? (() => Date.now());
  }

  /** Fuentes realmente utilizables ahora mismo, para diagnóstico. */
  configuredSources(): WeatherSourceId[] {
    return [...this.providers.values()]
      .filter((provider) => provider.isConfigured())
      .map((provider) => provider.id);
  }

  async answer(query: WeatherQuery): Promise<WeatherAnswer> {
    const route = ROUTES[query.intent];
    if (!route) {
      return this.failure(`intención de clima desconocida: ${query.intent}`);
    }

    const location = query.location?.trim() || this.defaultLocation();
    const candidates = this.candidatesFor(query, route.capability, route.order);
    if (candidates.length === 0) {
      return this.failure(
        query.location
          ? "No tengo ninguna fuente configurada para consultar otra ciudad."
          : "No tengo ninguna fuente de clima configurada.",
      );
    }

    // `now` es el único caso donde se consultan dos fuentes a la vez: es la
    // pregunta más frecuente y la que más se beneficia de una segunda opinión.
    if (query.intent === "now") {
      return this.answerNow(query, location, candidates);
    }

    const degraded: string[] = [];
    for (const provider of candidates) {
      const bundle = await this.load(provider, { ...query, location });
      if (bundle.error) {
        degraded.push(`${provider.label}: ${bundle.error}`);
        continue;
      }
      const answer = this.compose(query, bundle);
      if (answer) {
        return {
          ...answer,
          degraded: degraded.length ? degraded.join("; ") : this.appDisabledReason,
        };
      }
      degraded.push(`${provider.label}: sin datos para ${query.intent}`);
    }

    return this.failure(
      "No pude leer el tiempo de ninguna fuente.",
      degraded.join("; "),
    );
  }

  private async answerNow(
    query: WeatherQuery,
    location: string | undefined,
    candidates: WeatherProvider[],
  ): Promise<WeatherAnswer> {
    // Solo las APIs van en paralelo. Meter la app aquí pondría 12 segundos en
    // el camino crítico de la pregunta más común.
    const fast = candidates.filter((provider) => provider.id !== "msn-app");
    const bundles = await Promise.all(
      (fast.length > 0 ? fast : candidates).map((provider) =>
        this.load(provider, { ...query, location }),
      ),
    );

    const usable = bundles.filter((bundle) => !bundle.error && bundle.observation);
    const degraded = bundles
      .filter((bundle) => bundle.error)
      .map((bundle) => `${this.labelOf(bundle.source)}: ${bundle.error}`);

    if (usable.length === 0) {
      // Todas las APIs cayeron: ahora sí vale la pena pagar la app.
      const app = candidates.find((provider) => provider.id === "msn-app");
      if (app) {
        const bundle = await this.load(app, { ...query, location: undefined });
        if (!bundle.error && bundle.observation) {
          usable.push(bundle);
        } else if (bundle.error) {
          degraded.push(`${app.label}: ${bundle.error}`);
        }
      }
    }

    if (usable.length === 0) {
      return this.failure(
        "No pude leer el tiempo de ninguna fuente.",
        degraded.join("; "),
      );
    }

    const observations = usable
      .map((bundle) => bundle.observation)
      .filter((entry): entry is WeatherObservation => Boolean(entry));
    const consensus = reconcileObservations(observations);
    if (!consensus) {
      return this.failure("No pude leer el tiempo.", degraded.join("; "));
    }

    const place = usable.find((bundle) => bundle.place?.name)?.place;
    const alerts = usable.flatMap((bundle) => bundle.alerts ?? []);
    const observedAgeMs = Math.max(
      0,
      this.now() - Date.parse(consensus.observation.observedAt),
    );

    return {
      speak: composeNow(consensus, place, { observedAgeMs, alerts }),
      confidence: consensus.confidence,
      place,
      observation: consensus.observation,
      alerts,
      sources: consensus.sources,
      disagreement: consensus.disagreement,
      degraded: degraded.length ? degraded.join("; ") : this.appDisabledReason,
    };
  }

  private compose(
    query: WeatherQuery,
    bundle: WeatherBundle,
  ): WeatherAnswer | undefined {
    const base = {
      confidence: "medium" as const,
      place: bundle.place,
      sources: [bundle.source],
    };
    const alerts = bundle.alerts ?? [];

    switch (query.intent) {
      case "narrative": {
        const cards = bundle.narrative ?? [];
        const prose = composeNarrative(cards, bundle.place, alerts);
        if (!prose) {
          // La app puede devolver fichas a medio renderizar, sin ninguna frase
          // redactada. Un resumen diario responde igual de bien la pregunta.
          const daily = bundle.daily ?? [];
          if (daily.length === 0) return undefined;
          return {
            ...base,
            speak: composeDaily(daily, bundle.place, alerts),
            daily,
            alerts,
          };
        }
        return {
          ...base,
          confidence: "high",
          speak: prose,
          narrative: cards,
          observation: bundle.observation,
          alerts,
        };
      }
      case "hourly": {
        const hourly = bundle.hourly ?? [];
        if (hourly.length === 0) return undefined;
        return {
          ...base,
          speak: composeHourly(hourly, bundle.place, alerts),
          hourly,
          alerts,
        };
      }
      case "daily": {
        const daily = bundle.daily ?? [];
        if (daily.length === 0) return undefined;
        return {
          ...base,
          speak: composeDaily(daily, bundle.place, alerts),
          daily,
          alerts,
        };
      }
      case "alerts":
        return {
          ...base,
          confidence: "high",
          speak: composeAlerts(alerts, bundle.place),
          alerts,
        };
      case "astronomy": {
        const astronomy = bundle.astronomy;
        if (!astronomy) return undefined;
        return {
          ...base,
          confidence: "high",
          speak: composeAstronomy(astronomy, bundle.place),
          astronomy,
        };
      }
      case "history": {
        const daily = bundle.daily ?? [];
        return {
          ...base,
          speak: composeHistory(daily[0], bundle.place, query.date ?? ""),
          daily,
        };
      }
      default:
        return undefined;
    }
  }

  private candidatesFor(
    query: WeatherQuery,
    capability: WeatherCapability,
    order: WeatherSourceId[],
  ): WeatherProvider[] {
    const wantsOtherCity = Boolean(query.location?.trim());
    return order
      .map((id) => this.providers.get(id))
      .filter((provider): provider is WeatherProvider => Boolean(provider))
      .filter((provider) => provider.isConfigured())
      .filter((provider) => this.options.isSourceAllowed?.(provider.id) ?? true)
      .filter((provider) => provider.capabilities.has(capability))
      // La app solo sabe de la ubicación que tiene configurada.
      .filter(
        (provider) =>
          !wantsOtherCity || provider.capabilities.has("anyLocation"),
      )
      .filter((provider) => provider.id !== "msn-app" || !this.appDisabledReason);
  }

  private async load(
    provider: WeatherProvider,
    request: WeatherQuery,
  ): Promise<WeatherBundle> {
    // Una fuente sin `anyLocation` solo sabe de su propio sitio: pasarle una
    // ubicación —aunque sea la que resolvimos por defecto para las APIs— la
    // hace rechazar la consulta en vez de leer la que ella tiene configurada.
    const query: WeatherQuery = provider.capabilities.has("anyLocation")
      ? request
      : { ...request, location: undefined };

    const key = WeatherCache.key(
      provider.id,
      query.intent,
      query.location ?? "@default",
      `${query.days ?? ""}:${query.date ?? ""}`,
    );
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const bundle = await provider.fetch(query);

    if (provider.id === "msn-app") {
      this.recordAppOutcome(bundle);
      // La ubicación que la app tiene puesta ES la preferencia del usuario:
      // se aprende una vez y sirve luego para preguntar a las APIs por "aquí".
      if (!bundle.error && bundle.place?.name) {
        this.learnedLocation = bundle.place.name;
      }
    }

    this.cache.set(key, query.intent, bundle);
    return bundle;
  }

  /**
   * Cortacircuitos del scraping. Si la app cambia y los ids se mueven, sin esto
   * cada pregunta de clima costaría veinte segundos para acabar fallando.
   */
  private recordAppOutcome(bundle: WeatherBundle): void {
    if (!bundle.error) {
      this.appFailures = 0;
      return;
    }
    this.appFailures += 1;
    if (this.appFailures >= APP_FAILURE_BUDGET && !this.appDisabledReason) {
      this.appDisabledReason = `La app MSN El Tiempo no respondió (${bundle.error}); sigo solo con las APIs.`;
    }
  }

  private defaultLocation(): string | undefined {
    return (
      this.options.resolveDefaultLocation?.() ??
      this.learnedLocation ??
      undefined
    );
  }

  private labelOf(id: WeatherSourceId): string {
    return this.providers.get(id)?.label ?? id;
  }

  private failure(message: string, detail?: string): WeatherAnswer {
    return {
      speak: message,
      confidence: "low",
      sources: [],
      error: detail || message,
      degraded: this.appDisabledReason,
    };
  }
}
