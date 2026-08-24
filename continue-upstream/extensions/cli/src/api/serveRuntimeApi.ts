import type { ServerState } from "../commands/serve.helpers.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import { getCompleteStateSnapshot } from "../session.js";
import { messageQueue } from "../stream/messageQueue.js";
import { listChildSessions } from "../subagent/childSession.js";
import { getGitDiffSnapshot } from "../util/git.js";

import { createRuntimeApiRouter } from "./runtimeApi.js";

interface ServeRuntimeApiOptions {
  state: ServerState;
  syncSessionHistory: () => void;
  startProcessing: () => void;
}

/** Bind the generic v1 contract to a live `cn serve` runtime. */
export function createServeRuntimeApiRouter(options: ServeRuntimeApiOptions) {
  const { state, syncSessionHistory, startProcessing } = options;

  return createRuntimeApiRouter({
    sessionId: state.session.sessionId,
    getState: () => {
      state.lastActivity = Date.now();
      syncSessionHistory();
      return getCompleteStateSnapshot(
        state.session,
        state.isProcessing,
        messageQueue.getQueueLength(),
        state.pendingPermission,
      );
    },
    listChildren: listChildSessions,
    queueMessage: async (message) => {
      state.lastActivity = Date.now();
      await messageQueue.enqueueMessage(message);
      const position = messageQueue.getQueueLength();
      if (!state.isProcessing) startProcessing();
      return { position };
    },
    resolvePermission: (requestId, approved) => {
      state.lastActivity = Date.now();
      if (!state.pendingPermission) {
        return { success: false, error: "No pending permission request" };
      }
      if (state.pendingPermission.requestId !== requestId) {
        return { success: false, error: "Invalid request ID" };
      }
      if (approved) {
        toolPermissionManager.approveRequest(requestId);
      } else {
        toolPermissionManager.rejectRequest(requestId);
      }
      state.pendingPermission = null;
      return { success: true };
    },
    pause: () => {
      state.lastActivity = Date.now();
      if (!state.isProcessing) {
        return { success: false, message: "No active processing to pause" };
      }
      state.currentAbortController?.abort();
      state.isProcessing = false;
      return { success: true, message: "Agent run paused" };
    },
    getDiff: getGitDiffSnapshot,
  });
}
