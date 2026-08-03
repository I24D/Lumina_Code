/**
 * singleton.ts — Process-wide handle for the active ActivityLog.
 *
 * The activation function of `lumina-cognitive-os` creates one ActivityLog
 * per running gateway and registers it here. Consumers outside the
 * extension (e.g. gateway server-methods that surface transparency to
 * the UI) can then read the current snapshot without importing the
 * extension's private wiring.
 *
 * When the plugin is not active the getter returns `undefined` and
 * callers must handle that gracefully (return an empty list, hide the
 * panel, etc.). This mirrors the singleton pattern used by
 * `src/harness/runtime/singleton.ts` for the Harness runtime.
 */
import type { ActivityLog } from "./activity-log.js";

let active: ActivityLog | undefined;

export function setActiveActivityLog(log: ActivityLog | undefined): void {
  active = log;
}

export function getActiveActivityLog(): ActivityLog | undefined {
  return active;
}
