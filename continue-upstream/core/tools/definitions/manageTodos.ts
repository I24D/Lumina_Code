import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

/**
 * manage_todos — the agent's working task list.
 *
 * Ported from Hermes's todo tool: one call both reads and writes, because the
 * model almost always wants the current state right after changing it, and two
 * tools would cost an extra round trip on every update.
 */
export const manageTodosTool: Tool = {
  type: "function",
  displayTitle: "Task List",
  wouldLikeTo: "update the task list",
  isCurrently: "updating the task list",
  hasAlready: "updated the task list",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.ManageTodos,
    description: `Keep a visible task list while working through anything multi-step. The user sees this list, so it is also how you show progress.

Call with no arguments to read the current list. Call with "todos" to write it.

Use it when a request needs several distinct steps: write the plan out first, mark exactly one item "in_progress" as you start it, and mark it "completed" the moment it is actually done — not in a batch at the end. Skip it for single-step requests; a one-item list is noise.

Order matters: the first item is the highest priority. Each item needs a stable "id" so you can update it later without resending the whole list.`,
    parameters: {
      type: "object",
      required: [],
      properties: {
        todos: {
          type: "array",
          description:
            "The task list to write. Omit to just read the current list.",
          items: {
            type: "object",
            required: ["id", "content", "status"],
            properties: {
              id: {
                type: "string",
                description:
                  "Stable identifier for this item, chosen by you (e.g. 'add-index').",
              },
              content: {
                type: "string",
                description: "What the step is, in one line.",
              },
              status: {
                type: "string",
                description:
                  "pending | in_progress | completed | cancelled. Keep at most one item in_progress.",
              },
            },
          },
        },
        mode: {
          type: "string",
          description:
            "replace (default — 'todos' is the whole new list) | merge (update items by id and append new ones, leaving the rest alone).",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To plan and show progress on a multi-step task, call the ${BuiltInToolNames.ManageTodos} tool. For example:`,
    exampleArgs: [
      [
        "todos",
        '[{"id":"read-config","content":"Read the current config","status":"in_progress"},{"id":"add-flag","content":"Add the new flag","status":"pending"}]',
      ],
    ],
  },
  toolCallIcon: "ClipboardDocumentListIcon",
};
