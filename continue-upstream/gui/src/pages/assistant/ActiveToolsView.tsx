import { WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import { AssistantToolState } from "./types";

const statusClass: Record<AssistantToolState["status"], string> = {
  ready: "bg-[color:var(--vscode-testing-iconPassed)]",
  running: "bg-[color:var(--vscode-progressBar-background)]",
  blocked: "bg-[color:var(--vscode-testing-iconFailed)]",
};

export function ActiveToolsView({ tools }: { tools: AssistantToolState[] }) {
  return (
    <section className="border-0 border-b border-solid border-[color:var(--vscode-panel-border)] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[color:var(--vscode-descriptionForeground)]">
        <WrenchScrewdriverIcon className="h-4 w-4" />
        Tools
      </div>
      <div className="grid grid-cols-1 gap-2">
        {tools.map((tool) => (
          <div key={tool.name} className="flex items-center justify-between gap-3 rounded border border-[color:var(--vscode-panel-border)] p-2">
            <div className="min-w-0">
              <div className="truncate text-sm">{tool.name}</div>
              {tool.detail && <div className="truncate text-xs text-[color:var(--vscode-descriptionForeground)]">{tool.detail}</div>}
            </div>
            <span className={`h-2.5 w-2.5 flex-none rounded-full ${statusClass[tool.status]}`} />
          </div>
        ))}
      </div>
    </section>
  );
}
