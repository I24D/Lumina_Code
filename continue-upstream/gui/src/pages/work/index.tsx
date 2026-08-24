import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FlagIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import type { BaseSessionMetadata } from "core";
import type { SessionGoal } from "core/goals/sessionGoal";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import AcceptRejectDiffButtons from "../../components/AcceptRejectDiffButtons";
import FileIcon from "../../components/FileIcon";
import { PageHeader } from "../../components/PageHeader";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useNavigationListener } from "../../hooks/useNavigationListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { loadSession } from "../../redux/thunks/session";
import { cn } from "../../util/cn";
import type { AssistantTaskStep } from "../assistant/types";

type RuntimeState = { steps: AssistantTaskStep[] };
type TokenDay = { day: string; promptTokens: number; generatedTokens: number };

function formatTokens(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(
    value,
  );
}

function taskTone(status: AssistantTaskStep["status"]) {
  if (status === "running") return "text-sky-300 bg-sky-500/10";
  if (status === "failed") return "text-red-300 bg-red-500/10";
  if (status === "succeeded") return "text-green-300 bg-green-500/10";
  return "text-[color:var(--vscode-descriptionForeground)] bg-white/5";
}

function goalLabel(goal: SessionGoal) {
  switch (goal.status) {
    case "active":
      return "Trabajando";
    case "completed":
      return "Completada";
    case "blocked":
      return "Bloqueada";
    case "limitReached":
      return "Límite alcanzado";
    case "cancelled":
      return "Cancelada";
  }
}

export default function WorkPanel() {
  useNavigationListener();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const sessionState = useAppSelector((state) => state.session);
  const currentSession = {
    id: sessionState.id,
    title: sessionState.title,
    isStreaming: sessionState.isStreaming,
    messages: sessionState.history.length,
    hasError: Boolean(sessionState.inlineErrorMessage),
  };
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const approvals = useMemo(
    () => applyStates.filter((state) => state.status === "done"),
    [applyStates],
  );
  const [runtime, setRuntime] = useState<RuntimeState>({ steps: [] });
  const [goals, setGoals] = useState<SessionGoal[]>([]);
  const [sessions, setSessions] = useState<BaseSessionMetadata[]>([]);
  const [tokenDays, setTokenDays] = useState<TokenDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [runtimeResult, goalsResult, sessionsResult, tokensResult] =
        await Promise.all([
          ideMessenger.request("lumina/assistantState", undefined),
          ideMessenger.request("goals/list", undefined),
          ideMessenger.request("history/list", { limit: 30 }),
          ideMessenger.request("stats/getTokensPerDay", undefined),
        ]);
      if (runtimeResult.status === "success") setRuntime(runtimeResult.content);
      if (goalsResult.status === "success") setGoals(goalsResult.content);
      if (sessionsResult.status === "success")
        setSessions(sessionsResult.content);
      if (tokensResult.status === "success") setTokenDays(tokensResult.content);
      const failure = [
        runtimeResult,
        goalsResult,
        sessionsResult,
        tokensResult,
      ].find((result) => result.status === "error");
      setError(failure?.status === "error" ? failure.error : undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo actualizar el panel.",
      );
    } finally {
      setLoading(false);
    }
  }, [ideMessenger]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeGoals = goals.filter((goal) => goal.status === "active");
  const runningTasks = runtime.steps.filter(
    (step) => step.status === "running",
  );
  const completedTasks = runtime.steps.filter(
    (step) => step.status === "succeeded",
  );
  const failedTasks = runtime.steps.filter((step) => step.status === "failed");
  const today = new Date().toISOString().slice(0, 10);
  const todayUsage = tokenDays.find((row) => row.day === today);
  const todayTokens =
    (todayUsage?.promptTokens ?? 0) + (todayUsage?.generatedTokens ?? 0);
  const currentGoal = goals.find(
    (goal) => goal.sessionId === currentSession.id,
  );
  const currentStatus = currentSession.hasError
    ? "Falló"
    : approvals.length
      ? "Espera aprobación"
      : currentSession.isStreaming || currentGoal?.status === "active"
        ? "Trabajando"
        : "Lista";

  const openSession = async (sessionId: string) => {
    await dispatch(
      loadSession({ sessionId, saveCurrentSession: true }),
    ).unwrap();
    navigate("/");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Panel de trabajo"
        onTitleClick={() => navigate(-1)}
        showBorder
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h1 className="m-0 text-base">Actividad de Lumina</h1>
            <p className="m-0 mt-1 text-xs opacity-60">
              Sesiones, metas, aprobaciones y consumo en un solo lugar.
            </p>
          </div>
          <button
            aria-label="Actualizar panel"
            className="cursor-pointer rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent p-1.5"
            onClick={() => void refresh()}
          >
            <ArrowPathIcon
              className={cn("h-4 w-4", loading && "animate-spin")}
            />
          </button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            {
              label: "Trabajando",
              value: runningTasks.length + activeGoals.length,
              icon: PlayCircleIcon,
              tone: "text-sky-300",
            },
            {
              label: "Aprobaciones",
              value: approvals.length,
              icon: ShieldCheckIcon,
              tone: "text-amber-300",
            },
            {
              label: "Completadas",
              value: completedTasks.length,
              icon: CheckCircleIcon,
              tone: "text-green-300",
            },
            {
              label: "Fallidas",
              value: failedTasks.length,
              icon: ExclamationTriangleIcon,
              tone: "text-red-300",
            },
          ].map(({ label, value, icon: Icon, tone }) => (
            <div
              key={label}
              className="rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs opacity-65">{label}</span>
                <Icon className={cn("h-4 w-4", tone)} />
              </div>
              <div className="mt-1 text-xl font-semibold">{value}</div>
            </div>
          ))}
        </div>

        {error && (
          <div className="mb-3 rounded border border-solid border-red-500/40 p-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <section className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase opacity-60">
                Sesión actual
              </div>
              <div className="mt-1 truncate font-semibold">
                {currentSession.title}
              </div>
              <div className="mt-1 text-xs opacity-60">
                {currentSession.messages} mensajes · {currentStatus}
              </div>
            </div>
            <span className="rounded-full bg-sky-500/10 px-2 py-1 text-xs text-sky-300">
              {currentStatus}
            </span>
          </div>
        </section>

        {approvals.length > 0 && (
          <section className="mb-3 rounded-lg border border-solid border-amber-500/40 bg-amber-500/5 p-3">
            <h2 className="m-0 mb-2 text-xs font-semibold uppercase text-amber-300">
              Esperan tu aprobación
            </h2>
            <div className="mb-2 flex flex-col gap-1.5">
              {approvals.map((state) => (
                <div
                  key={state.streamId}
                  className="flex items-center gap-2 text-sm"
                >
                  <FileIcon
                    filename={state.filepath ?? "archivo"}
                    height="18px"
                    width="18px"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {state.filepath ?? "Cambio pendiente"}
                  </span>
                  <span className="text-xs opacity-60">
                    {state.numDiffs ?? 0} diffs
                  </span>
                </div>
              ))}
            </div>
            <AcceptRejectDiffButtons
              applyStates={approvals}
              onAcceptOrReject={() => setTimeout(() => void refresh(), 150)}
            />
          </section>
        )}

        <section className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
              Metas de sesión
            </h2>
            <FlagIcon className="h-4 w-4 opacity-60" />
          </div>
          {goals.length === 0 ? (
            <p className="m-0 text-xs opacity-60">No hay metas registradas.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {goals.slice(0, 8).map((goal) => (
                <div key={goal.sessionId} className="rounded bg-white/5 p-2">
                  <div className="flex items-start justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1">{goal.text}</span>
                    <span className="whitespace-nowrap text-xs opacity-60">
                      {goalLabel(goal)}
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded bg-white/10">
                    <div
                      className="h-full bg-[color:var(--vscode-progressBar-background)]"
                      style={{
                        width: `${Math.min(100, (goal.turnsUsed / goal.maxTurns) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-xs opacity-50">
                    Turno {goal.turnsUsed} de {goal.maxTurns}
                    {goal.lastReason ? ` · ${goal.lastReason}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
              Tareas recientes
            </h2>
            <ClockIcon className="h-4 w-4 opacity-60" />
          </div>
          {runtime.steps.length === 0 ? (
            <p className="m-0 text-xs opacity-60">
              Aún no hay herramientas ejecutadas.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {runtime.steps.slice(0, 12).map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-2 rounded bg-white/5 p-2 text-sm"
                >
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] uppercase",
                      taskTone(step.status),
                    )}
                  >
                    {step.status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{step.title}</div>
                    {(step.error || step.detail) && (
                      <div className="truncate text-xs opacity-50">
                        {step.error ?? step.detail}
                      </div>
                    )}
                  </div>
                  {step.durationMs !== undefined && (
                    <span className="text-xs opacity-50">
                      {(step.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
            Uso de hoy
          </h2>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div>
              <div className="text-xl font-semibold">
                {formatTokens(todayTokens)}
              </div>
              <div className="text-xs opacity-60">tokens totales</div>
            </div>
            <div className="text-right text-xs opacity-60">
              <div>{formatTokens(todayUsage?.promptTokens ?? 0)} entrada</div>
              <div>{formatTokens(todayUsage?.generatedTokens ?? 0)} salida</div>
            </div>
          </div>
          <p className="m-0 mt-2 text-[11px] opacity-50">
            Coste: el proveedor Ollama Cloud/GLM no informa una tarifa
            verificable; Lumina no inventa una estimación.
          </p>
        </section>

        <section className="rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <h2 className="m-0 mb-2 text-xs font-semibold uppercase opacity-60">
            Sesiones recientes
          </h2>
          <div className="flex flex-col gap-1">
            {sessions
              .filter((session) => session.sessionId !== currentSession.id)
              .slice(0, 12)
              .map((session) => (
                <button
                  key={session.sessionId}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded border-0 bg-transparent p-2 text-left text-[color:var(--vscode-foreground)] hover:bg-white/5"
                  onClick={() => void openSession(session.sessionId)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {session.title}
                  </span>
                  <span className="text-xs opacity-50">Abrir</span>
                </button>
              ))}
            {sessions.length === 0 && (
              <p className="m-0 text-xs opacity-60">
                No hay sesiones guardadas.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
