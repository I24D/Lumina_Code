import { Type } from "typebox";
import type { HarnessRuntime } from "../../../../src/harness/core/HarnessRuntime.js";
import { checkGatewayRemoteBrainHealth } from "../../../../src/gateway/remote-brain.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";

export function createLuminaHarnessHealthTool(runtime: HarnessRuntime): AnyAgentTool {
  return {
    name: "lumina_harness_health",
    label: "Lumina Harness Health",
    description:
      "Reports the live Lumina Harness registry and Remote Brain connection without executing a task.",
    parameters: Type.Object({}),
    async execute() {
      const remoteBrain = await checkGatewayRemoteBrainHealth();
      const tools = runtime.toolRegistry.list().length;
      return jsonResult({
        ok: tools > 0,
        state: tools > 0 ? "connected" : "off",
        tools,
        tasks: runtime.taskStore.list().length,
        remoteBrain,
      });
    },
  };
}

export function createLuminaHarnessTaskTool(runtime: HarnessRuntime): AnyAgentTool {
  return {
    name: "lumina_harness_task",
    label: "Lumina Harness Task",
    description:
      "Runs a multi-step PC goal through Lumina Harness. Safety, execution, observation and verification remain inside the Harness.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 6000 }),
      source: Type.Optional(
        Type.Union([
          Type.Literal("voice"),
          Type.Literal("chat"),
          Type.Literal("ui"),
          Type.Literal("system"),
          Type.Literal("mcp"),
        ]),
      ),
      userId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      mode: Type.Optional(Type.Union([Type.Literal("simulate"), Type.Literal("production")])),
      maxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      brainProvider: Type.Optional(Type.String({ maxLength: 80 })),
      brainModel: Type.Optional(Type.String({ maxLength: 160 })),
      preferBrowser: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, raw) {
      const params = raw as {
        goal?: unknown;
        source?: unknown;
        userId?: unknown;
        mode?: "simulate" | "production";
        maxIterations?: number;
        brainProvider?: string;
        brainModel?: string;
        preferBrowser?: boolean;
      };
      const goal = String(params.goal ?? "").trim();
      if (!goal) throw new ToolInputError("goal is required");
      if (!runtime.toolRegistry.get("pc_operator.run")) {
        return jsonResult({
          ok: false,
          state: "off",
          error: "pc_operator.run is not registered in Lumina Harness",
        });
      }

      const source =
        params.source === "voice" ||
        params.source === "chat" ||
        params.source === "ui" ||
        params.source === "system" ||
        params.source === "mcp"
          ? params.source
          : "ui";
      const userId =
        String(params.userId ?? "").trim() ||
        String(process.env.LUMINA_CANONICAL_USER_ID ?? "").trim() ||
        "lumina-user:owner";
      const intent = runtime.receiveIntent({
        source,
        userText: goal,
        context: { userId, caller: "lumina-harness-task" },
      });
      const task = await runtime.runTask({
        intent,
        steps: [
          {
            id: "pc-operator-loop",
            description: `PC Operator Loop: ${goal}`,
            toolCall: {
              toolName: "pc_operator.run",
              proposedBy: "lumina-harness-task",
              input: {
                goal,
                ...(params.mode ? { mode: params.mode } : {}),
                ...(params.maxIterations ? { maxIterations: params.maxIterations } : {}),
                ...(params.brainProvider ? { brainProvider: params.brainProvider } : {}),
                ...(params.brainModel ? { brainModel: params.brainModel } : {}),
                ...(params.preferBrowser === true ? { preferBrowser: true } : {}),
              },
            },
          },
        ],
      });
      return jsonResult({
        ok: task.status === "completed",
        state: task.status,
        task,
        userId,
      });
    },
  };
}
