import { ToolCallState } from "core";
import { describe, expect, it, vi } from "vitest";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { evaluateToolPolicies } from "./evaluateToolPolicies";

const terminalToolName = "runTerminalCommand";

function getToolCallState(command: string): ToolCallState {
  return {
    toolCallId: "tool-call-1",
    status: "generated",
    parsedArgs: { command },
    processedArgs: { command },
    toolCall: {
      id: "tool-call-1",
      type: "function",
      function: {
        name: terminalToolName,
        arguments: JSON.stringify({ command }),
      },
    },
  } as ToolCallState;
}

function getIdeMessenger(policy: string): IIdeMessenger {
  return {
    request: vi.fn().mockResolvedValue({
      status: "success",
      content: {
        policy,
        displayValue: "Remove-Item index.html",
      },
    }),
  } as unknown as IIdeMessenger;
}

describe("evaluateToolPolicies", () => {
  it("auto-approves permission-only tool calls when Full access is active", async () => {
    const policies = await evaluateToolPolicies(
      vi.fn() as any,
      getIdeMessenger("allowedWithPermission"),
      [
        {
          function: { name: terminalToolName },
          defaultToolPolicy: "allowedWithPermission",
        } as any,
      ],
      [getToolCallState('Remove-Item -Path "index.html"')],
      { [terminalToolName]: "allowedWithPermission" },
      true,
    );

    expect(policies[0].policy).toBe("allowedWithoutPermission");
  });

  it("does not override disabled policy when Full access is active", async () => {
    const dispatch = vi.fn();
    const policies = await evaluateToolPolicies(
      dispatch as any,
      getIdeMessenger("disabled"),
      [
        {
          function: { name: terminalToolName },
          defaultToolPolicy: "allowedWithPermission",
        } as any,
      ],
      [getToolCallState('Remove-Item -Path "index.html"')],
      { [terminalToolName]: "allowedWithPermission" },
      true,
    );

    expect(policies[0].policy).toBe("disabled");
    expect(dispatch).toHaveBeenCalled();
  });
});
