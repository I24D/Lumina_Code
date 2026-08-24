import type { ThunkAction, UnknownAction } from "@reduxjs/toolkit";
import type { SessionGoal } from "core/goals/sessionGoal";
import {
  buildContinuationPrompt,
  buildGoalEvaluationPrompt,
} from "core/goals/sessionGoal";

import { textToEditorState } from "../../components/startTalk/voiceDelegation";
import { selectSelectedChatModel } from "../slices/configSlice";
import type { RootState, ThunkExtrasType } from "../store";
import { streamResponseThunk } from "./streamResponse";

/**
 * pursueSessionGoal — el bucle que persigue una meta de sesión.
 *
 * Se ejecuta al terminar cada turno. Si la sesión tiene meta activa, juzga si
 * ya se cumplió y, si no, relanza al agente. El techo de turnos vive en core
 * (ver `sessionGoal.ts`), no aquí: quien decide cuándo parar no puede ser el
 * mismo lado que decide cuándo seguir.
 *
 * Cómo termina, que es lo único que importa de un bucle que se relanza solo:
 *   - core cuenta un turno en CADA veredicto, incluso ilegible;
 *   - al llegar al techo la meta pasa a `limitReached` y deja de estar activa;
 *   - un veredicto `blocked` corta en el acto;
 *   - si el usuario cancela o cambia de sesión, no se relanza;
 *   - si falla el juez o la red, se abandona en vez de reintentar.
 */

/** Cuántos mensajes recientes ve el juez. Basta para decidir si algo se logró. */
const JUDGE_CONTEXT_MESSAGES = 6;
/** Recorte por mensaje, para que un volcado enorme no dispare el coste. */
const JUDGE_MESSAGE_CHARS = 1200;

/** Últimos mensajes en texto plano, recortados, para el verificador. */
export function buildRecentConversation(
  history: Array<{ message: { role: string; content: unknown } }>,
): string {
  return history
    .slice(-JUDGE_CONTEXT_MESSAGES)
    .map((item) => {
      const content =
        typeof item.message.content === "string"
          ? item.message.content
          : JSON.stringify(item.message.content);
      return `${item.message.role}: ${String(content).slice(0, JUDGE_MESSAGE_CHARS)}`;
    })
    .join("\n\n");
}

export function pursueSessionGoal(): ThunkAction<
  Promise<void>,
  RootState,
  ThunkExtrasType,
  UnknownAction
> {
  return async (dispatch, getState, extra) => {
    const state = getState();
    const sessionId = state.session.id;
    if (!sessionId || state.session.history.length === 0) {
      return;
    }

    let goalResult;
    try {
      goalResult = await extra.ideMessenger.request("goals/get", {
        sessionId,
      });
    } catch {
      // Older hosts and transient bridge failures must not turn an otherwise
      // successful chat response into a rejected request.
      return;
    }
    if (goalResult.status === "error" || !goalResult.content) {
      return;
    }
    const goal = goalResult.content as SessionGoal;
    if (goal.status !== "active") {
      return;
    }

    const model = selectSelectedChatModel(state);
    if (!model) {
      return;
    }

    // El juez es una llamada aparte, sin herramientas y a temperatura cero: si
    // se hiciera dentro del turno, el agente podría aprobarse a sí mismo.
    let raw = "";
    try {
      const completion = await extra.ideMessenger.request("llm/complete", {
        prompt: buildGoalEvaluationPrompt(
          goal.text,
          buildRecentConversation(state.session.history as any),
        ),
        completionOptions: { maxTokens: 200, temperature: 0 },
        title: model.title,
      });
      if (completion.status === "error") {
        return;
      }
      raw = completion.content ?? "";
    } catch {
      // El juez no respondió: se abandona. Reintentar a ciegas es la forma más
      // rápida de convertir un fallo de red en una factura.
      return;
    }

    // core parsea el veredicto y aplica el techo. Se hace allí a propósito: es
    // la parte que no puede depender de lo que un modelo haya respondido.
    const updated = await extra.ideMessenger.request("goals/applyVerdict", {
      sessionId,
      raw,
    });
    if (updated.status === "error" || !updated.content) {
      return;
    }

    const next = updated.content as SessionGoal;
    if (next.status !== "active") {
      return;
    }

    // El usuario pudo cancelar o cambiar de sesión mientras se juzgaba.
    const after = getState();
    if (after.session.id !== sessionId || after.session.isStreaming) {
      return;
    }

    await dispatch(
      streamResponseThunk({
        editorState: textToEditorState(buildContinuationPrompt(next)),
        modifiers: { noContext: false, useCodebase: false },
      }),
    );
  };
}
