import {
  evaluatePermissionPolicies,
  permissionDecisionToToolPolicy,
} from "@continuedev/terminal-security";

import { ALL_BUILT_IN_TOOLS } from "src/tools/allBuiltIns.js";

import {
  PermissionCheckResult,
  ToolCallRequest,
  ToolPermissions,
} from "./types.js";

export {
  matchesArguments,
  matchesToolPattern,
} from "@continuedev/terminal-security";

/**
 * Evaluates a tool call against the shared first-match policy engine, then
 * applies any tool-specific safety evaluator. A dynamic disable always wins;
 * otherwise the user's shared policy remains authoritative.
 */
export function checkToolPermission(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
): PermissionCheckResult {
  const evaluation = evaluatePermissionPolicies(toolCall, permissions);
  const basePermission = evaluation.permission;
  const matchedPolicy = evaluation.matchedPolicy;

  const tool = ALL_BUILT_IN_TOOLS.find((item) => item.name === toolCall.name);
  if (!tool?.evaluateToolCallPolicy) {
    return evaluation;
  }

  const evaluatedPolicy = tool.evaluateToolCallPolicy(
    permissionDecisionToToolPolicy(basePermission),
    toolCall.arguments,
  );
  if (evaluatedPolicy === "disabled") {
    return { permission: "exclude", matchedPolicy };
  }

  return { permission: basePermission, matchedPolicy };
}
