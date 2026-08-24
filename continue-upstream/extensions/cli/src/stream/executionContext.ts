import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { Usage } from "core/index.js";

import { serviceContainer } from "../services/ServiceContainer.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import { SERVICE_NAMES } from "../services/types.js";
import { trackSessionUsage } from "../session.js";

export interface AgentExecutionContext {
  sessionId: string;
  parentSessionId?: string;
  kind: "primary" | "subagent";
  permissionState?: ToolPermissionServiceState;
  systemMessageOverride?: string;
  useChatHistoryService?: boolean;
  workingDirectory?: string;
  onUsage?: (cost: number, usage: Usage) => void;
}

const executionContextGlobal = globalThis as typeof globalThis & {
  __luminaAgentExecutionContextStorage?: AsyncLocalStorage<AgentExecutionContext>;
};

// Bundlers and test runners can load this module through both its TypeScript
// and ESM paths. Keep one process-wide storage instance so every tool observes
// the same request scope without falling back to process.cwd().
const executionContextStorage =
  (executionContextGlobal.__luminaAgentExecutionContextStorage ??=
    new AsyncLocalStorage<AgentExecutionContext>());

export function runWithAgentExecutionContext<T>(
  context: AgentExecutionContext,
  task: () => Promise<T>,
): Promise<T> {
  return executionContextStorage.run(context, task);
}

export function getAgentExecutionContext(): AgentExecutionContext | undefined {
  return executionContextStorage.getStore();
}

export function shouldUseChatHistoryService(): boolean {
  return getAgentExecutionContext()?.useChatHistoryService !== false;
}

export function getSystemMessageOverride(): string | undefined {
  return getAgentExecutionContext()?.systemMessageOverride;
}

export function getAgentWorkingDirectory(): string {
  return getAgentExecutionContext()?.workingDirectory ?? process.cwd();
}

export function resolveAgentPath(requestedPath: string): string {
  const scopedRoot = getAgentExecutionContext()?.workingDirectory;
  const resolved = path.resolve(scopedRoot ?? process.cwd(), requestedPath);
  if (scopedRoot) {
    const relative = path.relative(scopedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Path escapes the isolated agent worktree: ${requestedPath}`,
      );
    }
  }
  return resolved;
}

/** Attribute usage to the active request instead of a process-global session. */
export function trackAgentExecutionUsage(cost: number, usage: Usage): void {
  const onUsage = getAgentExecutionContext()?.onUsage;
  if (onUsage) {
    onUsage(cost, usage);
    return;
  }
  trackSessionUsage(cost, usage);
}

export async function resolveToolPermissionState(): Promise<ToolPermissionServiceState> {
  const scopedState = getAgentExecutionContext()?.permissionState;
  if (scopedState) {
    return scopedState;
  }

  const registered = serviceContainer.getSync<ToolPermissionServiceState>(
    SERVICE_NAMES.TOOL_PERMISSIONS,
  );
  if (registered.state === "ready" && registered.value) {
    return registered.value;
  }

  try {
    return await serviceContainer.get<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );
  } catch {
    // Some embedders and isolated tests call the stream before the registry is
    // bootstrapped. Preserve the public service's established fallback state.
    const { services } = await import("../services/index.js");
    return services.toolPermissions.getState();
  }
}

/** Capture permissions for a delegated run so later mode changes cannot elevate it. */
export function snapshotToolPermissionState(
  state: ToolPermissionServiceState,
): ToolPermissionServiceState {
  const clonePolicies = (policies: typeof state.permissions.policies) =>
    policies.map((policy) => ({
      ...policy,
      argumentMatches: policy.argumentMatches
        ? structuredClone(policy.argumentMatches)
        : undefined,
    }));

  return {
    ...state,
    permissions: { policies: clonePolicies(state.permissions.policies) },
    originalPolicies: state.originalPolicies
      ? { policies: clonePolicies(state.originalPolicies.policies) }
      : undefined,
  };
}
