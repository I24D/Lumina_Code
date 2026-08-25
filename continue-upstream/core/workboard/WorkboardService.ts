import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

import { getContinueGlobalPath } from "../util/paths.js";

export const WORKBOARD_COLUMNS = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;

export type WorkboardColumn = (typeof WORKBOARD_COLUMNS)[number];
export type WorkboardPriority = "low" | "normal" | "high" | "critical";

export interface WorkboardCard {
  id: string;
  title: string;
  description: string;
  column: WorkboardColumn;
  priority: WorkboardPriority;
  tags: string[];
  sessionId?: string;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkboardActivity {
  id: string;
  cardId: string;
  kind: "created" | "updated" | "moved" | "deleted";
  summary: string;
  fromColumn?: WorkboardColumn;
  toColumn?: WorkboardColumn;
  createdAt: string;
}

export interface WorkboardSnapshot {
  cards: WorkboardCard[];
  activity: WorkboardActivity[];
  counts: Record<WorkboardColumn, number>;
}

export interface WorkboardCardInput {
  title: string;
  description?: string;
  column?: WorkboardColumn;
  priority?: WorkboardPriority;
  tags?: string[];
  sessionId?: string;
  worktreePath?: string;
}

type WorkboardStore = {
  version: 1;
  cards: WorkboardCard[];
  activity: WorkboardActivity[];
};

const MAX_CARDS = 1_000;
const MAX_ACTIVITY = 2_000;
const MAX_TITLE_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 20_000;
const PRIORITIES: WorkboardPriority[] = ["low", "normal", "high", "critical"];

function isColumn(value: unknown): value is WorkboardColumn {
  return WORKBOARD_COLUMNS.includes(value as WorkboardColumn);
}

function isPriority(value: unknown): value is WorkboardPriority {
  return PRIORITIES.includes(value as WorkboardPriority);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function normalizedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function emptyCounts(): Record<WorkboardColumn, number> {
  return {
    backlog: 0,
    ready: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
  };
}

function cloneCard(card: WorkboardCard): WorkboardCard {
  return { ...card, tags: [...card.tags] };
}

export class WorkboardService {
  private readonly storagePath: string;
  private readonly now: () => Date;
  private store: WorkboardStore = { version: 1, cards: [], activity: [] };

  constructor(options: { storagePath?: string; now?: () => Date } = {}) {
    this.storagePath =
      options.storagePath ??
      path.join(getContinueGlobalPath(), "lumina-workboard.json");
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  snapshot(): WorkboardSnapshot {
    const counts = emptyCounts();
    for (const card of this.store.cards) counts[card.column] += 1;
    return {
      cards: [...this.store.cards]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(cloneCard),
      activity: this.store.activity
        .slice(-100)
        .reverse()
        .map((entry) => ({ ...entry })),
      counts,
    };
  }

  create(input: WorkboardCardInput): WorkboardCard {
    if (this.store.cards.length >= MAX_CARDS) {
      throw new Error("El workboard alcanzó el límite de 1000 tarjetas.");
    }
    const title = optionalText(input.title, MAX_TITLE_LENGTH);
    if (!title) throw new Error("La tarjeta necesita un título.");
    const now = this.now().toISOString();
    const card: WorkboardCard = {
      id: uuidv4(),
      title,
      description:
        optionalText(input.description, MAX_DESCRIPTION_LENGTH) ?? "",
      column: isColumn(input.column) ? input.column : "backlog",
      priority: isPriority(input.priority) ? input.priority : "normal",
      tags: normalizedTags(input.tags),
      sessionId: optionalText(input.sessionId, 240),
      worktreePath: optionalText(input.worktreePath, 4_000),
      createdAt: now,
      updatedAt: now,
      completedAt: input.column === "done" ? now : undefined,
    };
    this.store.cards.unshift(card);
    this.record(card, "created", `Creada en ${card.column}.`);
    this.persist();
    return cloneCard(card);
  }

  update(id: string, patch: Partial<WorkboardCardInput>): WorkboardCard {
    const card = this.requireCard(id);
    const previousColumn = card.column;
    if (patch.title !== undefined) {
      const title = optionalText(patch.title, MAX_TITLE_LENGTH);
      if (!title) throw new Error("La tarjeta necesita un título.");
      card.title = title;
    }
    if (patch.description !== undefined) {
      card.description =
        optionalText(patch.description, MAX_DESCRIPTION_LENGTH) ?? "";
    }
    if (patch.column !== undefined) {
      if (!isColumn(patch.column)) throw new Error("La columna no es válida.");
      card.column = patch.column;
    }
    if (patch.priority !== undefined) {
      if (!isPriority(patch.priority))
        throw new Error("La prioridad no es válida.");
      card.priority = patch.priority;
    }
    if (patch.tags !== undefined) card.tags = normalizedTags(patch.tags);
    if (patch.sessionId !== undefined) {
      card.sessionId = optionalText(patch.sessionId, 240);
    }
    if (patch.worktreePath !== undefined) {
      card.worktreePath = optionalText(patch.worktreePath, 4_000);
    }
    card.updatedAt = this.now().toISOString();
    if (card.column === "done" && previousColumn !== "done") {
      card.completedAt = card.updatedAt;
    } else if (card.column !== "done") {
      card.completedAt = undefined;
    }
    if (previousColumn !== card.column) {
      this.record(
        card,
        "moved",
        `Movida de ${previousColumn} a ${card.column}.`,
        {
          fromColumn: previousColumn,
          toColumn: card.column,
        },
      );
    } else {
      this.record(card, "updated", "Tarjeta actualizada.");
    }
    this.persist();
    return cloneCard(card);
  }

  remove(id: string): void {
    const card = this.requireCard(id);
    this.store.cards = this.store.cards.filter(
      (candidate) => candidate.id !== id,
    );
    this.record(card, "deleted", "Tarjeta eliminada.");
    this.persist();
  }

  private requireCard(id: string): WorkboardCard {
    const card = this.store.cards.find((candidate) => candidate.id === id);
    if (!card) throw new Error("La tarjeta del workboard no existe.");
    return card;
  }

  private record(
    card: WorkboardCard,
    kind: WorkboardActivity["kind"],
    summary: string,
    columns: Pick<WorkboardActivity, "fromColumn" | "toColumn"> = {},
  ): void {
    this.store.activity.push({
      id: uuidv4(),
      cardId: card.id,
      kind,
      summary: `${card.title}: ${summary}`,
      ...columns,
      createdAt: this.now().toISOString(),
    });
    this.store.activity = this.store.activity.slice(-MAX_ACTIVITY);
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(this.store, null, 2),
      "utf8",
    );
    fs.renameSync(temporaryPath, this.storagePath);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = JSON.parse(
        fs.readFileSync(this.storagePath, "utf8"),
      ) as Partial<WorkboardStore>;
      const cards = Array.isArray(raw.cards)
        ? raw.cards.filter((card): card is WorkboardCard =>
            Boolean(
              card &&
                typeof card.id === "string" &&
                typeof card.title === "string" &&
                isColumn(card.column) &&
                isPriority(card.priority),
            ),
          )
        : [];
      const activity = Array.isArray(raw.activity)
        ? raw.activity.filter((entry): entry is WorkboardActivity =>
            Boolean(
              entry &&
                typeof entry.id === "string" &&
                typeof entry.cardId === "string" &&
                typeof entry.summary === "string" &&
                typeof entry.createdAt === "string",
            ),
          )
        : [];
      this.store = {
        version: 1,
        cards: cards.slice(0, MAX_CARDS).map((card) => ({
          ...card,
          description:
            typeof card.description === "string" ? card.description : "",
          tags: normalizedTags(card.tags),
        })),
        activity: activity.slice(-MAX_ACTIVITY),
      };
    } catch {
      this.store = { version: 1, cards: [], activity: [] };
    }
  }
}
