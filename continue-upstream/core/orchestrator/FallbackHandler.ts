import { ToolDescriptor } from "./types.js";

export class FallbackHandler {
  chooseFallback(failedToolName: string, tools: ToolDescriptor[]): ToolDescriptor | undefined {
    const failed = tools.find((tool) => tool.name === failedToolName);
    if (!failed) {
      return undefined;
    }

    return tools.find(
      (tool) =>
        tool.name !== failed.name &&
        tool.risk !== "high" &&
        tool.capabilities.some((capability) => failed.capabilities.includes(capability)),
    );
  }
}
