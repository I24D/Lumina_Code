import type {
  PermissionDecision,
  PermissionEvaluation,
  PermissionMode,
  ToolPermissionPolicy,
  ToolPermissionRequest,
  ToolPermissions,
} from "@continuedev/terminal-security";

import type { ToolCallPreview } from "../tools/types.js";

export type PermissionPolicy = PermissionDecision;
export type { PermissionMode, ToolPermissionPolicy, ToolPermissions };

export interface ToolCallRequest extends ToolPermissionRequest {
  preview?: ToolCallPreview[];
}

export interface PermissionCheckResult extends PermissionEvaluation {}
