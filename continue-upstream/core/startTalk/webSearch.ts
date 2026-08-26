/**
 * webSearch.ts — Búsqueda web en vivo para Start Talk.
 *
 * Por qué existe: la Live API solo ofrece grounding nativo con Google Search en
 * los modelos 2.5 native-audio. `gemini-3.1-flash-live-preview` NO lo soporta
 * (ver `SEARCH_INCOMPATIBLE_MODELS`), y mandarlo igualmente provoca un cierre
 * 1011 garantizado. Como 3.1 es el modelo que lee sin truncar las respuestas
 * largas, la salida es darle búsqueda propia por function calling en vez de
 * quedarnos en 2.5 solo por el grounding.
 *
 * Diseñado para VOZ, que es lo que lo diferencia de `tools/implementations/
 * searchWeb.ts` (ese devuelve hasta 8000 caracteres por resultado para que un
 * LLM de texto los lea). Aquí el resultado se va a LEER EN ALTO: se pide
 * respuesta sintetizada, se recortan las fuentes con fuerza y se limita el
 * número, porque nadie quiere escuchar cinco páginas web.
 *
 * Nunca lanza: cualquier fallo vuelve como `{ error }` para que Lumina pueda
 * decir "no pude buscar eso" en vez de romper el turno.
 */
import { readLuminaEnv } from "../luminaBridge/luminaEnv.js";
import type { GroundingMetadata } from "@google/genai";
import type { StartTalkWebSearchDisclosure } from "./types.js";

/** Una fuente citable, ya recortada a tamaño de voz. */
export interface VoiceSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface VoiceSearchPayload {
  query: string;
  /** Respuesta sintetizada cuando el proveedor la ofrece (Tavily). */
  answer?: string;
  sources: VoiceSearchSource[];
  provider: string;
}

export interface VoiceSearchError {
  error: string;
}

export type VoiceSearchOutcome = VoiceSearchPayload | VoiceSearchError;

/** Límites pensados para que la respuesta se pueda escuchar sin aburrir. */
export interface VoiceSearchLimits {
  maxSources: number;
  maxAnswerChars: number;
  maxSnippetChars: number;
}

export const DEFAULT_VOICE_SEARCH_LIMITS: VoiceSearchLimits = {
  maxSources: 3,
  maxAnswerChars: 700,
  maxSnippetChars: 220,
};

/** Accepts only user-openable HTTP(S) source URLs and strips embedded auth. */
export function safeWebUrl(value: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      parsed.username = "";
      parsed.password = "";
      parsed.hash = "";
      return parsed.toString();
    }
    return raw;
  } catch {
    return undefined;
  }
}

/** Shapes the limited metadata exposed by native Google Live grounding. */
export function discloseNativeGrounding(
  metadata: GroundingMetadata | undefined,
): StartTalkWebSearchDisclosure | undefined {
  if (!metadata) return undefined;
  const queries = (metadata.webSearchQueries ?? [])
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, 8);
  const sources = (metadata.groundingChunks ?? [])
    .flatMap((chunk) => {
      const url = safeWebUrl(chunk.web?.uri ?? "");
      if (!url) return [];
      return [
        {
          title: String(chunk.web?.title ?? url)
            .trim()
            .slice(0, 160),
          url,
        },
      ];
    })
    .filter(
      (source, index, all) =>
        all.findIndex((candidate) => candidate.url === source.url) === index,
    )
    .slice(0, 8);
  if (!queries.length && !sources.length) return undefined;
  return {
    query: queries.join(" · ") || "Consulta generada por Google",
    provider: "google",
    sources,
    visibility: "metadata-only",
  };
}

/**
 * Timeout corto a propósito: esto ocurre en mitad de una conversación hablada.
 * Más de unos segundos y el silencio ya resulta raro; es preferible admitir que
 * no se pudo buscar.
 */
const SEARCH_TIMEOUT_MS = 9_000;

/** Normaliza espacios y recorta sin partir una palabra por la mitad. */
export function clip(text: string, maxChars: number): string {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (
    (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "…"
  );
}

/**
 * Aplica los límites de voz a un resultado crudo. Separado del acceso a red
 * para poder testearlo sin tocar internet.
 */
export function shapeForVoice(
  query: string,
  provider: string,
  raw: { answer?: string; sources: VoiceSearchSource[] },
  limits: VoiceSearchLimits = DEFAULT_VOICE_SEARCH_LIMITS,
): VoiceSearchPayload {
  const seen = new Set<string>();
  const sources: VoiceSearchSource[] = [];
  for (const source of raw.sources) {
    const url = safeWebUrl(source.url);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    sources.push({
      title: clip(source.title || url, 120),
      url,
      snippet: clip(source.snippet, limits.maxSnippetChars),
    });
    if (sources.length >= limits.maxSources) {
      break;
    }
  }

  const answer = raw.answer
    ? clip(raw.answer, limits.maxAnswerChars)
    : undefined;
  return { query, provider, ...(answer ? { answer } : {}), sources };
}

/** Orden de proveedores: `SEARCH_PROVIDERS` del .env, filtrado a los soportados. */
export function resolveProviderOrder(): string[] {
  const supported = ["tavily", "brave"];
  const configured = (readLuminaEnv("SEARCH_PROVIDERS") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => supported.includes(entry));
  // Los configurados primero, respetando su orden; el resto detrás como reserva.
  return [...configured, ...supported.filter((s) => !configured.includes(s))];
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tavily es el preferido porque devuelve una respuesta ya sintetizada
 * (`include_answer`), que es justo lo que se puede leer en alto sin reelaborar.
 */
async function searchTavily(
  query: string,
  limits: VoiceSearchLimits,
): Promise<VoiceSearchPayload | null> {
  const apiKey = readLuminaEnv("TAVILY_API_KEY");
  if (!apiKey) {
    return null;
  }

  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.max(1, limits.maxSources),
      search_depth: "basic", // "advanced" duplica la latencia; en voz no compensa
      include_answer: true,
    }),
  });
  if (!data) {
    return null;
  }

  const results = Array.isArray(data.results) ? data.results : [];
  const sources: VoiceSearchSource[] = results.map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      title: String(item.title ?? ""),
      url: String(item.url ?? ""),
      snippet: String(item.content ?? ""),
    };
  });
  const answer = typeof data.answer === "string" ? data.answer : undefined;
  if (!answer && sources.length === 0) {
    return null;
  }
  return shapeForVoice(query, "tavily", { answer, sources }, limits);
}

/** Brave como reserva: sin síntesis, pero resultados propios y rápidos. */
async function searchBrave(
  query: string,
  limits: VoiceSearchLimits,
): Promise<VoiceSearchPayload | null> {
  const apiKey = readLuminaEnv("BRAVE_API_KEY");
  if (!apiKey) {
    return null;
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query,
  )}&count=${Math.max(1, limits.maxSources)}`;
  const data = await fetchJson(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!data) {
    return null;
  }

  const web = data.web as { results?: unknown } | undefined;
  const results = Array.isArray(web?.results) ? web.results : [];
  const sources: VoiceSearchSource[] = results.map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      title: String(item.title ?? ""),
      url: String(item.url ?? ""),
      // Brave marca los términos con <strong>; en voz sobran.
      snippet: String(item.description ?? "").replace(/<[^>]+>/g, ""),
    };
  });
  if (sources.length === 0) {
    return null;
  }
  return shapeForVoice(query, "brave", { sources }, limits);
}

/**
 * Busca en la web con la cadena de proveedores configurada. Devuelve el primer
 * proveedor que responda algo útil; si ninguno responde, un error legible.
 */
export async function searchWebForVoice(
  query: string,
  limits: VoiceSearchLimits = DEFAULT_VOICE_SEARCH_LIMITS,
): Promise<VoiceSearchOutcome> {
  const clean = String(query ?? "").trim();
  if (!clean) {
    return { error: "empty_query" };
  }

  const providers: Record<
    string,
    {
      run: (
        q: string,
        l: VoiceSearchLimits,
      ) => Promise<VoiceSearchPayload | null>;
      keyName: string;
    }
  > = {
    tavily: { run: searchTavily, keyName: "TAVILY_API_KEY" },
    brave: { run: searchBrave, keyName: "BRAVE_API_KEY" },
  };

  const order = resolveProviderOrder();
  // Distinguir "no hay clave" de "la búsqueda falló" importa: la primera vez que
  // esto se rompió en producción, el .env no se encontraba y el error decía
  // `search_unavailable`, que apunta al proveedor y no al sitio real del fallo.
  let anyKeyPresent = false;
  for (const name of order) {
    const provider = providers[name];
    if (!provider) {
      continue;
    }
    if (!readLuminaEnv(provider.keyName)) {
      continue;
    }
    anyKeyPresent = true;
    const result = await provider.run(clean, limits);
    if (result) {
      return result;
    }
  }

  return {
    error: anyKeyPresent ? "search_unavailable" : "no_search_api_key",
  };
}
