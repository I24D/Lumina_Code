import {
  ArrowPathIcon,
  CpuChipIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { useMemo, useState } from "react";
import { useAppDispatch } from "../../../redux/hooks";
import { cancelStream } from "../../../redux/thunks/cancelStream";
import { parseSubagentMetadata } from "./subagentMetadata";

function getRuntimeApiUrl(): string | null {
  const runtimeWindow = window as typeof window & {
    __LUMINA_RUNTIME_API_URL__?: string;
  };
  const value = runtimeWindow.__LUMINA_RUNTIME_API_URL__;
  return value ? value.replace(/\/$/, "") : null;
}

export function SubagentSession({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const dispatch = useAppDispatch();
  const [controlState, setControlState] = useState<string | null>(null);
  const content = useMemo(
    () => toolCallState.output?.map((item) => item.content).join("\n") ?? "",
    [toolCallState.output],
  );
  const metadata = useMemo(() => parseSubagentMetadata(content), [content]);
  const agentName = toolCallState.parsedArgs?.subagent_name ?? "Subagent";
  const description =
    toolCallState.parsedArgs?.description ?? toolCallState.parsedArgs?.prompt;
  const status =
    metadata.status ??
    (toolCallState.status === "done"
      ? "completed"
      : toolCallState.status === "canceled"
        ? "canceled"
        : toolCallState.status === "errored"
          ? "failed"
          : "running");
  const runtimeApiUrl = getRuntimeApiUrl();
  const isActive = status === "running" || status === "queued";

  const invokeControl = async (action: "cancel" | "retry") => {
    if (runtimeApiUrl && metadata.sessionId) {
      setControlState(action === "cancel" ? "Canceling…" : "Retrying…");
      const response = await fetch(
        `${runtimeApiUrl}/api/v1/sessions/${encodeURIComponent(metadata.sessionId)}/${action}`,
        { method: "POST" },
      );
      setControlState(
        response.ok
          ? action === "cancel"
            ? "Cancellation requested"
            : "Retry queued"
          : "Control request failed",
      );
      return;
    }
    if (action === "cancel") {
      void dispatch(cancelStream());
    }
  };

  const statusClass =
    status === "completed"
      ? "text-success"
      : status === "failed"
        ? "text-error"
        : status === "canceled"
          ? "text-warning"
          : "text-description";

  return (
    <div className="border-border bg-editor mx-1 rounded-lg border p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <CpuChipIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{agentName}</span>
              <span className={statusClass}>{status}</span>
              {metadata.sessionId && (
                <code className="text-description">
                  {metadata.sessionId.slice(0, 8)}
                </code>
              )}
            </div>
            {description && (
              <div className="text-description mt-1 break-words">
                {description}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 gap-1">
          {isActive && (
            <button
              className="border-border hover:bg-list-active flex items-center gap-1 rounded border px-2 py-1"
              onClick={() => void invokeControl("cancel")}
              title="Cancel this delegated task"
            >
              <StopIcon className="h-3.5 w-3.5" />
              Stop
            </button>
          )}
          {!isActive && (
            <button
              className="border-border hover:bg-list-active flex items-center gap-1 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!runtimeApiUrl || !metadata.sessionId}
              onClick={() => void invokeControl("retry")}
              title={
                runtimeApiUrl
                  ? "Retry this delegated task"
                  : "Retry is available when connected to cn serve"
              }
            >
              <ArrowPathIcon className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
        </div>
      </div>

      {(metadata.output || metadata.error) && (
        <pre className="border-border mt-3 max-h-48 overflow-auto whitespace-pre-wrap border-t pt-3 font-sans">
          {metadata.error || metadata.output}
        </pre>
      )}
      {controlState && (
        <div className="text-description mt-2">{controlState}</div>
      )}
    </div>
  );
}
