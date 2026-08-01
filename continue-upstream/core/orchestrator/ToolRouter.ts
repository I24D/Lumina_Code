import { ToolContext, ToolDescriptor, ToolRoute } from "./types.js";

function scoreTool(tool: ToolDescriptor, context: ToolContext): number {
  const haystack = `${context.goal} ${context.visibleText ?? ""} ${(context.tags ?? []).join(" ")}`.toLowerCase();
  let score = 0;

  for (const capability of tool.capabilities) {
    if (haystack.includes(capability.toLowerCase())) {
      score += 3;
    }
  }

  if (context.activeApp && tool.requiresForegroundApp?.includes(context.activeApp.toLowerCase())) {
    score += 2;
  }

  if (context.recentFailures?.includes(tool.name)) {
    score -= 4;
  }

  if (tool.risk === "low") {
    score += 1;
  } else if (tool.risk === "high") {
    score -= 1;
  }

  return score;
}

export class ToolRouter {
  constructor(private readonly tools: ToolDescriptor[]) {}

  route(context: ToolContext): ToolRoute | undefined {
    return this.tools
      .map((tool) => ({
        tool,
        score: scoreTool(tool, context),
        reason: `Matched ${tool.capabilities.join(", ")} for goal: ${context.goal}`,
      }))
      .filter((route) => route.score > 0)
      .sort((left, right) => right.score - left.score)[0];
  }
}
