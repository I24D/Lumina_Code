import type { LuminaRuntimeStatus } from "core/protocol/ideWebview";
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { getLuminaAssetUrl } from "../util/luminaAssets";

export function useLuminaRuntimeStatus() {
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
      return "Iniciando servicios";
    }
    if (runtime.state === "connected") {
      return "Servicios listos";
    }
    if (runtime.state === "degraded") {
      return "Servicios parciales";
    }
    return "Servicios sin conexión";
  }, [runtime]);

  const runtimeTitle = useMemo(() => {
    if (!runtime) {
      return "Checking Lumina runtime";
    }
    return runtime.components
      .map(
        (component) =>
          `${component.label}: ${component.status}${component.required ? "" : " (opcional)"}`,
      )
      .join("\n");
  }, [runtime]);

  return { runtime, runtimeLabel, runtimeTitle };
}

export function LuminaWorkspaceSwitcher({
  leading,
  trailing,
  pageTitle,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  pageTitle?: string;
}) {
  const { runtime, runtimeLabel, runtimeTitle } = useLuminaRuntimeStatus();

  return (
    <header className="lumina-workspace-switcher">
      {leading}
      <div
        className="lumina-workspace-switcher__brand"
        aria-label="Lumina Code"
      >
        <img
          className="lumina-workspace-switcher__mark"
          src={window.luminaAvatarUrl || getLuminaAssetUrl("lumina-icon.png")}
          alt="Lumina Code mascot"
          draggable={false}
        />
        <span>{pageTitle || "Lumina Code"}</span>
      </div>

      <div
        className="lumina-workspace-switcher__runtime"
        data-state={runtime?.state ?? "starting"}
        title={runtimeTitle}
      >
        <span aria-hidden="true" />
        {runtimeLabel}
      </div>
      {trailing}
    </header>
  );
}
