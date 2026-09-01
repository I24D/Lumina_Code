/**
 * SpeculativeSearch — empezar a buscar mientras el usuario todavía habla.
 *
 * Una búsqueda web tarda entre uno y tres segundos, y hoy ese reloj no arranca
 * hasta que el usuario calla, el turno se cierra, el modelo decide llamar a
 * `search_web` y la llamada llega. Cuando alguien dice "busca en internet cuál
 * es el modelo de voz más reciente de Gemini", la mitad de la frase ya dice a
 * dónde va: se puede ir buscando durante la otra mitad.
 *
 * Lo único que se adelanta es la búsqueda, que es de solo lectura. Nada con
 * efectos: ni responder un mensaje, ni tocar el PC, ni delegar una tarea. Esas
 * siguen esperando a que el modelo las pida y el usuario las autorice.
 *
 * Se paga una llamada de más cuando el usuario cambia de idea a media frase, así
 * que se dispara una sola vez por turno y solo ante una petición de búsqueda
 * explícita. Un resultado adelantado que no encaja con lo que el modelo acaba
 * pidiendo se tira: contestar la pregunta de al lado es peor que tardar.
 */
import { looksLikeIncompleteUtterance } from "./ConversationTurnManager.js";
import type { VoiceSearchOutcome } from "./webSearch.js";

/**
 * Frases con las que alguien pide una búsqueda en voz alta. Se exige una de
 * ellas: "cuál es la última versión" también acaba en búsqueda muchas veces,
 * pero adivinarlo cuesta dinero real por cada vez que se falla.
 */
const SEARCH_INTENTS: readonly RegExp[] = [
  /\bbusca(?:me|r)?\b/u,
  /\bbúsca(?:me)?\b/u,
  /\bgoogle(?:a|ar)?\b/u,
  /\bsearch\b/u,
  /\blook up\b/u,
  /\bmira\b[^.]{0,20}\b(?:internet|web|red)\b/u,
  /\ben (?:internet|la web|la red)\b/u,
  /\bon the (?:web|internet)\b/u,
];

/** Arranques que no forman parte de lo que hay que buscar. */
const LEAD_INS: readonly RegExp[] = [
  /^.*?\bbúsca(?:me)?\b\s*/u,
  /^.*?\bbusca(?:me|r)?\b\s*/u,
  /^.*?\bgoogle(?:a|ar)?\b\s*/u,
  /^.*?\blook up\b\s*/u,
  /^.*?\bsearch (?:for |the web for |online for )?/u,
  /^\s*(?:en (?:internet|la web|la red)|on the (?:web|internet))\s*/u,
];

/**
 * Palabras que no distinguen una consulta de otra. Se quitan antes de comparar
 * para que el parecido lo decidan los sustantivos, no los artículos.
 */
const STOPWORDS = new Set([
  "a",
  "al",
  "and",
  "de",
  "del",
  "e",
  "el",
  "en",
  "es",
  "for",
  "in",
  "is",
  "la",
  "las",
  "lo",
  "los",
  "me",
  "of",
  "on",
  "para",
  "por",
  "que",
  "qué",
  "the",
  "to",
  "un",
  "una",
  "y",
]);

function normalize(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function contentTokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** True cuando la frase pide explícitamente buscar algo fuera. */
export function looksLikeSearchRequest(text: string): boolean {
  const clean = normalize(text);
  return clean.length > 0 && SEARCH_INTENTS.some((rx) => rx.test(clean));
}

/**
 * Lo que habría que buscar, sin el "busca en internet" de delante. Devuelve
 * `undefined` cuando lo que queda es demasiado corto para ser una consulta:
 * "busca" a secas todavía no dice nada.
 */
export function extractSpeculativeQuery(
  text: string,
  minChars = 12,
): string | undefined {
  let query = normalize(text);
  for (const lead of LEAD_INS) {
    query = query.replace(lead, "");
  }
  query = query.trim();
  return query.length >= minChars ? query : undefined;
}

/**
 * Cuánto de la consulta más corta aparece en la otra, entre 0 y 1.
 *
 * Se usa contención y no Jaccard porque las dos cadenas no son comparables en
 * longitud por naturaleza: el parcial es habla ("a ver, busca cuál es el modelo
 * de voz más reciente de Gemini") y lo que pide el modelo es una consulta ya
 * limpia ("modelo de voz más reciente Gemini"). Jaccard penalizaría justo esa
 * limpieza, que es lo que se espera que ocurra.
 */
export function queryOverlap(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  const [shorter, longer] = left.size <= right.size ? [left, right] : [right, left];
  // Con una o dos palabras cualquier cosa se parece a cualquier cosa.
  if (shorter.size < 3) {
    return 0;
  }
  let shared = 0;
  for (const token of shorter) {
    if (longer.has(token)) {
      shared += 1;
    }
  }
  return shared / shorter.size;
}

export interface SpeculativeSearchOptions {
  /** Quien busca de verdad. Inyectado para poder probar esto sin red. */
  run: (query: string, signal: AbortSignal) => Promise<VoiceSearchOutcome>;
  /** Mínimo de la consulta ya limpia antes de arriesgarse. */
  minQueryChars?: number;
  /** Cuánto vale un resultado adelantado antes de considerarlo viejo. */
  ttlMs?: number;
  /** Parecido mínimo para reutilizarlo con lo que pide el modelo. */
  minOverlap?: number;
  now?: () => number;
}

interface Speculation {
  query: string;
  startedAt: number;
  controller: AbortController;
  result: Promise<VoiceSearchOutcome>;
}

export class SpeculativeSearch {
  private readonly run: SpeculativeSearchOptions["run"];
  private readonly minQueryChars: number;
  private readonly ttlMs: number;
  private readonly minOverlap: number;
  private readonly now: () => number;

  private pending?: Speculation;
  /** Ya se arriesgó una búsqueda en este turno. */
  private firedThisTurn = false;

  constructor(options: SpeculativeSearchOptions) {
    this.run = options.run;
    this.minQueryChars = options.minQueryChars ?? 14;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.minOverlap = options.minOverlap ?? 0.8;
    this.now = options.now ?? (() => Date.now());
  }

  /** El turno anterior ya no cuenta: lo que se buscara para él sobra. */
  beginTurn(): void {
    this.cancel();
    this.firedThisTurn = false;
  }

  /**
   * Transcripción parcial del usuario. Dispara la búsqueda como mucho una vez
   * por turno, y solo cuando la frase ya pide buscar algo concreto y no está
   * cortada a media palabra.
   */
  observe(partial: string): void {
    if (this.firedThisTurn || !looksLikeSearchRequest(partial)) {
      return;
    }
    // Un parcial que acaba en "de" o "los" todavía va a crecer, y lo que crece
    // cambia la consulta. Esperar a la siguiente transcripción sale gratis.
    if (looksLikeIncompleteUtterance(partial)) {
      return;
    }
    const query = extractSpeculativeQuery(partial, this.minQueryChars);
    if (!query) {
      return;
    }

    const controller = new AbortController();
    this.firedThisTurn = true;
    this.pending = {
      query,
      startedAt: this.now(),
      controller,
      // El fallo de una especulación no es un fallo de la conversación: se
      // guarda como resultado y quien lo reclame decidirá qué hacer. Sin este
      // catch sería un rechazo sin dueño hasta que alguien lo reclame.
      result: this.run(query, controller.signal).catch(
        (): VoiceSearchOutcome => ({ error: "speculation_failed" }),
      ),
    };
  }

  /**
   * El modelo pidió `search_web`. Devuelve el resultado adelantado si servía
   * para esta consulta, o `undefined` para que se busque de verdad.
   */
  take(query: string): Promise<VoiceSearchOutcome> | undefined {
    const pending = this.pending;
    if (!pending) {
      return undefined;
    }
    this.pending = undefined;

    if (this.now() - pending.startedAt > this.ttlMs) {
      pending.controller.abort();
      return undefined;
    }
    if (queryOverlap(pending.query, query) < this.minOverlap) {
      // Preguntó otra cosa. Tirarlo cuesta una llamada; contestarlo costaría
      // una respuesta hablada sobre algo que nadie preguntó.
      pending.controller.abort();
      return undefined;
    }
    return pending.result;
  }

  /** Aborta lo que hubiera en vuelo (interrupción, cierre de sesión). */
  cancel(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}
