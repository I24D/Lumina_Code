import type { LuminaRuntimeStatus } from "core/protocol/ideWebview";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

export function LuminaWorkspaceSwitcher() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [runtime, setRuntime] = useState<LuminaRuntimeStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const response = await ideMessenger.request(
        "lumina/runtimeStatus",
        undefined,
      );
      if (!disposed && response.status === "success") {
        setRuntime(response.content);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [ideMessenger]);

  const runtimeLabel = useMemo(() => {
    if (!runtime || runtime.state === "starting") {
      return "Runtime starting";
    }
    if (runtime.state === "connected") {
      return "Runtime connected";
    }
    if (runtime.state === "degraded") {
      return "Runtime degraded";
    }
    return "Runtime offline";
  }, [runtime]);

  const runtimeTitle = useMemo(() => {
    if (!runtime) {
      return "Checking Lumina runtime";
    }
    return runtime.components
      .map((component) => `${component.label}: ${component.status}`)
      .join("\n");
  }, [runtime]);

  return (
    <header className="lumina-workspace-switcher">
      <div
        className="lumina-workspace-switcher__brand"
        aria-label="Lumina Code"
      >
        <span className="lumina-workspace-switcher__mark">L</span>
        <span>Lumina Code</span>
      </div>

      <div
        className="lumina-workspace-switcher__runtime"
        data-state={runtime?.state ?? "starting"}
        title={runtimeTitle}
      >
        <span aria-hidden="true" />
        {runtimeLabel}
      </div>
    </header>
  );
}
