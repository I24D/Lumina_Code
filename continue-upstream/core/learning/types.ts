export type RecordedAction = {
  id: string;
  type: "click" | "key" | "text" | "tool" | "window";
  target?: string;
  value?: string;
  app?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type LearnedPattern = {
  id: string;
  name: string;
  actions: RecordedAction[];
  confidence: number;
  createdAt: string;
};

export type GeneratedSkill = {
  name: string;
  markdown: string;
  patternId: string;
};
