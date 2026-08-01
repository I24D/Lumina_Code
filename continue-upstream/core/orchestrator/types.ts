export type ToolDescriptor = {
  name: string;
  description: string;
  capabilities: string[];
  requiresForegroundApp?: string[];
  risk: "low" | "medium" | "high";
};

export type ToolContext = {
  goal: string;
  activeApp?: string;
  visibleText?: string;
  recentFailures?: string[];
  tags?: string[];
};

export type ToolRoute = {
  tool: ToolDescriptor;
  score: number;
  reason: string;
};

export type ToolStep = {
  toolName: string;
  args: Record<string, unknown>;
  verify?: string;
};
