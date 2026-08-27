/**
 * VoiceProvider — el contrato que comparten los backends de voz en tiempo real
 * de Start Talk.
 *
 * Start Talk habla hoy con dos proveedores:
 *
 *  - `gemini-live`     : la Live API de Google (`@google/genai`), audio dúplex
 *                        nativo con grounding de Google Search en el mismo
 *                        stream bidi.
 *  - `openai-realtime` : la Realtime API de OpenAI sobre WebSocket
 *                        (`OpenAIRealtimeSession`), con `gpt-realtime-2.1`.
 *
 * Los dos exponen el mismo ciclo de vida a `StartTalkManager`:
 *
 *   connect → startCapture → (audio/transcript/toolCall events) → stop
 *
 * El vocabulario de cable es el de la Live API (`LiveServerMessage` y los
 * parámetros de `Session`): es el que ya sabe despachar el manager, así que un
 * proveedor nuevo traduce a esa forma en vez de obligar a duplicar el
 * despachador de eventos, la puerta de voz, el vídeo y las métricas.
 */
import type { Session, LiveServerMessage } from "@google/genai";

import { providerForModel } from "./voices.js";
import type { StartTalkProvider } from "./types.js";

export const DEFAULT_VOICE_PROVIDER: StartTalkProvider = "openai-realtime";

/** Proveedores con implementación real. */
export const SUPPORTED_VOICE_PROVIDERS: readonly StartTalkProvider[] = [
  "gemini-live",
  "openai-realtime",
];

/**
 * La parte de la sesión de la Live API que usa el manager. Es lo único que un
 * proveedor tiene que implementar: `Session` de `@google/genai` la satisface
 * tal cual, y `OpenAIRealtimeSession` la implementa traduciendo a eventos de
 * la Realtime API.
 */
export interface LiveSessionHandle {
  sendClientContent(content: Parameters<Session["sendClientContent"]>[0]): void;
  sendRealtimeInput(input: Parameters<Session["sendRealtimeInput"]>[0]): void;
  sendToolResponse(response: Parameters<Session["sendToolResponse"]>[0]): void;
  close(): void;
}

/** Callbacks de conexión, con la misma forma que `ai.live.connect`. */
export interface LiveSessionCallbacks {
  onopen: () => void;
  onmessage: (message: LiveServerMessage) => void;
  onerror: (error: { message: string }) => void;
  onclose: (event: { code: number; reason?: string }) => void;
}

export function isSupportedVoiceProvider(
  value: string | undefined,
): value is StartTalkProvider {
  return SUPPORTED_VOICE_PROVIDERS.includes(value as StartTalkProvider);
}

/**
 * Resuelve el proveedor activo.
 *
 * El modelo manda: si se ha elegido uno concreto, su identificador ya dice de
 * quién es (`gpt-*` es de OpenAI). Sin modelo se usa `START_TALK_PROVIDER` y,
 * en su defecto, el proveedor por defecto.
 */
export function resolveVoiceProvider(model?: string): StartTalkProvider {
  if (model?.trim()) {
    return providerForModel(model);
  }

  const requested = String(process.env.START_TALK_PROVIDER ?? "").trim();
  return isSupportedVoiceProvider(requested)
    ? requested
    : DEFAULT_VOICE_PROVIDER;
}
