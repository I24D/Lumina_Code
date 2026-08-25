import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

/**
 * manage_skills — curation for procedural memory.
 *
 * Ported from Hermes's skill manager, minus deletion. Archiving already
 * achieves "stop offering me this" while leaving the file on disk, and a tool
 * that can silently erase work the user wrote by hand is a poor trade for the
 * small convenience of skipping a trip to the editor.
 */
export const manageSkillsTool: Tool = {
  type: "function",
  displayTitle: "Manage Skills",
  wouldLikeTo: "review Lumina's skills",
  isCurrently: "reviewing Lumina's skills",
  hasAlready: "reviewed Lumina's skills",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.ManageSkills,
    description: `Inspect and curate Lumina's learned skills (procedural memory). Use "list" to see every skill with how often it has actually been used and whether it has gone stale. Archive skills that are no longer relevant so they stop taking up room in the skill index; pin the ones that must never be flagged stale even during quiet stretches.

Archiving never deletes a SKILL.md — read_skill can still open an archived skill by name, and using it again un-archives it automatically.`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          description:
            "list | archive | unarchive | pin | unpin. Everything except 'list' requires skillName.",
        },
        skillName: {
          type: "string",
          description:
            "The skill to act on, matching the name shown by read_skill.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To review which skills exist and how much they are used, call the ${BuiltInToolNames.ManageSkills} tool. For example:`,
    exampleArgs: [["action", "list"]],
  },
  toolCallIcon: "AcademicCapIcon",
};
