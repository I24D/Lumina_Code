import { AgentDefinition } from "./types.js";

export const codeAgent: AgentDefinition = {
  name: "code-expert",
  role: "Write, refactor, and verify project code in the workspace.",
  capabilities: ["code"],
  tools: ["read_file", "edit_existing_file", "create_new_file", "run_terminal_command", "view_diff"],
};
