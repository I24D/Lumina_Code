import { ContextItem } from "../..";
import { callLuminaRuntime, type LuminaRuntimeCallArgs } from "../../luminaBridge/runtimeClient.js";
import { ToolImpl } from ".";

export const luminaRuntimeImpl: ToolImpl = async (args, extras) => {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const allowed = new Set(["health", "chat", "harness_task", "memory_recent", "memory_search"]);
  if (!allowed.has(action)) {
    throw new Error(`Unsupported Lumina Runtime action: ${action || "<empty>"}`);
  }
  const data = await callLuminaRuntime(extras.fetch, {
    ...args,
    action,
  } as LuminaRuntimeCallArgs);
  return [
    {
      name: "Lumina Runtime",
      description: action,
      content: JSON.stringify(data, null, 2),
      status: "Lumina Runtime call completed",
    } satisfies ContextItem,
  ];
};
