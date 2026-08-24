import { act } from "@testing-library/react";
import {
  applyVerdict,
  createGoal,
  parseGoalVerdict,
} from "core/goals/sessionGoal";
import { describe, expect, it, vi } from "vitest";
import { textToEditorState } from "../../components/startTalk/voiceDelegation";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setupStore } from "../store";
import { addAndSelectMockLlm } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import { streamResponseThunk } from "./streamResponse";

describe("Session Goals integration", () => {
  it("continues after an incomplete verdict and stops after completion", async () => {
    const messenger = new MockIdeMessenger();
    messenger.setChatResponseText("Turno del agente terminado");
    const store = setupStore({ ideMessenger: messenger });
    await renderWithProviders(<div />, { mockIdeMessenger: messenger, store });
    await act(async () => addAndSelectMockLlm(store, messenger));

    let goal = createGoal(
      store.getState().session.id,
      "Completar y verificar el trabajo",
      4,
    );
    const judge = vi
      .fn()
      .mockResolvedValueOnce(
        '{"verdict":"incomplete","reason":"falta una verificación"}',
      )
      .mockResolvedValueOnce(
        '{"verdict":"complete","reason":"resultado verificado"}',
      );
    messenger.responseHandlers["goals/get"] = vi.fn(async () => goal);
    messenger.responseHandlers["llm/complete"] = judge;
    messenger.responseHandlers["goals/applyVerdict"] = vi.fn(
      async ({ raw }) => {
        goal = applyVerdict(goal, parseGoalVerdict(raw));
        return goal;
      },
    );

    await act(async () => {
      await store
        .dispatch(
          streamResponseThunk({
            editorState: textToEditorState("Empieza la tarea"),
            modifiers: { noContext: false, useCodebase: true },
          }),
        )
        .unwrap();
    });

    expect(judge).toHaveBeenCalledTimes(2);
    expect(goal).toMatchObject({
      status: "completed",
      turnsUsed: 2,
      lastReason: "resultado verificado",
    });
    const dialog = store.getState().ui.dialogMessage as any;
    expect(dialog?.props?.error).toBeUndefined();
    expect(
      store
        .getState()
        .session.history.filter((item) => item.message.role === "assistant"),
    ).toHaveLength(2);
    expect(store.getState().session.isStreaming).toBe(false);
  }, 20_000);

  it("does not judge goal progress when the agent turn fails", async () => {
    const messenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger: messenger });
    const getGoal = vi.fn();
    messenger.responseHandlers["goals/get"] = getGoal;

    // No model is selected, so streamThunkWrapper reports the turn error.
    // The goal judge must never see unchanged conversation history.
    await store
      .dispatch(
        streamResponseThunk({
          editorState: textToEditorState("No debe contar como progreso"),
          modifiers: { noContext: false, useCodebase: false },
        }),
      )
      .unwrap();

    expect(getGoal).not.toHaveBeenCalled();
    expect(store.getState().ui.showDialog).toBe(true);
  });
});
