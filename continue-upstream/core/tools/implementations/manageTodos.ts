import { ToolImpl } from ".";
import { getTodoStore } from "../../planner/TodoStore";
import { TodoSnapshot, TodoWriteMode } from "../../planner/types";

const STATUS_LABEL: Record<string, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
  cancelled: "-",
};

function render(snapshot: TodoSnapshot): string {
  if (snapshot.items.length === 0) {
    return "The task list is empty.";
  }
  const lines = snapshot.items.map(
    (item) => `[${STATUS_LABEL[item.status] ?? "?"}] ${item.content}  (${item.id})`,
  );
  const { pending, in_progress, completed, cancelled } = snapshot.counts;
  const summary =
    `${completed} done, ${in_progress} in progress, ${pending} pending` +
    (cancelled > 0 ? `, ${cancelled} cancelled` : "");
  return `${lines.join("\n")}\n\n${summary}.`;
}

/**
 * manage_todos — read or write the working task list.
 *
 * Rejected entries are reported rather than swallowed. A todo the model
 * believes it wrote but that never landed is worse than an error: it plans
 * against a list that does not exist.
 */
export const manageTodosImpl: ToolImpl = async (args) => {
  const store = getTodoStore();

  if (args?.todos === undefined) {
    const snapshot = store.read();
    return [
      {
        name: "Task list",
        description: `${snapshot.items.length} item${snapshot.items.length === 1 ? "" : "s"}`,
        content: render(snapshot),
      },
    ];
  }

  const mode: TodoWriteMode =
    typeof args.mode === "string" && args.mode.trim().toLowerCase() === "merge"
      ? "merge"
      : "replace";

  const { snapshot, rejected } = store.write(args.todos, mode);

  const problems =
    rejected.length > 0
      ? `\n\nNot written (${rejected.length}):\n${rejected.map((entry) => `- ${entry}`).join("\n")}`
      : "";

  return [
    {
      name: "Task list updated",
      description: `${snapshot.counts.completed} of ${snapshot.items.length} done`,
      content: `${render(snapshot)}${problems}`,
    },
  ];
};
