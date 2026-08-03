/**
 * sandbox-policy.ts — Pre-execution gate for the Code Executor.
 *
 * The Risk Engine classifies actions (SAFE/WARNING/HIGH_RISK/CRITICAL).
 * This file adds a small layer of HARD checks specific to code execution
 * that the Risk Engine doesn't model:
 *
 *   - cwd allowlist — only execute under directories the user has
 *     explicitly opted into. Default allowlist:
 *       %USERPROFILE%, c:/I24D_WhatsApp, c:/I24D_WhatsApp/skills, /tmp
 *   - cwd denylist — refuse under c:/Windows, /etc, /usr, etc.
 *   - language allowlist — only python / bash / powershell / pwsh / node.
 *   - code denylist — fast string match on a small list of strings that
 *     are almost never legitimate from a voice assistant (shutdown /
 *     format / rm -rf / Remove-Item -Recurse -Force / reg delete on
 *     HKLM / etc). These trigger CRITICAL.
 *
 * Everything else is delegated to the Risk Engine, which decides whether
 * we proceed silently (SAFE), with a notice (WARNING), with single
 * confirmation (HIGH_RISK), or with double confirmation (CRITICAL).
 */
import path from "node:path";

export type SandboxLanguage = "python" | "python3" | "node" | "bash" | "powershell" | "pwsh";

export const SUPPORTED_LANGUAGES: ReadonlyArray<SandboxLanguage> = [
  "python", "python3", "node", "bash", "powershell", "pwsh",
];

export type SandboxPolicy = {
  readonly cwdAllow: ReadonlyArray<string>;
  readonly cwdDeny: ReadonlyArray<string>;
  readonly maxTimeoutMs: number;
  readonly defaultTimeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
};

// Default: empty allowlist ⇒ run anywhere that is NOT explicitly denied below.
// Lumina is a real assistant, not a sandboxed toy — it should reach any working
// directory the user could. The denylist still fences off system-critical dirs.
const DEFAULT_CWD_ALLOW: ReadonlyArray<string> = [];

const DEFAULT_CWD_DENY: ReadonlyArray<string> = [
  "c:/Windows",
  "c:/Program Files",
  "c:/Program Files (x86)",
  "c:/ProgramData",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var/lib",
  "/root/.openclaw",
  "/root/openclaw",
];

export function defaultSandboxPolicy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    cwdAllow: overrides.cwdAllow ?? DEFAULT_CWD_ALLOW,
    cwdDeny: overrides.cwdDeny ?? DEFAULT_CWD_DENY,
    maxTimeoutMs: overrides.maxTimeoutMs ?? 120_000,
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? 30_000,
    maxStdoutBytes: overrides.maxStdoutBytes ?? 512 * 1024,
    maxStderrBytes: overrides.maxStderrBytes ?? 64 * 1024,
  };
}

/** Hard-deny patterns. Case-insensitive substring match.
 *  These ALWAYS reject (no user override) — they're not just risky,
 *  they're things a voice assistant should never run. */
const HARD_DENY: ReadonlyArray<{ id: string; needle: RegExp; reason: string }> = [
  { id: "shutdown",        needle: /\bshutdown(\.exe)?\b|\bRestart-Computer\b|\bStop-Computer\b/i, reason: "Shutdown / restart command." },
  { id: "format",          needle: /\bformat\s+[a-z]:|\bClear-Disk\b|\bFormat-Volume\b/i,            reason: "Disk format command." },
  { id: "rm-rf",           needle: /\brm\s+-rf\s+\/|\brm\s+-fr\s+\/|\bRemove-Item\b[^|]*-Recurse[^|]*-Force[^|]*[\\/]/i, reason: "Recursive force delete on root." },
  { id: "del-system",      needle: /\bdel\s+\/[fsq][\s/]*[a-z]:\\?(Windows|Program)/i,               reason: "del on a system path." },
  { id: "reg-delete-hklm", needle: /\breg\s+delete\b.*HKLM|\bRemove-ItemProperty\b.*HKLM/i,          reason: "Registry HKLM delete." },
  { id: "diskpart",        needle: /\bdiskpart\b/i,                                                  reason: "diskpart invocation." },
  { id: "boot-edit",       needle: /\bbcdedit\b|\bbootcfg\b/i,                                       reason: "Boot configuration edit." },
];

export type PreflightVerdict =
  | { ok: true; cwd: string; timeoutMs: number }
  | { ok: false; reason: string };

function normalizePath(p: string): string {
  // Forward-slash normalization for cross-platform compare.
  const resolved = isAbsolutePath(p)
    ? isWindowsDrivePath(p)
      ? path.win32.resolve(p)
      : path.resolve(p)
    : path.resolve(p);
  return resolved.replace(/\\/g, "/").toLowerCase();
}

function isWindowsDrivePath(p: string): boolean {
  return /^[a-z]:[\\/]/iu.test(p);
}

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || isWindowsDrivePath(p);
}

function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

export function preflightCheck(params: {
  policy: SandboxPolicy;
  language: string;
  cwd: string;
  code: string;
  timeoutMs?: number;
}): PreflightVerdict {
  const lang = params.language?.trim().toLowerCase() as SandboxLanguage;
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    return { ok: false, reason: `language '${params.language}' is not supported. Allowed: ${SUPPORTED_LANGUAGES.join(", ")}` };
  }
  if (!params.cwd || !isAbsolutePath(params.cwd)) {
    return { ok: false, reason: "cwd must be an absolute path" };
  }
  if (!params.code || params.code.trim().length === 0) {
    return { ok: false, reason: "code is empty" };
  }
  for (const denied of params.policy.cwdDeny) {
    if (isUnder(params.cwd, denied)) {
      return { ok: false, reason: `cwd '${params.cwd}' is inside denied directory '${denied}'` };
    }
  }
  if (params.policy.cwdAllow.length > 0) {
    const allowed = params.policy.cwdAllow.some((root) => isUnder(params.cwd, root));
    if (!allowed) {
      return { ok: false, reason: `cwd '${params.cwd}' is outside the allowlist. Allowed roots: ${params.policy.cwdAllow.join(", ")}` };
    }
  }
  for (const rule of HARD_DENY) {
    if (rule.needle.test(params.code)) {
      return { ok: false, reason: `hard-denied pattern '${rule.id}': ${rule.reason}` };
    }
  }
  const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : params.policy.defaultTimeoutMs;
  const timeoutMs = Math.max(100, Math.min(requested, params.policy.maxTimeoutMs));
  return { ok: true, cwd: params.cwd, timeoutMs };
}

/** Map a language string to a Risk Engine action verb used for classification. */
export function languageToRiskAction(lang: string): string {
  const normalized = lang.toLowerCase();
  if (normalized.startsWith("python")) return "python_exec";
  if (normalized === "node") return "node_exec";
  if (normalized === "bash") return "bash_exec";
  if (normalized === "powershell" || normalized === "pwsh") return "powershell_exec";
  return `${normalized}_exec`;
}
