import { ConsolidationService } from "./ConsolidationService.js";
import { ExperienceLogger } from "./ExperienceLogger.js";
import { ReflectionEngine } from "./ReflectionEngine.js";
import { VectorIndex } from "./VectorIndex.js";
import { ExperienceRecord, ReflectionInsight, SkillCandidate, VectorSearchResult } from "./types.js";

export class MemoryService {
  readonly experienceLogger = new ExperienceLogger();
  readonly reflectionEngine = new ReflectionEngine();
  readonly consolidationService = new ConsolidationService();
  readonly vectorIndex = new VectorIndex<ExperienceRecord>();

  private readonly insights: ReflectionInsight[] = [];
  private readonly skillCandidates: SkillCandidate[] = [];

  hydrate(records: ExperienceRecord[]): void {
    for (const record of records) {
      this.experienceLogger.log(record);
      this.vectorIndex.upsert({
        id: record.id,
        text: `${record.goal}\n${record.summary}\n${record.error ?? ""}\n${record.tags.join(" ")}`,
        item: record,
      });
    }
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

    const newSkillCandidates = this.consolidationService.consolidate(newInsights);
    this.skillCandidates.push(...newSkillCandidates);

    return { record, newInsights, newSkillCandidates };
  }

  searchExperiences(query: string, limit = 5): VectorSearchResult<ExperienceRecord>[] {
    return this.vectorIndex.search(query, { limit });
  }

  getInsights(): ReflectionInsight[] {
    return [...this.insights];
  }

  getSkillCandidates(): SkillCandidate[] {
    return [...this.skillCandidates];
  }
}
