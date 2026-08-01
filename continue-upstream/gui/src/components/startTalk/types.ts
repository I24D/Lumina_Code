export type StartTalkStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "unsupported"
  | "error";

export type StartTalkThinkingLevel = "low" | "high";

export type StartTalkModelOption = {
  description: string;
  label: string;
  model: string;
};

export type StartTalkToolActivityStatus =
  | "running"
  | "waiting"
  | "done"
  | "error";

export type StartTalkToolActivity = {
  id: string;
  label: string;
  status: StartTalkToolActivityStatus;
  detail?: string;
};
