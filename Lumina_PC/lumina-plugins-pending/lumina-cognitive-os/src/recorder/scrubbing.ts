/**
 * scrubbing.ts — Tiny PII / secret redactor for recorded key sequences.
 *
 * The Recorder captures `key` strings as the user typed them. If
 * `LUMINA_RECORDER_REDACT=1` or the user explicitly calls
 * `lumina_recorder_scrub`, this file rewrites obvious secrets in-place
 * so the recording can be shared or used to train a skill without
 * leaking credentials.
 *
 * Scope: regex-based. Detects:
 *   - emails
 *   - bearer-token-looking strings
 *   - sk-*** API keys (OpenAI / Anthropic / generic format)
 *   - common credit card patterns (Luhn not enforced)
 *   - high-entropy chunks (heuristic)
 *
 * Out of scope: passwords with no surrounding context (can't tell from
 * keystroke stream what was a password vs normal text). The Recorder
 * mitigates this separately by trying to skip key events while the
 * foreground control is `Type=Password` (best-effort, sidecar level).
 */

export type ScrubbingPolicy = {
  readonly redactEmails: boolean;
  readonly redactBearerTokens: boolean;
  readonly redactApiKeys: boolean;
  readonly redactCreditCards: boolean;
  readonly redactHighEntropy: boolean;
};

export function defaultScrubbingPolicy(): ScrubbingPolicy {
  return {
    redactEmails: true,
    redactBearerTokens: true,
    redactApiKeys: true,
    redactCreditCards: true,
    redactHighEntropy: false,
  };
}

const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._\-]{16,}/g;
const RE_API_KEY = /\b(sk|pk|ghp|xoxb|xoxp|AIza)[-_]?[A-Za-z0-9_\-]{16,}/g;
const RE_CC = /\b(?:\d[ -]*?){13,19}\b/g;

export function redactSecretsInText(input: string, policy: ScrubbingPolicy = defaultScrubbingPolicy()): string {
  let out = input;
  if (policy.redactEmails) out = out.replace(RE_EMAIL, "[REDACTED:email]");
  if (policy.redactBearerTokens) out = out.replace(RE_BEARER, "[REDACTED:bearer]");
  if (policy.redactApiKeys) out = out.replace(RE_API_KEY, "[REDACTED:apikey]");
  if (policy.redactCreditCards) {
    out = out.replace(RE_CC, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 ? "[REDACTED:cc]" : match;
    });
  }
  if (policy.redactHighEntropy) {
    out = out.replace(/[A-Za-z0-9+/=_-]{24,}/g, (match) => {
      return looksHighEntropy(match) ? "[REDACTED:secret]" : match;
    });
  }
  return out;
}

function looksHighEntropy(text: string): boolean {
  const len = text.length;
  if (len < 24) return false;
  const counts: Record<string, number> = {};
  for (const c of text) counts[c] = (counts[c] ?? 0) + 1;
  let entropy = 0;
  for (const k of Object.keys(counts)) {
    const p = counts[k]! / len;
    entropy -= p * Math.log2(p);
  }
  // English ~4 bits/char; base64 random ~6 bits/char. 4.5 is a decent cutoff.
  return entropy >= 4.5;
}
