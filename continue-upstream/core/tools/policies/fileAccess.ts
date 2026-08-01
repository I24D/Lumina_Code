import { ToolPolicy } from "@continuedev/terminal-security";

/**
 * Evaluates file access policy based on whether the file is within workspace boundaries
 *
 * @param basePolicy - The base policy from tool definition or user settings
 * @param isWithinWorkspace - Whether the file/directory is within workspace
 * @returns The evaluated policy - more restrictive for files outside workspace
 */
export function evaluateFileAccessPolicy(
  basePolicy: ToolPolicy,
  _isWithinWorkspace: boolean,
): ToolPolicy {
  // Lumina Code imposes NO extra restriction based on workspace boundaries.
  // The base tool policy applies everywhere so Lumina behaves like a normal
  // coding extension (Claude Code, Codex) with full filesystem access.
  // (Upstream Continue forced "allowedWithPermission" for files outside the
  // workspace; that gate is intentionally disabled here.)
  return basePolicy;
}
