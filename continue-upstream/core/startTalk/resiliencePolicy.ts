export const LIVE_SESSION_ROTATION_MS = 12 * 60_000;
export const MAX_START_TALK_RECONNECT_ATTEMPTS = 8;

const MAX_RETRY_DELAY_MS = 30_000;

export function getStartTalkRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(safeAttempt - 1, 5);
  return Math.min(1_000 * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

export type VoiceFailureKind =
  | "authentication"
  | "configuration"
  | "quota"
  | "rate-limit"
  | "network"
  | "server"
  | "unknown";

export interface VoiceReconnectDecision {
  kind: VoiceFailureKind;
  retry: boolean;
  fallbackRecommended: boolean;
  delayMs: number;
}

/** Classifies provider/network failures without depending on one SDK's shape. */
export function classifyVoiceFailure(reason?: string): VoiceFailureKind {
  const value = String(reason ?? "").toLocaleLowerCase();
  if (/api.?key|unauth|forbidden|\b401\b|\b403\b|permission denied/u.test(value)) {
    return "authentication";
  }
  if (/unsupported|invalid model|model .*not found|unknown model/u.test(value)) {
    return "configuration";
  }
  if (/quota|billing|insufficient.?fund|credit/u.test(value)) {
    return "quota";
  }
  if (/rate.?limit|too many requests|\b429\b/u.test(value)) {
    return "rate-limit";
  }
  if (/timeout|timed out|network|socket|econn|dns|offline|abnormal closure/u.test(value)) {
    return "network";
  }
  if (/server|internal|unavailable|\b50[0234]\b/u.test(value)) {
    return "server";
  }
  return "unknown";
}

/**
 * Prevents the old infinite "Connecting…" loop. Credential/configuration
 * errors are terminal; transient failures back off for a bounded number of
 * attempts. Quota/rate failures explicitly recommend the provider fallback.
 */
export function getVoiceReconnectDecision(
  reason: string | undefined,
  attempt: number,
): VoiceReconnectDecision {
  const kind = classifyVoiceFailure(reason);
  const terminal = kind === "authentication" || kind === "configuration";
  const exhausted = attempt > MAX_START_TALK_RECONNECT_ATTEMPTS;
  return {
    kind,
    retry: !terminal && !exhausted,
    fallbackRecommended:
      terminal || kind === "quota" || kind === "rate-limit" || exhausted,
    delayMs: getStartTalkRetryDelayMs(attempt),
  };
}
