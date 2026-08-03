/**
 * working-memory.ts — "What is the user doing RIGHT NOW?"
 *
 * Slots:
 *   - currentProject     (name + path)
 *   - activeWindow       (process + title)
 *   - activeFile         (path)
 *   - currentIntent      (free-form, set by the agent / intent router)
 *   - pinnedContext      (≤ 5 bullets injected into every voice turn)
 *
 * The store is a single JSON file rewritten on every set(); we never
 * need to keep more than one version.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./store.js";

export type WorkingMemory = {
  currentProject: { name: string; path: string } | null;
  activeWindow: { processName: string; title: string } | null;
  activeFile: string | null;
  currentIntent: string | null;
  pinnedContext: string[];
  updatedAtISO: string;
};

const INITIAL: WorkingMemory = {
  currentProject: null,
  activeWindow: null,
  activeFile: null,
  currentIntent: null,
  pinnedContext: [],
  updatedAtISO: new Date(0).toISOString(),
};

export class WorkingMemoryStore {
  private state: WorkingMemory = INITIAL;
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, "working-memory.json");
    ensureDir(dir);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkingMemory>;
      this.state = {
        ...INITIAL,
        ...parsed,
        pinnedContext: Array.isArray(parsed.pinnedContext) ? parsed.pinnedContext.slice(0, 5) : [],
      };
    } catch {
      this.state = INITIAL;
    }
  }

  private persist(): void {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  get(): WorkingMemory {
    return this.state;
  }

  set(partial: Partial<WorkingMemory>): WorkingMemory {
    this.state = {
      ...this.state,
      ...partial,
      pinnedContext:
        partial.pinnedContext !== undefined
          ? partial.pinnedContext.slice(0, 5)
          : this.state.pinnedContext,
      updatedAtISO: new Date().toISOString(),
    };
    this.persist();
    return this.state;
  }

  pin(line: string): WorkingMemory {
    const next = [line, ...this.state.pinnedContext.filter((x) => x !== line)].slice(0, 5);
    return this.set({ pinnedContext: next });
  }

  unpin(line: string): WorkingMemory {
    return this.set({ pinnedContext: this.state.pinnedContext.filter((x) => x !== line) });
  }
}
