import fs from "node:fs";
import path from "node:path";

import type {
  ExperienceRecord,
  MemorySnapshot,
  MemoryTombstone,
  ReflectionInsight,
  SkillCandidate,
} from "./types.js";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isExperience(value: unknown): value is ExperienceRecord {
  const record = value as Partial<ExperienceRecord> | undefined;
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.goal === "string" &&
      typeof record.summary === "string" &&
      ["success", "failure", "partial"].includes(record.outcome ?? "") &&
      isStringArray(record.toolNames) &&
      isStringArray(record.tags) &&
      typeof record.createdAt === "string",
  );
}

function isInsight(value: unknown): value is ReflectionInsight {
  const insight = value as Partial<ReflectionInsight> | undefined;
  return Boolean(
    insight &&
      typeof insight.id === "string" &&
      typeof insight.title === "string" &&
      typeof insight.summary === "string" &&
      ["info", "warning", "critical"].includes(insight.severity ?? "") &&
      isStringArray(insight.tags) &&
      isStringArray(insight.sourceExperienceIds) &&
      typeof insight.createdAt === "string",
  );
}

function isSkillCandidate(value: unknown): value is SkillCandidate {
  const candidate = value as Partial<SkillCandidate> | undefined;
  return Boolean(
    candidate &&
      typeof candidate.name === "string" &&
      typeof candidate.description === "string" &&
      typeof candidate.markdown === "string" &&
      isStringArray(candidate.sourceInsightIds) &&
      typeof candidate.createdAt === "string",
  );
}

function isTombstone(value: unknown): value is MemoryTombstone {
  const tombstone = value as Partial<MemoryTombstone> | undefined;
  return Boolean(
    tombstone &&
      typeof tombstone.id === "string" &&
      typeof tombstone.deletedAt === "string",
  );
}

export function emptyMemorySnapshot(): MemorySnapshot {
  return {
    version: 1,
    experiences: [],
    insights: [],
    skillCandidates: [],
    tombstones: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export function sanitizeMemorySnapshot(value: unknown): MemorySnapshot {
  if (!value || typeof value !== "object") return emptyMemorySnapshot();
  const raw = value as Partial<MemorySnapshot>;
  return {
    version: 1,
    experiences: Array.isArray(raw.experiences)
      ? raw.experiences.filter(isExperience).slice(-2_000)
      : [],
    insights: Array.isArray(raw.insights)
      ? raw.insights.filter(isInsight).slice(-1_000)
      : [],
    skillCandidates: Array.isArray(raw.skillCandidates)
      ? raw.skillCandidates.filter(isSkillCandidate).slice(-1_000)
      : [],
    tombstones: Array.isArray(raw.tombstones)
      ? raw.tombstones.filter(isTombstone).slice(-5_000)
      : [],
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
  };
}

function newestBy<T>(
  left: T[],
  right: T[],
  key: (item: T) => string,
  timestamp: (item: T) => string,
  limit: number,
): T[] {
  const merged = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const id = key(item);
    const previous = merged.get(id);
    if (!previous || timestamp(item) >= timestamp(previous))
      merged.set(id, item);
  }
  return [...merged.values()]
    .sort((a, b) => timestamp(a).localeCompare(timestamp(b)))
    .slice(-limit);
}

export function mergeMemorySnapshots(
  local: MemorySnapshot,
  remote: MemorySnapshot,
): MemorySnapshot {
  const tombstones = newestBy(
    local.tombstones,
    remote.tombstones,
    (entry) => entry.id,
    (entry) => entry.deletedAt,
    5_000,
  );
  const deleted = new Map(
    tombstones.map((entry) => [entry.id, entry.deletedAt]),
  );
  const experiences = newestBy(
    local.experiences,
    remote.experiences,
    (record) => record.id,
    (record) => record.createdAt,
    2_000,
  ).filter(
    (record) =>
      !deleted.has(record.id) || deleted.get(record.id)! < record.createdAt,
  );
  const experienceIds = new Set(experiences.map((record) => record.id));
  const insights = newestBy(
    local.insights,
    remote.insights,
    (insight) => insight.id,
    (insight) => insight.createdAt,
    1_000,
  )
    .map((insight) => ({
      ...insight,
      sourceExperienceIds: insight.sourceExperienceIds.filter((id) =>
        experienceIds.has(id),
      ),
    }))
    .filter((insight) => insight.sourceExperienceIds.length > 0);
  const skillCandidates = newestBy(
    local.skillCandidates,
    remote.skillCandidates,
    (candidate) => `${candidate.name}\u0000${candidate.createdAt}`,
    (candidate) => candidate.createdAt,
    1_000,
  );
  return {
    version: 1,
    experiences,
    insights,
    skillCandidates,
    tombstones,
    updatedAt: [local.updatedAt, remote.updatedAt, new Date().toISOString()]
      .sort()
      .at(-1)!,
  };
}

export class MemoryPersistence {
  constructor(
    private readonly storagePath: string,
    private readonly legacyExperiencesPath?: string,
  ) {}

  load(): MemorySnapshot {
    try {
      if (fs.existsSync(this.storagePath)) {
        return sanitizeMemorySnapshot(
          JSON.parse(fs.readFileSync(this.storagePath, "utf8")),
        );
      }
      return this.loadLegacyExperiences();
    } catch {
      return emptyMemorySnapshot();
    }
  }

  save(snapshot: MemorySnapshot): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(temporaryPath, this.storagePath);
  }

  private loadLegacyExperiences(): MemorySnapshot {
    if (
      !this.legacyExperiencesPath ||
      !fs.existsSync(this.legacyExperiencesPath)
    ) {
      return emptyMemorySnapshot();
    }
    const experiences = fs
      .readFileSync(this.legacyExperiencesPath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isExperience(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .slice(-2_000);
    return { ...emptyMemorySnapshot(), experiences };
  }
}
