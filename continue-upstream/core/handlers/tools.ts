import { fetchModels } from "../llm/fetchModels";
import { BuiltInToolNames } from "../tools/builtIn";
import { ContinueError, ContinueErrorReason } from "../util/errors";
import {
  isProcessBackgrounded,
  killTerminalProcess,
  markProcessAsBackgrounded,
} from "../util/processTerminalStates";
import { defineHandlers } from "./types.js";

export default defineHandlers("tools", (ctx) => {
  const { on } = ctx;

  on("tools/call", async ({ data: { toolCall } }) =>
    ctx.core.handleToolCall(toolCall),
  );

  on(
    "tools/evaluatePolicy",
    async ({ data: { toolName, basePolicy, parsedArgs, processedArgs } }) => {
      const { config } = await ctx.configHandler.loadConfig();
      if (!config) {
        throw new Error("Config not loaded");
      }

      const tool = config.tools.find((t) => t.function.name === toolName);
      if (!tool) {
        return { policy: basePolicy };
      }

      const action =
        typeof parsedArgs.action === "string" ? parsedArgs.action.trim() : "";
      const requiresExplicitApproval =
        processedArgs?.dryRun !== true &&
        parsedArgs.dryRun !== true &&
        ((toolName === BuiltInToolNames.LuminaWhatsApp &&
          (action === "reply" || action === "publish_status")) ||
          (toolName === BuiltInToolNames.LuminaPhoneLink &&
            action === "reply"));

      // Extract display value for specific tools
      let displayValue: string | undefined;
      if (toolName === "runTerminalCommand" && parsedArgs.command) {
        displayValue = parsedArgs.command as string;
      }

      if (tool.evaluateToolCallPolicy) {
        const evaluatedPolicy = tool.evaluateToolCallPolicy(
          basePolicy,
          parsedArgs,
          processedArgs,
        );
        return {
          policy: evaluatedPolicy,
          displayValue,
          requiresExplicitApproval,
        };
      }
      return { policy: basePolicy, displayValue, requiresExplicitApproval };
    },
  );

  on("tools/preprocessArgs", async ({ data: { toolName, args } }) => {
    const { config } = await ctx.configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const tool = config?.tools.find((t) => t.function.name === toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    try {
      const preprocessedArgs = await tool.preprocessArgs?.(args, {
        ide: ctx.ide,
      });
      return {
        preprocessedArgs,
      };
    } catch (e) {
      let errorReason =
        e instanceof ContinueError ? e.reason : ContinueErrorReason.Unknown;
      let errorMessage =
        e instanceof Error
          ? e.message
          : `Error preprocessing tool call args for ${toolName}\n${JSON.stringify(args)}`;
      return {
        preprocessedArgs: undefined,
        errorReason,
        errorMessage,
      };
    }
  });

  on("isItemTooBig", async ({ data: { item } }) => {
    return ctx.core.isItemTooBig(item);
  });

  // Process state handlers
  on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
    markProcessAsBackgrounded(toolCallId);
  });

  on("process/isBackgrounded", async ({ data: { toolCallId }, messageId }) => {
    const isBackgrounded = isProcessBackgrounded(toolCallId);
    return isBackgrounded; // Return true to indicate the message was handled successfully
  });

  on("process/killTerminalProcess", async ({ data: { toolCallId } }) => {
    await killTerminalProcess(toolCallId);
  });

  on("models/fetch", async (msg) => {
    try {
      return await fetchModels(
        msg.data.provider,
        msg.data.apiKey,
        msg.data.apiBase,
      );
    } catch (error: any) {
      void ctx.ide.showToast("error", error.message);
      return [];
    }
  });
});
