import { AgentDefinition } from "./types.js";

export const docsAgent: AgentDefinition = {
  name: "docs-expert",
  role: "Create and maintain project documentation.",
  capabilities: ["docs"],
  tools: ["read_file", "edit_existing_file", "create_new_file", "grep_search"],
};
