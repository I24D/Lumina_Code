import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getContinueGlobalPath } from "../util/paths.js";

export type ScheduledTaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "cron"; expression: string };

export type ScheduledRunStatus = "queued" | "running" | "completed" | "failed";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  runAsGoal: boolean;
  maxTurns?: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: ScheduledRunStatus;
  lastError?: string;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  scheduledFor: string;
  status: ScheduledRunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  sessionId?: string;
  error?: string;
}

export type ScheduledTaskInput = Pick<
  ScheduledTask,
  "name" | "prompt" | "enabled" | "schedule" | "runAsGoal" | "maxTurns"
>;

type SchedulerStore = { tasks: ScheduledTask[]; runs: ScheduledTaskRun[] };

const MAX_PROMPT_LENGTH = 100_000;
const MAX_TIMER_MS = 2_147_000_000;
const RUN_STALE_MS = 30 * 60_000;

function parseTime(value: string): [number, number] {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error("La hora debe usar el formato HH:mm.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("La hora no es válida.");
  return [hour, minute];
}

function parseCronField(value: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!step) throw new Error("El intervalo cron no es válido.");
      for (let number = min; number <= max; number += step) result.add(number);
      continue;
    }
    if (part === "*") {
      for (let number = min; number <= max; number++) result.add(number);
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < min || end > max || start > end)
        throw new Error("El rango cron no es válido.");
      for (let number = start; number <= end; number++) result.add(number);
      continue;
    }
    const number = Number(part);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`El valor cron '${part}' está fuera de rango.`);
    }
    result.add(number);
  }
  return result;
}

function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Cron debe tener cinco campos: minuto hora día mes semana.",
    );
  }
  const [minute, hour, day, month, weekday] = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 6),
  ];
  const dayMatches = day.has(date.getDate());
  const weekdayMatches = weekday.has(date.getDay());
  const dayRestricted = parts[2] !== "*";
  const weekdayRestricted = parts[4] !== "*";
  const calendarDayMatches =
    dayRestricted && weekdayRestricted
      ? dayMatches || weekdayMatches
      : dayMatches && weekdayMatches;
  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    month.has(date.getMonth() + 1) &&
    calendarDayMatches
  );
}

export function computeNextRun(
  schedule: ScheduledTaskSchedule,
  from: Date,
): Date | undefined {
  if (schedule.kind === "once") {
    const result = new Date(schedule.at);
    if (Number.isNaN(result.getTime()))
      throw new Error("La fecha programada no es válida.");
    return result.getTime() > from.getTime() ? result : undefined;
  }

  if (schedule.kind === "daily") {
    const [hour, minute] = parseTime(schedule.time);
    const result = new Date(from);
    result.setSeconds(0, 0);
    result.setHours(hour, minute, 0, 0);
    if (result.getTime() <= from.getTime())
      result.setDate(result.getDate() + 1);
    return result;
  }

  if (schedule.kind === "weekly") {
    const [hour, minute] = parseTime(schedule.time);
    const days = new Set(schedule.days);
    if (
      !days.size ||
      [...days].some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      throw new Error("Selecciona al menos un día válido de la semana.");
    }
    for (let offset = 0; offset <= 7; offset++) {
      const result = new Date(from);
      result.setDate(result.getDate() + offset);
      result.setHours(hour, minute, 0, 0);
      if (days.has(result.getDay()) && result.getTime() > from.getTime())
        return result;
    }
    return undefined;
  }

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const maxChecks = 366 * 24 * 60;
  for (let index = 0; index < maxChecks; index++) {
    if (cronMatches(schedule.expression, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(
    "La expresión cron no produce una fecha durante el próximo año.",
  );
}

function validateInput(input: ScheduledTaskInput): ScheduledTaskInput {
  const name = input.name.trim().slice(0, 120);
  const prompt = input.prompt.trim();
  if (!name) throw new Error("La tarea necesita un nombre.");
  if (!prompt) throw new Error("La tarea necesita un prompt.");
  if (prompt.length > MAX_PROMPT_LENGTH)
    throw new Error("El prompt programado es demasiado largo.");
  // Validate syntax independently from whether a one-off date is already past.
  computeNextRun(input.schedule, new Date(0));
  return {
    ...input,
    name,
    prompt,
    maxTurns: input.runAsGoal
      ? Math.max(1, Math.min(50, Math.floor(input.maxTurns ?? 12)))
      : undefined,
  };
}

export class ScheduledTaskService {
  private store: SchedulerStore = { tasks: [], runs: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private readonly storagePath: string;
  private readonly now: () => Date;

  constructor(
    options: {
      storagePath?: string;
      now?: () => Date;
      startTimers?: boolean;
    } = {},
  ) {
    this.storagePath =
      options.storagePath ??
      path.join(getContinueGlobalPath(), "lumina-scheduled-tasks.json");
    this.now = options.now ?? (() => new Date());
    this.load();
    this.recoverInterruptedRuns();
    this.tick();
    if (options.startTimers !== false) this.armTimer();
  }

  list(): { tasks: ScheduledTask[]; runs: ScheduledTaskRun[] } {
    this.tick();
    return {
      tasks: [...this.store.tasks].sort((a, b) =>
        (a.nextRunAt ?? "z").localeCompare(b.nextRunAt ?? "z"),
      ),
      runs: [...this.store.runs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100),
    };
  }

  create(input: ScheduledTaskInput): ScheduledTask {
    const valid = validateInput(input);
    const now = this.now();
    const nextRun = valid.enabled
      ? computeNextRun(valid.schedule, now)
      : undefined;
    if (valid.enabled && !nextRun) {
      throw new Error("La fecha de una tarea única debe estar en el futuro.");
    }
    const task: ScheduledTask = {
      ...valid,
      id: uuidv4(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRun?.toISOString(),
    };
    this.store.tasks.push(task);
    this.persistAndArm();
    return task;
  }

  update(id: string, patch: Partial<ScheduledTaskInput>): ScheduledTask {
    const task = this.requireTask(id);
    const valid = validateInput({
      name: patch.name ?? task.name,
      prompt: patch.prompt ?? task.prompt,
      enabled: patch.enabled ?? task.enabled,
      schedule: patch.schedule ?? task.schedule,
      runAsGoal: patch.runAsGoal ?? task.runAsGoal,
      maxTurns: patch.maxTurns ?? task.maxTurns,
    });
    const now = this.now();
    const nextRun = valid.enabled
      ? computeNextRun(valid.schedule, now)
      : undefined;
    if (valid.enabled && !nextRun) {
      throw new Error("La fecha de una tarea única debe estar en el futuro.");
    }
    Object.assign(task, valid, { updatedAt: now.toISOString() });
    task.nextRunAt = nextRun?.toISOString();
    this.persistAndArm();
    return task;
  }

  remove(id: string): void {
    this.requireTask(id);
    this.store.tasks = this.store.tasks.filter((task) => task.id !== id);
    this.store.runs = this.store.runs.filter(
      (run) => run.taskId !== id || run.status === "running",
    );
    this.persistAndArm();
  }

  runNow(id: string): ScheduledTaskRun {
    const task = this.requireTask(id);
    const run = this.enqueue(task, this.now());
    this.persistAndArm();
    return run;
  }

  claimDue(): { task: ScheduledTask; run: ScheduledTaskRun } | undefined {
    this.tick();
    const run = this.store.runs.find(
      (candidate) => candidate.status === "queued",
    );
    if (!run) return undefined;
    const task = this.store.tasks.find(
      (candidate) => candidate.id === run.taskId,
    );
    if (!task) {
      run.status = "failed";
      run.error = "La tarea programada ya no existe.";
      run.endedAt = this.now().toISOString();
      this.persistAndArm();
      return undefined;
    }
    run.status = "running";
    run.startedAt = this.now().toISOString();
    task.lastStatus = "running";
    task.lastError = undefined;
    this.persistAndArm();
    return { task: { ...task }, run: { ...run } };
  }

  reportRun(input: {
    runId: string;
    status: "completed" | "failed";
    sessionId?: string;
    error?: string;
  }): void {
    const run = this.store.runs.find(
      (candidate) => candidate.id === input.runId,
    );
    if (!run) throw new Error("La ejecución programada no existe.");
    run.status = input.status;
    run.sessionId = input.sessionId;
    run.error = input.error?.slice(0, 2000);
    run.endedAt = this.now().toISOString();
    const task = this.store.tasks.find(
      (candidate) => candidate.id === run.taskId,
    );
    if (task) {
      task.lastStatus = input.status;
      task.lastError = run.error;
      task.updatedAt = this.now().toISOString();
    }
    this.persistAndArm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private tick(): void {
    const now = this.now();
    let changed = false;
    for (const run of this.store.runs) {
      if (
        run.status === "running" &&
        run.startedAt &&
        now.getTime() - new Date(run.startedAt).getTime() > RUN_STALE_MS
      ) {
        run.status = "failed";
        run.error = "La ejecución quedó sin respuesta del host.";
        run.endedAt = now.toISOString();
        const task = this.store.tasks.find(
          (candidate) => candidate.id === run.taskId,
        );
        if (task) {
          task.lastStatus = "failed";
          task.lastError = run.error;
        }
        changed = true;
      }
    }
    for (const task of this.store.tasks) {
      if (
        !task.enabled ||
        !task.nextRunAt ||
        new Date(task.nextRunAt).getTime() > now.getTime()
      )
        continue;
      const scheduledFor = new Date(task.nextRunAt);
      this.enqueue(task, scheduledFor);
      task.lastRunAt = scheduledFor.toISOString();
      task.lastStatus = "queued";
      if (task.schedule.kind === "once") {
        task.enabled = false;
        task.nextRunAt = undefined;
      } else {
        task.nextRunAt = computeNextRun(task.schedule, now)?.toISOString();
      }
      task.updatedAt = now.toISOString();
      changed = true;
    }
    if (changed) this.persist();
  }

  private enqueue(task: ScheduledTask, scheduledFor: Date): ScheduledTaskRun {
    const iso = scheduledFor.toISOString();
    const existing = this.store.runs.find(
      (run) => run.taskId === task.id && run.scheduledFor === iso,
    );
    if (existing) return existing;
    const run: ScheduledTaskRun = {
      id: uuidv4(),
      taskId: task.id,
      scheduledFor: iso,
      status: "queued",
      createdAt: this.now().toISOString(),
    };
    this.store.runs.push(run);
    task.lastRunAt = iso;
    task.lastStatus = "queued";
    return run;
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    const next = this.store.tasks
      .filter((task) => task.enabled && task.nextRunAt)
      .map((task) => new Date(task.nextRunAt!).getTime())
      .sort((a, b) => a - b)[0];
    if (!next) return;
    const delay = Math.max(
      50,
      Math.min(MAX_TIMER_MS, next - this.now().getTime()),
    );
    this.timer = setTimeout(() => {
      this.tick();
      this.armTimer();
    }, delay);
    this.timer.unref?.();
  }

  private persistAndArm(): void {
    this.persist();
    this.armTimer();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.store, null, 2), "utf8");
    fs.renameSync(temporary, this.storagePath);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const parsed = JSON.parse(
        fs.readFileSync(this.storagePath, "utf8"),
      ) as SchedulerStore;
      this.store = {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      };
    } catch {
      this.store = { tasks: [], runs: [] };
    }
  }

  private recoverInterruptedRuns(): void {
    let changed = false;
    for (const run of this.store.runs) {
      if (run.status === "running") {
        run.status = "queued";
        run.startedAt = undefined;
        run.error = undefined;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private requireTask(id: string): ScheduledTask {
    const task = this.store.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error("La tarea programada no existe.");
    return task;
  }
}
