import { BookOpenIcon } from "@heroicons/react/24/outline";
import { AssistantMemoryItem } from "./types";

export function MemoryView({ items }: { items: AssistantMemoryItem[] }) {
  return (
    <section className="border-0 border-b border-solid border-[color:var(--vscode-panel-border)] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[color:var(--vscode-descriptionForeground)]">
        <BookOpenIcon className="h-4 w-4" />
        Memory
      </div>
      <div className="flex flex-col gap-2">
        {items.length === 0 ? (
          <div className="text-sm text-[color:var(--vscode-descriptionForeground)]">No experiences logged.</div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded border border-[color:var(--vscode-panel-border)] p-2">
              <div className="flex items-center justify-between gap-2 text-sm font-medium">
                <span>{item.title}</span>
                {item.severity && (
                  <span className="text-xs text-[color:var(--vscode-descriptionForeground)]">{item.severity}</span>
                )}
              </div>
              <p className="m-0 mt-1 text-xs leading-5 text-[color:var(--vscode-descriptionForeground)]">
                {item.summary}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
