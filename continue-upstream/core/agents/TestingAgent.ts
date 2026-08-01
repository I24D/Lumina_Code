import { AgentDefinition } from "./types.js";

export const testingAgent: AgentDefinition = {
  name: "testing-expert",
  role: "Run tests, interpret failures, and propose verification steps.",
  capabilities: ["testing"],
  tools: ["run_terminal_command", "read_file", "grep_search"],
};
