/**
 * User-idle observer.
 *
 * Reads how long since the last input (mouse/keyboard) via the Win32
 * `GetLastInputInfo` API. This is the canonical way to know whether the
 * user is "at the desk". It does NOT distinguish between a screen lock
 * and an away user — Phase 3 treats both as "user is idle".
 *
 * AMSI note: the API is reached through the pure-ctypes win_activity.py
 * sidecar, NOT PowerShell. The old `Add-Type` P/Invoke version tripped
 * Bitdefender's CMD:Heur...Boxter heuristic on every poll. See utils/python.ts.
 */
import { readActivity } from "../utils/python.js";

export async function readUserIdleMs(): Promise<number> {
  const activity = await readActivity();
  if (activity === null) return 0;
  const ms = Number(activity.idleMs ?? 0);
  // -1 means the probe failed; treat as 0 (active) to avoid false
  // "user is idle" narrations.
  return ms < 0 ? 0 : ms;
}
