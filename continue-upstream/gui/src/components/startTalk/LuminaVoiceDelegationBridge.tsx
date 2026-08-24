import { useContext, useEffect, useRef } from "react";
import { useStore } from "react-redux";
import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch } from "../../redux/hooks";
import { setMode } from "../../redux/slices/sessionSlice";
import type { RootState } from "../../redux/store";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import {
  buildDelegatedPrompt,
  getLatestAssistantResponse,
  isOrbWindow,
  textToEditorState,
} from "./voiceDelegation";

/**
 * LuminaVoiceDelegationBridge
 *
 * Runs ONLY in the main Lumina Code sidebar (never in the desktop orb). It
 * receives voice tasks that Start Talk delegated from the orb
 * (`startTalk/runInMain`), executes them in the REAL chat session — so the
 * request and streamed answer appear in the chat UI, using the full agent with
 * all its tools — and posts the FINAL answer back (`startTalk/mainResult`) so
 * the orb reads it aloud in full.
 *
 * Completion is detected from the Redux store after streaming becomes idle.
 * The subscription remains active for the lifetime of the sidebar, so a long
 * tool run cannot lose its final response. Ordinary typed chat responses are
 * also relayed to Start Talk for queued speech.
 */
export function LuminaVoiceDelegationBridge() {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();

  // The delegation currently running in the sidebar (if any).
  const pendingRef = useRef<{ requestId: string; started: boolean } | null>(
    null,
  );
  const turnStartedRef = useRef(false);
  const initialSession = store.getState().session;
  const trackedSessionIdRef = useRef(initialSession.id);
  const lastReportedResponseKeyRef = useRef(
    getLatestAssistantResponse(initialSession.history, initialSession.id)?.key,
  );

  // Observe every completed assistant turn, including turns started directly
  // from the Lumina Code chat rather than from Start Talk.
  useEffect(() => {
    return store.subscribe(() => {
      if (isOrbWindow()) {
        return;
      }

      const session = store.getState().session;
      if (session.id !== trackedSessionIdRef.current) {
        trackedSessionIdRef.current = session.id;
        lastReportedResponseKeyRef.current = getLatestAssistantResponse(
          session.history,
          session.id,
        )?.key;
        turnStartedRef.current = false;
      }

      if (session.isStreaming) {
        turnStartedRef.current = true;
        if (pendingRef.current) {
          pendingRef.current.started = true;
        }
        return;
      }

      const pending = pendingRef.current;
      if (!turnStartedRef.current && !pending?.started) {
        return;
      }

      const response = getLatestAssistantResponse(session.history, session.id);
      if (!response || response.key === lastReportedResponseKeyRef.current) {
        return;
      }

      turnStartedRef.current = false;
      lastReportedResponseKeyRef.current = response.key;

      if (pending?.started) {
        console.log(
          `[VoiceDelegation] delegated turn finished (${response.text.length} chars) for ${pending.requestId}`,
        );
        ideMessenger.post("startTalk/mainResult", {
          requestId: pending.requestId,
          text: response.text,
        });
        pendingRef.current = null;
        return;
      }

      const responseId = `chat:${response.key}`;
      console.log(
        `[VoiceDelegation] typed chat turn finished (${response.text.length} chars) as ${responseId}`,
      );
      ideMessenger.post("startTalk/mainResult", {
        requestId: responseId,
        text: response.text,
      });
    });
  }, [ideMessenger, store]);

  useWebviewListener(
    "startTalk/runInMain",
    async ({ requestId, task, context, userApproved }) => {
      // The orb also receives the broadcast; only the sidebar must act on it.
      if (isOrbWindow()) {
        return;
      }

      const reply = (text: string, error?: boolean) => {
        ideMessenger.post("startTalk/mainResult", { requestId, text, error });
      };

      console.log(`[VoiceDelegation] runInMain received: ${requestId}`);
      const authorization = evaluateSurfaceAuthorization({
        surface: "start-talk",
        capability: "delegate-agent",
        userApproved,
        policy: "allow",
      });
      if (!authorization.authorized) {
        reply("La tarea de Start Talk no tiene autorizacion valida.", true);
        return;
      }
      if (store.getState().session.isStreaming || pendingRef.current) {
        reply("Lumina Code ya está trabajando en otra tarea.", true);
        return;
      }

      pendingRef.current = { requestId, started: false };

      try {
        if (store.getState().session.mode === "chat") {
          dispatch(setMode("agent"));
        }
        const fullTask = context ? `${task}\n\nContexto: ${context}` : task;
        // Fire the turn; the persistent store subscription reports completion.
        await dispatch(
          streamResponseThunk({
            editorState: textToEditorState(buildDelegatedPrompt(fullTask)),
            modifiers: { noContext: false, useCodebase: true },
          }),
        );
      } catch (error) {
        // Synchronous/dispatch failure: report and clear so we don't hang.
        if (pendingRef.current?.requestId === requestId) {
          pendingRef.current = null;
          reply(
            error instanceof Error
              ? error.message
              : "Lumina Code no pudo completar la solicitud.",
            true,
          );
        }
      }
    },
    [dispatch, ideMessenger, store],
  );

  return null;
}
