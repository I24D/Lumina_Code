import type { HookServiceState } from "../hooks/HookService.js";
import type { HookEventName } from "../hooks/types.js";
import type { MCPTool } from "../services/types.js";
import type { Tool } from "../tools/types.js";
import type { Skill } from "../util/loadMarkdownSkills.js";

import type { LuminaPlugin, PluginOrigin } from "./types.js";

export function toolsPlugin(
  id: string,
  origin: PluginOrigin,
  tools: Tool[],
): LuminaPlugin {
  return {
    id,
    version: "1.0.0",
    origin,
    contributions: tools.map((tool) => ({
      id: `tool:${tool.name}`,
      kind: "tool" as const,
      origin,
      tool,
    })),
  };
}

export function skillsPlugin(skills: Skill[], gateway: Tool): LuminaPlugin {
  return {
    id: "skills:markdown",
    version: "1.0.0",
    origin: "skill",
    contributions: [
      {
        id: `tool:${gateway.name}`,
        kind: "tool" as const,
        origin: "skill" as const,
        tool: gateway,
      },
      ...skills.map((skill) => ({
        id: `skill:${skill.name}`,
        kind: "skill" as const,
        origin: "skill" as const,
        skill,
      })),
    ],
  };
}

export function mcpPlugin(
  tools: MCPTool[],
  convert: (tool: MCPTool) => Tool,
): LuminaPlugin {
  return toolsPlugin("mcp:connected", "mcp", tools.map(convert));
}

export function hooksPlugin(state: HookServiceState): LuminaPlugin {
  const contributions: NonNullable<LuminaPlugin["contributions"]> = [];
  if (state.disabled) {
    return {
      id: "hooks:configured",
      version: "1.0.0",
      origin: "hook",
      contributions,
    };
  }
  for (const [event, groups] of Object.entries(state.config)) {
    groups?.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        contributions.push({
          id: `hook:${event}:${groupIndex}:${handlerIndex}`,
          kind: "hook",
          origin: "hook",
          event: event as HookEventName,
          matcher: group.matcher,
          handler,
        });
      });
    });
  }
  return {
    id: "hooks:configured",
    version: "1.0.0",
    origin: "hook",
    contributions,
  };
}
