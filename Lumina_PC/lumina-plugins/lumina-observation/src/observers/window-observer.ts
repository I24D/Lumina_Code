/**
 * Foreground window observer.
 *
 * Reads the active window's title + owning process via the Win32
 * GetForegroundWindow / GetWindowText / GetWindowThreadProcessId APIs.
 *
 * AMSI note: these are reached through the pure-ctypes win_activity.py
 * sidecar, NOT PowerShell. The old `Add-Type` P/Invoke version tripped
 * Bitdefender's CMD:Heur...Boxter heuristic on every poll. See utils/python.ts.
 */
import { readActivity } from "../utils/python.js";
import type { ForegroundWindow } from "../types.js";

const TITLE_CAP = 240;

export async function readForegroundWindow(): Promise<ForegroundWindow | null> {
  const activity = await readActivity();
  const fg = activity?.foreground;
  if (!fg) return null;
  const title = String(fg.title ?? "").slice(0, TITLE_CAP);
  const processName = String(fg.processName ?? "");
  const processId = Number(fg.processId ?? 0);
  if (!processName || !processId) return null;
  return { title, processName, processId };
}
