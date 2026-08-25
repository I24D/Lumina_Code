import { ConsolidationService } from "./ConsolidationService.js";
import { ExperienceLogger } from "./ExperienceLogger.js";
import { ReflectionEngine } from "./ReflectionEngine.js";
import { VectorIndex } from "./VectorIndex.js";
import {
  ExperienceRecord,
  MemorySnapshot,
  MemoryTombstone,
  ReflectionInsight,
  SkillCandidate,
  VectorSearchResult,
} from "./types.js";

export class MemoryService {
  readonly experienceLogger = new ExperienceLogger();
  readonly reflectionEngine = new ReflectionEngine();
  readonly consolidationService = new ConsolidationService();
  readonly vectorIndex = new VectorIndex<ExperienceRecord>();

  private readonly insights: ReflectionInsight[] = [];
  private readonly skillCandidates: SkillCandidate[] = [];
  private readonly tombstones: MemoryTombstone[] = [];

  hydrate(
    records: ExperienceRecord[],
    insights: ReflectionInsight[] = [],
    skillCandidates: SkillCandidate[] = [],
    tombstones: MemoryTombstone[] = [],
  ): void {
    this.clear(false);
    const deleted = new Set(tombstones.map((entry) => entry.id));
    for (const record of records.filter((entry) => !deleted.has(entry.id))) {
      this.experienceLogger.log(record);
      this.vectorIndex.upsert({
        id: record.id,
        text: `${record.goal}\n${record.summary}\n${record.error ?? ""}\n${record.tags.join(" ")}`,
        item: record,
      });
    }
    this.insights.push(...insights);
    this.skillCandidates.push(...skillCandidates);
    this.tombstones.push(...tombstones);
  }

  logExperience(input: Omit<ExperienceRecord, "id" | "createdAt">): {
    record: ExperienceRecord;
    newInsights: ReflectionInsight[];
    newSkillCandidates: SkillCandidate[];
  } {
    const record = this.experienceLogger.log(input);
    this.vectorIndex.upsert({
      id: record.id,
      text: `${record.goal}\n${record.summary}\n${record.error ?? ""}\n${record.tags.join(" ")}`,
      item: record,
    });

    const shouldReflect =
      this.experienceLogger.count() % 5 === 0 ||
      record.outcome === "failure" ||
      record.tags.includes("critical");
    const newInsights = shouldReflect
      ? this.reflectionEngine.reflect(this.experienceLogger.list({ limit: 10 }))
      : [];
    this.insights.push(...newInsights);

    const newSkillCandidates =
      this.consolidationService.consolidate(newInsights);
    this.skillCandidates.push(...newSkillCandidates);

    return { record, newInsights, newSkillCandidates };
  }

  searchExperiences(
    query: string,
    limit = 5,
  ): VectorSearchResult<ExperienceRecord>[] {
    return this.vectorIndex.search(query, { limit });
  }

  getInsights(): ReflectionInsight[] {
    return [...this.insights];
  }

  getSkillCandidates(): SkillCandidate[] {
    return [...this.skillCandidates];
  }

  snapshot(): MemorySnapshot {
    const timestamps = [
      ...this.experienceLogger.list().map((record) => record.createdAt),
      ...this.insights.map((insight) => insight.createdAt),
      ...this.skillCandidates.map((candidate) => candidate.createdAt),
      ...this.tombstones.map((tombstone) => tombstone.deletedAt),
    ].sort();
    return {
      version: 1,
      experiences: this.experienceLogger.list(),
      insights: this.getInsights(),
      skillCandidates: this.getSkillCandidates(),
      tombstones: this.tombstones.map((entry) => ({ ...entry })),
      updatedAt: timestamps.at(-1) ?? new Date(0).toISOString(),
    };
  }

  replace(snapshot: MemorySnapshot): void {
    this.hydrate(
      snapshot.experiences,
      snapshot.insights,
      snapshot.skillCandidates,
      snapshot.tombstones,
    );
  }

  removeExperience(id: string, deletedAt = new Date().toISOString()): boolean {
    const removed = this.experienceLogger.remove(id);
    if (!removed) return false;
    this.vectorIndex.delete(id);
    const existing = this.tombstones.find((entry) => entry.id === id);
    if (existing) existing.deletedAt = deletedAt;
    else this.tombstones.push({ id, deletedAt });
    for (let index = this.insights.length - 1; index >= 0; index -= 1) {
      const insight = this.insights[index];
      insight.sourceExperienceIds = insight.sourceExperienceIds.filter(
        (sourceId) => sourceId !== id,
      );
      if (insight.sourceExperienceIds.length === 0)
        this.insights.splice(index, 1);
    }
    return true;
  }

  clear(createTombstones = true): void {
    if (createTombstones) {
      const deletedAt = new Date().toISOString();
      for (const record of this.experienceLogger.list()) {
        const existing = this.tombstones.find(
          (entry) => entry.id === record.id,
        );
        if (existing) existing.deletedAt = deletedAt;
        else this.tombstones.push({ id: record.id, deletedAt });
      }
    } else {
      this.tombstones.length = 0;
    }
    this.experienceLogger.clear();
    this.vectorIndex.clear();
    this.insights.length = 0;
    this.skillCandidates.length = 0;
  }
}
