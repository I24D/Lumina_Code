/**
 * Lumina Input Control — Phase 6 (Mouse + Keyboard with Allowlist)
 * ════════════════════════════════════════════════════════════════
 * Four tools that let the agent drive the desktop:
 *   - lumina_input_focus_window   bring an app to the foreground
 *   - lumina_input_type            type literal text into the focused window
 *   - lumina_input_hotkey          send a SendKeys combo (Ctrl+C, Alt+F4, …)
 *   - lumina_input_mouse_click     click at an absolute screen coordinate
 *
 * Every call passes through:
 *   1. RateLimiter   (max 12 actions / 10 s default per tool — prevents runaway loops)
 *   2. Gatekeeper    (per-process allowlist; off-list → needs_confirmation; denylist → hard deny)
 *   3. AuditLog      (append-only JSONL in ~/.lumina/input-control/audit.jsonl)
 *
 * Disabled by default. Opt-in:
 *   plugins.entries.lumina-input-control: { enabled: true, appAllowlist: [...] }
 *
 * Default allowlist:
 *   Code, chrome, msedge, firefox, WindowsTerminal, powershell, pwsh
 *
 * Default denylist (hard, even with confirmation):
 *   winlogon, lsass, csrss, smss, consent, UserAccountControlSettings, LsaIso
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AuditLog } from "./src/audit-log.js";
import { Gatekeeper } from "./src/gatekeeper.js";
import { RateLimiter } from "./src/rate-limit.js";
import { createFocusWindowTool } from "./src/tools/focus-window.js";
import { createHotkeyTool } from "./src/tools/hotkey.js";
import { createMouseClickTool } from "./src/tools/mouse-click.js";
import { createTypeTool } from "./src/tools/type-text.js";

type InputControlConfig = {
  enabled?: boolean;
  appAllowlist?: string[];
  denylistAlways?: string[];
  confirmationMode?: "block" | "log_only";
  auditLogPath?: string;
  maxTypingChars?: number;
};

const DEFAULT_ALLOWLIST = [
  "Code",
  "chrome",
  "msedge",
  "firefox",
  "WindowsTerminal",
  "powershell",
  "pwsh",
];

const DEFAULT_DENYLIST = [
  "LsaIso",
  "winlogon",
  "lsass",
  "csrss",
  "smss",
  "consent",
  "UserAccountControlSettings",
];

export default definePluginEntry({
  id: "lumina-input-control",
  name: "Lumina Input Control",
  description:
    "Mouse/keyboard automation with per-process allowlist, rate limiting, and an append-only audit log. Phase 6. Four tools, all gated by the same Gatekeeper.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as InputControlConfig;
    if (raw.enabled === false) return;

    const gatekeeper = new Gatekeeper({
      appAllowlist: raw.appAllowlist ?? DEFAULT_ALLOWLIST,
      denylistAlways: raw.denylistAlways ?? DEFAULT_DENYLIST,
      confirmationMode: raw.confirmationMode ?? "block",
    });
    const audit = new AuditLog(raw.auditLogPath);
    const maxTypingChars = raw.maxTypingChars ?? 4_000;

    // One limiter per tool so a noisy hotkey loop doesn't starve a focus call.
    const focusLimiter = new RateLimiter(12, 10_000);
    const typeLimiter = new RateLimiter(8, 10_000);
    const hotkeyLimiter = new RateLimiter(12, 10_000);
    const mouseLimiter = new RateLimiter(12, 10_000);

    api.registerTool(createFocusWindowTool(gatekeeper, audit, focusLimiter));
    api.registerTool(createTypeTool(gatekeeper, audit, typeLimiter, maxTypingChars));
    api.registerTool(createHotkeyTool(gatekeeper, audit, hotkeyLimiter));
    api.registerTool(createMouseClickTool(gatekeeper, audit, mouseLimiter));
  },
});
