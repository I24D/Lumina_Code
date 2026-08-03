/**
 * Lumina Memory — shared types.
 *
 * Three storage tiers (Phase 2):
 *   1. UserProfile  — slowly-changing facts ABOUT the user (preferences,
 *      role, projects, communication style). One JSON document with named
 *      slots. Versioned schema so future migrations are safe.
 *   2. FactStore    — append-only log of discrete memories ("Dal prefers
 *      X", "the proxy bug fix lives at line Y"). JSONL on disk; queryable
 *      via BM25 or an optional mem0 backend.
 *   3. Working memory is OWNED by the agent runtime (its context window).
 *      We do not duplicate it here.
 *
 * Privacy rule: nothing in this module ever leaves the local machine
 * unless the user explicitly configures a `mem0BaseUrl`.
 */

/** Schema versioning for the user profile JSON. Bump when the shape
 *  changes and provide a migration in `profile-store.ts::migrate`. */
export const USER_PROFILE_SCHEMA_VERSION = 1 as const;

export type UserProfile = {
  readonly schemaVersion: typeof USER_PROFILE_SCHEMA_VERSION;
  /** Display name the user wants Lumina to use. */
  readonly displayName: string | null;
  /** Role / job description in 1-2 short lines. */
  readonly role: string | null;
  /** Spoken language code (BCP-47), e.g. "es-MX". */
  readonly language: string | null;
  /** Free-form preferences keyed by short label.
   *  Examples: { tone: "directo", units: "metric", emoji: "minimal" }. */
  readonly preferences: Readonly<Record<string, string>>;
  /** Active projects. Each project is a short name + 1-line description. */
  readonly projects: ReadonlyArray<UserProject>;
  /** Free-form pinned facts the agent should "always know".
   *  Bounded length to keep the prompt budget sane. */
  readonly pinnedFacts: ReadonlyArray<string>;
  /** ISO timestamps for auditing. */
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
};

export type UserProject = {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
};

/** A single fact in the long-term store. */
export type StoredFact = {
  /** ULID-ish id: timestamp prefix + 6 random hex chars. Sortable. */
  readonly id: string;
  /** ISO timestamp when the fact was created. */
  readonly createdAtISO: string;
  /** The fact, in natural language. Capped at 2 KB. */
  readonly text: string;
  /** Optional source attribution: who/what produced the fact. */
  readonly source: string | null;
  /** Optional free-form tags for filtering ("project:lumina", "person:dal"). */
  readonly tags: ReadonlyArray<string>;
  /** Optional importance hint 1..5. The agent decides; we just store. */
  readonly importance: number;
};

export type RecallHit = {
  readonly fact: StoredFact;
  /** Score in [0, 1] — higher = more relevant. Scale is BACKEND-DEPENDENT,
   *  only meaningful for relative ranking within one query. */
  readonly score: number;
  /** Where the hit came from. */
  readonly source: "bm25" | "mem0";
};

export type RecallResult = {
  readonly hits: ReadonlyArray<RecallHit>;
  readonly backend: "bm25" | "mem0";
  /** Total facts scanned (BM25) or returned by mem0 before truncation. */
  readonly scanned: number;
};
