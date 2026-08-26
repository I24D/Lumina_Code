import {
  ArchiveBoxArrowDownIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  CloudArrowDownIcon,
  ExclamationTriangleIcon,
  ComputerDesktopIcon,
  PowerIcon,
  ShieldCheckIcon,
  SignalIcon,
} from "@heroicons/react/24/outline";
import type {
  LuminaDoctorReport,
  LuminaRuntimeStatus,
  LuminaUpdateStatus,
} from "core/protocol/ideWebview";
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
  const [doctor, setDoctor] = useState<LuminaDoctorReport>();
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [update, setUpdate] = useState<LuminaUpdateStatus>();
  const [updateLoading, setUpdateLoading] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string>();

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

  const runDoctor = async () => {
    setDoctorLoading(true);
    setMaintenanceMessage(undefined);
    const response = await ideMessenger.request("lumina/doctor", undefined);
    if (response.status === "success") {
      setDoctor(response.content);
    } else {
      setMaintenanceMessage(response.error);
    }
    setDoctorLoading(false);
  };

  const createBackup = async () => {
    setBackupLoading(true);
    setMaintenanceMessage(undefined);
    const response = await ideMessenger.request(
      "lumina/backup/create",
      undefined,
    );
    if (response.status === "success" && !response.content.canceled) {
      setMaintenanceMessage(
        `Backup seguro creado: ${response.content.globalEntries ?? 0} entradas y ${response.content.workspaceFiles ?? 0} archivos del proyecto.`,
      );
      void ideMessenger.request("security/audit/record", {
        category: "system",
        action: "backup_created",
        actor: "user",
        outcome: "allowed",
        summary: "El usuario creó un backup seguro sin secretos ni auditoría.",
      });
    } else if (response.status === "error") {
      setMaintenanceMessage(response.error);
    }
    setBackupLoading(false);
  };

  const restoreBackup = async () => {
    setRestoreLoading(true);
    setMaintenanceMessage(undefined);
    const response = await ideMessenger.request(
      "lumina/backup/restore",
      undefined,
    );
    if (response.status === "success" && response.content.restored) {
      setMaintenanceMessage("Backup restaurado; recargando VS Code…");
      void ideMessenger.request("security/audit/record", {
        category: "system",
        action: "backup_restored",
        actor: "user",
        outcome: "allowed",
        summary: "El usuario confirmó restaurar un backup local.",
      });
    } else if (response.status === "error") {
      setMaintenanceMessage(response.error);
    }
    setRestoreLoading(false);
  };

  const checkUpdate = async () => {
    setUpdateLoading(true);
    setMaintenanceMessage(undefined);
    const response = await ideMessenger.request(
      "lumina/update/check",
      undefined,
    );
    if (response.status === "success") {
      setUpdate(response.content);
    } else {
      setMaintenanceMessage(response.error);
    }
    setUpdateLoading(false);
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

      <section className="bg-editor border-border mt-5 rounded-lg border border-solid p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <strong className="flex items-center gap-2 text-sm">
              <ShieldCheckIcon className="h-5 w-5 text-emerald-400" />
              Lumina Doctor
            </strong>
            <p className="text-description mt-1 text-xs">
              Comprueba UI, módulos nativos, Start Talk, almacenamiento y
              workers sin mostrar credenciales.
            </p>
          </div>
          <button
            type="button"
            data-testid="runtime-doctor"
            disabled={doctorLoading}
            onClick={() => void runDoctor()}
          >
            <ArrowPathIcon
              className={`h-4 w-4 ${doctorLoading ? "animate-spin" : ""}`}
            />
            {doctorLoading ? "Revisando…" : "Ejecutar Doctor"}
          </button>
        </div>
        {doctor ? (
          <div className="grid gap-2" aria-label="Resultado de Lumina Doctor">
            <div className="text-description text-xs">
              {doctor.counts.passed} correctas · {doctor.counts.warnings} avisos
              · {doctor.counts.failed} fallos
            </div>
            {doctor.checks.map((check) => (
              <article
                key={check.id}
                className="border-border flex items-start gap-2 rounded-md border border-solid p-3"
              >
                {check.status === "pass" ? (
                  <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <ExclamationTriangleIcon
                    className={`h-4 w-4 shrink-0 ${check.status === "fail" ? "text-red-400" : "text-amber-400"}`}
                  />
                )}
                <div className="min-w-0">
                  <strong className="block text-xs">{check.label}</strong>
                  <span className="text-description block text-xs">
                    {check.detail}
                  </span>
                  {check.remediation ? (
                    <span className="mt-1 block text-xs text-amber-300">
                      {check.remediation}
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="bg-editor border-border mt-4 rounded-lg border border-solid p-4">
        <strong className="flex items-center gap-2 text-sm">
          <ArchiveBoxArrowDownIcon className="h-5 w-5 text-emerald-400" />
          Backup y restauración
        </strong>
        <p className="text-description mt-1 text-xs">
          Exporta estado, memoria, tareas, reglas, skills y plugins. Excluye
          secretos y la auditoría; restaurar exige confirmación modal y recarga.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="runtime-backup"
            disabled={backupLoading}
            onClick={() => void createBackup()}
          >
            <ArchiveBoxArrowDownIcon className="h-4 w-4" />
            {backupLoading ? "Guardando…" : "Crear backup"}
          </button>
          <button
            type="button"
            disabled={restoreLoading}
            onClick={() => void restoreBackup()}
          >
            <CloudArrowDownIcon className="h-4 w-4" />
            {restoreLoading ? "Restaurando…" : "Restaurar backup"}
          </button>
        </div>
      </section>

      <section className="bg-editor border-border mt-4 rounded-lg border border-solid p-4">
        <strong className="text-sm">Actualizaciones verificables</strong>
        <p className="text-description mt-1 text-xs">
          Consulta la última release del repositorio oficial. Lumina nunca
          descarga ni instala código sin intervención del usuario.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="runtime-update-check"
            disabled={updateLoading}
            onClick={() => void checkUpdate()}
          >
            <ArrowPathIcon
              className={`h-4 w-4 ${updateLoading ? "animate-spin" : ""}`}
            />
            {updateLoading ? "Comprobando…" : "Buscar actualización"}
          </button>
          {update?.status === "available" && update.releaseUrl ? (
            <button
              type="button"
              onClick={() => ideMessenger.post("openUrl", update.releaseUrl!)}
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              Revisar release {update.latestVersion}
            </button>
          ) : null}
          {update ? (
            <span className="text-description text-xs">{update.message}</span>
          ) : null}
        </div>
      </section>

      {maintenanceMessage ? (
        <div className="lumina-settings-summary mt-4" role="status">
          {maintenanceMessage}
        </div>
      ) : null}
    </div>
  );
}
