export const LIVE_SESSION_ROTATION_MS = 12 * 60_000;

const MAX_RETRY_DELAY_MS = 30_000;

export function getStartTalkRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(safeAttempt - 1, 5);
  return Math.min(1_000 * 2 ** exponent, MAX_RETRY_DELAY_MS);
}
