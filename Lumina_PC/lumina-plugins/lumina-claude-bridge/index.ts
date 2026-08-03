/**
 * Lumina Claude Bridge — Phase 7
 * ════════════════════════════════════════════════════════════════
 * Tres destinos Claude desde Lumina:
 *   - chat-app  → Claude App desktop via UI automation (find + focus + type
 *                 + Ctrl+V + Enter, lee respuesta vía Ctrl+A+C + clipboard
 *                 diff).
 *   - code-cli  → `claude -p "<prompt>"` spawn directo.
 *   - cowork    → STUB. Beta sin API estable.
 *
 * Tools expuestas:
 *   - lumina_claude_dispatch         (entry point, con router automático)
 *   - lumina_claude_app_status       (read-only, dónde está Claude App)
 *   - lumina_claude_app_send_prompt  (bajo nivel, salta router)
 *
 * Disabled by default. Opt-in via openclaw.json:
 *   plugins.entries.lumina-claude-bridge.enabled: true
 *
 * Cuando esté activa, el agente puede recibir órdenes como:
 *   "Lumina, dile a Claude App que me resuma este artículo: …"
 *   "Lumina, pídele a Claude Code que refactorice src/foo.ts"
 *
 * Y Lumina llamará `lumina_claude_dispatch` con el transcript adecuado.
 *
 * Diseño:
 *   - TypeScript estricto, helpers PowerShell locales (no cross-plugin import).
 *   - Capability gating: el router rechaza requests imposibles antes de
 *     ejecutar (ej. attachments + chat-app → fallback a code-cli o error).
 *   - AbortSignal en los 3 adapters para cancelación por voz.
 *   - Fail-open: cualquier excepción del adapter se convierte en
 *     DispatchResult.ok=false con razón estructurada.
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ClaudeAppAdapter } from "./src/adapters/claude-app/adapter.js";
import { ClaudeCodeCliAdapter } from "./src/adapters/claude-code-cli.js";
import { CoworkStubAdapter } from "./src/adapters/cowork-stub.js";
import { ClaudeBridge } from "./src/bridge.js";
import { createKeywordRouter } from "./src/router.js";
import { createClaudeAppStatusTool } from "./src/tools/status.js";
import { createDispatchTool } from "./src/tools/dispatch.js";
import { createSendPromptTool } from "./src/tools/send-prompt.js";
import type { ClaudeTarget, ClaudeAdapter } from "./src/types.js";

type ClaudeBridgeConfig = {
  enabled?: boolean;
  claudeApp?: {
    processName?: string;
    responseWaitMaxMs?: number;
    responseStableMs?: number;
  };
  claudeCodeCli?: {
    binPath?: string;
    timeoutMs?: number;
  };
};

export default definePluginEntry({
  id: "lumina-claude-bridge",
  name: "Lumina Claude Bridge",
  description:
    "Phase 7 — delega tareas a Claude App (UI automation), Claude Code CLI o Cowork (stub). Tres tools: lumina_claude_dispatch, lumina_claude_app_status, lumina_claude_app_send_prompt.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as ClaudeBridgeConfig;
    if (raw.enabled === false) return;

    const claudeAppOpts = {
      processName: raw.claudeApp?.processName ?? "Claude",
      responseWaitMaxMs: raw.claudeApp?.responseWaitMaxMs ?? 60_000,
      responseStableMs: raw.claudeApp?.responseStableMs ?? 1_500,
    };
    const claudeApp = new ClaudeAppAdapter(claudeAppOpts);
    const claudeCodeCli = new ClaudeCodeCliAdapter({
      binPath: raw.claudeCodeCli?.binPath,
      timeoutMs: raw.claudeCodeCli?.timeoutMs ?? 300_000,
    });
    const cowork = new CoworkStubAdapter();

    const adapters: Readonly<Record<ClaudeTarget, ClaudeAdapter>> = {
      "chat-app": claudeApp,
      "code-cli": claudeCodeCli,
      "cowork": cowork,
    };

    const router = createKeywordRouter();
    const bridge = new ClaudeBridge(router, adapters);

    api.registerTool(createDispatchTool(bridge));
    api.registerTool(createClaudeAppStatusTool(claudeApp));
    api.registerTool(createSendPromptTool(claudeApp));
  },
});
