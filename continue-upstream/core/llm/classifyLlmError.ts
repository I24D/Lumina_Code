/**
 * Turns a provider error into something the user can act on.
 *
 * Ported from Hermes's error classifier. The problem it replaces is visible
 * here already: the only structured handling in the chat path was a single
 * `includes("Not enough context")`, and everything else reached the user as
 * whatever text the provider happened to send. "429" and "402" look identical
 * to someone who just wants to know whether to wait or to top up an account.
 *
 * Hermes classifies in order to drive retries, credential rotation and
 * provider failover. Lumina has none of that machinery, so the port keeps the
 * half that matters here — naming the failure and saying what to do about it —
 * and reports `retryable` as information rather than acting on it. Claiming to
 * retry without a retry loop would be worse than saying nothing.
 */

export type LlmErrorCategory =
  /** Kept spelled this way because the session state already uses it. */
  | "out-of-context"
  | "auth"
  | "billing"
  | "rate-limit"
  | "model-not-found"
  | "content-policy"
  | "server-error"
  | "network"
  | "unknown";

export interface LlmErrorDiagnosis {
  category: LlmErrorCategory;
  /** One short line naming what went wrong. */
  title: string;
  /** What the user can do about it. */
  guidance: string;
  /** Whether the same request could plausibly succeed if repeated. */
  retryable: boolean;
}

/**
 * The wording for each category, kept apart from the detection rules.
 *
 * Callers that already know the category — the chat UI stores one rather than
 * the raw provider text — read from here directly. Re-running detection on the
 * category name would not work: "rate-limit" does not contain "rate limit".
 */
const DIAGNOSES: Record<
  LlmErrorCategory,
  Omit<LlmErrorDiagnosis, "category">
> = {
  "out-of-context": {
    title: "The conversation no longer fits in the model's context",
    guidance:
      "Compact the conversation with /compact, start a new session, or pick a " +
      "model with a larger context window.",
    retryable: false,
  },
  auth: {
    title: "The provider rejected the credentials",
    guidance:
      "Check the API key for this model in your config — it may be missing, " +
      "expired, or belong to a different account.",
    retryable: false,
  },
  billing: {
    title: "The account has no credit left",
    guidance:
      "Waiting will not help — top up or upgrade the plan with the provider, " +
      "or switch to another model.",
    retryable: false,
  },
  "rate-limit": {
    title: "The provider is rate limiting this key",
    guidance:
      "Wait a moment and send it again. If it keeps happening, the key is " +
      "hitting its per-minute limit and a different model or key will get through.",
    retryable: true,
  },
  "model-not-found": {
    title: "The provider does not recognise this model",
    guidance:
      "Check the model name in your config against the provider's current list — " +
      "names change and models are retired.",
    retryable: false,
  },
  "content-policy": {
    title: "The provider blocked this request",
    guidance:
      "Its safety filter rejected the prompt or the response. Rephrasing usually " +
      "clears it; the block comes from the provider, not from Lumina.",
    retryable: false,
  },
  "server-error": {
    title: "The provider is having trouble",
    guidance:
      "This is on their side, not yours. Try again shortly, or switch to another " +
      "model if it persists.",
    retryable: true,
  },
  network: {
    title: "Lumina could not reach the provider",
    guidance:
      "Check the connection and, for a local or self-hosted model, that it is " +
      "actually running. A corporate proxy or VPN intercepting TLS also causes this.",
    retryable: true,
  },
  unknown: {
    title: "The model request failed",
    guidance:
      "The provider did not explain why. Check the model's configuration, then " +
      "try again — if it keeps failing, the provider's status page is the next place to look.",
    retryable: true,
  },
};

/** The wording for a category that has already been determined. */
export function describeLlmError(
  category: LlmErrorCategory,
): LlmErrorDiagnosis {
  return { category, ...DIAGNOSES[category] };
}

/**
 * Finds an HTTP status in the shapes providers actually emit.
 *
 * Deliberately narrow. A three-digit number anywhere in the text is not a
 * status — "Generated 404 tokens" would send the user hunting for a model name
 * that is perfectly fine — so a bare number only counts at the very start,
 * which is where providers put it ("429 Too Many Requests").
 */
function findStatus(text: string): number | undefined {
  const match =
    /^\s*(\d{3})\b/u.exec(text) ??
    /\b(?:status(?:\s*code)?|http|error code)\D{0,3}(\d{3})\b/iu.exec(text);
  const status = match ? Number(match[1]) : NaN;
  return Number.isFinite(status) ? status : undefined;
}

function has(text: string, ...needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

/**
 * True when the text is complaining about the API key itself.
 *
 * Phrased as "key plus a complaint" rather than a list of exact sentences,
 * because every provider words this differently and an unmatched wording
 * degrades to an unhelpful "unknown".
 */
function complainsAboutApiKey(text: string): boolean {
  if (!has(text, "api key", "api_key", "apikey")) {
    return false;
  }
  return has(
    text,
    "not set",
    "missing",
    "invalid",
    "incorrect",
    "no api key",
    "not found",
    "expired",
    "required",
    "provide",
  );
}

/**
 * A 429 that says when it resets is throttling; one that talks about credits
 * or quota with no reset is an exhausted account. Hermes draws the same
 * distinction, and it is the one that decides whether waiting helps.
 */
function looksLikeExhaustedAccount(text: string): boolean {
  const mentionsMoney = has(
    text,
    "insufficient_quota",
    "insufficient quota",
    "insufficient credit",
    "insufficient funds",
    "billing",
    "payment",
    "credit balance",
    "out of credit",
    "upgrade your plan",
  );
  const mentionsReset = has(
    text,
    "retry after",
    "retry-after",
    "try again in",
    "resets in",
    "per minute",
    "per second",
    "rpm",
    "tpm",
  );
  return mentionsMoney && !mentionsReset;
}

/**
 * Classifies a provider error message.
 *
 * Order matters. The specific, unambiguous signals are tested before the
 * generic ones, because a message often carries several: a 400 that says
 * "context length exceeded" is a context problem, not a malformed request.
 */
export function classifyLlmError(raw: string): LlmErrorDiagnosis {
  const text = (raw ?? "").toLowerCase();
  if (text.trim() === "") {
    return describeLlmError("unknown");
  }
  const status = findStatus(text);

  if (
    has(
      text,
      "context length",
      "context_length_exceeded",
      "maximum context",
      "not enough context",
      "too many tokens",
      "reduce the length",
      "prompt is too long",
    )
  ) {
    return describeLlmError("out-of-context");
  }

  if (
    status === 401 ||
    status === 403 ||
    complainsAboutApiKey(text) ||
    has(text, "invalid_api_key", "unauthorized", "authentication")
  ) {
    return describeLlmError("auth");
  }

  if (status === 402 || looksLikeExhaustedAccount(text)) {
    return describeLlmError("billing");
  }

  if (status === 429 || has(text, "rate limit", "too many requests")) {
    return describeLlmError("rate-limit");
  }

  if (
    status === 404 ||
    has(text, "model not found", "unknown model", "does not exist")
  ) {
    return describeLlmError("model-not-found");
  }

  if (
    has(
      text,
      "content policy",
      "content_policy",
      "safety",
      "was blocked",
      "responsible ai",
      "content filter",
    )
  ) {
    return describeLlmError("content-policy");
  }

  if (
    has(
      text,
      "econnrefused",
      "enotfound",
      "etimedout",
      "econnreset",
      "socket hang up",
      "fetch failed",
      "network error",
      "getaddrinfo",
      "self signed certificate",
      "unable to verify",
      "certificate",
    )
  ) {
    return describeLlmError("network");
  }

  if (
    (status !== undefined && status >= 500) ||
    has(
      text,
      "overloaded",
      "internal server error",
      "service unavailable",
      "bad gateway",
    )
  ) {
    return describeLlmError("server-error");
  }

  return describeLlmError("unknown");
}
