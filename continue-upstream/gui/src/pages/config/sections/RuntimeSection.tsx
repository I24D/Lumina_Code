import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ComputerDesktopIcon,
  PowerIcon,
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
  const [restartArmed, setRestartArmed] = useState(false);
  const [restarting, setRestarting] = useState(false);

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

  const restart = async () => {
    if (!restartArmed) {
      setRestartArmed(true);
      return;
    }
    setRestartArmed(false);
    setRestarting(true);
    setError(undefined);
    await ideMessenger
      .request("security/audit/record", {
        category: "system",
        action: "runtime_restart_approved",
        actor: "user",
        outcome: "allowed",
        summary: "El usuario aprobó reiniciar el runtime administrado.",
      })
      .catch(() => undefined);
    const response = await ideMessenger.request(
      "lumina/runtimeRestart",
      undefined,
    );
    if (response.status === "success") {
      setRuntime(response.content);
    } else {
      setError(response.error);
    }
    setRestarting(false);
  };

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

      {runtime?.device && (
        <section className="bg-editor border-border mb-4 rounded-lg border border-solid p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ComputerDesktopIcon className="mt-0.5 h-5 w-5 text-emerald-400" />
              <div>
                <strong className="block text-sm">{runtime.device.name}</strong>
                <span className="text-description text-xs">
                  {runtime.device.platform} · {runtime.device.architecture} ·
                  transporte local
                </span>
              </div>
            </div>
            <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-400">
              Dispositivo local
            </span>
          </div>
          <div className="text-description mt-3 text-xs">
            Operaciones remotas: desactivadas. Lumina no abre un listener ni
            acepta workers externos sin un transporte de emparejamiento seguro.
          </div>
        </section>
      )}

      <div className="lumina-runtime-grid">
        {runtime?.components.map((component) => {
          const healthy = component.status === "connected";
          const optionalOffline =
            !component.required && component.status === "offline";
          const StateIcon = healthy
            ? CheckCircleIcon
            : optionalOffline
              ? SignalIcon
              : ExclamationTriangleIcon;
          return (
            <article
              key={component.name}
              data-state={optionalOffline ? "optional" : component.status}
            >
              <div className="lumina-runtime-card__heading">
                <StateIcon />
                <strong>{component.label}</strong>
              </div>
              <span>{optionalOffline ? "opcional" : component.status}</span>
              <small className="text-description">
                worker local ·{" "}
                {component.lastHeartbeatAt
                  ? `sondeo ${new Date(component.lastHeartbeatAt).toLocaleTimeString()}`
                  : "sin heartbeat"}
              </small>
              <code title={component.endpoint}>{component.endpoint}</code>
            </article>
          );
        })}
      </div>

      <div className="lumina-settings-actions">
        {runtime?.operations.restartManagedRuntime && (
          <button
            data-testid="runtime-restart"
            type="button"
            onClick={() => void restart()}
            onBlur={() => setRestartArmed(false)}
            disabled={restarting}
            className={restartArmed ? "!text-red-400" : ""}
          >
            <PowerIcon />
            {restarting
              ? "Reiniciando…"
              : restartArmed
                ? "Confirmar reinicio"
                : "Reiniciar workers administrados"}
          </button>
        )}
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
