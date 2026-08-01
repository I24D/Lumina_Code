import { AgentDefinition } from "./types.js";

export const deploymentAgent: AgentDefinition = {
  name: "deployment-expert",
  role: "Prepare release, deployment, and packaging workflows.",
  capabilities: ["deployment"],
  tools: ["run_terminal_command", "read_file", "grep_search"],
};
