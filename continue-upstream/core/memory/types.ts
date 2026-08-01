export type ExperienceOutcome = "success" | "failure" | "partial";

export type ExperienceRecord = {
  id: string;
  goal: string;
  summary: string;
  outcome: ExperienceOutcome;
  toolNames: string[];
  tags: string[];
  createdAt: string;
  error?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type ReflectionInsight = {
  id: string;
  title: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  tags: string[];
  sourceExperienceIds: string[];
  createdAt: string;
};

export type SkillCandidate = {
  name: string;
  description: string;
  markdown: string;
  sourceInsightIds: string[];
  createdAt: string;
};

export type VectorSearchResult<T> = {
  item: T;
  score: number;
};
