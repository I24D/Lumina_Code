import { CheckIcon } from "@heroicons/react/24/outline";
import type { TodoItem, TodoSnapshot } from "core/planner/types";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useContext, useEffect, useState } from "react";

import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";

function StatusMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <CheckIcon className="text-success h-3 w-3 flex-none" />;
  }
  if (status === "in_progress") {
    return (
      <span className="bg-accent h-1.5 w-1.5 flex-none rounded-full" />
    );
  }
  if (status === "cancelled") {
    return <span className="text-description-muted flex-none">–</span>;
  }
  return (
    <span className="border-description-muted h-1.5 w-1.5 flex-none rounded-full border border-solid" />
  );
}

/**
 * The agent's working task list, shown above the input while it works.
 *
 * Read from core rather than from the tool's rendered output: the tool result
 * is prose written for the model, and parsing it back out would break the
 * moment that wording changed.
 */
export function TodoList() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [snapshot, setSnapshot] = useState<TodoSnapshot | undefined>();

  const sessionId = useAppSelector((state) => state.session.id);

  // A string, so it compares by value and the effect only re-runs when a
  // manage_todos call actually appears or changes state. Watching the whole
  // history object would refetch on every streamed token.
  const todoCallSignal = useAppSelector((state) =>
    state.session.history
      .flatMap((item) => item.toolCallStates ?? [])
      .filter(
        (call) =>
          call.toolCall.function?.name === BuiltInToolNames.ManageTodos,
      )
      .map((call) => `${call.toolCallId}:${call.status}`)
      .join(","),
  );

  useEffect(() => {
    let cancelled = false;
    void ideMessenger.request("todos/list", undefined).then((result) => {
      if (!cancelled && result.status === "success") {
        setSnapshot(result.content);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, sessionId, todoCallSignal]);

  if (!snapshot || snapshot.items.length === 0) {
    return null;
  }

  const { completed, cancelled: cancelledCount } = snapshot.counts;
  const done = completed + cancelledCount;

  return (
    <div
      className="border-command-border flex flex-col gap-0.5 border-0 border-b border-solid px-1 pb-1 pt-0.5"
      data-testid="todo-list"
    >
      <div className="text-description-muted flex items-center justify-between text-xs">
        <span>Tasks</span>
        <span data-testid="todo-progress">
          {done}/{snapshot.items.length}
        </span>
      </div>
      {snapshot.items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-1.5 text-xs"
          data-testid={`todo-item-${item.id}`}
        >
          <StatusMark status={item.status} />
          <span
            className={
              item.status === "completed" || item.status === "cancelled"
                ? "text-description-muted line-through"
                : item.status === "in_progress"
                  ? "text-vscForeground"
                  : "text-description-muted"
            }
          >
            {item.content}
          </span>
        </div>
      ))}
    </div>
  );
}
