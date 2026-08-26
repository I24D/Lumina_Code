export type StartTalkProvider = "gemini-live";

export type StartTalkThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * Session behaviour:
 *  - "assistant"   : normal Lumina voice assistant (persona + memory + tools).
 *  - "interpreter" : real-time interpreter that only translates, never answers.
 */
export type StartTalkMode = "assistant" | "interpreter";

/** Real-time translation settings used when `mode === "interpreter"`. */
export interface StartTalkTranslationConfig {
  /** BCP-47 source language (e.g. "es-ES"), or "auto" / undefined to detect. */
  source?: string;
  /** BCP-47 target language the interpreter speaks (e.g. "en-US"). Required. */
  target: string;
  /**
   * Two-way interpreting: translate source→target and target→source,
   * auto-selecting direction per utterance. Requires an explicit `source`.
   */
  bidirectional?: boolean;
}

export type StartTalkConnectionStatus =
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "idle"
  | "closed";

export type StartTalkNotificationAccess =
  | "checking"
  | "allowed"
  | "denied"
  | "unsupported"
  | "error";

export interface StartTalkNotification {
  id: string;
  appName: string;
  appUserModelId?: string;
  title: string;
  body?: string;
  createdAt: string;
  textElements?: string[];
  sourceKind?: "windows" | "phone_link";
  mobileApp?: string;
  sender?: string;
  message?: string;
  conversationKind?: "direct" | "group" | "unknown" | "not_applicable";
  replyEligibility?:
    | "eligible"
    | "group_blocked"
    | "sensitive_blocked"
    | "ambiguous"
    | "not_actionable";
}

export interface StartTalkConnectRequest {
  preferredModel?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  /** Fija un idioma de salida (BCP-47, p.ej. "es-ES"). Si se omite, la voz
   * detecta y cambia de idioma automáticamente. */
  languageCode?: string;
  /** Activa grounding con Google Search en vivo (default: true). */
  enableSearch?: boolean;
  /** Activa function calling (delegación real a Lumina Code) (default: true). */
  enableTools?: boolean;
  /** Activa reanudación de sesión para superar el límite de 15 min sin perder
   * contexto (default: true). */
  enableSessionResumption?: boolean;
  /** Session behaviour (default: "assistant"). */
  mode?: StartTalkMode;
  /** Real-time translation settings, used only when `mode === "interpreter"`. */
  translation?: StartTalkTranslationConfig;
  /**
   * Optional speaking-style / emotion hint for assistant mode (e.g. "warm and
   * upbeat", "calm and slow", "energetic"). Ignored in interpreter mode.
   */
  voiceStyle?: string;
  /** Announces new Windows notifications after the current spoken turn ends. */
  announceNotifications?: boolean;
}

export interface StartTalkMuteRequest {
  sessionId: string;
  muted: boolean;
}

export interface StartTalkTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface StartTalkConnectResponse {
  sessionId: string;
  model: string;
  provider: StartTalkProvider;
}

export interface StartTalkAudioChunk {
  sessionId: string;
  data: string;
  mimeType: string;
}

export interface StartTalkTextInput {
  sessionId: string;
  text: string;
}

export interface StartTalkSessionRequest {
  sessionId: string;
}

export interface StartTalkNotificationSettingsRequest {
  sessionId: string;
  enabled: boolean;
}

/**
 * El usuario acaba de autorizar de viva voz que se responda a algo concreto.
 * Sin uno de estos registrado, las funciones de respuesta se rechazan: la
 * instrucción del prompt de "pide confirmación antes" es una indicación, no una
 * garantía, y enviar un mensaje en nombre de alguien no se puede deshacer.
 */
export interface StartTalkReplyAuthorization {
  sessionId: string;
  /** Notificaciones de Enlace Móvil que el usuario autorizó responder. */
  notificationIds?: string[];
  /** Contactos de WhatsApp en el PC que el usuario autorizó responder. */
  contacts?: string[];
}

export interface StartTalkCaptureRequest {
  sessionId: string;
  deviceName?: string;
}

/** Una llamada a función que el modelo pide ejecutar (function calling). */
export interface StartTalkFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Live connection generation that created this function call. */
  connectionEpoch?: number;
}

/** Resultado de una function call, devuelto al modelo. */
export interface StartTalkToolResponseInput {
  sessionId: string;
  id: string;
  name: string;
  /** Must match the Live connection that created the function call. */
  connectionEpoch?: number;
  /** Salida textual (o error) de la función ejecutada. */
  output: string;
  error?: boolean;
}

export type StartTalkVideoSource = "screen" | "camera";

/**
 * Región de escritorio a capturar, en píxeles del escritorio virtual. Se usa
 * para compartir UN monitor concreto en vez de la unión de todos (que en
 * multi-monitor produce una imagen panorámica ilegible al escalarla).
 */
export interface StartTalkVideoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Una fuente de vídeo elegible: un monitor concreto o una cámara. */
export interface StartTalkVideoSourceInfo {
  /** Identificador estable usado para volver a seleccionarla. */
  id: string;
  kind: StartTalkVideoSource;
  label: string;
  /** Solo para monitores: región del escritorio virtual que ocupa. */
  region?: StartTalkVideoRegion;
  /** Solo para monitores: true si es el monitor principal de Windows. */
  primary?: boolean;
  /**
   * Solo para cámaras: nombre exacto del dispositivo DirectShow. Va aparte de
   * `label` a propósito: la etiqueta es texto para el usuario y puede cambiar,
   * mientras que esto es lo que se le pasa a FFmpeg.
   */
  deviceName?: string;
}

export interface StartTalkVideoStartRequest {
  sessionId: string;
  source: StartTalkVideoSource;
  /** Nombre del dispositivo de cámara (DirectShow) si source === "camera". */
  deviceName?: string;
  /**
   * Solo pantalla: recorta la captura a esta región. Si se omite, se captura
   * el escritorio completo (todos los monitores).
   */
  region?: StartTalkVideoRegion;
  /** Identificador de la fuente elegida (para reflejarlo en la UI). */
  sourceId?: string;
  /** Etiqueta legible de la fuente, para que la UI diga cuál se está viendo. */
  label?: string;
}

import type {
  StartTalkSessionMetrics,
  StartTalkTurnMetrics,
} from "./TurnMetrics.js";

export type { StartTalkSessionMetrics, StartTalkTurnMetrics };

/** Fase del stream de vídeo, para que la UI no mienta sobre lo que Lumina ve. */
export type StartTalkVideoPhase = "starting" | "live" | "stopped" | "error";

/**
 * Cuánta voz le queda a Lumina por sonar en la cola de reproducción del
 * cliente. Es el único dato fiable de "sigue hablando": el servidor entrega el
 * audio hasta 3x más rápido que el tiempo real, así que core no puede deducirlo
 * de la hora de llegada de los fragmentos.
 */
export interface StartTalkPlaybackReport {
  sessionId: string;
  remainingMs: number;
}

/** Fotograma de vídeo (JPEG base64) provisto por el cliente, si aplica. */
export interface StartTalkVideoFrameInput {
  sessionId: string;
  data: string;
  mimeType: string;
}

export type StartTalkToolActivityStatus =
  | "running"
  | "waiting"
  | "done"
  | "error";

export interface StartTalkWebSearchSource {
  title: string;
  url: string;
  /** Exact excerpt delivered to the voice model, when the provider exposes it. */
  snippet?: string;
}

export interface StartTalkWebSearchDisclosure {
  query: string;
  provider?: string;
  /** Provider synthesis delivered to the voice model. */
  answer?: string;
  sources: StartTalkWebSearchSource[];
  /** Google Live exposes citations but not the retrieved page excerpts. */
  visibility: "payload" | "metadata-only";
}

export interface StartTalkToolActivity {
  id: string;
  label: string;
  status: StartTalkToolActivityStatus;
  detail?: string;
  /** Auditable web-search material shown in the Start Talk conversation. */
  webSearch?: StartTalkWebSearchDisclosure;
}

export type StartTalkCoreEvent =
  | {
      type: "status";
      sessionId: string;
      status: StartTalkConnectionStatus;
      message?: string;
      model?: string;
    }
  | {
      type: "audio";
      sessionId: string;
      data: string;
      mimeType: string;
    }
  | {
      type: "transcript";
      sessionId: string;
      source: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      type: "interrupted";
      sessionId: string;
    }
  | {
      /**
       * Cambió el entorno acústico: varias voces solapadas de forma sostenida
       * (o vuelta a la calma). Lumina aplica sus reglas de grupo cuando está
       * `crowded`: por defecto calla y solo habla si la interpelan.
       */
      type: "environment";
      sessionId: string;
      crowded: boolean;
    }
  | {
      /**
       * Decidió que el turno no iba dirigido a ella y gastó el turno en
       * `stay_silent` en vez de hablar. Es comportamiento correcto, no un fallo.
       */
      type: "stayedSilent";
      sessionId: string;
      reason?: string;
    }
  | {
      /**
       * Un turno se cerró: latencia de respuesta, velocidad de entrega, falsos
       * inicios. Sirve para afinar el VAD y comparar modelos con datos en vez
       * de a oído.
       */
      type: "turnMetrics";
      sessionId: string;
      turn: StartTalkTurnMetrics;
      session: StartTalkSessionMetrics;
    }
  | {
      // Voice biometrics identified (or failed to identify) the current speaker.
      type: "speaker";
      sessionId: string;
      /** Monotonic user-turn id. Lets clients discard late biometric results. */
      turnId: number;
      /** Canonical identity id when matched. */
      identityId?: string;
      /** Human-readable speaker name when matched. */
      name?: string;
      /** Cosine similarity score of the match (0..1). */
      score?: number;
      /** True when the voiceprint matched an enrolled identity. */
      matched: boolean;
    }
  | {
      type: "toolCall";
      sessionId: string;
      call: StartTalkFunctionCall;
    }
  | {
      type: "goingAway";
      sessionId: string;
      /** Tiempo restante que reporta el servidor antes de cerrar (si lo da). */
      timeLeft?: string;
    }
  | {
      type: "toolActivity";
      sessionId: string;
      activity: StartTalkToolActivity;
    }
  | {
      type: "notification";
      sessionId: string;
      notification: StartTalkNotification;
    }
  | {
      // A finished external coding-chat response (Claude Code or Codex), to be
      // read aloud through the same queue as Lumina Code chat responses.
      type: "chatResponse";
      sessionId: string;
      requestId: string;
      text: string;
    }
  | {
      type: "notificationAccess";
      sessionId: string;
      status: StartTalkNotificationAccess;
      message?: string;
    }
  | {
      // Real-time microphone input level for the audio-reactive visualizer.
      type: "level";
      sessionId: string;
      /** Normalised RMS level in [0, 1]. */
      level: number;
    }
  | {
      // A non-speech acoustic event was detected in the microphone stream.
      type: "soundEvent";
      sessionId: string;
      /** Coarse category of the detected sound. */
      category: StartTalkSoundCategory;
      /** Confidence in [0, 1]. */
      confidence: number;
    }
  | {
      // Estado real del stream de vídeo (pantalla o cámara). Va aparte de
      // `error` a propósito: que se caiga la captura de pantalla NO debe dejar
      // toda la sesión de voz marcada como rota en la UI.
      type: "videoState";
      sessionId: string;
      phase: StartTalkVideoPhase;
      source?: StartTalkVideoSource;
      /** Identificador de la fuente elegida (monitor o cámara). */
      sourceId?: string;
      /** Etiqueta legible de la fuente ("Monitor 1", "HD Webcam"…). */
      label?: string;
      /** Fotogramas enviados al modelo desde que arrancó este stream. */
      framesSent?: number;
      /** Momento (epoch ms) del último fotograma que vio el modelo. */
      lastFrameAt?: number;
      /** Miniatura JPEG en base64 para la vista previa de la UI (throttled). */
      preview?: string;
      /** Causa del fallo cuando phase === "error". */
      message?: string;
    }
  | {
      type: "error";
      sessionId?: string;
      message: string;
    };

export type StartTalkSoundCategory =
  | "speech"
  | "tonal"
  | "impulsive"
  | "broadband"
  | "silence";
