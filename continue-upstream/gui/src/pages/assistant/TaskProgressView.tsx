import { ListBulletIcon } from "@heroicons/react/24/outline";
import { AssistantTaskStep } from "./types";

export function TaskProgressView({ steps }: { steps: AssistantTaskStep[] }) {
  const complete = steps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
  const percent = steps.length === 0 ? 0 : Math.round((complete / steps.length) * 100);

  return (
    <section className="border-0 border-b border-solid border-[color:var(--vscode-panel-border)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[color:var(--vscode-descriptionForeground)]">
          <ListBulletIcon className="h-4 w-4" />
          Progress
        </div>
        <span className="text-xs text-[color:var(--vscode-descriptionForeground)]">{percent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-[color:var(--vscode-panel-border)]">
        <div className="h-full bg-[color:var(--vscode-progressBar-background)]" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {steps.map((step) => (
          <div key={step.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{step.title}</span>
            <span className="text-xs text-[color:var(--vscode-descriptionForeground)]">{step.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
