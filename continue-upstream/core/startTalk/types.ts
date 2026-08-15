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

export interface StartTalkVideoStartRequest {
  sessionId: string;
  source: StartTalkVideoSource;
  /** Nombre del dispositivo de cámara (DirectShow) si source === "camera". */
  deviceName?: string;
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

export interface StartTalkToolActivity {
  id: string;
  label: string;
  status: StartTalkToolActivityStatus;
  detail?: string;
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
      // Voice biometrics identified (or failed to identify) the current speaker.
      type: "speaker";
      sessionId: string;
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
