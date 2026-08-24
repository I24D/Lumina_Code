import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  SignalIcon,
} from "@heroicons/react/24/outline";
import type { LuminaRuntimeStatus } from "core/protocol/ideWebview";
import { useCallback, useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

function stateLabel(state: LuminaRuntimeStatus["state"]) {
  if (state === "connected") return "Conectado";
  if (state === "degraded") return "Degradado";
  if (state === "offline") return "Sin conexión";
  return "Iniciando";
}

export function RuntimeSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [runtime, setRuntime] = useState<LuminaRuntimeStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    const response = await ideMessenger.request(
      "lumina/runtimeStatus",
      undefined,
    );
    if (response.status === "success") {
      setRuntime(response.content);
      setError(undefined);
    } else {
      setError(response.error);
    }
    setLoading(false);
  }, [ideMessenger]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="lumina-config-section">
      <ConfigHeader
        title="Runtime y diagnóstico"
        subtext="Estado real de los servicios que sostienen el chat, las herramientas y la automatización."
      />

      <div className="lumina-settings-summary">
        <div
          className="lumina-settings-summary__icon"
          data-state={runtime?.state ?? "starting"}
        >
          <SignalIcon />
        </div>
        <div>
          <strong>
            {runtime ? stateLabel(runtime.state) : "Comprobando…"}
          </strong>
          <span>
            {runtime?.managedByLuminaCode
              ? "Administrado por Lumina Code"
              : "Runtime externo o no administrado"}
          </span>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          <ArrowPathIcon className={loading ? "animate-spin" : ""} />
          Actualizar
        </button>
      </div>

      {error && <div className="lumina-settings-error">{error}</div>}

      <div className="lumina-runtime-grid">
        {runtime?.components.map((component) => {
          const healthy = component.status === "connected";
          const StateIcon = healthy ? CheckCircleIcon : ExclamationTriangleIcon;
          return (
            <article key={component.name} data-state={component.status}>
              <div className="lumina-runtime-card__heading">
                <StateIcon />
                <strong>{component.label}</strong>
              </div>
              <span>{component.status}</span>
              <code title={component.endpoint}>{component.endpoint}</code>
            </article>
          );
        })}
      </div>

      <div className="lumina-settings-actions">
        <button
          type="button"
          onClick={() => ideMessenger.post("toggleDevTools", undefined)}
        >
          <ArrowTopRightOnSquareIcon />
          Abrir registros y herramientas de diagnóstico
        </button>
        <p>
          Los registros permiten inspeccionar activación, modelos y conexiones
          sin exponer claves ni contenido privado en esta pantalla.
        </p>
      </div>
    </div>
  );
}
