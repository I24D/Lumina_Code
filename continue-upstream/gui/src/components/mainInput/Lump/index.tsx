import { LumpToolbar } from "./LumpToolbar/LumpToolbar";
import { TodoList } from "./TodoList";

/**
 * Simplified toolbar component that only shows the toolbar without expansion
 */
export function Lump() {
  return (
    <div className="bg-input rounded-t-default border-command-border mx-1.5 border-l border-r border-t">
      {/* Renders nothing until the agent actually keeps a task list, so the
          strip above the input stays as compact as it was. */}
      <TodoList />
      <div className="xs:px-2 px-1 py-0.5">
        <LumpToolbar />
      </div>
    </div>
  );
}
