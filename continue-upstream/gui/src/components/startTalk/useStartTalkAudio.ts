import type {
  StartTalkCoreEvent,
  StartTalkFunctionCall,
  StartTalkNotification,
  StartTalkNotificationAccess,
  StartTalkSoundCategory,
  StartTalkTranscriptEntry,
  StartTalkTranslationConfig,
  StartTalkVideoSource,
} from "core/startTalk";
import { getStartTalkRetryDelayMs } from "core/startTalk/resiliencePolicy";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppSelector } from "../../redux/hooks";
import {
  StartTalkDelegationApproval,
  StartTalkModelOption,
  StartTalkStatus,
  StartTalkThinkingLevel,
  StartTalkToolActivity,
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
import { buildChatResponseSpeechPrompt } from "./voiceDelegation";

const PCM_CHUNK_SIZE = 0x8000;

// How long, after Start Talk asks "¿quieres que le responda?", a spoken
// confirmation still triggers the delegated reply. After this the pending
// message is dropped so a much-later "sí" about something else never fires it.
const REPLY_CONFIRMATION_WINDOW_MS = 90_000;

type ChatResponseAnnouncement = {
  requestId: string;
  text: string;
};

type AudioContextConstructor = typeof AudioContext;
type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as AudioWindow;
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += PCM_CHUNK_SIZE) {
    const chunk = binary.slice(index, index + PCM_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex++) {
      bytes[index + chunkIndex] = chunk.charCodeAt(chunkIndex);
    }
  }

  return bytes.buffer;
}

function parseAudioRate(mimeType: string): number {
  const rate = mimeType.match(/rate=(\d+)/)?.[1];
  return rate ? Number(rate) : 24000;
}

function pcm16Base64ToAudioBuffer(
  audioContext: AudioContext,
  base64: string,
  sampleRate: number,
) {
  const pcmBuffer = base64ToArrayBuffer(base64);
  const view = new DataView(pcmBuffer);
  const frameCount = Math.floor(pcmBuffer.byteLength / 2);
  const audioBuffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const channel = audioBuffer.getChannelData(0);

  for (let index = 0; index < frameCount; index++) {
    channel[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return audioBuffer;
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

export interface SpeakerInfo {
  identityId?: string;
  name?: string;
  score?: number;
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
  const outputContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const outputSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // Keeps the output AudioContext alive across long reports: WebView2/OS power
  // policy can suspend it mid-playback, which used to make the voice go silent
  // while the model kept "reading". The watchdog resumes it whenever audio is
  // pending. See resumeOutputContextIfNeeded / ensureOutputWatchdog below.
  const outputWatchdogRef = useRef<ReturnType<typeof setInterval>>();
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
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [toolActivities, setToolActivities] = useState<StartTalkToolActivity[]>(
    [],
  );
  const [pendingDelegationApproval, setPendingDelegationApproval] =
    useState<StartTalkDelegationApproval | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [assistantTranscript, setAssistantTranscript] = useState("");
  const [videoSource, setVideoSource] = useState<StartTalkVideoSource | null>(
    null,
  );
  const [micLevel, setMicLevel] = useState(0);
  const [speaker, setSpeaker] = useState<SpeakerInfo | null>(null);
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

  const stopPlayback = useCallback(() => {
    outputSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Source may have already finished.
      }
    });
    outputSourcesRef.current = [];
    nextPlaybackTimeRef.current = outputContextRef.current?.currentTime ?? 0;
    handlePlaybackIdleRef.current();
  }, []);

  const stopListening = useCallback(async () => {
    const sessionId = sessionIdRef.current;

    recoverActiveSessionRef.current = false;
    clearSessionRecoveryTimer();
    stopPlayback();
    resetNotificationQueue();
    resetChatResponseQueue();
    settleDelegationApproval(false);
    sessionIdRef.current = null;
    setStatus("idle");
    setVideoSource(null);

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

  // Resume the output context if the WebView/OS suspended it while audio is
  // (about to be) playing. Safe to call often; it no-ops when running.
  const resumeOutputContextIfNeeded = useCallback(() => {
    const outputContext = outputContextRef.current;
    if (!outputContext || outputContext.state !== "suspended") {
      return;
    }
    const hasPending =
      outputSourcesRef.current.length > 0 ||
      nextPlaybackTimeRef.current > outputContext.currentTime + 0.01;
    if (hasPending) {
      void outputContext.resume().catch(() => undefined);
    }
  }, []);

  // Start a low-frequency watchdog (once) that keeps the output context awake
  // for the whole session, so a mid-report suspend can never leave the voice
  // permanently silent. Cleared on unmount.
  const ensureOutputWatchdog = useCallback(() => {
    if (outputWatchdogRef.current) {
      return;
    }
    outputWatchdogRef.current = setInterval(() => {
      resumeOutputContextIfNeeded();
    }, 500);
  }, [resumeOutputContextIfNeeded]);

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
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        setStatus("unsupported");
        setErrorMessage("Audio playback is not available in this WebView.");
        return;
      }

      const outputContext =
        outputContextRef.current ?? new AudioContextConstructor();
      outputContextRef.current = outputContext;
      ensureOutputWatchdog();

      if (outputContext.state === "suspended") {
        await outputContext.resume().catch(() => undefined);
      }

      const audioBuffer = pcm16Base64ToAudioBuffer(
        outputContext,
        data,
        parseAudioRate(mimeType),
      );
      const source = outputContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputContext.destination);
      source.onended = () => {
        outputSourcesRef.current = outputSourcesRef.current.filter(
          (item) => item !== source,
        );
        handlePlaybackIdleRef.current();
      };

      // Gapless while streaming continuously (nextPlaybackTime stays ahead of
      // the clock). But if we fell behind — a fresh turn, or a main-thread
      // stall during a long report drained the queue — scheduling at exactly
      // currentTime risks the buffer landing in the past on the next stall,
      // which is what produced the rasping. Re-arm with a small lead so brief
      // jank can't corrupt playback. The extra latency only appears after an
      // underrun and is imperceptible.
      const OUTPUT_LEAD_SECONDS = 0.12;
      let startAt = nextPlaybackTimeRef.current;
      if (startAt < outputContext.currentTime + 0.005) {
        startAt = outputContext.currentTime + OUTPUT_LEAD_SECONDS;
      }
      source.start(startAt);
      nextPlaybackTimeRef.current = startAt + audioBuffer.duration;
      outputSourcesRef.current.push(source);
    },
    [ensureOutputWatchdog],
  );

  const requeueCurrentNotificationBatch = useCallback(() => {
    if (notificationBatchInFlightRef.current.length > 0) {
      notificationQueueRef.current = notificationBatchInFlightRef.current
        .concat(notificationQueueRef.current)
        .slice(0, 50);
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
        audioSources: outputSourcesRef.current.length,
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
        .slice(0, 50);
      notificationBatchInFlightRef.current = bridgeBatch;
    } else {
      notificationBatchInFlightRef.current = batch;
    }
    notificationInFlightRef.current = true;
    serverTurnCompleteRef.current = false;
    setPendingNotificationCount(notificationQueueRef.current.length);

    notificationWatchdogRef.current = setTimeout(() => {
      notificationWatchdogRef.current = undefined;
      if (!notificationInFlightRef.current) {
        return;
      }
      finishCurrentNotificationBatch();
      serverTurnCompleteRef.current = true;
      scheduleNotificationFlush(3_000);
    }, 45_000);

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
  }, []);

  const tryFlushChatResponse = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId ||
      chatResponseQueueRef.current.length === 0 ||
      chatResponseInFlightRef.current ||
      notificationInFlightRef.current ||
      outputSourcesRef.current.length > 0 ||
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
  }, [ideMessenger, requeueCurrentChatResponse, scheduleChatResponseFlush]);
  tryFlushChatResponseRef.current = tryFlushChatResponse;

  const handlePlaybackIdle = useCallback(() => {
    if (outputSourcesRef.current.length > 0 || !serverTurnCompleteRef.current) {
      return;
    }

    if (chatResponseInFlightRef.current) {
      activeChatResponseRef.current = undefined;
      chatResponseInFlightRef.current = false;
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
        if (!approved) {
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

        const response = await runDelegatedTask(fullTask, true);
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

      if (event.type === "transcript") {
        if (event.source === "user") {
          lastUserActivityAtRef.current = Date.now();
          serverTurnCompleteRef.current = false;
          setUserTranscript(event.text);
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
          .slice(-50);
        setPendingNotificationCount(notificationQueueRef.current.length);
        scheduleNotificationFlush();
        return;
      }

      if (event.type === "chatResponse") {
        // A finished Claude Code chat response, relayed from the Windows Bridge.
        // Reuse the same dedup + speech queue as Lumina Code chat responses so it
        // is read aloud once, after the current turn, and never twice.
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
        if (event.matched) {
          setSpeaker({
            identityId: event.identityId,
            name: event.name,
            score: event.score,
          });
        }
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
            return current.concat(event.activity);
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

  const startScreenShare = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    const res = await ideMessenger.request("startTalk/startVideo", {
      sessionId,
      source: "screen",
    });
    if (res.status !== "error") {
      setVideoSource("screen");
    }
  }, [ideMessenger]);

  const startCamera = useCallback(
    async (deviceName?: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      const res = await ideMessenger.request("startTalk/startVideo", {
        sessionId,
        source: "camera",
        deviceName,
      });
      if (res.status !== "error") {
        setVideoSource("camera");
      }
    },
    [ideMessenger],
  );

  const stopVideo = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    setVideoSource(null);
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

  const listAudioDevices = useCallback(async (): Promise<string[]> => {
    const res = await ideMessenger.request(
      "startTalk/listAudioDevices",
      undefined,
    );
    return res.status === "error" ? [] : (res.content ?? []);
  }, [ideMessenger]);

  const switchAudioDevice = useCallback(
    async (deviceName: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      await ideMessenger.request("startTalk/switchAudioDevice", {
        sessionId,
        deviceName,
      });
    },
    [ideMessenger],
  );

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
    setSpeaker(null);
    setLastSoundEvent(null);
    setMicLevel(0);
    setIsMuted(false);
    resetNotificationQueue();
    assistantTurnActiveRef.current = false;
    assistantTranscriptRef.current = "";

    const activeTranslation = translationRef.current;
    try {
      const response = await ideMessenger.request("startTalk/connect", {
        preferredModel: model.model,
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
      const captureResponse = await ideMessenger.request(
        "startTalk/startCapture",
        {
          sessionId: response.content.sessionId,
        },
      );

      if (captureResponse.status === "error") {
        throw new Error(captureResponse.error);
      }

      sessionRecoveryAttemptsRef.current = 0;
      recoverActiveSessionRef.current = true;
      setStatus("listening");
      scheduleChatResponseFlush();
    } catch (error) {
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;

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
      void stopListening();
      void outputContextRef.current?.close();
    };
  }, [clearSessionRecoveryTimer, stopListening]);

  return {
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
    userTranscript,
    videoSource,
    startScreenShare,
    startCamera,
    stopVideo,
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
