import * as fs from "fs";
import * as path from "path";

import { getGlobalFolderWithName } from "../util/paths.js";

import {
  SkillLifecycleState,
  SkillProvenance,
  SkillUsageRecord,
  SkillUsageView,
} from "./types.js";

/**
 * A skill with no activity for this long is reported as stale. It keeps
 * working and keeps loading — "stale" is a signal for the user and for skill
 * ranking, never a deletion.
 */
export const STALE_AFTER_DAYS = 60;

const USAGE_FILE_NAME = ".usage.json";

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function asIsoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Rebuilds one record from whatever is on disk. The usage file is a cache of
 * observations, not a source of truth: a hand-edited or half-written entry
 * must degrade to sane defaults rather than propagate NaN into ranking.
 */
function coerceRecord(value: unknown): SkillUsageRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const createdBy: SkillProvenance =
    value.createdBy === "agent" ? "agent" : "user";
  return {
    createdBy,
    createdAt: asIsoOrUndefined(value.createdAt) ?? nowIso(),
    useCount: asCount(value.useCount),
    lastUsedAt: asIsoOrUndefined(value.lastUsedAt),
    patchCount: asCount(value.patchCount),
    lastPatchedAt: asIsoOrUndefined(value.lastPatchedAt),
    pinned: value.pinned === true,
    archivedAt: asIsoOrUndefined(value.archivedAt),
  };
}

function newRecord(createdBy: SkillProvenance): SkillUsageRecord {
  return {
    createdBy,
    createdAt: nowIso(),
    useCount: 0,
    patchCount: 0,
    pinned: false,
  };
}

function lastActivityAt(record: SkillUsageRecord): string {
  return [record.lastUsedAt, record.lastPatchedAt, record.createdAt]
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1)!;
}

function deriveState(
  record: SkillUsageRecord,
  now: number,
): SkillLifecycleState {
  if (record.archivedAt) {
    return "archived";
  }
  if (record.pinned || record.createdBy === "user") {
    return "active";
  }
  const idleMs = now - Date.parse(lastActivityAt(record));
  if (!Number.isFinite(idleMs)) {
    return "active";
  }
  return idleMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000 ? "stale" : "active";
}

/**
 * Tracks how skills are actually used, so procedural memory can be ranked and
 * curated instead of growing without bound.
 *
 * Every method here is best-effort by design. Telemetry sits directly on the
 * path of read_skill and create_skill, and a corrupt or unwritable usage file
 * must never be the reason a skill fails to load — a lost counter costs
 * nothing, a failed tool call costs the turn.
 */
export class SkillUsageStore {
  private readonly dir: string;

  constructor(dir: string = getGlobalFolderWithName("skills")) {
    this.dir = dir;
  }

  private get filePath(): string {
    return path.join(this.dir, USAGE_FILE_NAME);
  }

  /** Every record on disk, keyed by skill name. Never throws. */
  loadAll(): Record<string, SkillUsageRecord> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return {};
      }
      const records: Record<string, SkillUsageRecord> = {};
      for (const [name, value] of Object.entries(parsed)) {
        const record = coerceRecord(value);
        if (record) {
          records[name] = record;
        }
      }
      return records;
    } catch {
      // Missing file is the normal first-run case; anything else is a corrupt
      // cache we can rebuild from scratch.
      return {};
    }
  }

  /** Records with their clock-derived fields resolved. */
  viewAll(): SkillUsageView[] {
    const now = Date.now();
    return Object.entries(this.loadAll()).map(([name, record]) => ({
      ...record,
      name,
      state: deriveState(record, now),
      lastActivityAt: lastActivityAt(record),
    }));
  }

  get(name: string): SkillUsageView | undefined {
    return this.viewAll().find((view) => view.name === name);
  }

  /** Called when read_skill pulls a skill body into the conversation. */
  recordUse(name: string): void {
    this.mutate(name, "user", (record) => {
      record.useCount += 1;
      record.lastUsedAt = nowIso();
      // Reaching for a skill again is exactly the evidence that it should not
      // have been archived. Bring it back rather than making the user notice.
      delete record.archivedAt;
    });
  }

  /** Called when create_skill writes a brand-new skill. */
  recordCreate(name: string, createdBy: SkillProvenance): void {
    this.mutate(name, createdBy, (record) => {
      record.createdBy = createdBy;
      record.createdAt = nowIso();
    });
  }

  /** Called when create_skill overwrites a skill: the skill improving itself. */
  recordPatch(name: string): void {
    this.mutate(name, "agent", (record) => {
      record.patchCount += 1;
      record.lastPatchedAt = nowIso();
      delete record.archivedAt;
    });
  }

  /**
   * Hides a skill from the index the model reads, without touching its file.
   * Curation, not deletion: read_skill still finds it by name, and using it
   * again brings it back.
   */
  setArchived(name: string, archived: boolean): void {
    this.mutate(name, "user", (record) => {
      if (archived) {
        record.archivedAt = nowIso();
      } else {
        delete record.archivedAt;
      }
    });
  }

  /** Exempts a skill from going stale through disuse. */
  setPinned(name: string, pinned: boolean): void {
    this.mutate(name, "user", (record) => {
      record.pinned = pinned;
    });
  }

  /** Forgets a skill's telemetry, e.g. once its SKILL.md is gone. */
  forget(name: string): void {
    const records = this.loadAll();
    if (!(name in records)) {
      return;
    }
    delete records[name];
    this.write(records);
  }

  private mutate(
    name: string,
    fallbackProvenance: SkillProvenance,
    apply: (record: SkillUsageRecord) => void,
  ): void {
    try {
      const records = this.loadAll();
      const record = records[name] ?? newRecord(fallbackProvenance);
      apply(record);
      records[name] = record;
      this.write(records);
    } catch {
      // Telemetry is never worth failing a tool call over.
    }
  }

  private write(records: Record<string, SkillUsageRecord>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const serialized = JSON.stringify(records, null, 2);
      // Write-then-rename so a crash mid-write leaves the previous file intact
      // rather than a truncated one that loadAll would discard wholesale.
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, serialized, "utf8");
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch {
        // Some Windows setups (indexers, AV) can hold a transient lock on the
        // destination. A direct write still beats losing the update.
        fs.writeFileSync(this.filePath, serialized, "utf8");
        fs.rmSync(tempPath, { force: true });
      }
    } catch {
      // Best-effort: see the class comment.
    }
  }
}

/**
 * Shared instance for the tool implementations. Constructed lazily so that
 * simply importing this module never touches the filesystem.
 */
let sharedStore: SkillUsageStore | undefined;

export function getSkillUsageStore(): SkillUsageStore {
  if (!sharedStore) {
    sharedStore = new SkillUsageStore();
  }
  return sharedStore;
}
