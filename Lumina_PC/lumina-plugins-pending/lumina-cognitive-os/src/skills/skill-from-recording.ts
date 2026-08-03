/**
 * skill-from-recording.ts — Convert a Recorder session into an
 * agentskills.io-compatible SKILL.md folder under c:/I24D_WhatsApp/skills/.
 *
 * Output layout:
 *
 *   c:/I24D_WhatsApp/skills/learned-<safeName>/
 *   ├── SKILL.md                  name + description + replay instructions
 *   ├── references/
 *   │   └── demo-summary.md       narrative summary of the recording
 *   ├── recording/                metadata.json + symlink/copy to original
 *   │   └── source.json           {sessionId, dir, eventCount, durationMs, ...}
 *   └── scripts/
 *       └── replay.json           {sessionId, strategy, mode}
 *
 * The agent then invokes the resulting skill via `lumina_skill_run`,
 * which returns the SKILL.md preamble; the agent reads it and follows
 * the instructions ("call lumina_replay_run with this sessionId").
 *
 * This is a SAFE, additive operation — it never modifies or deletes the
 * original recording.
 */
import fs from "node:fs";
import path from "node:path";
import type { RecorderStore, RecordingSummary, RecordingEvent } from "../recorder/recorder-store.js";

export type SkillFromRecordingParams = {
  readonly sessionId: string;
  readonly skillName: string;
  readonly description?: string;
  readonly strategy?: string;
  readonly mode?: "literal" | "abstracted";
  readonly skillsDir: string;
  readonly authorMetadata?: Record<string, string>;
};

export type SkillFromRecordingResult =
  | { ok: true; skillId: string; skillDir: string; skillFile: string }
  | { ok: false; error: string };

const SAFE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function buildSkillFromRecording(
  store: RecorderStore,
  params: SkillFromRecordingParams,
): SkillFromRecordingResult {
  const summary = store.summarize(params.sessionId);
  if (!summary) return { ok: false, error: `recording '${params.sessionId}' not found` };

  const rawSkillName = (params.skillName ?? "").trim();
  if (!rawSkillName) return { ok: false, error: "skillName is required" };

  const safeName = normalizeSkillName(rawSkillName);
  if (!safeName) return { ok: false, error: "skillName must contain lowercase letters/numbers/hyphens" };

  const skillId = `learned-${safeName}`.slice(0, 60);
  if (!SAFE_RE.test(skillId)) {
    return { ok: false, error: `derived skill id '${skillId}' is invalid` };
  }

  const skillDir = path.join(params.skillsDir, skillId);
  if (fs.existsSync(skillDir)) {
    return { ok: false, error: `skill '${skillId}' already exists at ${skillDir}` };
  }

  // Read a small sample of events to summarize.
  const sample = store.readEvents(params.sessionId, { limit: 200 });
  const narrative = buildNarrative(summary, sample);
  const description = (params.description ?? deriveDescription(summary, sample)).slice(0, 1024);

  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "recording"), { recursive: true });

  const skillMd = buildSkillMd({
    skillId,
    description,
    summary,
    narrative,
    strategy: params.strategy ?? "hybrid",
    mode: params.mode ?? "literal",
    extraMetadata: params.authorMetadata ?? {},
  });
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, skillMd, "utf8");

  fs.writeFileSync(
    path.join(skillDir, "references", "demo-summary.md"),
    narrative,
    "utf8",
  );
  fs.writeFileSync(
    path.join(skillDir, "scripts", "replay.json"),
    JSON.stringify(
      {
        sessionId: summary.sessionId,
        strategy: params.strategy ?? "hybrid",
        mode: params.mode ?? "literal",
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(skillDir, "recording", "source.json"),
    JSON.stringify(
      {
        sessionId: summary.sessionId,
        dir: summary.dir,
        eventCount: summary.eventCount,
        durationMs: summary.durationMs,
        startedAtISO: summary.startedAtISO,
        stoppedAtISO: summary.stoppedAtISO,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { ok: true, skillId, skillDir, skillFile };
}

function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 50);
}

function deriveDescription(summary: RecordingSummary, sample: RecordingEvent[]): string {
  const winTitles = new Set<string>();
  let clicks = 0;
  let keys = 0;
  for (const e of sample) {
    if (e.window?.title) winTitles.add(e.window.title);
    if (e.kind === "mouse.down") clicks++;
    if (e.kind === "key.down") keys++;
  }
  const apps = Array.from(winTitles).slice(0, 3).join(", ") || "the desktop";
  return (
    `Replay a recorded Lumina demo (${summary.eventCount} events, ` +
    `${Math.round((summary.durationMs ?? 0) / 1000)}s) covering ${apps}. ` +
    `${clicks} click(s) and ${keys} keypress(es). Use when the user asks to ` +
    `repeat this exact task or asks the assistant to "do that thing I taught you".`
  );
}

function buildNarrative(summary: RecordingSummary, sample: RecordingEvent[]): string {
  const lines: string[] = [
    `# Demo summary — ${summary.sessionId}`,
    "",
    `- **Recorded at**: ${summary.startedAtISO}`,
    `- **Duration**: ${Math.round((summary.durationMs ?? 0) / 1000)}s`,
    `- **Events**: ${summary.eventCount}`,
    `- **Screenshots**: ${summary.screenshotCount}`,
    `- **UIA snapshots**: ${summary.uiaSnapshotCount}`,
    "",
    "## First 20 events",
    "",
  ];
  for (const e of sample.slice(0, 20)) {
    const win = e.window?.title ? `[${e.window.title}]` : "";
    const detail =
      e.kind === "mouse.down" || e.kind === "mouse.up"
        ? `(${e.pos?.x},${e.pos?.y}) ${e.button ?? ""}`
        : e.kind.startsWith("key")
          ? `key=${e.key}`
          : e.kind === "mouse.scroll"
            ? `scroll dx=${e.dx} dy=${e.dy}`
            : "";
    lines.push(`- t+${e.atMs}ms ${e.kind} ${detail} ${win}`.trim());
  }
  if (sample.length > 20) lines.push(`- … and ${sample.length - 20} more`);
  return lines.join("\n") + "\n";
}

function buildSkillMd(params: {
  skillId: string;
  description: string;
  summary: RecordingSummary;
  narrative: string;
  strategy: string;
  mode: "literal" | "abstracted";
  extraMetadata: Record<string, string>;
}): string {
  const meta: Record<string, unknown> = {
    lumina: {
      type: "learned-skill",
      recordingId: params.summary.sessionId,
      recordingDir: params.summary.dir,
      demosCount: 1,
      strategy: params.strategy,
      mode: params.mode,
      experimental: true,
      ...params.extraMetadata,
    },
  };
  const frontmatter = [
    "---",
    `name: ${params.skillId}`,
    `description: ${escapeYamlValue(params.description)}`,
    `version: "1.0.0"`,
    `metadata: ${JSON.stringify(meta)}`,
    "---",
    "",
  ].join("\n");

  const body = [
    `# ${params.skillId}`,
    "",
    "This skill was learned by Lumina from a recorded demonstration.",
    "It is **experimental** — generalization is best-effort and may fail",
    "across resolution, theme, or app updates.",
    "",
    "## How to run me",
    "",
    "Call `lumina_replay_run` with the bundled `scripts/replay.json`:",
    "",
    "```",
    `lumina_replay_run({`,
    `  sessionId: "${params.summary.sessionId}",`,
    `  strategy: "${params.strategy}",`,
    `  mode: "simulate",   // start in simulate; if the dispatch plan looks right,`,
    `                       // re-call with mode: "production" and confirm: true`,
    `})`,
    "```",
    "",
    "## What this demo did",
    "",
    `See \`references/demo-summary.md\` for the recorded event timeline.`,
    "",
    "## Safety checklist (before production)",
    "",
    "- Confirm with the user that the current desktop state matches the",
    "  starting state of the recording (same app open, same monitor).",
    "- Run `lumina_replay_run` in `mode: \"simulate\"` first; share the",
    "  step plan with the user.",
    "- Production run pays attention to verification failures and aborts",
    "  on the first one — never bypass `verifyEachStep`.",
    "",
  ].join("\n");

  return frontmatter + body;
}

function escapeYamlValue(value: string): string {
  // Single-line description: escape leading/trailing spaces, embed safely.
  const cleaned = value.replace(/\r?\n/g, " ").trim();
  if (cleaned.includes('"') || cleaned.includes(":") || cleaned.includes("#")) {
    return `"${cleaned.replace(/"/g, '\\"')}"`;
  }
  return cleaned;
}
