import { createAsyncThunk } from "@reduxjs/toolkit";

import {
  cancelToolCall as cancelToolCallAction,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById } from "../util";

import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

const DEFAULT_USER_REJECTION_MESSAGE = `The user skipped the tool call.
If the tool call is optional or non-critical to the main goal, skip it and continue with the next step.
If the tool call is essential, try an alternative approach.
If no alternatives exist, offer to pause here.`;

export const cancelToolCallThunk = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>(
  "chat/cancelToolCall",
  async ({ toolCallId }, { dispatch, extra, getState }) => {
    const state = getState();
    const toolCallState = findToolCallById(state.session.history, toolCallId);
    const continueAfterToolRejection =
      state.config.config.ui?.continueAfterToolRejection;

    void extra.ideMessenger
      .request("security/audit/record", {
        category: "tools",
        action: "rejected",
        actor: "user",
        outcome: "rejected",
        summary: `El usuario rechazó ${toolCallState?.toolCall.function.name ?? "una herramienta"}.`,
        details: {
          tool: toolCallState?.toolCall.function.name ?? "unknown",
          toolCallId,
        },
      })
      .catch(() => undefined);

    if (continueAfterToolRejection) {
      // Update tool call output with rejection message
      dispatch(
        updateToolCallOutput({
          toolCallId,
          contextItems: [
            {
              icon: "problems",
              name: "Tool Call Rejected",
              description: "User skipped the tool call",
              content: DEFAULT_USER_REJECTION_MESSAGE,
              hidden: true,
            },
          ],
        }),
      );
    }

    // Dispatch the actual cancel action
    dispatch(cancelToolCallAction({ toolCallId }));

    void dispatch(streamResponseAfterToolCall({ toolCallId }));
  },
);
