/**
 * AMSI-safe foreground-window probe runner.
 *
 * Replaces the PowerShell `Add-Type` + user32 P/Invoke snippet that
 * Bitdefender flagged as CMD:Heur...Boxter. We shell out to a pure-ctypes
 * Python sidecar (win_foreground.py) instead.
 *
 * NOTE on idle: hardware idle detection (GetLastInputInfo) is a keylogger
 * fingerprint that AV blocks in ANY language — Bitdefender quarantines the
 * file the moment that API appears in it. We deliberately do NOT probe idle
 * here (idleMs is reported as 0 = "active"); the observation service degrades
 * to window/process-only change detection. If precise idle is ever wanted
 * back, it needs an explicit AV exclusion, not an evasion trick.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === "win32";
const pythonExe = process.env.LUMINA_PYTHON ?? "python";

// Bundled at <plugin>/dist/index.js → sidecar at <plugin>/sidecars/win_foreground.py.
// LUMINA_FOREGROUND_SIDECAR overrides with an explicit full path if needed.
const sidecarPath =
  process.env.LUMINA_FOREGROUND_SIDECAR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "sidecars", "win_foreground.py");

export type ForegroundInfo = {
  readonly title: string;
  readonly processName: string;
  readonly processId: number;
};

export type Activity = {
  readonly idleMs: number;
  readonly foreground: ForegroundInfo | null;
};

const CACHE_TTL_MS = 1_500;
let cache: { at: number; value: Activity | null } | null = null;
let inflight: Promise<Activity | null> | null = null;

async function spawnActivity(): Promise<Activity | null> {
  if (!IS_WIN) return null;
  try {
    const { stdout } = await execFileAsync(pythonExe, ["-X", "utf8", sidecarPath], {
      timeout: 6_000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) return null;
    const parsed = JSON.parse(text) as { ok?: boolean; foreground?: ForegroundInfo | null };
    if (!parsed.ok) return null;
    // idleMs intentionally fixed at 0 — see the file header note.
    return { idleMs: 0, foreground: parsed.foreground ?? null };
  } catch {
    // Fail-open: never let a probe error degrade the runtime or fall back to
    // the flagged PowerShell path. Callers treat null as "no signal".
    return null;
  }
}

/**
 * Read the current activity snapshot (foreground; idle stubbed to 0),
 * reusing a recent result within CACHE_TTL_MS so idle/window observers
 * polling together only spawn Python once.
 */
export async function readActivity(): Promise<Activity | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = spawnActivity()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
