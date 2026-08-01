export type AgentCapability = "code" | "docs" | "testing" | "deployment" | "windows";

export type AgentDefinition = {
  name: string;
  role: string;
  capabilities: AgentCapability[];
  tools: string[];
  models?: string[];
};

export type AgentTask = {
  goal: string;
  capability: AgentCapability;
  context?: Record<string, unknown>;
};

export type AgentAssignment = {
  agent: AgentDefinition;
  reason: string;
};
