/**
 * voiceMemory.ts — Puente de memoria para Start Talk (voz).
 *
 * La memoria REAL vive en el backend I24D (`src/cerebro/memory`, pgvector sobre
 * Supabase) y se expone por HTTP en `/api/memory/*`. Este helper deja que la
 * sesión de voz (StartTalkManager) la consuma SIN sacar el service_role de
 * Supabase al cliente: todo pasa por el backend local con el bearer
 * `I24D_ADMIN_TOKEN` (la misma clave que ya usa runtimeClient).
 *
 *   - loadVoiceMemoryBlock: al conectar, arma un bloque de memoria (identidad +
 *     brief proactivo + memorias durables + conversación reciente) para
 *     inyectarlo en el systemInstruction de Gemini Live.
 *   - learnFromVoiceTranscript: al cerrar, envía el transcript a
 *     `/api/memory/learn` para que Lumina aprenda hechos durables.
 *
 * Todo es best-effort: cualquier fallo (backend caído, sin token) degrada a
 * "sin memoria" en silencio y nunca rompe la sesión de voz.
 */
import { readLuminaEnv } from "../luminaBridge/luminaEnv.js";
import {
  resolveLuminaCanonicalUserId,
  resolveLuminaCoreUrl,
} from "../luminaBridge/runtimeClient.js";

const REQUEST_TIMEOUT_MS = 6000;
const MAX_BLOCK_CHARS = 2200;

export type VoiceTranscriptEntry = { role: "user" | "assistant"; text: string };

function authHeaders(): Record<string, string> {
  const token = readLuminaEnv("I24D_ADMIN_TOKEN");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Resuelve el userId canónico compartido con el backend (mismo del cerebro). */
export function resolveVoiceUserId(): string {
  try {
    return resolveLuminaCanonicalUserId();
  } catch {
    return "lumina-user:owner";
  }
}

function clip(value: unknown, max = 240): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function getJson(
  url: string,
  signal: AbortSignal,
): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(url, { headers: authHeaders(), signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Construye el bloque de memoria para el system prompt. Devuelve "" si no hay
 * nada que recordar o el backend no responde (degradación silenciosa).
 */
export async function loadVoiceMemoryBlock(
  userId?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string> {
  let baseUrl: string;
  try {
    baseUrl = resolveLuminaCoreUrl();
  } catch {
    return "";
  }
  const uid = (userId && userId.trim()) || resolveVoiceUserId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const recentUrl = new URL(`${baseUrl}/api/memory/recent`);
    recentUrl.searchParams.set("userId", uid);
    const proactiveUrl = new URL(`${baseUrl}/api/memory/proactive`);
    proactiveUrl.searchParams.set("userId", uid);

    const [recent, proactive] = await Promise.all([
      getJson(recentUrl.toString(), controller.signal),
      getJson(proactiveUrl.toString(), controller.signal),
    ]);

    const lines: string[] = [];

    const identity = recent?.identity ?? proactive?.identity ?? null;
    const displayName = clip(identity?.displayName ?? identity?.name ?? "", 80);
    if (displayName) {
      lines.push(`The user you are talking to is ${displayName}.`);
    }

    const brief = clip(proactive?.brief ?? "", 600);
    if (brief) {
      lines.push(`Open threads / proactive brief: ${brief}`);
    }

    const durable = Array.isArray(recent?.durable) ? recent!.durable : [];
    if (durable.length) {
      lines.push("What you durably know about the user:");
      for (const item of durable.slice(0, 8)) {
        const text = clip(item?.memory ?? item?.summary ?? "", 200);
        if (text) {
          lines.push(`- ${text}`);
        }
      }
    }

    const recentMsgs = Array.isArray(recent?.recent) ? recent!.recent : [];
    if (recentMsgs.length) {
      lines.push("Most recent conversation with the user:");
      for (const item of recentMsgs.slice(-6)) {
        const role = item?.role === "assistant" ? "You" : "User";
        const text = clip(
          item?.content ?? item?.summary ?? item?.memory ?? "",
          200,
        );
        if (text) {
          lines.push(`${role}: ${text}`);
        }
      }
    }

    if (!lines.length) {
      return "";
    }

    const header =
      "MEMORY — persistent context about this user from earlier sessions. " +
      "Use it naturally to sound like you remember them; never read it aloud verbatim or announce that you have memory.";
    return [header, ...lines].join("\n").slice(0, MAX_BLOCK_CHARS);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envía el transcript de la sesión a `/api/memory/learn` para extraer hechos
 * durables. Best-effort y fire-and-forget desde el punto de vista del caller.
 */
export async function learnFromVoiceTranscript(
  transcript: VoiceTranscriptEntry[],
  userId?: string,
): Promise<void> {
  const cleaned = (transcript || [])
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      text: clip(entry.text, 4000),
    }))
    .filter((entry) => entry.text.length > 0);

  if (cleaned.length < 2) {
    return;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveLuminaCoreUrl();
  } catch {
    return;
  }
  const uid = (userId && userId.trim()) || resolveVoiceUserId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    await fetch(`${baseUrl}/api/memory/learn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        userId: uid,
        transcript: cleaned,
        channel: "voice",
      }),
      signal: controller.signal,
    });
  } catch {
    // best-effort: si el backend no está, no aprende esta vez.
  } finally {
    clearTimeout(timer);
  }
}
