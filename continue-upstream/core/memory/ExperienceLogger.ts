import { ExperienceRecord } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ExperienceLogger {
  private readonly records: ExperienceRecord[] = [];

  log(input: Omit<ExperienceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): ExperienceRecord {
    const record: ExperienceRecord = {
      ...input,
      id: input.id ?? createId("exp"),
      createdAt: input.createdAt ?? new Date().toISOString(),
      toolNames: [...new Set(input.toolNames)],
      tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
    };
    this.records.push(record);
    return record;
  }

  list(options: { limit?: number; tag?: string } = {}): ExperienceRecord[] {
    const filtered = options.tag
      ? this.records.filter((record) => record.tags.includes(options.tag!.toLowerCase()))
      : this.records;
    return filtered.slice(-(options.limit ?? filtered.length));
  }

  count(): number {
    return this.records.length;
  }
}
