import { useEffect, useState } from "react";
import { lightGray, vscBackground, vscForeground } from ".";
import { useAppSelector } from "../redux/hooks";
import { LuminaEvent } from "../redux/slices/luminaSlice";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function shortToolName(name: unknown): string {
  return String(name ?? "")
    .replace(/^(automation_|lumina_)/, "")
    .slice(0, 42);
}

function eventLabel(entry: LuminaEvent): string {
  const { event, payload } = entry;

  if (event.startsWith("tool:")) {
    return `${event.replace("tool:", "tool ")} ${shortToolName(
      payload.toolName,
    )}`.trim();
  }

  if (event === "command:started" || event === "command:ended") {
    return `${event.replace("command:", "cmd ")} ${String(
      payload.command ?? "",
    ).slice(0, 60)}`.trim();
  }

  return event;
}

function eventDetail(entry: LuminaEvent): string | null {
  const { event, payload } = entry;

  if (event === "tool:end") {
    const result = payload.success ? "ok" : "fail";
    return `${result} ${Number(payload.durationMs ?? 0)}ms`;
  }

  if (event === "command:ended") {
    return `exit=${String(payload.exitCode ?? "")} ${Number(
      payload.durationMs ?? 0,
    )}ms`;
  }

  if (typeof payload.preview === "string" && payload.preview.trim()) {
    return payload.preview.slice(0, 160);
  }

  return null;
}

export function LuminaActivityFeed() {
  const events = useAppSelector((state) => state.lumina.recentEvents);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (isStreaming && events.length > 0) {
      setCollapsed(false);
    }
  }, [events.length, isStreaming]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        borderTop: `1px solid ${lightGray}33`,
        backgroundColor: vscBackground,
        maxHeight: collapsed ? 30 : 180,
        overflow: "hidden",
        transition: "max-height 0.2s ease",
        fontSize: 11,
        fontFamily: "var(--vscode-editor-font-family, monospace)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left"
        style={{ color: vscForeground, opacity: 0.75 }}
      >
        <span>{collapsed ? "+" : "-"}</span>
        <span>Actividad ({events.length})</span>
        {isStreaming && (
          <span className="font-semibold text-red-400">activo</span>
        )}
      </button>

      <div className="max-h-[150px] overflow-y-auto px-2.5 pb-1">
        {events.map((entry) => {
          const detail = eventDetail(entry);

          return (
            <div
              key={`${entry.timestamp}-${entry.event}`}
              className="flex gap-1.5 py-px"
              style={{
                color: vscForeground,
                opacity: entry.event === "tool:output" ? 0.65 : 0.85,
              }}
            >
              <span className="w-[58px] shrink-0 opacity-50">
                {formatTime(entry.timestamp)}
              </span>
              <span className="min-w-0 shrink truncate font-medium">
                {eventLabel(entry)}
              </span>
              {detail && (
                <span className="min-w-0 truncate opacity-60">{detail}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
