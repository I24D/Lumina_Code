import type { HookEventName, HookHandler } from "../hooks/types.js";
import type { Tool } from "../tools/types.js";
import type { Skill } from "../util/loadMarkdownSkills.js";

export type PluginOrigin = "builtin" | "custom" | "hook" | "mcp" | "skill";

interface ContributionBase {
  id: string;
  pluginId: string;
  origin: PluginOrigin;
}

export interface ToolPluginContribution extends ContributionBase {
  kind: "tool";
  tool: Tool;
}

export interface SkillPluginContribution extends ContributionBase {
  kind: "skill";
  skill: Skill;
}

export interface HookPluginContribution extends ContributionBase {
  kind: "hook";
  event: HookEventName;
  matcher?: string;
  handler: HookHandler;
}

export type PluginContribution =
  | ToolPluginContribution
  | SkillPluginContribution
  | HookPluginContribution;

export type PluginContributionInput =
  PluginContribution extends infer Contribution
    ? Contribution extends PluginContribution
      ? Omit<Contribution, "pluginId">
      : never
    : never;

export interface PluginContext {
  register(contribution: PluginContributionInput): void;
}

export interface LuminaPlugin {
  id: string;
  version: string;
  origin: PluginOrigin;
  contributions?: PluginContributionInput[];
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginDiagnostic {
  pluginId: string;
  contributionId?: string;
  severity: "warning" | "error";
  message: string;
}
