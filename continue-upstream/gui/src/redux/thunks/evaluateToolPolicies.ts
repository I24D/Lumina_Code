import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool, ToolCallState } from "core";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { isEditTool } from "../../util/toolCallState";
import { errorToolCall, updateToolCallOutput } from "../slices/sessionSlice";
import { DEFAULT_TOOL_SETTING, ToolPolicies } from "../slices/uiSlice";
import { AppThunkDispatch } from "../store";

interface EvaluatedPolicy {
  policy: ToolPolicy;
  displayValue?: string;
  toolCallState: ToolCallState;
}

function getLuminaBasePolicy(
  toolPolicies: ToolPolicies,
  activeTools: Tool[],
  toolName: string,
): ToolPolicy {
  const explicitPolicy = toolPolicies[toolName];
  if (explicitPolicy) {
    return explicitPolicy;
  }

  const defaultPolicy = activeTools.find(
    (tool) => tool.function.name === toolName,
  )?.defaultToolPolicy;

  if (defaultPolicy === "disabled") {
    return "disabled";
  }

  return DEFAULT_TOOL_SETTING;
}

/**
 * Evaluates the tool policy for a tool call, including dynamic policy evaluation
 * Note that tool group policies are not considered here because activeTools already excludes disabled groups
 */
async function evaluateToolPolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
  fullAccess: boolean,
): Promise<EvaluatedPolicy> {
  // allow edit tool calls without permission
  if (isEditTool(toolCallState.toolCall.function.name)) {
    return { policy: "allowedWithoutPermission", toolCallState };
  }

  const toolName = toolCallState.toolCall.function.name;
  const basePolicy = getLuminaBasePolicy(toolPolicies, activeTools, toolName);
  const result = await ideMessenger.request("tools/evaluatePolicy", {
    toolName,
    basePolicy,
    parsedArgs: toolCallState.parsedArgs,
    processedArgs: toolCallState.processedArgs,
  });

  // Evaluate the policy dynamically
  if (result.status === "error") {
    console.error(`Error evaluating tool policy for ${toolName}`, result.error);
    return { policy: "disabled", toolCallState };
  }

  const dynamicPolicy = result.content.policy;
  const displayValue = result.content.displayValue;

  // Ensure dynamic policy cannot be more lenient than base policy
  // Policy hierarchy (most restrictive to least): disabled > allowedWithPermission > allowedWithoutPermission
  if (basePolicy === "disabled") {
    return { policy: "disabled", displayValue, toolCallState }; // Cannot override disabled
  }
  if (dynamicPolicy === "disabled") {
    return { policy: "disabled", displayValue, toolCallState };
  }

  if (fullAccess) {
    return {
      policy: "allowedWithoutPermission",
      displayValue,
      toolCallState,
    };
  }

  if (
    basePolicy === "allowedWithPermission" &&
    dynamicPolicy === "allowedWithoutPermission"
  ) {
    return { policy: "allowedWithPermission", displayValue, toolCallState }; // Cannot make more lenient
  }

  return { policy: dynamicPolicy, displayValue, toolCallState };
}

/*
    1. Get arg-dependent tool policies from core
    2. Mark any disabled ones as errored
    3. Mark others as generated
*/
export async function evaluateToolPolicies(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  generatedToolCalls: ToolCallState[],
  toolPolicies: ToolPolicies,
  fullAccess: boolean,
): Promise<EvaluatedPolicy[]> {
  // Check if ALL tool calls are auto-approved using dynamic evaluation
  const policyResults = await Promise.all(
    generatedToolCalls.map((toolCallState) =>
      evaluateToolPolicy(
        ideMessenger,
        activeTools,
        toolCallState,
        toolPolicies,
        fullAccess,
      ),
    ),
  );

  const disabledResults = policyResults.filter(
    ({ policy }) => policy === "disabled",
  );

  for (const { displayValue, toolCallState } of disabledResults) {
    void ideMessenger
      .request("security/audit/record", {
        category: "tools",
        action: "policy_blocked",
        actor: "system",
        outcome: "blocked",
        summary: `La política bloqueó ${toolCallState.toolCall.function.name}.`,
        details: {
          tool: toolCallState.toolCall.function.name,
          toolCallId: toolCallState.toolCallId,
        },
      })
      .catch(() => undefined);
    dispatch(errorToolCall({ toolCallId: toolCallState.toolCallId }));

    // Use the displayValue from the policy evaluation, or fallback to function name
    const command = displayValue || toolCallState.toolCall.function.name;

    // Add error message explaining why it's disabled
    dispatch(
      updateToolCallOutput({
        toolCallId: toolCallState.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Security Policy Violation",
            description: "Command Disabled",
            content: `This command has been disabled by security policy:\n\n${command}\n\nThis command cannot be executed as it may pose a security risk.`,
            hidden: false,
          },
        ],
      }),
    );
  }

  return policyResults;
}
