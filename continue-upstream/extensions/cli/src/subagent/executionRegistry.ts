const activeChildExecutions = new Map<string, AbortController>();

export function registerChildExecution(
  sessionId: string,
  abortController: AbortController,
): () => void {
  activeChildExecutions.set(sessionId, abortController);
  return () => {
    if (activeChildExecutions.get(sessionId) === abortController) {
      activeChildExecutions.delete(sessionId);
    }
  };
}

export function cancelChildExecution(sessionId: string): boolean {
  const controller = activeChildExecutions.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isChildExecutionActive(sessionId: string): boolean {
  return activeChildExecutions.has(sessionId);
}
