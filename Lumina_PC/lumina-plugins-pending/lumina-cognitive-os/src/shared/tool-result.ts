/**
 * tool-result.ts — Re-exports the agent tool helpers from the OpenClaw core
 * so every tool file in this extension imports from one short path instead
 * of the deep `../../../../src/agents/tools/common.js` relative one.
 */
export {
  jsonResult,
  ToolInputError,
  ToolAuthorizationError,
  textResult,
  payloadTextResult,
} from "../../../../src/agents/tools/common.js";
export type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
