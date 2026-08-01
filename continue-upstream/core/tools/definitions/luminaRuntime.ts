import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

export const luminaRuntimeTool: Tool = {
  type: "function",
  displayTitle: "Lumina Runtime",
  wouldLikeTo: "use Lumina Runtime",
  isCurrently: "using Lumina Runtime",
  hasAlready: "used Lumina Runtime",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.LuminaRuntime,
    description:
      "Use Lumina's shared Core, Supabase memory and Harness. Use chat for Lumina Core reasoning, memory_recent/search for the shared user memory, health for all integration states, and harness_task for real PC/browser/app operations. harness_task is the preferred path for operational goals because it enforces Safety Gate, observation and verification.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["health", "chat", "harness_task", "memory_recent", "memory_search"],
        },
        message: { type: "string", description: "Chat message or Harness goal." },
        query: { type: "string", description: "Semantic memory query." },
        context: { type: "object", description: "Optional VS Code workspace context." },
        provider: { type: "string" },
        model: { type: "string" },
        mode: { type: "string", enum: ["simulate", "production"] },
        maxIterations: { type: "number", minimum: 1, maximum: 50 },
        preferBrowser: { type: "boolean" },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  systemMessageDescription: {
    prefix:
      "Use lumina_runtime to share identity and Supabase memory with Start Talk. Send operational desktop goals through harness_task; do not decompose them into direct mouse calls unless diagnosing the Bridge.",
    exampleArgs: [
      ["action", "health"],
    ],
  },
  toolCallIcon: "CloudIcon",
};
