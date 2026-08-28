import type {
  StartTalkCoreEvent,
  StartTalkFunctionCall,
  StartTalkNotification,
  StartTalkNotificationAccess,
  StartTalkSessionMetrics,
  StartTalkSoundCategory,
  StartTalkTranscriptEntry,
  StartTalkTranslationConfig,
  StartTalkTurnMetrics,
  StartTalkVideoPhase,
  StartTalkVideoSource,
  StartTalkVideoSourceInfo,
} from "core/startTalk";
import { getStartTalkRetryDelayMs } from "core/startTalk/resiliencePolicy";
import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppSelector } from "../../redux/hooks";
import {
  StartTalkActiveSession,
  StartTalkDelegationApproval,
  StartTalkModelOption,
  StartTalkStatus,
  StartTalkThinkingLevel,
  StartTalkToolActivity,
  StartTalkTranscriptItem,
} from "./types";
import {
  buildNotificationAnnouncementPrompt,
  buildNotificationAutoReplyTask,
  canAnnounceNotificationNow,
  rememberNotificationOnce,
} from "./notificationAnnouncement";
import {
  buildPhoneAssistantBridgePrompt,
  isPhoneBridgeEligible,
  selectPhoneBridgeNotifications,
} from "./phoneAssistantBridge";
import { isAffirmativeReply, isNegativeReply } from "./confirmationPhrases";
import {
  MicCapture,
  listMicrophones,
  type MicCaptureSettings,
  type MicrophoneDevice,
} from "./micCapture";
import { PcmPlayer } from "./pcmPlayer";
import { resolveSpeakerUpdate, type SpeakerInfo } from "./speakerState";
import { buildChatResponseSpeechPrompt } from "./voiceDelegation";

// How long, after Start Talk asks "¿quieres que le responda?", a spoken
// confirmation still triggers the delegated reply. After this the pending
// message is dropped so a much-later "sí" about something else never fires it.
const REPLY_CONFIRMATION_WINDOW_MS = 90_000;

/**
 * Cuánto se espera, tras vaciarse la cola de voz, antes de dar el turno por
 * cerrado sin haber recibido `turnComplete`. Solo salta si la sesión se cayó a
 * media respuesta; en el caso normal `turnComplete` llega cuando ella termina
 * de sonar, no cuando el servidor termina de generar.
 */
const TURN_STUCK_TIMEOUT_MS = 8_000;

/**
 * Techo del watchdog de una tanda de notificaciones. El fijo de 45 s se
 * disparaba EN MEDIO de una lectura normal: medido contra la API, leer una
 * respuesta de 3.100 caracteres son 164 s de voz. Ahora se dimensiona con lo
 * que queda por sonar y este valor solo actúa como tope absoluto.
 */
const NOTIFICATION_WATCHDOG_MAX_MS = 300_000;
/** Margen sobre la duración estimada de la lectura antes de darla por perdida. */
const ANNOUNCEMENT_WATCHDOG_GRACE_MS = 45_000;
/**
 * Cuántas notificaciones pueden esperar turno de lectura. Con todas las apps
 * del móvil reenviando por Enlace Móvil, una ráfaga pasaba del tope viejo de 50
 * y las más antiguas se perdían sin que nadie se enterara. Sigue habiendo tope
 * — no se puede acumular sin límite —, pero ahora cabe una ráfaga real.
 */
const MAX_QUEUED_NOTIFICATIONS = 200;

type ChatResponseAnnouncement = {
  requestId: string;
  text: string;
};

function parseAudioRate(mimeType: string): number {
  const rate = mimeType.match(/rate=(\d+)/)?.[1];
  return rate ? Number(rate) : 24000;
}

function mergeTranscriptChunk(current: string, next: string) {
  if (!next) {
    return current;
  }

  if (!current || next.startsWith(current)) {
    return next;
  }

  if (current.endsWith(next)) {
    return current;
  }

  const shouldSeparate =
    /[.!?]$/.test(current.trimEnd()) && /^[A-Za-z0-9]/.test(next);

  return `${current}${shouldSeparate ? " " : ""}${next}`;
}

function commitTranscriptTurn(
  entries: StartTalkTranscriptItem[],
  role: StartTalkTranscriptItem["role"],
  text: string,
): StartTalkTranscriptItem[] {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) return entries;

  const last = entries.at(-1);
  if (last?.role === role) {
    if (last.text === clean || last.text.startsWith(clean)) {
      return entries;
    }
    if (clean.startsWith(last.text)) {
      return entries.slice(0, -1).concat({ ...last, text: clean });
    }
  }

  return entries
    .concat({
      id: `${role}-${Date.now()}-${entries.length}`,
      role,
      text: clean,
      createdAt: Date.now(),
    })
    .slice(-60);
}

/** Lo que la UI sabe del stream de vídeo, siempre según lo que reporta core. */
export interface StartTalkVideoStatus {
  phase: StartTalkVideoPhase;
  source?: StartTalkVideoSource;
  sourceId?: string;
  label?: string;
  /** Fotogramas que el modelo ha recibido de verdad. 0 ⇒ todavía no ve nada. */
  framesSent: number;
  lastFrameAt?: number;
  /** Miniatura JPEG (base64) del último fotograma, para la vista previa. */
  preview?: string;
  message?: string;
}

export function useStartTalkAudio({
  isOpen,
  model,
  thinkingLevel,
  translation,
  voiceStyle,
  announceNotifications,
  phoneAssistantBridge,
  phoneAssistantWakeWord,
}: {
  isOpen: boolean;
  model: StartTalkModelOption;
  thinkingLevel: StartTalkThinkingLevel;
  /** When set, the session runs in real-time interpreter (translation) mode. */
  translation?: StartTalkTranslationConfig | null;
  /** Optional speaking-style hint for assistant mode. */
  voiceStyle?: string;
  /** Read new Windows notifications after the current spoken turn finishes. */
  announceNotifications: boolean;
  /**
   * Relay messaging/mail notifications to the phone's Google Assistant by voice
   * (say the wake word, ask it to reply). Off by default; when off, messaging
   * notifications keep using the normal Phone Link announcement/reply path.
   */
  phoneAssistantBridge?: boolean;
  /** Spoken hotword for the phone assistant when the bridge is on. */
  phoneAssistantWakeWord?: string;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const isStreaming = useAppSelector((store) => store.session.isStreaming);
  const sessionIdRef = useRef<string | null>(null);
  const assistantTurnActiveRef = useRef(false);
  const assistantTranscriptRef = useRef("");
  const isStreamingRef = useRef(isStreaming);
  // Keeps the output AudioContext alive across long reports: WebView2/OS power
  // policy can suspend it mid-playback, which used to make the voice go silent
  // while the model kept "reading". The watchdog resumes it whenever audio is
  // pending. See resumeOutputContextIfNeeded / ensureOutputWatchdog below.
  // Unica ruta de reproduccion: AudioWorklet con anillo (ver pcmPlayer.ts).
  const pcmPlayerRef = useRef<PcmPlayer>();
  // Microfono: se abre AQUI, en el WebView, para que Chromium pueda cancelar el
  // eco de la voz de Lumina usando la reproduccion como referencia.
  const micCaptureRef = useRef<MicCapture>();
  const micDevicesRef = useRef<Array<{ deviceId: string; label: string }>>([]);
  const selectedMicIdRef = useRef<string | undefined>(undefined);
  const startMicCaptureRef = useRef<(deviceId?: string) => Promise<void>>(
    async () => undefined,
  );
  // Para detectar el instante en que la cola se vacia: el worklet no emite un
  // evento tipo `source.onended`, asi que el flanco se detecta por sondeo.
  const wasPlayingRef = useRef(false);
  const outputWatchdogRef = useRef<ReturnType<typeof setInterval>>();
  // Último valor enviado a core, para no repetir el mismo informe.
  const lastPlaybackReportRef = useRef<number>(-1);
  // Red de seguridad: si la cola de audio se vacía y el servidor nunca manda
  // turnComplete (caída de sesión a media respuesta), las colas de
  // notificaciones y de respuestas de chat se quedarían bloqueadas para
  // siempre y Lumina no volvería a hablar nunca.
  const turnStuckTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Coalesces assistant-transcript updates so a long streaming report does not
  // re-render (and re-layout) the growing text on every audio chunk — that
  // main-thread jank was starving the audio scheduler and causing the rasp.
  const assistantTranscriptFlushRef = useRef<ReturnType<typeof setTimeout>>();
  const notificationQueueRef = useRef<StartTalkNotification[]>([]);
  const notificationBatchInFlightRef = useRef<StartTalkNotification[]>([]);
  const seenNotificationIdsRef = useRef(new Set<string>());
  const notificationInFlightRef = useRef(false);
  const notificationFlushTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const notificationWatchdogRef = useRef<ReturnType<typeof setTimeout>>();
  const chatResponseQueueRef = useRef<ChatResponseAnnouncement[]>([]);
  const chatResponseInFlightRef = useRef(false);
  const activeChatResponseRef = useRef<ChatResponseAnnouncement>();
  const chatResponseFlushTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const chatResponseWatchdogRef = useRef<ReturnType<typeof setTimeout>>();
  const seenChatResponseIdsRef = useRef(new Set<string>());
  const serverTurnCompleteRef = useRef(true);
  const lastUserActivityAtRef = useRef(0);
  const tryFlushNotificationRef = useRef<() => void>(() => undefined);
  const tryFlushChatResponseRef = useRef<() => void>(() => undefined);
  const handlePlaybackIdleRef = useRef<() => void>(() => undefined);
  // Notifications whose reply has already been delegated to the Lumina Code
  // chat, so requeues/retries never send a second reply for the same message.
  const autoRepliedIdsRef = useRef(new Set<string>());
  // Reply-eligible notifications that were just read aloud and are waiting for
  // the user to confirm out loud ("si", "ok", "respondele", ...) before the
  // reply is delegated. Null when nothing is awaiting confirmation.
  const pendingReplyRef = useRef<{
    notifications: StartTalkNotification[];
    expiresAt: number;
  } | null>(null);
  // Gemini function calls are untrusted proposals. This resolver is the hard
  // authorization gate between a proposal and the real Lumina Code agent.
  const pendingDelegationDecisionRef = useRef<{
    id: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const dispatchAutoReplyRef = useRef<
    (notifications: StartTalkNotification[]) => void
  >(() => undefined);
  const runDelegatedTaskRef = useRef<
    (text: string, userApproved?: boolean) => Promise<string>
  >(async () => "");
  const enqueueChatResponseRef = useRef<
    (response: { requestId: string; text: string }) => void
  >(() => undefined);
  const startListeningRef = useRef<(() => Promise<void>) | undefined>();
  const connectInFlightRef = useRef(false);
  const sessionRecoveryAttemptsRef = useRef(0);
  const sessionRecoveryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const shouldStayActiveRef = useRef(isOpen);
  // Automatic recovery is only valid after capture started successfully. An
  // initial configuration/device failure must remain visible to the user.
  const recoverActiveSessionRef = useRef(false);
  const [status, setStatus] = useState<StartTalkStatus>("idle");
  // Modelo y proveedor que core resolvió de verdad. Con "Automático" el orbe no
  // sabe cuál va a ser hasta conectar, y decir un modelo distinto del que suena
  // sería mentir sobre lo que el usuario está oyendo.
  const [activeSession, setActiveSession] =
    useState<StartTalkActiveSession | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [toolActivities, setToolActivities] = useState<StartTalkToolActivity[]>(
    [],
  );
  const [pendingDelegationApproval, setPendingDelegationApproval] =
    useState<StartTalkDelegationApproval | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [assistantTranscript, setAssistantTranscript] = useState("");
  const [transcriptEntries, setTranscriptEntries] = useState<
    StartTalkTranscriptItem[]
  >([]);
  const [videoSource, setVideoSource] = useState<StartTalkVideoSource | null>(
    null,
  );
  // Estado REAL del stream, reportado por core. La UI no debe decir que Lumina
  // está viendo la pantalla hasta que haya llegado un fotograma de verdad.
  const [videoState, setVideoState] = useState<StartTalkVideoStatus>({
    phase: "stopped",
    framesSent: 0,
  });
  // True cuando core detecta varias voces solapadas: Lumina pasa a hablar solo
  // si la interpelan o tiene algo que aportar de verdad.
  const [isCrowded, setIsCrowded] = useState(false);
  // Instrumentación: sin estos números, cada ajuste del VAD o cambio de modelo
  // se evalúa a oído — que ya falló de forma medible en este proyecto.
  const [lastTurnMetrics, setLastTurnMetrics] =
    useState<StartTalkTurnMetrics | null>(null);
  const [sessionMetrics, setSessionMetrics] =
    useState<StartTalkSessionMetrics | null>(null);
  // Lo que Chromium aplicó REALMENTE al micrófono. Se expone porque pedir
  // cancelación de eco no garantiza obtenerla, y conviene poder verlo.
  const [micSettings, setMicSettings] = useState<MicCaptureSettings | null>(
    null,
  );
  const [micLevel, setMicLevel] = useState(0);
  const [speaker, setSpeaker] = useState<SpeakerInfo | null>(null);
  const latestSpeakerTurnIdRef = useRef(0);
  const [lastSoundEvent, setLastSoundEvent] =
    useState<StartTalkSoundCategory | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [notificationAccess, setNotificationAccess] =
    useState<StartTalkNotificationAccess>("checking");
  const [pendingNotificationCount, setPendingNotificationCount] = useState(0);
  const translationRef = useRef(translation);
  const voiceStyleRef = useRef(voiceStyle);
  const announceNotificationsRef = useRef(announceNotifications);
  const phoneAssistantBridgeRef = useRef(phoneAssistantBridge ?? false);
  const phoneAssistantWakeWordRef = useRef(phoneAssistantWakeWord);

  useEffect(() => {
    translationRef.current = translation;
  }, [translation]);

  useEffect(() => {
    voiceStyleRef.current = voiceStyle;
  }, [voiceStyle]);

  useEffect(() => {
    shouldStayActiveRef.current = isOpen;
  }, [isOpen]);

  const clearSessionRecoveryTimer = useCallback(() => {
    if (sessionRecoveryTimerRef.current) {
      clearTimeout(sessionRecoveryTimerRef.current);
      sessionRecoveryTimerRef.current = undefined;
    }
  }, []);

  const scheduleSessionRecovery = useCallback(() => {
    if (
      !shouldStayActiveRef.current ||
      !recoverActiveSessionRef.current ||
      sessionIdRef.current ||
      connectInFlightRef.current ||
      sessionRecoveryTimerRef.current
    ) {
      return;
    }

    sessionRecoveryAttemptsRef.current += 1;
    const delayMs = getStartTalkRetryDelayMs(
      sessionRecoveryAttemptsRef.current,
    );
    setStatus("connecting");
    sessionRecoveryTimerRef.current = setTimeout(() => {
      sessionRecoveryTimerRef.current = undefined;
      void startListeningRef.current?.();
    }, delayMs);
  }, []);

  const clearNotificationTimers = useCallback(() => {
    if (notificationFlushTimerRef.current) {
      clearTimeout(notificationFlushTimerRef.current);
      notificationFlushTimerRef.current = undefined;
    }
    if (notificationWatchdogRef.current) {
      clearTimeout(notificationWatchdogRef.current);
      notificationWatchdogRef.current = undefined;
    }
  }, []);

  const settleDelegationApproval = useCallback((approved: boolean) => {
    const pending = pendingDelegationDecisionRef.current;
    if (!pending) {
      return;
    }
    pendingDelegationDecisionRef.current = null;
    setPendingDelegationApproval(null);
    pending.resolve(approved);
  }, []);

  const requestDelegationApproval = useCallback(
    (id: string, task: string): Promise<boolean> => {
      // A second model call must not inherit a click intended for the first.
      pendingDelegationDecisionRef.current?.resolve(false);
      return new Promise((resolve) => {
        pendingDelegationDecisionRef.current = { id, resolve };
        setPendingDelegationApproval({ id, task });
      });
    },
    [],
  );

  const resetNotificationQueue = useCallback(() => {
    clearNotificationTimers();
    notificationQueueRef.current = [];
    notificationBatchInFlightRef.current = [];
    notificationInFlightRef.current = false;
    pendingReplyRef.current = null;
    serverTurnCompleteRef.current = true;
    setPendingNotificationCount(0);
  }, [clearNotificationTimers]);

  const resetChatResponseQueue = useCallback(() => {
    if (chatResponseFlushTimerRef.current) {
      clearTimeout(chatResponseFlushTimerRef.current);
      chatResponseFlushTimerRef.current = undefined;
    }
    if (chatResponseWatchdogRef.current) {
      clearTimeout(chatResponseWatchdogRef.current);
      chatResponseWatchdogRef.current = undefined;
    }
    chatResponseQueueRef.current = [];
    chatResponseInFlightRef.current = false;
    activeChatResponseRef.current = undefined;
    seenChatResponseIdsRef.current.clear();
  }, []);

  const scheduleNotificationFlush = useCallback((delayMs = 650) => {
    if (notificationFlushTimerRef.current) {
      clearTimeout(notificationFlushTimerRef.current);
    }
    notificationFlushTimerRef.current = setTimeout(() => {
      notificationFlushTimerRef.current = undefined;
      tryFlushNotificationRef.current();
    }, delayMs);
  }, []);

  const scheduleChatResponseFlush = useCallback((delayMs = 250) => {
    if (chatResponseFlushTimerRef.current) {
      clearTimeout(chatResponseFlushTimerRef.current);
    }
    chatResponseFlushTimerRef.current = setTimeout(() => {
      chatResponseFlushTimerRef.current = undefined;
      tryFlushChatResponseRef.current();
    }, delayMs);
  }, []);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  /**
   * Milisegundos de voz que quedan por sonar en la cola. Es el único dato real
   * de "Lumina sigue hablando": el servidor entrega el audio hasta 3x más
   * rápido que el tiempo real, así que ni core ni la UI pueden deducirlo de la
   * hora de llegada de los fragmentos.
   */
  /**
   * Voz que le queda por sonar. El worklet informa de sus muestras reales, asi
   * que el dato es exacto — y core depende de el para no reabrir el microfono
   * mientras ella todavia habla.
   */
  const playbackRemainingMs = useCallback(() => {
    return pcmPlayerRef.current?.status().remainingMs ?? 0;
  }, []);

  /** Unico punto de verdad de "todavia suena su voz". */
  const hasQueuedAudio = useCallback(
    () => playbackRemainingMs() > 0,
    [playbackRemainingMs],
  );

  /**
   * Le dice a core cuánto le queda por sonar. Core mantiene el micrófono
   * cerrado mientras tanto, así que su propia voz por los altavoces no puede
   * abrir un turno y cortarla a media respuesta.
   */
  const reportPlayback = useCallback(
    (remainingMs: number) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || lastPlaybackReportRef.current === remainingMs) {
        return;
      }
      lastPlaybackReportRef.current = remainingMs;
      void ideMessenger
        .request("startTalk/reportPlayback", { sessionId, remainingMs })
        .catch(() => undefined);
    },
    [ideMessenger],
  );

  const stopPlayback = useCallback(() => {
    pcmPlayerRef.current?.stop();
    // La cola quedó vacía ya: core debe reabrir el micro sin esperar al tick.
    reportPlayback(0);
    handlePlaybackIdleRef.current();
  }, [reportPlayback]);

  const stopListening = useCallback(async () => {
    const sessionId = sessionIdRef.current;

    recoverActiveSessionRef.current = false;
    clearSessionRecoveryTimer();
    void micCaptureRef.current?.stop();
    stopPlayback();
    resetNotificationQueue();
    resetChatResponseQueue();
    settleDelegationApproval(false);
    sessionIdRef.current = null;
    setStatus("idle");
    setActiveSession(null);
    setIsCrowded(false);
    setMicSettings(null);
    setLastTurnMetrics(null);
    setSessionMetrics(null);
    setVideoSource(null);
    setVideoState({ phase: "stopped", framesSent: 0 });
    lastPlaybackReportRef.current = -1;
    if (turnStuckTimerRef.current) {
      clearTimeout(turnStuckTimerRef.current);
      turnStuckTimerRef.current = undefined;
    }

    if (sessionId) {
      await ideMessenger.request("startTalk/stop", { sessionId });
    }
  }, [
    ideMessenger,
    resetChatResponseQueue,
    resetNotificationQueue,
    clearSessionRecoveryTimer,
    settleDelegationApproval,
    stopPlayback,
  ]);

  /** WebView2 y la política de energía del sistema pueden suspender el audio. */
  const resumeOutputContextIfNeeded = useCallback(() => {
    pcmPlayerRef.current?.resumeIfNeeded();
  }, []);

  /**
   * Sondeo único de la reproducción: mantiene el contexto despierto (un
   * suspend a mitad dejaba la voz muda para siempre), alimenta a core con la
   * cola real, y detecta el flanco en que ella termina de hablar. Ese flanco
   * hay que sondearlo porque el worklet no emite un evento de fin.
   */
  const ensureOutputWatchdog = useCallback(() => {
    if (outputWatchdogRef.current) {
      return;
    }
    outputWatchdogRef.current = setInterval(() => {
      resumeOutputContextIfNeeded();
      const remaining = playbackRemainingMs();
      reportPlayback(remaining);

      const playing = remaining > 0;
      if (wasPlayingRef.current && !playing) {
        handlePlaybackIdleRef.current();
      }
      wasPlayingRef.current = playing;
    }, 250);
  }, [playbackRemainingMs, reportPlayback, resumeOutputContextIfNeeded]);

  // Push the accumulated assistant transcript to the UI at most ~8x/s. During a
  // long spoken report this replaces one React re-render per audio chunk (which
  // grew with the text and janked the main thread) with a bounded cadence.
  const scheduleAssistantTranscriptFlush = useCallback(() => {
    if (assistantTranscriptFlushRef.current) {
      return;
    }
    assistantTranscriptFlushRef.current = setTimeout(() => {
      assistantTranscriptFlushRef.current = undefined;
      setAssistantTranscript(assistantTranscriptRef.current);
    }, 120);
  }, []);

  const flushAssistantTranscriptNow = useCallback(() => {
    if (assistantTranscriptFlushRef.current) {
      clearTimeout(assistantTranscriptFlushRef.current);
      assistantTranscriptFlushRef.current = undefined;
    }
    setAssistantTranscript(assistantTranscriptRef.current);
  }, []);

  const playAudio = useCallback(
    async (data: string, mimeType: string) => {
      try {
        if (!pcmPlayerRef.current) {
          pcmPlayerRef.current = new PcmPlayer();
        }
        ensureOutputWatchdog();
        await pcmPlayerRef.current.play(data, parseAudioRate(mimeType));
      } catch (error) {
        setStatus("unsupported");
        setErrorMessage(
          error instanceof Error
            ? `No se pudo reproducir el audio: ${error.message}`
            : "No se pudo reproducir el audio en esta ventana.",
        );
        return;
      }

      // Sigue hablando: cancela la red de seguridad y avisa a core en el acto
      // en vez de esperar al siguiente tick del sondeo.
      if (turnStuckTimerRef.current) {
        clearTimeout(turnStuckTimerRef.current);
        turnStuckTimerRef.current = undefined;
      }
      reportPlayback(playbackRemainingMs());
    },
    [ensureOutputWatchdog, playbackRemainingMs, reportPlayback],
  );

  const requeueCurrentNotificationBatch = useCallback(() => {
    if (notificationBatchInFlightRef.current.length > 0) {
      notificationQueueRef.current = notificationBatchInFlightRef.current
        .concat(notificationQueueRef.current)
        .slice(0, MAX_QUEUED_NOTIFICATIONS);
    }
    notificationBatchInFlightRef.current = [];
    notificationInFlightRef.current = false;
    if (notificationWatchdogRef.current) {
      clearTimeout(notificationWatchdogRef.current);
      notificationWatchdogRef.current = undefined;
    }
    setPendingNotificationCount(notificationQueueRef.current.length);
  }, []);

  const finishCurrentNotificationBatch = useCallback(() => {
    notificationBatchInFlightRef.current = [];
    notificationInFlightRef.current = false;
    if (notificationWatchdogRef.current) {
      clearTimeout(notificationWatchdogRef.current);
      notificationWatchdogRef.current = undefined;
    }
    setPendingNotificationCount(notificationQueueRef.current.length);
  }, []);

  const tryFlushNotification = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId ||
      !announceNotificationsRef.current ||
      notificationQueueRef.current.length === 0 ||
      chatResponseQueueRef.current.length > 0 ||
      chatResponseInFlightRef.current ||
      !canAnnounceNotificationNow({
        audioSources: hasQueuedAudio() ? 1 : 0,
        serverTurnComplete: serverTurnCompleteRef.current,
        notificationInFlight: notificationInFlightRef.current,
      })
    ) {
      return;
    }

    const quietForMs = Date.now() - lastUserActivityAtRef.current;
    if (quietForMs < 1_200) {
      scheduleNotificationFlush(1_200 - quietForMs);
      return;
    }

    const batch = notificationQueueRef.current.splice(0, 5);
    const bridgeBatch = phoneAssistantBridgeRef.current
      ? selectPhoneBridgeNotifications(batch)
      : [];
    if (bridgeBatch.length > 0) {
      const bridgeIds = new Set(
        bridgeBatch.map((notification) => notification.id),
      );
      const regularBatch = batch.filter(
        (notification) => !bridgeIds.has(notification.id),
      );
      notificationQueueRef.current = regularBatch
        .concat(notificationQueueRef.current)
        .slice(0, MAX_QUEUED_NOTIFICATIONS);
      notificationBatchInFlightRef.current = bridgeBatch;
    } else {
      notificationBatchInFlightRef.current = batch;
    }
    notificationInFlightRef.current = true;
    serverTurnCompleteRef.current = false;
    setPendingNotificationCount(notificationQueueRef.current.length);

    // El watchdog solo debe rescatar una tanda que se PERDIÓ, nunca cortar una
    // lectura que va bien. Por eso se rearma mientras siga sonando voz, con un
    // tope absoluto por si algo se queda colgado de verdad.
    const startedAt = Date.now();
    const armNotificationWatchdog = () => {
      notificationWatchdogRef.current = setTimeout(() => {
        notificationWatchdogRef.current = undefined;
        if (!notificationInFlightRef.current) {
          return;
        }
        const stillSpeaking =
          hasQueuedAudio() || !serverTurnCompleteRef.current;
        if (
          stillSpeaking &&
          Date.now() - startedAt < NOTIFICATION_WATCHDOG_MAX_MS
        ) {
          armNotificationWatchdog();
          return;
        }
        finishCurrentNotificationBatch();
        serverTurnCompleteRef.current = true;
        scheduleNotificationFlush(3_000);
      }, ANNOUNCEMENT_WATCHDOG_GRACE_MS);
    };
    armNotificationWatchdog();

    // Ask before replying: if the batch has a reply-eligible direct message,
    // Start Talk reads it and then asks "¿quieres que le responda?". We hold the
    // eligible notifications as pending and wait for a spoken confirmation
    // ("si", "ok", "respondele", ...) before delegating the reply to the Lumina
    // Code chat. The voice itself never calls a tool for this. Skip when the
    // phone-assistant bridge owns this batch.
    let awaitingReplyConfirmation = false;
    if (bridgeBatch.length === 0) {
      const replyBatch = batch.filter(
        (notification) =>
          isPhoneBridgeEligible(notification) &&
          !autoRepliedIdsRef.current.has(notification.id),
      );
      if (replyBatch.length > 0) {
        awaitingReplyConfirmation = true;
        pendingReplyRef.current = {
          notifications: replyBatch,
          expiresAt: Date.now() + REPLY_CONFIRMATION_WINDOW_MS,
        };
      }
    }

    // When the phone-assistant bridge is on and the batch has messaging/mail
    // notifications, relay those to the phone's Google Assistant by voice.
    // Everything else keeps using the normal Phone Link announcement path.
    const promptText =
      bridgeBatch.length > 0
        ? buildPhoneAssistantBridgePrompt(bridgeBatch, {
            wakeWord: phoneAssistantWakeWordRef.current,
          })
        : buildNotificationAnnouncementPrompt(batch, {
            awaitingReplyConfirmation,
          });

    void ideMessenger
      .request("startTalk/sendText", {
        sessionId,
        text: promptText,
      })
      .then((response) => {
        if (response.status !== "error") {
          return;
        }
        requeueCurrentNotificationBatch();
        serverTurnCompleteRef.current = true;
        scheduleNotificationFlush(2_000);
      })
      .catch(() => {
        requeueCurrentNotificationBatch();
        serverTurnCompleteRef.current = true;
        scheduleNotificationFlush(2_000);
      });
  }, [
    ideMessenger,
    finishCurrentNotificationBatch,
    hasQueuedAudio,
    requeueCurrentNotificationBatch,
    scheduleNotificationFlush,
  ]);
  tryFlushNotificationRef.current = tryFlushNotification;

  const requeueCurrentChatResponse = useCallback(() => {
    const active = activeChatResponseRef.current;
    if (active) {
      chatResponseQueueRef.current = [active].concat(
        chatResponseQueueRef.current,
      );
    }
    activeChatResponseRef.current = undefined;
    chatResponseInFlightRef.current = false;
    if (chatResponseWatchdogRef.current) {
      clearTimeout(chatResponseWatchdogRef.current);
      chatResponseWatchdogRef.current = undefined;
    }
  }, []);

  const tryFlushChatResponse = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId ||
      chatResponseQueueRef.current.length === 0 ||
      chatResponseInFlightRef.current ||
      notificationInFlightRef.current ||
      hasQueuedAudio() ||
      !serverTurnCompleteRef.current
    ) {
      return;
    }

    const responseToRead = chatResponseQueueRef.current.shift();
    if (!responseToRead) {
      return;
    }

    activeChatResponseRef.current = responseToRead;
    chatResponseInFlightRef.current = true;
    serverTurnCompleteRef.current = false;

    // Esta ruta no tenía watchdog: si la lectura se perdía (sesión caída,
    // respuesta que nunca llega), `chatResponseInFlight` se quedaba en true
    // para siempre y Lumina no volvía a leer NINGUNA respuesta. Como en las
    // notificaciones, se rearma mientras siga sonando voz.
    const startedAt = Date.now();
    const armChatResponseWatchdog = () => {
      chatResponseWatchdogRef.current = setTimeout(() => {
        chatResponseWatchdogRef.current = undefined;
        if (!chatResponseInFlightRef.current) {
          return;
        }
        const stillSpeaking =
          hasQueuedAudio() || !serverTurnCompleteRef.current;
        if (
          stillSpeaking &&
          Date.now() - startedAt < NOTIFICATION_WATCHDOG_MAX_MS
        ) {
          armChatResponseWatchdog();
          return;
        }
        requeueCurrentChatResponse();
        serverTurnCompleteRef.current = true;
        scheduleChatResponseFlush(3_000);
      }, ANNOUNCEMENT_WATCHDOG_GRACE_MS);
    };
    armChatResponseWatchdog();

    void ideMessenger
      .request("startTalk/sendText", {
        sessionId,
        text: buildChatResponseSpeechPrompt(responseToRead.text),
      })
      .then((response) => {
        if (response.status !== "error") {
          return;
        }
        requeueCurrentChatResponse();
        serverTurnCompleteRef.current = true;
        scheduleChatResponseFlush(2_000);
      })
      .catch(() => {
        requeueCurrentChatResponse();
        serverTurnCompleteRef.current = true;
        scheduleChatResponseFlush(2_000);
      });
  }, [
    hasQueuedAudio,
    ideMessenger,
    requeueCurrentChatResponse,
    scheduleChatResponseFlush,
  ]);
  tryFlushChatResponseRef.current = tryFlushChatResponse;

  const handlePlaybackIdle = useCallback(() => {
    if (hasQueuedAudio()) {
      return;
    }

    // La cola de voz quedó vacía. Si el servidor todavía no cerró el turno,
    // esperamos un poco y lo damos por cerrado: sin esto, una sesión que cae a
    // media respuesta deja `serverTurnComplete` en false para siempre y ni las
    // notificaciones ni las respuestas de chat se vuelven a leer nunca.
    if (!serverTurnCompleteRef.current) {
      reportPlayback(0);
      if (!turnStuckTimerRef.current) {
        turnStuckTimerRef.current = setTimeout(() => {
          turnStuckTimerRef.current = undefined;
          if (hasQueuedAudio() || serverTurnCompleteRef.current) {
            return;
          }
          serverTurnCompleteRef.current = true;
          handlePlaybackIdleRef.current();
        }, TURN_STUCK_TIMEOUT_MS);
      }
      return;
    }

    reportPlayback(0);

    if (chatResponseInFlightRef.current) {
      activeChatResponseRef.current = undefined;
      chatResponseInFlightRef.current = false;
      if (chatResponseWatchdogRef.current) {
        clearTimeout(chatResponseWatchdogRef.current);
        chatResponseWatchdogRef.current = undefined;
      }
    }

    if (notificationInFlightRef.current) {
      finishCurrentNotificationBatch();
    }

    if (chatResponseQueueRef.current.length > 0) {
      scheduleChatResponseFlush();
      return;
    }

    scheduleNotificationFlush(450);
  }, [
    finishCurrentNotificationBatch,
    hasQueuedAudio,
    reportPlayback,
    scheduleChatResponseFlush,
    scheduleNotificationFlush,
  ]);
  handlePlaybackIdleRef.current = handlePlaybackIdle;

  // Pending voice-delegation requests routed to the main chat, keyed by
  // requestId, resolved when the sidebar posts its final answer.
  const pendingMainRef = useRef(
    new Map<
      string,
      { resolve: (text: string) => void; reject: (error: Error) => void }
    >(),
  );

  const enqueueChatResponse = useCallback(
    (response: ChatResponseAnnouncement) => {
      const text = response.text.trim();
      // Read each response at most once. Dedup by requestId AND by a text
      // signature so the same answer arriving through two channels (e.g. the
      // delegated result and the chat observer) is never spoken twice.
      const textSignature = `text:${text.length}:${text.slice(0, 160)}`;
      if (
        !text ||
        seenChatResponseIdsRef.current.has(response.requestId) ||
        seenChatResponseIdsRef.current.has(textSignature)
      ) {
        return;
      }
      seenChatResponseIdsRef.current.add(response.requestId);
      seenChatResponseIdsRef.current.add(textSignature);
      if (seenChatResponseIdsRef.current.size > 400) {
        seenChatResponseIdsRef.current = new Set(
          Array.from(seenChatResponseIdsRef.current).slice(-200),
        );
      }
      chatResponseQueueRef.current.push({ ...response, text });
      scheduleChatResponseFlush();
    },
    [scheduleChatResponseFlush],
  );
  enqueueChatResponseRef.current = enqueueChatResponse;

  // Delegated responses resolve their pending function call. Any unmatched
  // response came from an ordinary typed chat turn and is queued for speech.
  useWebviewListener(
    "startTalk/mainResultReady",
    async (data: { requestId: string; text: string; error?: boolean }) => {
      console.log(
        `[VoiceDelegation] orb received mainResultReady: ${data.requestId} (${(data.text ?? "").length} chars)`,
      );
      const pending = pendingMainRef.current.get(data.requestId);
      if (pending) {
        pendingMainRef.current.delete(data.requestId);
        if (data.error) {
          pending.reject(new Error(data.text || "La tarea no fue autorizada."));
        } else {
          pending.resolve(data.text ?? "");
        }
        return;
      }

      enqueueChatResponse({
        requestId: data.requestId,
        text: data.text ?? "",
      });
    },
    [enqueueChatResponse],
  );

  // Ejecuta una tarea real con el agente completo de Lumina Code (todas sus
  // herramientas: código, terminal, MCP, lumina_windows_bridge) y devuelve el
  // texto final para que la voz lo lea. Every Start Talk surface routes through
  // the main chat so one persistent completion observer owns all responses.
  const runDelegatedTask = useCallback(
    async (text: string, userApproved = false): Promise<string> => {
      return await new Promise<string>((resolve, reject) => {
        const requestId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        pendingMainRef.current.set(requestId, { resolve, reject });
        console.log(`[VoiceDelegation] sent delegateToMain: ${requestId}`);
        ideMessenger.post("startTalk/delegateToMain", {
          requestId,
          task: text,
          userApproved,
        });
      });
    },
    [ideMessenger],
  );
  runDelegatedTaskRef.current = runDelegatedTask;

  // Delegates the reply for confirmed notifications to the Lumina Code chat and
  // reads its result aloud when it returns. Fired only after the user confirms
  // out loud (see the user-transcript handler). Marks the notification ids so a
  // requeue/retry never sends a second reply for the same message.
  const dispatchAutoReply = useCallback(
    (notifications: StartTalkNotification[]) => {
      const batch = notifications.filter(
        (notification) => !autoRepliedIdsRef.current.has(notification.id),
      );
      if (batch.length === 0) {
        return;
      }
      for (const notification of batch) {
        autoRepliedIdsRef.current.add(notification.id);
      }
      if (autoRepliedIdsRef.current.size > 200) {
        autoRepliedIdsRef.current = new Set(
          Array.from(autoRepliedIdsRef.current).slice(-100),
        );
      }
      const replyRequestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `autoreply-${crypto.randomUUID()}`
          : `autoreply-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      void runDelegatedTask(buildNotificationAutoReplyTask(batch))
        .then((result) => {
          const text = (result ?? "").trim();
          if (text) {
            enqueueChatResponse({ requestId: replyRequestId, text });
          }
        })
        .catch(() => undefined);
    },
    [enqueueChatResponse, runDelegatedTask],
  );
  dispatchAutoReplyRef.current = dispatchAutoReply;

  // Function calling: el modelo de voz pidió ejecutar delegate_to_lumina_code.
  // Corremos el agente y devolvemos el resultado por sendToolResponse; el propio
  // modelo lo lee en voz natural (sin heurísticas de palabras clave).
  const handleToolCall = useCallback(
    async (call: StartTalkFunctionCall) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }

      if (call.name !== "delegate_to_lumina_code") {
        await ideMessenger.request("startTalk/sendToolResponse", {
          sessionId,
          id: call.id,
          name: call.name,
          connectionEpoch: call.connectionEpoch,
          output: `Función no soportada: ${call.name}.`,
          error: true,
        });
        return;
      }

      const task = typeof call.args.task === "string" ? call.args.task : "";
      const context =
        typeof call.args.context === "string" ? call.args.context : "";
      const fullTask = context ? `${task}\n\nContexto: ${context}` : task;
      const activityId = `tool-${call.id}`;

      setToolActivities((current) =>
        current.concat({
          id: activityId,
          label: "Lumina Code",
          status: "waiting",
          detail: task.slice(0, 80) || "Esperando autorizacion",
        }),
      );

      try {
        if (!task.trim()) {
          throw new Error("Start Talk propuso una tarea vacia.");
        }

        const approved = await requestDelegationApproval(call.id, fullTask);
        const authorization = evaluateSurfaceAuthorization({
          surface: "start-talk",
          capability: "delegate-agent",
          userApproved: approved,
          policy: "allow",
        });
        if (!authorization.authorized) {
          const message =
            "Solicitud cancelada: el usuario no autorizo esta tarea.";
          if (sessionIdRef.current === sessionId) {
            await ideMessenger.request("startTalk/sendToolResponse", {
              sessionId,
              id: call.id,
              name: call.name,
              connectionEpoch: call.connectionEpoch,
              output: message,
              error: true,
            });
          }
          setToolActivities((current) =>
            current.map((activity) =>
              activity.id === activityId
                ? { ...activity, status: "error", detail: "No autorizada" }
                : activity,
            ),
          );
          return;
        }

        if (isStreamingRef.current) {
          throw new Error("Lumina Code ya esta trabajando en otra tarea.");
        }

        setToolActivities((current) =>
          current.map((activity) =>
            activity.id === activityId
              ? { ...activity, status: "running", detail: task.slice(0, 80) }
              : activity,
          ),
        );

        const response = await runDelegatedTask(
          fullTask,
          authorization.authorized,
        );
        const output = response || "Tarea completada.";
        const toolResponse =
          sessionIdRef.current === sessionId
            ? await ideMessenger.request("startTalk/sendToolResponse", {
                sessionId,
                id: call.id,
                name: call.name,
                connectionEpoch: call.connectionEpoch,
                output,
              })
            : { status: "error" as const };

        // A long task may outlive its original Gemini Live connection. In that
        // case the old function-call id is no longer valid, so use the speech
        // queue to preserve the completed chat response after reconnection.
        if (toolResponse.status === "error") {
          enqueueChatResponse({
            requestId: `delegated:${call.id}`,
            text: output,
          });
        }

        setToolActivities((current) =>
          current.map((activity) =>
            activity.id === activityId
              ? { ...activity, status: "done", detail: "Listo" }
              : activity,
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Lumina Code no pudo completar la solicitud.";
        const errorResponse =
          sessionIdRef.current === sessionId
            ? await ideMessenger.request("startTalk/sendToolResponse", {
                sessionId,
                id: call.id,
                name: call.name,
                connectionEpoch: call.connectionEpoch,
                output: message,
                error: true,
              })
            : { status: "error" as const };
        if (errorResponse.status === "error") {
          enqueueChatResponse({
            requestId: `delegated-error:${call.id}`,
            text: message,
          });
        }
        setToolActivities((current) =>
          current.map((activity) =>
            activity.id === activityId
              ? { ...activity, status: "error", detail: message }
              : activity,
          ),
        );
      }
    },
    [
      enqueueChatResponse,
      ideMessenger,
      requestDelegationApproval,
      runDelegatedTask,
    ],
  );

  useWebviewListener(
    "startTalk/event",
    async (event: StartTalkCoreEvent) => {
      if (
        "sessionId" in event &&
        event.sessionId &&
        event.sessionId !== sessionIdRef.current
      ) {
        return;
      }

      if (event.type === "error") {
        if (chatResponseInFlightRef.current) {
          requeueCurrentChatResponse();
          serverTurnCompleteRef.current = true;
          scheduleChatResponseFlush(2_000);
        }
        setStatus("error");
        setErrorMessage(event.message);
        return;
      }

      if (event.type === "videoState") {
        // A propósito NO toca `status`: que se caiga la captura de pantalla no
        // puede dejar toda la sesión de voz marcada como rota.
        setVideoState((previous) => ({
          phase: event.phase,
          source: event.source,
          sourceId: event.sourceId,
          label: event.label,
          framesSent: event.framesSent ?? 0,
          lastFrameAt: event.lastFrameAt,
          // Los fotogramas llegan sin miniatura casi siempre (va limitada);
          // conservamos la última para que la vista previa no parpadee.
          preview: event.preview ?? previous.preview,
          message: event.message,
        }));
        setVideoSource(
          event.phase === "stopped" || event.phase === "error"
            ? null
            : (event.source ?? null),
        );
        return;
      }

      if (event.type === "status") {
        setStatus(event.status === "closed" ? "idle" : event.status);
        if (event.status === "idle" || event.status === "listening") {
          assistantTurnActiveRef.current = false;
          serverTurnCompleteRef.current = true;
          flushAssistantTranscriptNow();
          handlePlaybackIdleRef.current();
        }
        if (event.status === "closed") {
          sessionIdRef.current = null;
          connectInFlightRef.current = false;
          resetChatResponseQueue();
          resetNotificationQueue();
          scheduleSessionRecovery();
        }
        return;
      }

      if (event.type === "audio") {
        serverTurnCompleteRef.current = false;
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = "";
          setAssistantTranscript("");
        }
        setStatus("speaking");
        await playAudio(event.data, event.mimeType);
        return;
      }

      if (event.type === "environment") {
        setIsCrowded(event.crowded);
        return;
      }

      if (event.type === "turnMetrics") {
        setLastTurnMetrics(event.turn);
        setSessionMetrics(event.session);
        return;
      }

      if (event.type === "stayedSilent") {
        // Decidió que ese turno no era para ella. Es comportamiento correcto:
        // el turno se cierra sin voz y las colas siguen su curso.
        assistantTurnActiveRef.current = false;
        serverTurnCompleteRef.current = true;
        handlePlaybackIdleRef.current();
        return;
      }

      if (event.type === "transcript") {
        if (event.source === "user") {
          // Never carry the previous person's identity into a new utterance
          // while the asynchronous biometric result is still pending.
          setSpeaker(null);
          lastUserActivityAtRef.current = Date.now();
          serverTurnCompleteRef.current = false;
          setUserTranscript(event.text);
          if (event.final) {
            setTranscriptEntries((entries) =>
              commitTranscriptTurn(entries, "user", event.text),
            );
          }
          // If Start Talk just asked "¿quieres que le responda?", turn the
          // user's spoken answer into a yes/no decision and, on yes, delegate
          // the reply to the Lumina Code chat — deterministically, without
          // relying on the voice model to call a tool.
          const pending = pendingReplyRef.current;
          if (pending) {
            if (Date.now() > pending.expiresAt) {
              pendingReplyRef.current = null;
            } else if (isAffirmativeReply(event.text)) {
              pendingReplyRef.current = null;
              // Registrar el "sí" en core es lo que desbloquea las funciones de
              // respuesta. Sin esto se rechazan, así que este es el único punto
              // del que puede salir un mensaje enviado en nombre del usuario.
              const sessionId = sessionIdRef.current;
              if (sessionId) {
                void ideMessenger
                  .request("startTalk/authorizeReply", {
                    sessionId,
                    notificationIds: pending.notifications.map(
                      (notification) => notification.id,
                    ),
                    contacts: pending.notifications
                      .map((notification) => notification.sender ?? "")
                      .filter(Boolean),
                  })
                  .catch(() => undefined);
              }
              dispatchAutoReplyRef.current(pending.notifications);
            } else if (isNegativeReply(event.text)) {
              pendingReplyRef.current = null;
            }
          }
        } else {
          const base = assistantTurnActiveRef.current
            ? assistantTranscriptRef.current
            : "";
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = mergeTranscriptChunk(
            base,
            event.text,
          );
          if (event.final) {
            setTranscriptEntries((entries) =>
              commitTranscriptTurn(
                entries,
                "assistant",
                assistantTranscriptRef.current,
              ),
            );
          }
          scheduleAssistantTranscriptFlush();
        }
        return;
      }

      if (event.type === "toolCall") {
        void handleToolCall(event.call);
        return;
      }

      if (event.type === "goingAway") {
        // La reanudación de sesión reconecta de forma transparente; solo
        // informamos brevemente sin cortar la experiencia.
        return;
      }

      if (event.type === "interrupted") {
        requeueCurrentChatResponse();
        stopPlayback();
        finishCurrentNotificationBatch();
        serverTurnCompleteRef.current = false;
        lastUserActivityAtRef.current = Date.now();
        return;
      }

      if (event.type === "notificationAccess") {
        setNotificationAccess(event.status);
        return;
      }

      if (event.type === "notification") {
        if (!announceNotificationsRef.current) {
          return;
        }
        if (
          !rememberNotificationOnce(
            seenNotificationIdsRef.current,
            event.notification.id,
          )
        ) {
          return;
        }
        notificationQueueRef.current = notificationQueueRef.current
          .concat(event.notification)
          .slice(-MAX_QUEUED_NOTIFICATIONS);
        setPendingNotificationCount(notificationQueueRef.current.length);
        scheduleNotificationFlush();
        return;
      }

      if (event.type === "chatResponse") {
        // A finished external coding-chat response (Claude Code or Codex).
        // Reuse the same dedup + speech queue as Lumina Code chat responses so
        // it is read aloud once, after the current turn, and never twice.
        enqueueChatResponseRef.current?.({
          requestId: event.requestId,
          text: event.text,
        });
        return;
      }

      if (event.type === "level") {
        setMicLevel(event.level);
        return;
      }

      if (event.type === "speaker") {
        const update = resolveSpeakerUpdate(
          latestSpeakerTurnIdRef.current,
          event,
        );
        if (!update) {
          return;
        }
        latestSpeakerTurnIdRef.current = update.latestTurnId;
        setSpeaker(update.speaker);
        return;
      }

      if (event.type === "soundEvent") {
        setLastSoundEvent(event.category);
        return;
      }

      if (event.type === "toolActivity") {
        setToolActivities((current) => {
          const existingIndex = current.findIndex(
            (activity) => activity.id === event.activity.id,
          );

          if (existingIndex < 0) {
            return current.concat(event.activity).slice(-50);
          }

          return current.map((activity, index) =>
            index === existingIndex ? event.activity : activity,
          );
        });
      }
    },
    [
      handleToolCall,
      finishCurrentNotificationBatch,
      ideMessenger,
      playAudio,
      requeueCurrentChatResponse,
      requeueCurrentNotificationBatch,
      resetChatResponseQueue,
      resetNotificationQueue,
      scheduleSessionRecovery,
      scheduleChatResponseFlush,
      scheduleNotificationFlush,
      scheduleAssistantTranscriptFlush,
      flushAssistantTranscriptNow,
      stopPlayback,
    ],
  );

  /** Monitores y cámaras entre los que el usuario puede elegir. */
  const listVideoSources = useCallback(async (): Promise<
    StartTalkVideoSourceInfo[]
  > => {
    const res = await ideMessenger.request(
      "startTalk/listVideoSources",
      undefined,
    );
    return res.status === "error" ? [] : (res.content ?? []);
  }, [ideMessenger]);

  const startScreenShare = useCallback(
    async (target?: StartTalkVideoSourceInfo) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      // "starting" ya, para que el botón responda al instante; core corrige a
      // "live" en cuanto el modelo recibe el primer fotograma, o a "error".
      setVideoState({
        phase: "starting",
        source: "screen",
        sourceId: target?.id,
        label: target?.label ?? "Pantalla",
        framesSent: 0,
      });
      const res = await ideMessenger.request("startTalk/startVideo", {
        sessionId,
        source: "screen",
        region: target?.region,
        sourceId: target?.id,
        label: target?.label,
      });
      if (res.status === "error") {
        setVideoState({
          phase: "error",
          source: "screen",
          framesSent: 0,
          message: res.error,
        });
      }
    },
    [ideMessenger],
  );

  const startCamera = useCallback(
    async (deviceName?: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      setVideoState({
        phase: "starting",
        source: "camera",
        label: deviceName ?? "Cámara",
        framesSent: 0,
      });
      const res = await ideMessenger.request("startTalk/startVideo", {
        sessionId,
        source: "camera",
        deviceName,
      });
      if (res.status === "error") {
        setVideoState({
          phase: "error",
          source: "camera",
          framesSent: 0,
          message: res.error,
        });
      }
    },
    [ideMessenger],
  );

  const stopVideo = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    setVideoSource(null);
    setVideoState({ phase: "stopped", framesSent: 0 });
    if (sessionId) {
      await ideMessenger.request("startTalk/stopVideo", { sessionId });
    }
  }, [ideMessenger]);

  const toggleMute = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    const next = !isMuted;
    setIsMuted(next);
    if (next) {
      setMicLevel(0);
    }
    await ideMessenger.request("startTalk/setMuted", {
      sessionId,
      muted: next,
    });
  }, [ideMessenger, isMuted]);

  /**
   * Micrófonos del sistema, según el propio WebView. Antes los enumeraba core
   * con FFmpeg; ahora el micrófono lo abre el WebView para poder cancelar el
   * eco, así que es él quien conoce los dispositivos.
   */
  const listAudioDevices = useCallback(async (): Promise<
    MicrophoneDevice[]
  > => {
    try {
      const mics = await listMicrophones();
      micDevicesRef.current = mics;
      return mics;
    } catch {
      return [];
    }
  }, []);

  const switchAudioDevice = useCallback(async (deviceId: string) => {
    const target = micDevicesRef.current.find(
      (mic) => mic.deviceId === deviceId,
    );
    if (!target || !micCaptureRef.current) {
      return false;
    }
    const previousDeviceId = selectedMicIdRef.current;
    try {
      await startMicCaptureRef.current(target.deviceId);
      setErrorMessage(undefined);
      return true;
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "No se pudo cambiar el micrófono.",
      );
      // MicCapture.start closes the previous stream first. Restore it when the
      // requested device disappeared or rejected the exact-device constraint.
      if (previousDeviceId && previousDeviceId !== target.deviceId) {
        await startMicCaptureRef
          .current(previousDeviceId)
          .catch(() => undefined);
      }
      return false;
    }
  }, []);

  /**
   * Abre el micrófono en el WebView y bombea su PCM a core.
   *
   * Aquí es donde ocurre la cancelación de eco: Chromium tiene la señal que se
   * está reproduciendo (la voz de Lumina suena en este mismo WebView) y la usa
   * como referencia. FFmpeg no podía hacerlo porque captura del dispositivo y
   * nunca ve lo que sale por los altavoces.
   */
  const startMicCapture = useCallback(
    async (deviceId?: string) => {
      if (!micCaptureRef.current) {
        micCaptureRef.current = new MicCapture();
      }

      const applied = await micCaptureRef.current.start(deviceId, {
        onAudio: (pcm) => {
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            return;
          }
          // Int16Array -> base64, que es lo que viaja por el puente.
          const bytes = new Uint8Array(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength,
          );
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          // Continuous one-way stream: a response per audio block doubles
          // bridge traffic and creates listeners that the caller never needs.
          ideMessenger.post("startTalk/sendAudio", {
            sessionId,
            data: btoa(binary),
            mimeType: "audio/pcm;rate=16000",
          });
        },
        onError: (message) => {
          setErrorMessage(message);
        },
      });

      setMicSettings(applied);
      selectedMicIdRef.current = applied.deviceId;
    },
    [ideMessenger],
  );
  startMicCaptureRef.current = startMicCapture;

  const exportTranscript = useCallback(async (): Promise<
    StartTalkTranscriptEntry[]
  > => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return [];
    }
    const res = await ideMessenger.request("startTalk/getTranscript", {
      sessionId,
    });
    return res.status === "error" ? [] : (res.content ?? []);
  }, [ideMessenger]);

  const startListening = useCallback(async () => {
    if (sessionIdRef.current || connectInFlightRef.current) {
      return;
    }

    connectInFlightRef.current = true;
    recoverActiveSessionRef.current = false;
    clearSessionRecoveryTimer();
    setStatus("connecting");
    setErrorMessage(undefined);
    setToolActivities([]);
    setUserTranscript("");
    setAssistantTranscript("");
    setTranscriptEntries([]);
    setSpeaker(null);
    latestSpeakerTurnIdRef.current = 0;
    setLastSoundEvent(null);
    setMicLevel(0);
    setIsMuted(false);
    resetNotificationQueue();
    assistantTurnActiveRef.current = false;
    assistantTranscriptRef.current = "";

    // Warm AudioContext + AudioWorklet while Gemini connects so first speech
    // does not pay output initialization latency.
    if (!pcmPlayerRef.current) {
      pcmPlayerRef.current = new PcmPlayer();
    }
    void pcmPlayerRef.current.ensureStarted().catch(() => undefined);

    const activeTranslation = translationRef.current;
    try {
      const response = await ideMessenger.request("startTalk/connect", {
        // Sin modelo explícito manda el proveedor configurado en Ajustes; así
        // el orbe no fuerza OpenAI a quien solo tiene la clave de Google.
        preferredModel: model.model || undefined,
        thinkingLevel,
        mode: activeTranslation ? "interpreter" : undefined,
        translation: activeTranslation ?? undefined,
        voiceStyle: voiceStyleRef.current || undefined,
        announceNotifications: announceNotificationsRef.current,
      });

      if (response.status === "error") {
        throw new Error(response.error);
      }

      sessionIdRef.current = response.content.sessionId;
      setActiveSession({
        model: response.content.model,
        provider: response.content.provider,
      });
      const captureResponse = await ideMessenger.request(
        "startTalk/startCapture",
        {
          sessionId: response.content.sessionId,
        },
      );

      if (captureResponse.status === "error") {
        throw new Error(captureResponse.error);
      }

      // El micrófono se abre después de que core tenga el gate armado, para no
      // perder PCM en el hueco.
      await startMicCapture(selectedMicIdRef.current);

      sessionRecoveryAttemptsRef.current = 0;
      recoverActiveSessionRef.current = true;
      setStatus("listening");
      scheduleChatResponseFlush();
    } catch (error) {
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      setActiveSession(null);

      if (sessionId) {
        await ideMessenger.request("startTalk/stop", { sessionId });
      }

      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Start Talk failed.",
      );
    } finally {
      connectInFlightRef.current = false;
      if (!sessionIdRef.current && recoverActiveSessionRef.current) {
        scheduleSessionRecovery();
      }
    }
  }, [
    clearSessionRecoveryTimer,
    ideMessenger,
    model.model,
    resetNotificationQueue,
    scheduleSessionRecovery,
    scheduleChatResponseFlush,
    thinkingLevel,
  ]);

  startListeningRef.current = startListening;

  const restartListening = useCallback(async () => {
    await stopListening();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await startListeningRef.current?.();
  }, [stopListening]);

  useEffect(() => {
    if (!isOpen) {
      clearSessionRecoveryTimer();
      void stopListening();
    }
  }, [clearSessionRecoveryTimer, isOpen, stopListening]);

  useEffect(() => {
    announceNotificationsRef.current = announceNotifications;
    const sessionId = sessionIdRef.current;
    if (!announceNotifications) {
      resetNotificationQueue();
    } else {
      setNotificationAccess("checking");
    }
    if (sessionId) {
      void ideMessenger.request("startTalk/setNotificationAnnouncements", {
        sessionId,
        enabled: announceNotifications,
      });
    }
  }, [announceNotifications, ideMessenger, resetNotificationQueue]);

  useEffect(() => {
    phoneAssistantBridgeRef.current = phoneAssistantBridge ?? false;
  }, [phoneAssistantBridge]);

  useEffect(() => {
    phoneAssistantWakeWordRef.current = phoneAssistantWakeWord;
  }, [phoneAssistantWakeWord]);

  // The WebView can suspend the output AudioContext when the orb is occluded or
  // backgrounded; resume it as soon as it becomes visible/focused again so a
  // long report never stays silent after the window loses focus.
  useEffect(() => {
    const onVisible = () => resumeOutputContextIfNeeded();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [resumeOutputContextIfNeeded]);

  useEffect(() => {
    return () => {
      shouldStayActiveRef.current = false;
      clearSessionRecoveryTimer();
      if (outputWatchdogRef.current) {
        clearInterval(outputWatchdogRef.current);
        outputWatchdogRef.current = undefined;
      }
      if (assistantTranscriptFlushRef.current) {
        clearTimeout(assistantTranscriptFlushRef.current);
        assistantTranscriptFlushRef.current = undefined;
      }
      if (turnStuckTimerRef.current) {
        clearTimeout(turnStuckTimerRef.current);
        turnStuckTimerRef.current = undefined;
      }
      if (chatResponseWatchdogRef.current) {
        clearTimeout(chatResponseWatchdogRef.current);
        chatResponseWatchdogRef.current = undefined;
      }
      void stopListening();
      void micCaptureRef.current?.stop();
      micCaptureRef.current = undefined;
      void pcmPlayerRef.current?.close();
      pcmPlayerRef.current = undefined;
    };
  }, [clearSessionRecoveryTimer, stopListening]);

  return {
    activeSession,
    approveDelegation: () => settleDelegationApproval(true),
    assistantTranscript,
    errorMessage,
    isActive: Boolean(sessionIdRef.current),
    startListening,
    status,
    stopListening,
    stopSpeaking: stopPlayback,
    restartListening,
    toolActivities,
    transcriptEntries,
    userTranscript,
    isCrowded,
    lastTurnMetrics,
    micSettings,
    sessionMetrics,
    videoSource,
    videoState,
    startScreenShare,
    startCamera,
    stopVideo,
    listVideoSources,
    micLevel,
    speaker,
    lastSoundEvent,
    notificationAccess,
    pendingNotificationCount,
    pendingDelegationApproval,
    rejectDelegation: () => settleDelegationApproval(false),
    isMuted,
    toggleMute,
    listAudioDevices,
    switchAudioDevice,
    exportTranscript,
  };
}
