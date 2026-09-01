/**
 * Caché con TTL por tipo de dato.
 *
 * Es lo que hace que la mayoría de preguntas se respondan en el tramo de <50 ms
 * sin tocar la red, y de paso vuelve irrelevantes los límites de tasa de las
 * APIs. Los TTL no son arbitrarios: siguen a qué velocidad cambia cada cosa.
 */
import type { WeatherBundle, WeatherIntent } from "./types.js";

/** Milisegundos de vida por intención. El amanecer no se mueve; el cielo sí. */
export const WEATHER_TTL_MS: Record<WeatherIntent, number> = {
  now: 10 * 60_000,
  hourly: 60 * 60_000,
  daily: 60 * 60_000,
  // La prosa describe la FORMA del día, no el minuto: aguanta de sobra.
  narrative: 3 * 60 * 60_000,
  // Una alerta caducada se sigue anunciando si se cachea de más.
  alerts: 5 * 60_000,
  astronomy: 12 * 60 * 60_000,
  // El pasado es inmutable; se guarda hasta que se cierre la sesión.
  history: 24 * 60 * 60_000,
};

interface CacheEntry {
  bundle: WeatherBundle;
  storedAt: number;
  expiresAt: number;
}

export interface WeatherCacheStats {
  size: number;
  hits: number;
  misses: number;
}

export class WeatherCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries = 60,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static key(
    source: string,
    intent: WeatherIntent,
    location: string,
    extra = "",
  ): string {
    return `${source}|${intent}|${location.trim().toLowerCase()}|${extra}`;
  }

  get(key: string): WeatherBundle | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.bundle;
  }

  set(key: string, intent: WeatherIntent, bundle: WeatherBundle): void {
    // Un fallo no se cachea: la siguiente pregunta debe poder reintentar.
    if (bundle.error) {
      return;
    }
    const storedAt = this.now();
    this.entries.set(key, {
      bundle,
      storedAt,
      expiresAt: storedAt + WEATHER_TTL_MS[intent],
    });
    this.evictIfNeeded();
  }

  /** Edad en ms de una entrada viva, para poder decir si el dato es reciente. */
  ageMs(key: string): number | undefined {
    const entry = this.entries.get(key);
    return entry ? this.now() - entry.storedAt : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): WeatherCacheStats {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    // Map conserva orden de inserción: lo más viejo sale primero.
    const excess = this.entries.size - this.maxEntries;
    let removed = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      removed += 1;
      if (removed >= excess) {
        break;
      }
    }
  }
}
