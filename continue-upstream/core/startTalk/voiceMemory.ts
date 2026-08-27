/**
 * voiceMemory.ts — Puente de memoria para Start Talk (voz).
 *
 * La memoria vive en Supabase (proyecto Lumina_IA), donde ya están las tablas
 * del cerebro de Lumina: `long_term_memories`, `memory_wiki`,
 * `knowledge_entries`, `user_profiles` y `conversations`. Este helper deja que
 * la sesión de voz (StartTalkManager) las use SIN sacar la `service_role` al
 * cliente: todo corre en core (host de la extensión) y la clave se lee del
 * `.env` de la raíz (ver `luminaEnv.ts`).
 *
 *   - loadVoiceMemoryBlock: al conectar, arma el bloque de memoria (perfil +
 *     memorias durables + conversación reciente) para el systemInstruction.
 *   - recallVoiceMemory: durante la conversación, busca semánticamente en las
 *     memorias, la wiki de conocimiento y la base de Q&A (función recall_memory).
 *   - learnFromVoiceTranscript: al cerrar, extrae un hecho durable y lo guarda.
 *
 * Todo es best-effort: cualquier fallo (sin credenciales, Supabase lento)
 * degrada a "sin memoria" en silencio y nunca rompe la sesión de voz.
 */
import { resolveLuminaCanonicalUserId } from "../luminaBridge/runtimeClient.js";
import {
  resolveSupabaseVoiceMemoryConfig,
  SupabaseVoiceMemory,
  supabaseVoiceMemoryConfigured,
  type VoiceMemoryRecall,
  type VoiceTranscriptEntry,
} from "./SupabaseVoiceMemory.js";

export type { VoiceMemoryRecall, VoiceTranscriptEntry };

/** Resuelve el userId canónico compartido con el backend (mismo del cerebro). */
export function resolveVoiceUserId(): string {
  try {
    return resolveLuminaCanonicalUserId();
  } catch {
    return "lumina-user:owner";
  }
}

/** True cuando Start Talk puede usar la memoria persistente en Supabase. */
export function voiceMemoryAvailable(userId?: string): boolean {
  return supabaseVoiceMemoryConfigured(
    (userId && userId.trim()) || resolveVoiceUserId(),
  );
}

function client(userId?: string): SupabaseVoiceMemory | undefined {
  const uid = (userId && userId.trim()) || resolveVoiceUserId();
  const config = resolveSupabaseVoiceMemoryConfig(uid);
  return config ? new SupabaseVoiceMemory(config) : undefined;
}

/**
 * Construye el bloque de memoria para el system prompt. Devuelve "" si no hay
 * credenciales, nada que recordar, o Supabase no responde a tiempo.
 */
export async function loadVoiceMemoryBlock(
  userId?: string,
  timeoutMs?: number,
): Promise<string> {
  const memory = client(userId);
  if (!memory) {
    return "";
  }
  return memory.loadMemoryBlock(timeoutMs).catch(() => "");
}

/**
 * Búsqueda semántica bajo demanda para la función `recall_memory`. Devuelve las
 * coincidencias más relevantes (o ninguna, sin fallar).
 */
export async function recallVoiceMemory(
  query: string,
  userId?: string,
  limit?: number,
): Promise<VoiceMemoryRecall> {
  const memory = client(userId);
  if (!memory) {
    return { query, hits: [] };
  }
  return memory.recall(query, limit).catch(() => ({ query, hits: [] }));
}

/**
 * Extrae un hecho durable de la conversación y lo guarda. Best-effort y
 * fire-and-forget desde el punto de vista del caller.
 */
export async function learnFromVoiceTranscript(
  transcript: VoiceTranscriptEntry[],
  userId?: string,
): Promise<void> {
  const memory = client(userId);
  if (!memory) {
    return;
  }
  await memory.learn(transcript).catch(() => undefined);
}
