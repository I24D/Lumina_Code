/**
 * store.ts — Tiny JSONL store used by both working and episodic memory.
 * Append-only on disk, replays into memory on construction.
 */
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

export function readJsonlSync<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const out: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export function appendJsonl<T>(filePath: string, value: T): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf8");
}

export function rewriteJsonl<T>(filePath: string, values: ReadonlyArray<T>): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, values.map((v) => JSON.stringify(v)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
