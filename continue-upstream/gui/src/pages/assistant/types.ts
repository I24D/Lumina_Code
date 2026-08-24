export type AssistantMemoryItem = {
  id: string;
  title: string;
  summary: string;
  severity?: "info" | "warning" | "critical";
};

export type AssistantToolState = {
  name: string;
  status: "ready" | "running" | "blocked";
  detail?: string;
};

export type AssistantTaskStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  kind?: "tool" | "plan" | "agent";
  toolName?: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  detail?: string;
  error?: string;
};

export type AssistantSettingsState = {
  fullAccess: boolean;
  requireVerification: boolean;
  continuousVision: boolean;
};
