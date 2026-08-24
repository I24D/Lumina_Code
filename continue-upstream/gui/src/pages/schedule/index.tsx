import {
  ArrowPathIcon,
  CalendarDaysIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from "core/scheduler/ScheduledTaskService";
import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { ScheduledTaskDialog } from "../../components/dialogs/ScheduledTaskDialog";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useNavigationListener } from "../../hooks/useNavigationListener";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { cn } from "../../util/cn";

function scheduleLabel(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "once")
    return `Una vez · ${new Date(schedule.at).toLocaleString()}`;
  if (schedule.kind === "daily") return `Cada día · ${schedule.time}`;
  if (schedule.kind === "weekly") {
    const names = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    return `${schedule.days.map((day) => names[day]).join(", ")} · ${schedule.time}`;
  }
  return `Cron · ${schedule.expression}`;
}

function runTone(status: ScheduledTaskRun["status"]) {
  if (status === "completed") return "text-green-300";
  if (status === "failed") return "text-red-300";
  if (status === "running") return "text-sky-300";
  return "text-amber-300";
}

export default function SchedulePage() {
  useNavigationListener();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>();

  const refresh = useCallback(async () => {
    const response = await ideMessenger.request("scheduler/list", undefined);
    if (response.status === "success") {
      setTasks(response.content.tasks);
      setRuns(response.content.runs);
      setError(undefined);
    } else {
      setError(response.error);
    }
    setLoading(false);
  }, [ideMessenger]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveTask = async (input: ScheduledTaskInput, id?: string) => {
    const response = id
      ? await ideMessenger.request("scheduler/update", { id, patch: input })
      : await ideMessenger.request("scheduler/create", input);
    if (response.status === "error") throw new Error(response.error);
    await refresh();
  };

  const openDialog = (task?: ScheduledTask) => {
    dispatch(
      setDialogMessage(
        <ScheduledTaskDialog
          task={task}
          onSubmit={(input) => saveTask(input, task?.id)}
        />,
      ),
    );
    dispatch(setShowDialog(true));
  };

  const toggleTask = async (task: ScheduledTask) => {
    const response = await ideMessenger.request("scheduler/update", {
      id: task.id,
      patch: { enabled: !task.enabled },
    });
    if (response.status === "error") setError(response.error);
    await refresh();
  };

  const runNow = async (id: string) => {
    const response = await ideMessenger.request("scheduler/runNow", { id });
    if (response.status === "error") setError(response.error);
    await refresh();
  };

  const removeTask = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    const response = await ideMessenger.request("scheduler/delete", { id });
    if (response.status === "error") setError(response.error);
    setConfirmDelete(undefined);
    await refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Trabajo programado"
        onTitleClick={() => navigate(-1)}
        showBorder
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h1 className="m-0 text-base">Automatizaciones</h1>
            <p className="m-0 mt-1 text-xs opacity-60">
              Persisten al recargar el host. Los horarios usan tu zona local.
            </p>
          </div>
          <div className="flex gap-1">
            <button
              aria-label="Actualizar"
              className="cursor-pointer rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent p-1.5"
              onClick={() => void refresh()}
            >
              <ArrowPathIcon
                className={cn("h-4 w-4", loading && "animate-spin")}
              />
            </button>
            <button
              className="flex cursor-pointer items-center gap-1 rounded border-0 bg-[color:var(--vscode-button-background)] px-2 py-1.5 text-[color:var(--vscode-button-foreground)]"
              onClick={() => openDialog()}
            >
              <PlusIcon className="h-4 w-4" /> Nueva
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded border border-solid border-red-500/40 p-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <article
              key={task.id}
              className={cn(
                "rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3",
                !task.enabled && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <CalendarDaysIcon className="h-4 w-4 flex-none text-sky-300" />
                    <strong className="truncate">{task.name}</strong>
                    {task.runAsGoal && (
                      <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                        META
                      </span>
                    )}
                  </div>
                  <p className="mb-0 mt-1 line-clamp-2 text-xs opacity-65">
                    {task.prompt}
                  </p>
                  <div className="mt-2 text-xs opacity-55">
                    {scheduleLabel(task.schedule)}
                  </div>
                  <div className="mt-1 text-xs opacity-55">
                    {task.nextRunAt
                      ? `Próxima: ${new Date(task.nextRunAt).toLocaleString()}`
                      : task.enabled
                        ? "Sin próxima ejecución"
                        : "Pausada"}
                  </div>
                  {task.lastError && (
                    <div className="mt-1 truncate text-xs text-red-300">
                      {task.lastError}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`Activar ${task.name}`}
                    checked={task.enabled}
                    onChange={() => void toggleTask(task)}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-1">
                <button
                  className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent px-2 py-1 text-xs"
                  onClick={() => void runNow(task.id)}
                >
                  <PlayIcon className="h-3.5 w-3.5" /> Ejecutar ahora
                </button>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent px-2 py-1 text-xs"
                  onClick={() => openDialog(task)}
                >
                  <PencilSquareIcon className="h-3.5 w-3.5" /> Editar
                </button>
                <button
                  className={cn(
                    "flex cursor-pointer items-center gap-1 rounded border border-solid px-2 py-1 text-xs",
                    confirmDelete === task.id
                      ? "border-red-500 bg-red-500/10 text-red-300"
                      : "border-[color:var(--vscode-button-border)] bg-transparent",
                  )}
                  onClick={() => void removeTask(task.id)}
                >
                  <TrashIcon className="h-3.5 w-3.5" />{" "}
                  {confirmDelete === task.id ? "Confirmar" : "Eliminar"}
                </button>
              </div>
            </article>
          ))}
          {!loading && tasks.length === 0 && (
            <div className="rounded-lg border border-dashed border-[color:var(--vscode-panel-border)] p-8 text-center">
              <CalendarDaysIcon className="mx-auto h-9 w-9 opacity-50" />
              <strong className="mt-2 block">No hay trabajo programado</strong>
              <p className="mb-0 mt-1 text-xs opacity-60">
                Crea una tarea diaria, semanal, única o con cron.
              </p>
            </div>
          )}
        </div>

        {runs.length > 0 && (
          <section className="mt-4">
            <h2 className="text-xs font-semibold uppercase opacity-60">
              Ejecuciones recientes
            </h2>
            <div className="flex flex-col gap-1">
              {runs.slice(0, 12).map((run) => {
                const task = tasks.find(
                  (candidate) => candidate.id === run.taskId,
                );
                return (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-2 rounded bg-white/5 p-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {task?.name ?? "Tarea eliminada"}
                    </span>
                    <span className={runTone(run.status)}>{run.status}</span>
                    <span className="opacity-50">
                      {new Date(run.scheduledFor).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
