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
  webSearch?: {
    query: string;
    provider?: string;
    answer?: string;
    sources: Array<{ title: string; url: string; snippet?: string }>;
    visibility: "payload" | "metadata-only";
  };
};

/** A model-proposed task that cannot run until the user approves it. */
export type StartTalkDelegationApproval = {
  id: string;
  task: string;
};
