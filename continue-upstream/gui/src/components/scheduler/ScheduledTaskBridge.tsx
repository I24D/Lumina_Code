import { useContext, useEffect, useRef } from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch } from "../../redux/hooks";
import {
  newSession,
  setMode,
  updateSessionTitle,
} from "../../redux/slices/sessionSlice";
import type { RootState } from "../../redux/store";
import { saveCurrentSession } from "../../redux/thunks/session";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import {
  getLatestAssistantResponse,
  textToEditorState,
} from "../startTalk/voiceDelegation";

function scheduledPrompt(name: string, prompt: string) {
  return [
    `Tarea programada autorizada por el usuario: ${name}`,
    "Ejecuta esta solicitud con las herramientas disponibles y verifica el resultado.",
    "No cambies el alcance de la tarea programada.",
    "",
    prompt,
  ].join("\n");
}

export function ScheduledTaskBridge() {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const claimingRef = useRef(false);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      if (
        !active ||
        claimingRef.current ||
        store.getState().session.isStreaming
      ) {
        return;
      }
      claimingRef.current = true;
      let runId: string | undefined;
      try {
        const claim = await ideMessenger.request(
          "scheduler/claimDue",
          undefined,
        );
        if (claim.status === "error" || !claim.content) return;
        const { task, run } = claim.content;
        runId = run.id;

        const before = store.getState().session;
        if (before.history.length > 0) {
          await dispatch(
            saveCurrentSession({ openNewSession: true, generateTitle: true }),
          ).unwrap();
        } else {
          dispatch(newSession());
        }

        dispatch(setMode("agent"));
        dispatch(updateSessionTitle(`Programada: ${task.name}`));
        const sessionId = store.getState().session.id;
        if (task.runAsGoal) {
          const goal = await ideMessenger.request("goals/set", {
            sessionId,
            text: task.prompt,
            maxTurns: task.maxTurns,
          });
          if (goal.status === "error") throw new Error(goal.error);
        }

        const previousResponse = getLatestAssistantResponse(
          store.getState().session.history,
          sessionId,
        )?.key;
        await dispatch(
          streamResponseThunk({
            editorState: textToEditorState(
              scheduledPrompt(task.name, task.prompt),
            ),
            modifiers: { noContext: false, useCodebase: true },
          }),
        ).unwrap();
        const response = getLatestAssistantResponse(
          store.getState().session.history,
          sessionId,
        );
        if (!response || response.key === previousResponse) {
          throw new Error(
            "La tarea terminó sin una respuesta final del agente.",
          );
        }
        await ideMessenger.request("scheduler/reportRun", {
          runId,
          status: "completed",
          sessionId,
        });
      } catch (cause) {
        if (runId) {
          await ideMessenger.request("scheduler/reportRun", {
            runId,
            status: "failed",
            sessionId: store.getState().session.id,
            error:
              cause instanceof Error
                ? cause.message
                : "La tarea programada no pudo ejecutarse.",
          });
        }
      } finally {
        claimingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [dispatch, ideMessenger, store]);

  return null;
}
