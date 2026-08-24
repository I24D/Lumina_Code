import { serviceContainer } from "../services/ServiceContainer.js";
import type { ModelServiceState } from "../services/types.js";
import { SERVICE_NAMES } from "../services/types.js";
import { logger } from "../util/logger.js";

import {
  type ChildSessionRecord,
  createChildSession,
  loadChildSession,
} from "./childSession.js";
import { executeSubAgent } from "./executor.js";
import { getSubagent } from "./get-agents.js";

function getOriginalPrompt(child: ChildSessionRecord): string | null {
  const content = child.history.find((item) => item.message.role === "user")
    ?.message.content;
  return typeof content === "string" ? content : null;
}

/** Start a new traceable child using the original child's task and agent. */
export async function retryChildSession(
  sessionId: string,
): Promise<ChildSessionRecord | null> {
  const original = loadChildSession(sessionId);
  if (!original) return null;
  const prompt = getOriginalPrompt(original);
  if (!prompt) return null;

  const modelState = await serviceContainer.get<ModelServiceState>(
    SERVICE_NAMES.MODEL,
  );
  const agent = getSubagent(modelState, original.agentName);
  if (!agent) return null;

  const retry = createChildSession(
    original.parentSessionId,
    original.agentName,
    prompt,
    original.sessionId,
  );
  void executeSubAgent(
    {
      agent,
      prompt,
      parentSessionId: original.parentSessionId,
      abortController: new AbortController(),
    },
    retry,
  ).catch((error) => logger.error("Retried subagent failed", error));
  return retry;
}
