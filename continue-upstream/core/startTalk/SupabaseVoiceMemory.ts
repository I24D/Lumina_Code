/**
 * SupabaseVoiceMemory — memoria persistente de Start Talk directamente sobre
 * Supabase (proyecto Lumina_IA), sin depender del backend HTTP de I24D.
 *
 * Antes la memoria de voz pasaba por `/api/memory/*` del backend local en
 * `:3000`. Ese servicio no siempre está arriba y, cuando no lo está, Lumina
 * conversaba sin recordar nada. Aquí la sesión de voz habla con Supabase igual
 * que el resto del cerebro de Lumina: mismas tablas (`long_term_memories`,
 * `memory_wiki`, `knowledge_entries`, `user_profiles`, `conversations`) y
 * mismas funciones de búsqueda semántica (`match_*`).
 *
 * Tres capacidades, todas best-effort (cualquier fallo degrada a "sin memoria"
 * y NUNCA rompe la conversación):
 *
 *   - loadMemoryBlock: al conectar, arma el bloque de contexto persistente
 *     (perfil + memorias durables recientes + últimos mensajes) que se inyecta
 *     en el systemInstruction.
 *   - recall: durante la conversación, la función `recall_memory` busca
 *     semánticamente en las memorias durables, la wiki de conocimiento y la
 *     base de preguntas/respuestas, y devuelve lo relevante.
 *   - learn: al cerrar, resume la conversación en un hecho durable, lo vectoriza
 *     y lo guarda, de modo que la próxima sesión ya parte sabiéndolo.
 *
 * SEGURIDAD: la `service_role` de Supabase se lee del `.env` de la raíz y solo
 * viaja en la cabecera `Authorization` hacia el propio dominio de Supabase.
 * Este módulo corre en core (host de la extensión, Node), nunca en el webview,
 * así que la clave jamás llega al cliente. Ver `luminaEnv.ts`.
 */
import { v4 as uuidv4 } from "uuid";

import {
  readLuminaEnv,
  readLuminaEnvFirst,
} from "../luminaBridge/luminaEnv.js";

const EMBEDDING_DIM = 1536;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_SUMMARY_MODEL = "gpt-4o-mini";
const DEFAULT_WIKI_USER_ID = "lumina";
const REQUEST_TIMEOUT_MS = 6000;
const MAX_BLOCK_CHARS = 2200;

export type VoiceTranscriptEntry = { role: "user" | "assistant"; text: string };

/** Una coincidencia de recuerdo, ya normalizada para leerse en voz alta. */
export interface VoiceMemoryHit {
  /** De dónde salió: memoria durable, wiki de conocimiento o base Q&A. */
  kind: "memory" | "wiki" | "knowledge";
  text: string;
  /** Similitud coseno [0, 1] cuando la búsqueda fue vectorial. */
  similarity?: number;
}

export interface VoiceMemoryRecall {
  query: string;
  hits: VoiceMemoryHit[];
}

export interface SupabaseVoiceMemoryConfig {
  url: string;
  serviceRoleKey: string;
  openAiApiKey: string;
  embeddingModel: string;
  summaryModel: string;
  /** user_id con el que se leen/escriben perfil, memorias y conversaciones. */
  voiceUserId: string;
  /** user_id de la wiki de conocimiento (los datos sembrados usan "lumina"). */
  wikiUserId: string;
}

/**
 * Resuelve la configuración desde el `.env` de la raíz. Devuelve `undefined`
 * cuando falta cualquier pieza imprescindible, y en ese caso Start Talk sigue
 * funcionando sin memoria en vez de fallar.
 */
export function resolveSupabaseVoiceMemoryConfig(
  voiceUserId: string,
): SupabaseVoiceMemoryConfig | undefined {
  const url = readLuminaEnvFirst("SUPABASE_URL", "LUMINA_SUPABASE_URL");
  const serviceRoleKey = readLuminaEnv("SUPABASE_SERVICE_ROLE_KEY");
  const openAiApiKey = readLuminaEnvFirst(
    "START_TALK_OPENAI_API_KEY",
    "OPENAI_API_KEY",
  );
  if (!url || !serviceRoleKey || !openAiApiKey) {
    return undefined;
  }
  return {
    url: url.replace(/\/$/u, ""),
    serviceRoleKey,
    openAiApiKey,
    embeddingModel:
      readLuminaEnv("OPENAI_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL,
    summaryModel:
      readLuminaEnv("START_TALK_MEMORY_SUMMARY_MODEL") || DEFAULT_SUMMARY_MODEL,
    voiceUserId: voiceUserId.trim() || "lumina-user:owner",
    wikiUserId:
      readLuminaEnv("START_TALK_WIKI_USER_ID") || DEFAULT_WIKI_USER_ID,
  };
}

/** True cuando hay credenciales suficientes para usar la memoria en Supabase. */
export function supabaseVoiceMemoryConfigured(voiceUserId: string): boolean {
  return resolveSupabaseVoiceMemoryConfig(voiceUserId) !== undefined;
}

function clip(value: unknown, max = 240): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

/** Formato de texto que pgvector acepta al castear desde una cadena. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Puede recibir un embebedor y un `fetch` inyectados para las pruebas; en
 * producción usa OpenAI y el `fetch` global. Mantener las dependencias
 * inyectables evita tener que hablar con servicios reales en los tests.
 */
export class SupabaseVoiceMemory {
  constructor(
    private readonly config: SupabaseVoiceMemoryConfig,
    private readonly deps: {
      fetch?: typeof fetch;
      embed?: (text: string) => Promise<number[]>;
      summarize?: (transcript: VoiceTranscriptEntry[]) => Promise<string>;
    } = {},
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.serviceRoleKey,
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      Accept: "application/json",
      ...extra,
    };
  }

  private async withTimeout<T>(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET sobre la Data API (PostgREST) con la service_role. */
  private async restGet(
    path: string,
    signal: AbortSignal,
  ): Promise<any[] | null> {
    const response = await this.fetchImpl(
      `${this.config.url}/rest/v1/${path}`,
      { method: "GET", headers: this.headers(), signal },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as any[];
  }

  /** Llama a una función de Postgres (RPC de PostgREST). */
  private async rpc(
    fn: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<any[] | null> {
    const response = await this.fetchImpl(
      `${this.config.url}/rest/v1/rpc/${fn}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as any[];
  }

  /** Vectoriza un texto con OpenAI (o el embebedor inyectado). */
  private async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (this.deps.embed) {
      return this.deps.embed(text);
    }
    const response = await this.fetchImpl(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.openAiApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          input: text.slice(0, 8000),
        }),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`OpenAI embeddings HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      throw new Error("OpenAI embeddings devolvió un vector inesperado.");
    }
    return embedding;
  }

  /**
   * Bloque de memoria para el system prompt. Devuelve "" si no hay nada que
   * recordar o Supabase no responde a tiempo.
   */
  async loadMemoryBlock(timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    const uid = encodeURIComponent(this.config.voiceUserId);
    return this.withTimeout(
      timeoutMs,
      async (signal) => {
        const [profileRows, durableRows, conversationRows] = await Promise.all([
          this.restGet(
            `user_profiles?user_id=eq.${uid}&select=facts,interests&limit=1`,
            signal,
          ),
          this.restGet(
            `long_term_memories?user_id=eq.${uid}&select=summary,created_at&order=created_at.desc&limit=8`,
            signal,
          ),
          this.restGet(
            `conversations?user_id=eq.${uid}&select=messages&limit=1`,
            signal,
          ),
        ]);

        const lines: string[] = [];

        const profile = profileRows?.[0];
        const facts = collectStrings(profile?.facts).slice(0, 6);
        if (facts.length) {
          lines.push("What you durably know about the user:");
          for (const fact of facts) {
            lines.push(`- ${clip(fact, 200)}`);
          }
        }
        const interests = collectStrings(profile?.interests).slice(0, 6);
        if (interests.length) {
          lines.push(
            `Their interests: ${interests.map((i) => clip(i, 60)).join(", ")}.`,
          );
        }

        const durable = Array.isArray(durableRows) ? durableRows : [];
        if (durable.length) {
          lines.push("Things you remember from earlier conversations:");
          for (const item of durable.slice(0, 8)) {
            const text = clip(item?.summary, 200);
            if (text) {
              lines.push(`- ${text}`);
            }
          }
        }

        const messages = normalizeMessages(conversationRows?.[0]?.messages);
        if (messages.length) {
          lines.push("Most recent conversation with the user:");
          for (const item of messages.slice(-6)) {
            const role = item.role === "assistant" ? "You" : "User";
            lines.push(`${role}: ${clip(item.text, 200)}`);
          }
        }

        if (!lines.length) {
          return "";
        }

        const header =
          "MEMORY — persistent context about this user from earlier sessions. " +
          "Use it naturally to sound like you remember them; never read it aloud verbatim or announce that you have memory.";
        return [header, ...lines].join("\n").slice(0, MAX_BLOCK_CHARS);
      },
      "",
    );
  }

  /**
   * Búsqueda semántica bajo demanda (función `recall_memory`). Combina memorias
   * durables del usuario, la wiki de conocimiento y la base de Q&A, ordenadas
   * por relevancia. Devuelve como mucho `limit` coincidencias.
   */
  async recall(
    query: string,
    limit = 4,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<VoiceMemoryRecall> {
    const cleanQuery = clip(query, 400);
    if (!cleanQuery) {
      return { query: cleanQuery, hits: [] };
    }
    return this.withTimeout(
      timeoutMs,
      async (signal) => {
        const embedding = await this.embed(cleanQuery, signal);
        const vector = toVectorLiteral(embedding);

        const [memoryRows, wikiRows, knowledgeRows] = await Promise.all([
          this.rpc(
            "match_long_term_memories",
            {
              p_user_id: this.config.voiceUserId,
              query_embedding: vector,
              match_threshold: 0.3,
              match_count: limit,
            },
            signal,
          ),
          this.rpc(
            "match_memory_wiki",
            {
              query_embedding: vector,
              match_count: limit,
              match_threshold: 0.45,
              p_user_id: this.config.wikiUserId,
            },
            signal,
          ),
          this.rpc(
            "match_knowledge",
            {
              query_embedding: vector,
              match_threshold: 0.35,
              match_count: limit,
            },
            signal,
          ),
        ]);

        const hits: VoiceMemoryHit[] = [];
        for (const row of memoryRows ?? []) {
          const text = clip(row?.summary, 320);
          if (text) {
            hits.push({ kind: "memory", text, similarity: row?.similarity });
          }
        }
        for (const row of wikiRows ?? []) {
          const title = clip(row?.title, 80);
          const summary = clip(row?.summary ?? row?.content, 260);
          const text = title ? `${title}: ${summary}` : summary;
          if (text) {
            hits.push({ kind: "wiki", text, similarity: row?.similarity });
          }
        }
        for (const row of knowledgeRows ?? []) {
          const answer = extractKnowledgeAnswer(row?.answer);
          const text = answer || clip(row?.question, 260);
          if (text) {
            hits.push({ kind: "knowledge", text, similarity: row?.similarity });
          }
        }

        hits.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        return { query: cleanQuery, hits: hits.slice(0, limit) };
      },
      { query: cleanQuery, hits: [] },
    );
  }

  /**
   * Aprende de una conversación al cerrarla: guarda el hilo y extrae un hecho
   * durable vectorizado. Fire-and-forget desde el punto de vista del llamante.
   */
  async learn(
    transcript: VoiceTranscriptEntry[],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const cleaned: VoiceTranscriptEntry[] = (transcript || [])
      .map((entry) => ({
        role: entry.role === "assistant" ? "assistant" : "user",
        text: clip(entry.text, 4000),
      }))
      .filter((entry) => entry.text.length > 0) as VoiceTranscriptEntry[];
    if (cleaned.length < 2) {
      return;
    }

    await this.withTimeout(
      timeoutMs * 3,
      async (signal) => {
        await this.saveConversation(cleaned, signal);
        const summary = await this.summarize(cleaned);
        const durable = clip(summary, 1000);
        if (durable.length < 12) {
          return undefined;
        }
        const embedding = await this.embed(durable, signal).catch(() => null);
        if (!embedding) {
          return undefined;
        }
        await this.fetchImpl(`${this.config.url}/rest/v1/long_term_memories`, {
          method: "POST",
          headers: this.headers({
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          }),
          body: JSON.stringify({
            id: uuidv4(),
            user_id: this.config.voiceUserId,
            summary: durable,
            embedding: toVectorLiteral(embedding),
            message_count: cleaned.length,
          }),
          signal,
        });
        return undefined;
      },
      undefined,
    );
  }

  private async saveConversation(
    messages: VoiceTranscriptEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.fetchImpl(
        `${this.config.url}/rest/v1/conversations?on_conflict=user_id`,
        {
          method: "POST",
          headers: this.headers({
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          }),
          body: JSON.stringify({
            user_id: this.config.voiceUserId,
            messages: messages.slice(-40),
            updated_at: new Date().toISOString(),
          }),
          signal,
        },
      );
    } catch {
      // Guardar el hilo es secundario: si falla, el hecho durable igual se
      // intenta guardar aparte.
    }
  }

  /**
   * Extrae hechos durables del transcript. Usa OpenAI (o el resumidor
   * inyectado); si falla, cae a un resumen textual del propio hilo para no
   * perder del todo lo aprendido.
   */
  private async summarize(transcript: VoiceTranscriptEntry[]): Promise<string> {
    if (this.deps.summarize) {
      return this.deps.summarize(transcript).catch(() => "");
    }
    const conversation = transcript
      .map((m) => `${m.role === "assistant" ? "Lumina" : "Usuario"}: ${m.text}`)
      .join("\n")
      .slice(0, 6000);
    try {
      const response = await this.fetchImpl(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.openAiApiKey}`,
          },
          body: JSON.stringify({
            model: this.config.summaryModel,
            temperature: 0.2,
            max_tokens: 220,
            messages: [
              {
                role: "system",
                content:
                  "Extrae en 1-3 frases los hechos DURABLES sobre el usuario o sus asuntos que valga la pena recordar en futuras conversaciones (preferencias, datos personales, decisiones, tareas abiertas). Escribe en tercera persona, sin saludos ni relleno. Si no hay nada durable, responde exactamente 'NADA'.",
              },
              { role: "user", content: conversation },
            ],
          }),
        },
      );
      if (!response.ok) {
        return fallbackSummary(transcript);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = clip(data.choices?.[0]?.message?.content, 1000);
      if (!content || /^nada\.?$/iu.test(content)) {
        return "";
      }
      return content;
    } catch {
      return fallbackSummary(transcript);
    }
  }
}

/** Resumen de emergencia cuando la extracción con LLM no está disponible. */
function fallbackSummary(transcript: VoiceTranscriptEntry[]): string {
  const userTurns = transcript
    .filter((m) => m.role === "user")
    .map((m) => clip(m.text, 200))
    .filter(Boolean);
  return userTurns.slice(-3).join(" | ").slice(0, 1000);
}

/** Extrae cadenas de un `facts`/`interests` que puede ser array, objeto o texto. */
function collectStrings(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((v) => clip(v)).filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((v) => clip(v))
      .filter(Boolean);
  }
  const text = clip(value);
  return text ? [text] : [];
}

/** Normaliza el `messages` jsonb de `conversations` a la forma del transcript. */
function normalizeMessages(value: unknown): VoiceTranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: VoiceTranscriptEntry[] = [];
  for (const item of value) {
    const text = clip(item?.text ?? item?.content, 400);
    if (!text) {
      continue;
    }
    result.push({
      role: item?.role === "assistant" ? "assistant" : "user",
      text,
    });
  }
  return result;
}

/**
 * Las respuestas de `knowledge_entries` se guardaron como JSON `{"answer": ...}`
 * o como texto plano. Devuelve el texto legible en cualquiera de los dos casos.
 */
function extractKnowledgeAnswer(raw: unknown): string {
  const text = clip(raw, 4000);
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { answer?: unknown };
      return clip(parsed?.answer, 320);
    } catch {
      // No era JSON válido: se usa el texto tal cual.
    }
  }
  return clip(text, 320);
}
