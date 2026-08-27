import { MAX_STORED_EXPERIENCES } from "./MemoryPersistence.js";
import { ExperienceRecord } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ExperienceLogger {
  private readonly records: ExperienceRecord[] = [];

  constructor(private readonly maxRecords = MAX_STORED_EXPERIENCES) {}

  /**
   * Drops the oldest records past the cap and hands them back.
   *
   * The limit used to live only in `sanitizeMemorySnapshot`, so it applied when
   * the snapshot was read back and never while the process ran: a window left
   * open kept appending, and since every tool call rewrites the whole snapshot
   * synchronously, each one got slower than the last. Evicted records are
   * returned rather than discarded because the caller also has to drop them
   * from the vector index, which would otherwise keep matching entries that no
   * longer exist.
   */
  evictOverflow(): ExperienceRecord[] {
    if (this.records.length <= this.maxRecords) {
      return [];
    }
    return this.records.splice(0, this.records.length - this.maxRecords);
  }

  log(
    input: Omit<ExperienceRecord, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): ExperienceRecord {
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
      ? this.records.filter((record) =>
          record.tags.includes(options.tag!.toLowerCase()),
        )
      : this.records;
    return filtered.slice(-(options.limit ?? filtered.length));
  }

  count(): number {
    return this.records.length;
  }

  remove(id: string): boolean {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) return false;
    this.records.splice(index, 1);
    return true;
  }

  clear(): void {
    this.records.length = 0;
  }
}
