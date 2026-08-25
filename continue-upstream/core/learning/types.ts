/**
 * Procedural memory: the types behind Lumina's skill learning loop.
 *
 * A skill is a SKILL.md file (see loadMarkdownSkills). On its own that is just
 * a document — it never tells us whether it earned its place in the prompt.
 * These records are the missing half: who authored the skill, how often the
 * agent actually reached for it, and whether it has gone cold.
 */

/**
 * Where a skill came from. This decides what the lifecycle is allowed to touch:
 * only what Lumina wrote for itself is fair game for automatic archiving.
 */
export type SkillProvenance =
  /** Written by the agent via create_skill after solving something. */
  | "agent"
  /** Authored by hand, or shipped with a project. Never auto-archived. */
  | "user";

export type SkillLifecycleState = "active" | "stale" | "archived";

/**
 * The persisted half of a skill's telemetry. `state` is deliberately absent:
 * staleness is a function of the clock, so storing it would mean a background
 * job and a field that is wrong between runs. Only archiving — a decision, not
 * an observation — is written down.
 */
export interface SkillUsageRecord {
  createdBy: SkillProvenance;
  createdAt: string;
  /** Bumped when read_skill pulls the body into context. */
  useCount: number;
  lastUsedAt?: string;
  /** Bumped when create_skill overwrites it — the skill improving itself. */
  patchCount: number;
  lastPatchedAt?: string;
  /** Opts the skill out of automatic staleness. */
  pinned: boolean;
  archivedAt?: string;
}

/** A usage record plus the fields derived from the current time. */
export interface SkillUsageView extends SkillUsageRecord {
  name: string;
  state: SkillLifecycleState;
  /** Newest of the activity timestamps, or createdAt if never touched. */
  lastActivityAt: string;
}

export type SkillLintSeverity = "error" | "warning";

/**
 * One lint finding. `error` blocks the write (the skill would not load, or
 * would load under a name nothing can recall); `warning` is advice handed back
 * to the agent so the next revision is better.
 */
export interface SkillLintFinding {
  severity: SkillLintSeverity;
  rule: string;
  message: string;
}
