import type { ToolPolicy } from "./types.js";

export type PermissionDecision = "allow" | "ask" | "exclude";

export type PermissionMode = "normal" | "plan" | "auto";

export interface ToolPermissionPolicy {
  tool: string;
  permission: PermissionDecision;
  argumentMatches?: Record<string, unknown>;
}

export interface ToolPermissions {
  policies: ToolPermissionPolicy[];
}

export interface ToolPermissionRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface PermissionEvaluation {
  permission: PermissionDecision;
  matchedPolicy?: ToolPermissionPolicy;
}

export type AuthorizationSurface =
  | "cli"
  | "vscode"
  | "start-talk"
  | "windows-bridge"
  | "acp";

export type ProtectedCapability =
  | "read-workspace"
  | "write-workspace"
  | "execute-terminal"
  | "delegate-agent"
  | "inspect-desktop"
  | "control-desktop"
  | "send-message";

export interface SurfaceAuthorizationRequest {
  surface: AuthorizationSurface;
  capability: ProtectedCapability;
  userApproved: boolean;
  policy?: PermissionDecision;
}

export interface SurfaceAuthorizationResult {
  authorized: boolean;
  reason?: "policy-excluded" | "explicit-user-approval-required";
}

export function permissionDecisionToToolPolicy(
  permission: PermissionDecision,
): ToolPolicy {
  switch (permission) {
    case "allow":
      return "allowedWithoutPermission";
    case "ask":
      return "allowedWithPermission";
    case "exclude":
      return "disabled";
  }
}

export function toolPolicyToPermissionDecision(
  policy: ToolPolicy,
): PermissionDecision {
  switch (policy) {
    case "allowedWithoutPermission":
      return "allow";
    case "allowedWithPermission":
      return "ask";
    case "disabled":
      return "exclude";
  }
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexPattern}$`).test(value);
}

export function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolArguments?: Record<string, unknown>,
): boolean {
  if (pattern === "*" || pattern === toolName) return true;

  const bashCommandMatch = pattern.match(/^Bash\((.+)\)$/);
  if (bashCommandMatch) {
    const command = toolArguments?.command;
    return (
      toolName === "Bash" &&
      typeof command === "string" &&
      globMatches(command, bashCommandMatch[1])
    );
  }

  return globMatches(toolName, pattern);
}

export function matchesArguments(
  args: Record<string, unknown>,
  patterns?: Record<string, unknown>,
): boolean {
  if (!patterns) return true;

  return Object.entries(patterns).every(([key, pattern]) => {
    if (pattern === "*") return true;
    const value = args[key];
    if (
      typeof pattern === "string" &&
      (pattern.includes("*") || pattern.includes("?"))
    ) {
      return globMatches(String(value ?? ""), pattern);
    }
    return value === pattern;
  });
}

/** First matching policy wins; unmatched actions always require confirmation. */
export function evaluatePermissionPolicies(
  request: ToolPermissionRequest,
  permissions: ToolPermissions,
): PermissionEvaluation {
  for (const policy of permissions.policies) {
    if (
      matchesToolPattern(request.name, policy.tool, request.arguments) &&
      matchesArguments(request.arguments, policy.argumentMatches)
    ) {
      return { permission: policy.permission, matchedPolicy: policy };
    }
  }
  return { permission: "ask" };
}

const START_TALK_EXPLICIT_CAPABILITIES = new Set<ProtectedCapability>([
  "write-workspace",
  "execute-terminal",
  "delegate-agent",
  "control-desktop",
  "send-message",
]);

/**
 * Common authorization boundary for every Lumina host. Model output is never
 * approval evidence; callers must supply a user interaction they observed.
 */
export function evaluateSurfaceAuthorization(
  request: SurfaceAuthorizationRequest,
): SurfaceAuthorizationResult {
  if (request.policy === "exclude") {
    return { authorized: false, reason: "policy-excluded" };
  }

  const requiresExplicitApproval =
    request.policy === "ask" ||
    (request.surface === "start-talk" &&
      START_TALK_EXPLICIT_CAPABILITIES.has(request.capability));
  if (requiresExplicitApproval && !request.userApproved) {
    return {
      authorized: false,
      reason: "explicit-user-approval-required",
    };
  }
  return { authorized: true };
}
