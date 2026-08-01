import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type LuminaAgentMode = "chat" | "agent";

export interface LuminaEvent {
  event: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface ToolCallEvent {
  callId: string;
  toolName: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  success?: boolean;
  preview?: string;
}

interface LuminaState {
  agentMode: LuminaAgentMode;
  activeToolCall: ToolCallEvent | null;
  recentEvents: LuminaEvent[];
  agentError: string | null;
}

const MAX_EVENTS = 50;

export const INITIAL_LUMINA_STATE: LuminaState = {
  agentMode: "chat",
  activeToolCall: null,
  recentEvents: [],
  agentError: null,
};

const luminaSlice = createSlice({
  name: "lumina",
  initialState: INITIAL_LUMINA_STATE,
  reducers: {
    agentEventReceived(state, action: PayloadAction<LuminaEvent>) {
      const { event, payload } = action.payload;
      state.recentEvents = [action.payload, ...state.recentEvents].slice(
        0,
        MAX_EVENTS,
      );

      switch (event) {
        case "agent:mode":
          state.agentMode = (payload.mode as LuminaAgentMode) ?? "chat";
          break;

        case "agent:error":
          state.agentError = String(payload.message ?? "Unknown error");
          break;

        case "agent:done":
          state.activeToolCall = null;
          state.agentError = null;
          break;

        case "tool:start":
          state.activeToolCall = {
            callId: String(payload.callId ?? ""),
            toolName: String(payload.toolName ?? ""),
            args: payload.args as Record<string, unknown> | undefined,
          };
          break;

        case "tool:output":
          if (
            state.activeToolCall &&
            state.activeToolCall.callId === payload.callId
          ) {
            const activeToolCall = state.activeToolCall;
            activeToolCall.preview = String(payload.preview ?? "");
          }
          break;

        case "tool:end":
          if (
            state.activeToolCall &&
            state.activeToolCall.callId === payload.callId
          ) {
            const activeToolCall = state.activeToolCall;
            activeToolCall.durationMs = Number(payload.durationMs ?? 0);
            activeToolCall.success = Boolean(payload.success);
          }
          break;

        default:
          break;
      }
    },

    clearLuminaError(state) {
      state.agentError = null;
    },

    resetLuminaActiveCall(state) {
      state.activeToolCall = null;
    },
  },
});

export const {
  agentEventReceived,
  clearLuminaError,
  resetLuminaActiveCall,
} = luminaSlice.actions;

export default luminaSlice.reducer;
