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
  "voice-pipeline",
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

export type VoiceArchitecture =
  | "native-speech-to-speech"
  | "stt-llm-tts";

export type VoiceTransport = "webrtc" | "websocket" | "http" | "local";

export interface VoiceProviderCapabilities {
  architecture: VoiceArchitecture;
  transport: VoiceTransport;
  streamingInput: boolean;
  streamingOutput: boolean;
  tools: boolean;
  vision: boolean;
  /**
   * El proveedor entrega un handle para retomar la sesión tras una caída.
   * Es de la Live API; la Realtime API no cierra la sesión sola ni da handles,
   * así que allí pedirla es pedir algo que nunca llega.
   */
  sessionResumption: boolean;
  /**
   * El proveedor caduca la conexión por tiempo y hay que rotarla antes de que
   * lo haga. Rotar donde no hace falta solo tira el contexto de la conversación.
   */
  sessionRotation: boolean;
}

export interface VoiceProviderAdapter<TContext> {
  id: string;
  capabilities: VoiceProviderCapabilities;
  connect(context: TContext): Promise<LiveSessionHandle>;
}

/**
 * Architecture-neutral provider registry. Start Talk's UI/runtime only asks
 * for a provider id; native realtime and future STT→LLM→TTS/local adapters can
 * implement the same lifecycle without adding another branch to the manager.
 */
export class VoiceProviderRouter<TContext> {
  private readonly adapters = new Map<string, VoiceProviderAdapter<TContext>>();

  register(adapter: VoiceProviderAdapter<TContext>): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Voice provider '${adapter.id}' is already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  capabilities(provider: string): VoiceProviderCapabilities | undefined {
    return this.adapters.get(provider)?.capabilities;
  }

  async connect(
    provider: string,
    context: TContext,
    timeoutMs = 15_000,
  ): Promise<LiveSessionHandle> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Voice provider '${provider}' is not registered.`);
    }
    const pending = adapter.connect(context);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return pending;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `Voice provider '${provider}' did not connect within ${timeoutMs} ms.`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        // If the SDK eventually resolves after the timeout, close that orphan
        // socket instead of leaving a paid realtime session running invisibly.
        void pending.then((session) => session.close()).catch(() => undefined);
      }
    }
  }
}

/**
 * Extrae el texto de lo que el manager manda por `sendClientContent`.
 *
 * Vive aquí, con el contrato, porque lo necesita cualquier proveedor que no sea
 * la Live API: todos reciben la forma de Google y todos tienen que sacarle el
 * texto. Estuvo duplicado en dos adaptadores.
 */
export function flattenClientTurns(turns: unknown): string {
  if (typeof turns === "string") {
    return turns;
  }
  if (Array.isArray(turns)) {
    return turns
      .map((turn) => flattenClientTurns(turn))
      .filter(Boolean)
      .join("\n");
  }
  if (turns && typeof turns === "object") {
    const parts = (turns as { parts?: Array<{ text?: string }> }).parts;
    if (Array.isArray(parts)) {
      return parts
        .map((part) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
    }
    const text = (turns as { text?: string }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
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
