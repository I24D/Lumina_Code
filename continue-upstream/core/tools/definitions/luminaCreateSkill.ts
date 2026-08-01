import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

export const luminaCreateSkillTool: Tool = {
  type: "function",
  displayTitle: "Create Skill",
  wouldLikeTo: 'save a reusable skill "{{{ name }}}"',
  isCurrently: 'saving the skill "{{{ name }}}"',
  hasAlready: 'saved the skill "{{{ name }}}"',
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.CreateSkill,
    description:
      "Save a reusable SKILL so Lumina can recall it later with read_skill — this is how " +
      "Lumina LEARNS and grows with the user (procedural memory). Use it AFTER solving a " +
      "non-trivial, multi-step task to capture the exact repeatable procedure (steps, commands, " +
      "gotchas, file paths). The content should be a clear step-by-step guide someone (or Lumina) " +
      "could follow next time. Scope 'global' persists across all projects; 'workspace' stays in " +
      "this project's .continue/skills.",
    parameters: {
      type: "object",
      required: ["name", "description", "content"],
      properties: {
        name: {
          type: "string",
          description: "Short skill name (used to recall it with read_skill).",
        },
        description: {
          type: "string",
          description: "One line describing when to use this skill (shown in the skill list).",
        },
        content: {
          type: "string",
          description: "The step-by-step procedure in Markdown (the actual learned know-how).",
        },
        scope: {
          type: "string",
          description: "global (default, all projects) | workspace (this project only).",
        },
        overwrite: {
          type: "boolean",
          description: "Set true to replace an existing skill of the same name.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `After you finish a non-trivial multi-step task, capture it as a reusable skill by calling the ${BuiltInToolNames.CreateSkill} tool, so you can recall the procedure later with read_skill. For example:`,
    exampleArgs: [
      ["name", "Deploy to Render"],
      ["description", "Steps to deploy this service to Render and verify health"],
      ["content", "1. Push to main. 2. Render auto-builds. 3. Check /health returns 200. ..."],
    ],
  },
  toolCallIcon: "AcademicCapIcon",
};
