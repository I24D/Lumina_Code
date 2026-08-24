import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSchedule,
} from "core/scheduler/ScheduledTaskService";
import { FormEvent, useState } from "react";
import { useDispatch } from "react-redux";
import { Input, SecondaryButton } from "..";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";

function toLocalDateTime(value?: string) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface ScheduledTaskDialogProps {
  task?: ScheduledTask;
  onSubmit: (input: ScheduledTaskInput) => Promise<void>;
}

export function ScheduledTaskDialog({
  task,
  onSubmit,
}: ScheduledTaskDialogProps) {
  const dispatch = useDispatch();
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [kind, setKind] = useState<ScheduledTaskSchedule["kind"]>(
    task?.schedule.kind ?? "daily",
  );
  const [dateTime, setDateTime] = useState(
    toLocalDateTime(
      task?.schedule.kind === "once" ? task.schedule.at : undefined,
    ),
  );
  const [time, setTime] = useState(
    task?.schedule.kind === "daily" || task?.schedule.kind === "weekly"
      ? task.schedule.time
      : "09:00",
  );
  const [days, setDays] = useState<number[]>(
    task?.schedule.kind === "weekly" ? task.schedule.days : [1],
  );
  const [cron, setCron] = useState(
    task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * 1-5",
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [runAsGoal, setRunAsGoal] = useState(task?.runAsGoal ?? false);
  const [maxTurns, setMaxTurns] = useState(task?.maxTurns ?? 12);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  const buildSchedule = (): ScheduledTaskSchedule => {
    if (kind === "once") return { kind, at: new Date(dateTime).toISOString() };
    if (kind === "daily") return { kind, time };
    if (kind === "weekly") return { kind, time, days };
    return { kind, expression: cron.trim() };
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError("Completa el nombre y el prompt.");
      return;
    }
    if (kind === "weekly" && !days.length) {
      setError("Selecciona al menos un día.");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({
        name: name.trim(),
        prompt: prompt.trim(),
        enabled,
        schedule: buildSchedule(),
        runAsGoal,
        maxTurns: runAsGoal ? maxTurns : undefined,
      });
      close();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "No se pudo guardar la tarea.",
      );
      setSubmitting(false);
    }
  };

  const dayNames = ["D", "L", "M", "X", "J", "V", "S"];

  return (
    <div className="max-h-[80vh] overflow-y-auto px-2 pt-4 sm:px-4">
      <h1 className="mb-0">{task ? "Editar" : "Nueva"} tarea programada</h1>
      <p className="m-0 mt-2 text-xs text-stone-500">
        Al guardar, autorizas a Lumina a ejecutar este prompt en el horario
        indicado.
      </p>
      <form className="mt-3 flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1">
          <span>Nombre</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Revisar tests cada mañana"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Prompt</span>
          <textarea
            className="font-inherit min-h-24 resize-y rounded border border-solid border-[color:var(--vscode-input-border)] bg-[color:var(--vscode-input-background)] p-2 text-[color:var(--vscode-input-foreground)] outline-none focus:border-[color:var(--vscode-focusBorder)]"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ejecuta los tests, corrige fallos del proyecto y resume el resultado"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Frecuencia</span>
          <select
            className="rounded border border-solid border-[color:var(--vscode-dropdown-border)] bg-[color:var(--vscode-dropdown-background)] p-1.5 text-[color:var(--vscode-dropdown-foreground)]"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as ScheduledTaskSchedule["kind"])
            }
          >
            <option value="once">Una vez</option>
            <option value="daily">Diaria</option>
            <option value="weekly">Semanal</option>
            <option value="cron">Cron avanzado</option>
          </select>
        </label>

        {kind === "once" && (
          <Input
            aria-label="Fecha y hora"
            type="datetime-local"
            value={dateTime}
            onChange={(event) => setDateTime(event.target.value)}
          />
        )}
        {(kind === "daily" || kind === "weekly") && (
          <Input
            aria-label="Hora"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        )}
        {kind === "weekly" && (
          <div>
            <span className="text-xs">Días</span>
            <div className="mt-1 flex gap-1">
              {dayNames.map((label, day) => (
                <button
                  key={day}
                  aria-label={`Día ${day}`}
                  type="button"
                  className={cn(
                    "h-8 w-8 cursor-pointer rounded-full border border-solid",
                    days.includes(day)
                      ? "border-[color:var(--vscode-focusBorder)] bg-[color:var(--vscode-button-background)] text-[color:var(--vscode-button-foreground)]"
                      : "border-[color:var(--vscode-panel-border)] bg-transparent",
                  )}
                  onClick={() =>
                    setDays((current) =>
                      current.includes(day)
                        ? current.filter((value) => value !== day)
                        : [...current, day],
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {kind === "cron" && (
          <label className="flex flex-col gap-1">
            <span>Expresión cron (minuto hora día mes semana)</span>
            <Input
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder="0 9 * * 1-5"
            />
          </label>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Activada
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={runAsGoal}
            onChange={(event) => setRunAsGoal(event.target.checked)}
          />
          Ejecutar como meta hasta verificar el resultado
        </label>
        {runAsGoal && (
          <label className="flex flex-col gap-1">
            <span>Máximo de turnos</span>
            <Input
              type="number"
              min={1}
              max={50}
              value={maxTurns}
              onChange={(event) => setMaxTurns(Number(event.target.value))}
            />
          </label>
        )}
        {error && <p className="m-0 text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2 pb-3">
          <SecondaryButton type="button" onClick={close}>
            Cancelar
          </SecondaryButton>
          <SecondaryButton type="submit" disabled={submitting}>
            {submitting ? "Guardando…" : "Guardar"}
          </SecondaryButton>
        </div>
      </form>
    </div>
  );
}

// Kept local to avoid importing utility packages into the dialog bundle.
function cn(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}
