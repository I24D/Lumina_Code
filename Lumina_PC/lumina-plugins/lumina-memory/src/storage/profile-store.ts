/**
 * ProfileStore — read/write the single UserProfile document.
 *
 * - Stored at `<profileDir>/user-profile.json`.
 * - Writes are atomic: write to a `.tmp` file, then rename.
 * - Schema is versioned. Older versions are migrated lazily on read.
 * - The profile MUST never disappear; if the file is missing or corrupt
 *   we return a default and log a warning.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { USER_PROFILE_SCHEMA_VERSION, type UserProfile } from "../types.js";

const DEFAULT_PROFILE_DIR = join(homedir(), ".lumina", "profile");
const PROFILE_FILE = "user-profile.json";

function emptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    schemaVersion: USER_PROFILE_SCHEMA_VERSION,
    displayName: null,
    role: null,
    language: null,
    preferences: {},
    projects: [],
    pinnedFacts: [],
    createdAtISO: now,
    updatedAtISO: now,
  };
}

/** Lift an older profile up to the current schema. New migrations append
 *  a new `case`; the file becomes the single source of truth for the
 *  evolution of the document. */
function migrate(raw: unknown): UserProfile {
  if (typeof raw !== "object" || raw === null) return emptyProfile();
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  switch (v) {
    case USER_PROFILE_SCHEMA_VERSION:
      // Trust but verify: ensure required slots exist; coerce missing ones.
      return coerce(raw as Partial<UserProfile>);
    default:
      // Unknown future version OR very old version — keep what we can.
      return coerce(raw as Partial<UserProfile>);
  }
}

function coerce(partial: Partial<UserProfile>): UserProfile {
  const base = emptyProfile();
  return {
    schemaVersion: USER_PROFILE_SCHEMA_VERSION,
    displayName: typeof partial.displayName === "string" ? partial.displayName : base.displayName,
    role: typeof partial.role === "string" ? partial.role : base.role,
    language: typeof partial.language === "string" ? partial.language : base.language,
    preferences: isStringMap(partial.preferences) ? partial.preferences : base.preferences,
    projects: Array.isArray(partial.projects)
      ? partial.projects.filter(isValidProject)
      : base.projects,
    pinnedFacts: Array.isArray(partial.pinnedFacts)
      ? partial.pinnedFacts.filter((p): p is string => typeof p === "string").slice(0, 32)
      : base.pinnedFacts,
    createdAtISO: typeof partial.createdAtISO === "string" ? partial.createdAtISO : base.createdAtISO,
    updatedAtISO: new Date().toISOString(),
  };
}

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") return false;
  }
  return true;
}

function isValidProject(p: unknown): p is { name: string; description: string; active: boolean } {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as { name?: unknown }).name === "string" &&
    typeof (p as { description?: unknown }).description === "string" &&
    typeof (p as { active?: unknown }).active === "boolean"
  );
}

export type ProfileStoreOptions = {
  readonly profileDir?: string;
};

export class ProfileStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(opts: ProfileStoreOptions = {}) {
    this.dir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
    this.file = join(this.dir, PROFILE_FILE);
  }

  /** Returns the profile, creating an empty one if it doesn't exist. */
  read(): UserProfile {
    if (!existsSync(this.file)) {
      const fresh = emptyProfile();
      this.writeAtomic(fresh);
      return fresh;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return migrate(raw);
    } catch {
      // Corrupt file — DON'T overwrite without a backup.
      this.snapshotCorruption();
      return emptyProfile();
    }
  }

  /** Merge a partial update into the existing profile and persist atomically. */
  update(patch: Partial<UserProfile>): UserProfile {
    const current = this.read();
    // Disallow callers from changing schemaVersion / createdAtISO via patch.
    const next: UserProfile = {
      ...current,
      ...patch,
      schemaVersion: USER_PROFILE_SCHEMA_VERSION,
      createdAtISO: current.createdAtISO,
      preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
      projects: patch.projects ?? current.projects,
      pinnedFacts: patch.pinnedFacts ?? current.pinnedFacts,
      updatedAtISO: new Date().toISOString(),
    };
    this.writeAtomic(next);
    return next;
  }

  filePath(): string {
    return this.file;
  }

  // ─── internals ────────────────────────────────────────────────

  private writeAtomic(profile: UserProfile): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  private snapshotCorruption(): void {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(this.file, `${this.file}.corrupt-${ts}`);
    } catch {
      /* best-effort */
    }
  }
}
