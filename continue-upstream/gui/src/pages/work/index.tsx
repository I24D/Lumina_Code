import {
  ArrowPathIcon,
  BeakerIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FlagIcon,
  PlusIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { BaseSessionMetadata } from "core";
import type { SessionGoal } from "core/goals/sessionGoal";
import type { TodoSnapshot } from "core/planner/types";
import type { VerificationRecipe } from "core/verify/types";
import {
  WORKBOARD_COLUMNS,
  type WorkboardCard,
  type WorkboardColumn,
  type WorkboardPriority,
  type WorkboardSnapshot,
} from "core/workboard/types";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

const EMPTY_WORKBOARD: WorkboardSnapshot = {
  cards: [],
  activity: [],
  counts: {
    backlog: 0,
    ready: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
  },
};

const EMPTY_TODOS: TodoSnapshot = {
  items: [],
  counts: { pending: 0, in_progress: 0, completed: 0, cancelled: 0 },
};

const COLUMN_LABELS: Record<WorkboardColumn, string> = {
  backlog: "Backlog",
  ready: "Lista",
  in_progress: "En curso",
  review: "Revisión",
  blocked: "Bloqueada",
  done: "Terminada",
};

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
  const [workboard, setWorkboard] =
    useState<WorkboardSnapshot>(EMPTY_WORKBOARD);
  const [todos, setTodos] = useState<TodoSnapshot>(EMPTY_TODOS);
  const [loading, setLoading] = useState(true);
  // Kept apart on purpose: the 3-second poll owns the first, user actions own
  // the second. When one variable held both, a poll landing right after a
  // failed "Añadir" wiped the only explanation the user was going to get.
  const [pollError, setPollError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const error = actionError ?? pollError;
  const [recipe, setRecipe] = useState<VerificationRecipe | undefined>();
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardPriority, setNewCardPriority] =
    useState<WorkboardPriority>("normal");
  const [mutatingCard, setMutatingCard] = useState<string>();

  // Kept out of the 3-second refresh below: this reads the project's manifests,
  // and they do not change while you watch the panel.
  useEffect(() => {
    let cancelled = false;
    void ideMessenger.request("verify/recipe", undefined).then((result) => {
      if (!cancelled && result.status === "success") {
        setRecipe(result.content);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);

  // A tick that starts while the previous one is still in flight only queues
  // more work behind it; on a slow core the six requests pile up indefinitely.
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) {
      return;
    }
    refreshing.current = true;
    try {
      const [
        runtimeResult,
        goalsResult,
        sessionsResult,
        tokensResult,
        workboardResult,
        todosResult,
      ] = await Promise.all([
        ideMessenger.request("lumina/assistantState", undefined),
        ideMessenger.request("goals/list", undefined),
        ideMessenger.request("history/list", { limit: 30 }),
        ideMessenger.request("stats/getTokensPerDay", undefined),
        ideMessenger.request("workboard/get", undefined),
        ideMessenger.request("todos/list", undefined),
      ]);
      if (runtimeResult.status === "success") setRuntime(runtimeResult.content);
      if (goalsResult.status === "success") setGoals(goalsResult.content);
      if (sessionsResult.status === "success")
        setSessions(sessionsResult.content);
      if (tokensResult.status === "success") setTokenDays(tokensResult.content);
      if (workboardResult.status === "success")
        setWorkboard(workboardResult.content);
      if (todosResult.status === "success") setTodos(todosResult.content);
      const failure = [
        runtimeResult,
        goalsResult,
        sessionsResult,
        tokensResult,
        workboardResult,
        todosResult,
      ].find((result) => result.status === "error");
      setPollError(failure?.status === "error" ? failure.error : undefined);
    } catch (cause) {
      setPollError(
        cause instanceof Error
          ? cause.message
          : "No se pudo actualizar el panel.",
      );
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [ideMessenger]);

  useEffect(() => {
    void refresh();

    // The webview is created with retainContextWhenHidden, so it keeps running
    // after the user switches to another panel. Polling on regardless meant six
    // IPC round-trips a second — several of them reading disk — for a screen
    // nobody was looking at. Coming back refreshes immediately, so returning to
    // the panel still shows current state rather than whatever was last drawn.
    const tick = () => {
      if (!document.hidden) {
        void refresh();
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        void refresh();
      }
    };

    const timer = window.setInterval(tick, 3000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
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

  const createCard = async () => {
    const title = newCardTitle.trim();
    if (!title) return;
    setMutatingCard("new");
    setActionError(undefined);
    try {
      const result = await ideMessenger.request("workboard/create", {
        title,
        priority: newCardPriority,
        column: "backlog",
        sessionId: currentSession.id,
      });
      if (result.status === "error") throw new Error(result.error);
      setNewCardTitle("");
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingCard(undefined);
    }
  };

  const moveCard = async (card: WorkboardCard, column: WorkboardColumn) => {
    setMutatingCard(card.id);
    setActionError(undefined);
    try {
      const result = await ideMessenger.request("workboard/update", {
        id: card.id,
        patch: { column },
      });
      if (result.status === "error") throw new Error(result.error);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingCard(undefined);
    }
  };

  const deleteCard = async (card: WorkboardCard) => {
    setMutatingCard(card.id);
    setActionError(undefined);
    try {
      const result = await ideMessenger.request("workboard/delete", {
        id: card.id,
      });
      if (result.status === "error") throw new Error(result.error);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingCard(undefined);
    }
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
          <div
            role="alert"
            data-testid="work-error"
            className="mb-3 rounded border border-solid border-red-500/40 p-2 text-xs text-red-300"
          >
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

        <section
          className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3"
          data-testid="workboard"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
                Workboard persistente
              </h2>
              <p className="m-0 mt-1 text-xs opacity-50">
                Trabajo durable entre sesiones; el plan del agente sigue visible
                debajo.
              </p>
            </div>
            <span className="rounded-full bg-white/5 px-2 py-1 text-xs opacity-70">
              {workboard.cards.length} tarjetas
            </span>
          </div>

          <div className="mb-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            {WORKBOARD_COLUMNS.map((column) => (
              <div key={column} className="rounded bg-white/5 p-2 text-center">
                <div className="text-base font-semibold">
                  {workboard.counts[column]}
                </div>
                <div className="truncate text-[10px] opacity-55">
                  {COLUMN_LABELS[column]}
                </div>
              </div>
            ))}
          </div>

          <form
            className="mb-3 flex flex-wrap gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void createCard();
            }}
          >
            <input
              className="min-w-40 flex-1 rounded border border-solid border-[color:var(--vscode-input-border)] bg-[color:var(--vscode-input-background)] px-2 py-1.5 text-sm text-[color:var(--vscode-input-foreground)] outline-none"
              aria-label="Título de la nueva tarjeta"
              placeholder="Nueva tarea del workboard…"
              value={newCardTitle}
              onChange={(event) => setNewCardTitle(event.target.value)}
              maxLength={240}
            />
            <select
              aria-label="Prioridad de la nueva tarjeta"
              className="rounded border border-solid border-[color:var(--vscode-dropdown-border)] bg-[color:var(--vscode-dropdown-background)] px-2 text-xs text-[color:var(--vscode-dropdown-foreground)]"
              value={newCardPriority}
              onChange={(event) =>
                setNewCardPriority(event.target.value as WorkboardPriority)
              }
            >
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
            <button
              type="submit"
              disabled={!newCardTitle.trim() || mutatingCard === "new"}
              className="flex cursor-pointer items-center gap-1 rounded border-0 bg-[color:var(--vscode-button-background)] px-2.5 py-1.5 text-xs text-[color:var(--vscode-button-foreground)] disabled:cursor-default disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" /> Añadir
            </button>
          </form>

          {workboard.cards.length === 0 ? (
            <p className="m-0 rounded bg-white/5 p-3 text-xs opacity-60">
              No hay tarjetas. Añade la primera tarea sin perderla al cambiar de
              chat.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {workboard.cards.slice(0, 40).map((card) => (
                <article
                  key={card.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-solid border-[color:var(--vscode-panel-border)] bg-white/[0.025] p-2"
                >
                  <span
                    className={cn(
                      "h-2 w-2 flex-none rounded-full",
                      card.priority === "critical"
                        ? "bg-red-400"
                        : card.priority === "high"
                          ? "bg-amber-400"
                          : card.priority === "low"
                            ? "bg-slate-400"
                            : "bg-sky-400",
                    )}
                    title={`Prioridad ${card.priority}`}
                  />
                  <button
                    type="button"
                    className="min-w-28 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-[color:var(--vscode-foreground)]"
                    title={card.description || card.title}
                    onClick={() =>
                      card.sessionId
                        ? void openSession(card.sessionId)
                        : undefined
                    }
                  >
                    <span className="block truncate">{card.title}</span>
                    {(card.worktreePath || card.tags.length > 0) && (
                      <small className="block truncate opacity-45">
                        {[card.worktreePath, ...card.tags]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
                  </button>
                  <select
                    aria-label={`Estado de ${card.title}`}
                    disabled={mutatingCard === card.id}
                    className="rounded border border-solid border-[color:var(--vscode-dropdown-border)] bg-[color:var(--vscode-dropdown-background)] px-1.5 py-1 text-xs text-[color:var(--vscode-dropdown-foreground)]"
                    value={card.column}
                    onChange={(event) =>
                      void moveCard(card, event.target.value as WorkboardColumn)
                    }
                  >
                    {WORKBOARD_COLUMNS.map((column) => (
                      <option key={column} value={column}>
                        {COLUMN_LABELS[column]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Eliminar ${card.title}`}
                    disabled={mutatingCard === card.id}
                    className="cursor-pointer border-0 bg-transparent p-1 text-[color:var(--vscode-descriptionForeground)] hover:text-red-300 disabled:opacity-40"
                    onClick={() => void deleteCard(card)}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </article>
              ))}
            </div>
          )}

          {workboard.activity.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer opacity-65">
                Actividad reciente ({workboard.activity.length})
              </summary>
              <div className="mt-2 max-h-36 overflow-y-auto border-0 border-l border-solid border-[color:var(--vscode-panel-border)] pl-2">
                {workboard.activity.slice(0, 20).map((entry) => (
                  <div key={entry.id} className="mb-1.5 opacity-65">
                    {entry.summary}
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        <section className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
              Plan activo del agente
            </h2>
            <span className="text-xs opacity-55">
              {todos.counts.completed}/{todos.items.length}
            </span>
          </div>
          {todos.items.length === 0 ? (
            <p className="m-0 text-xs opacity-60">No hay un plan activo.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {todos.items.map((item) => (
                <div key={item.id} className="flex items-start gap-2 text-xs">
                  <span
                    className={cn(
                      "mt-1 h-2 w-2 flex-none rounded-full",
                      item.status === "completed"
                        ? "bg-green-400"
                        : item.status === "in_progress"
                          ? "bg-sky-400"
                          : item.status === "cancelled"
                            ? "bg-slate-500"
                            : "bg-amber-400",
                    )}
                  />
                  <span
                    className={
                      item.status === "cancelled"
                        ? "line-through opacity-50"
                        : ""
                    }
                  >
                    {item.content}
                  </span>
                </div>
              ))}
            </div>
          )}
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

        {recipe && (
          <section
            className="mb-3 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3"
            data-testid="work-project-recipe"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="m-0 text-xs font-semibold uppercase opacity-60">
                Proyecto
              </h2>
              <BeakerIcon className="h-4 w-4 opacity-60" />
            </div>
            <div className="font-semibold">{recipe.name}</div>
            <div className="mt-2 flex flex-col gap-1 text-xs">
              {[
                ["Instalar", recipe.bootstrap.join(" && ")],
                ["Compilar", recipe.build.join(" && ")],
                ["Probar", recipe.test.join(" && ")],
                ["Arrancar", recipe.start ?? ""],
              ]
                .filter(([, command]) => command !== "")
                .map(([label, command]) => (
                  <div key={label} className="flex gap-2">
                    <span className="w-16 flex-none opacity-60">{label}</span>
                    <code className="min-w-0 break-all">{command}</code>
                  </div>
                ))}
            </div>
            {/* Sin esto, una detección equivocada es indistinguible de una
                acertada y no hay forma de saber cuál es. */}
            <div className="mt-2 text-xs opacity-50">
              Detectado desde: {recipe.evidence.join(", ")}
            </div>
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
