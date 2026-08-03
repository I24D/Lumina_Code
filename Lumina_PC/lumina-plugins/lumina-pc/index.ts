/**
 * Lumina_PC — Execution Layer for I24D
 * ════════════════════════════════════════════════════════════════
 * This extension turns OpenClaw into the "arms, hands and eyes"
 * of the I24D brain. It exposes tools that let I24D:
 *
 *   PERCEIVE   → screen-capture, clipboard, window-list, process-list
 *   ACT        → shell-run, file-ops, notify-toast, window-focus
 *   MONITOR    → system-metrics, heartbeat, file-watcher
 *
 * All tools degrade gracefully on non-Windows platforms.
 * Security: shell-run and clipboard are ownerOnly by default.
 * ════════════════════════════════════════════════════════════════
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createHeartbeatService } from "./src/services/heartbeat.js";
import { createWatcherService } from "./src/services/watcher.js";
import { createAlarmTool } from "./src/tools/alarm.js";
import { createClipboardTool } from "./src/tools/clipboard.js";
import { createFileOpsTool } from "./src/tools/file-ops.js";
import { createInputControlTool } from "./src/tools/input-control.js";
import { createLuminaCodeTool } from "./src/tools/lumina-code.js";
import { createNotifyToastTool } from "./src/tools/notify-toast.js";
import { createNotificationsTool } from "./src/tools/notifications.js";
import { createNotificationDismissTool } from "./src/tools/notification-dismiss.js";
import { createWhatsappReplyTool } from "./src/tools/whatsapp-reply.js";
import { createProcessListTool } from "./src/tools/process-list.js";
import { createScreenCaptureTool } from "./src/tools/screen-capture.js";
import { createShellRunTool } from "./src/tools/shell-run.js";
import { createSystemMetricsTool } from "./src/tools/system-metrics.js";
import { createWindowControlTool } from "./src/tools/window-control.js";

// ── Config type ───────────────────────────────────────────────────
type LuminaConfig = {
  enabled?: boolean;
  shellApprovalRequired?: boolean;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMs?: number;
  screenshotDir?: string;
  watchedPaths?: string[];
  inputControlEnabled?: boolean;
  inputApprovalRequired?: boolean;
  inputAllowedApps?: string[];
};

export default definePluginEntry({
  id: "lumina-pc",
  name: "Lumina_PC",
  description:
    "Execution layer for I24D. Gives the AI brain perception and actuation capabilities " +
    "on the local Windows PC: screenshots, shell commands, file ops, clipboard, " +
    "toast notifications, window control, process monitoring and system metrics.",

  register(api) {
    // Read plugin config (with safe defaults)
    const raw = (api.pluginConfig ?? {}) as LuminaConfig;
    const cfg: Required<LuminaConfig> = {
      enabled: raw.enabled ?? true,
      shellApprovalRequired: raw.shellApprovalRequired ?? true,
      heartbeatEnabled: raw.heartbeatEnabled ?? true,
      heartbeatIntervalMs: raw.heartbeatIntervalMs ?? 30_000,
      screenshotDir: raw.screenshotDir ?? "",
      watchedPaths: raw.watchedPaths ?? [],
      inputControlEnabled: raw.inputControlEnabled ?? false,
      inputApprovalRequired: raw.inputApprovalRequired ?? true,
      inputAllowedApps: raw.inputAllowedApps ?? [],
    };

    if (!cfg.enabled) return;

    // ── PERCEPTION TOOLS ──────────────────────────────────────────
    // I24D eyes: see the screen
    api.registerTool(createScreenCaptureTool({ screenshotDir: cfg.screenshotDir || undefined }));

    // I24D eyes: read clipboard (what user copied)
    api.registerTool(createClipboardTool());

    // I24D eyes: list visible windows
    api.registerTool(createWindowControlTool());

    // I24D eyes: list running processes
    api.registerTool(createProcessListTool());

    // ── BODY METRICS ──────────────────────────────────────────────
    // I24D pulse: CPU / RAM / network status
    api.registerTool(createSystemMetricsTool());

    // ── EXECUTION TOOLS ───────────────────────────────────────────
    // I24D hands: run PowerShell commands
    api.registerTool(createShellRunTool({ shellApprovalRequired: cfg.shellApprovalRequired }));

    // I24D hands: read/write files
    api.registerTool(createFileOpsTool());

    // I24D development bridge: delegate coding work to Lumina Code in VS Code
    api.registerTool(createLuminaCodeTool());

    // I24D voice: notify user via Windows Toast
    api.registerTool(createNotifyToastTool());

    // I24D awareness: read notifications retained by Windows Notification Center
    api.registerTool(createNotificationsTool());

    // I24D awareness: dismiss/remove notifications from the Notification Center
    api.registerTool(createNotificationDismissTool());

    // I24D voice→action: reply to a WhatsApp conversation in one step
    api.registerTool(createWhatsappReplyTool());

    // I24D time sense: register real native Windows alarms/reminders
    api.registerTool(createAlarmTool());

    if (cfg.inputControlEnabled) {
      api.registerTool(
        createInputControlTool({
          enabled: true,
          allowedApps: cfg.inputAllowedApps,
          onAudit: (event) =>
            api.logger.info(`[lumina-pc] input control audit ${JSON.stringify(event)}`),
        }),
      );
      api.registerToolMetadata({
        toolName: "lumina_input_control",
        displayName: "Lumina Input Control",
        description: "Allowlisted mouse and keyboard control for the active Windows application.",
        risk: "high",
        tags: ["desktop", "input", "approval", "allowlist"],
      });
      if (cfg.inputApprovalRequired) {
        api.registerTrustedToolPolicy({
          id: "lumina-input-control-approval",
          description: "Require explicit approval before mouse or keyboard input is sent.",
          evaluate(event) {
            if (event.toolName !== "lumina_input_control") return undefined;
            const action =
              typeof event.params.action === "string" ? event.params.action : "desktop input";
            return {
              requireApproval: {
                title: "Allow Lumina to control input?",
                description: `Lumina wants to perform ${action} in an allowlisted application.`,
                severity: "warning",
                allowedDecisions: ["allow-once", "deny"],
              },
            };
          },
        });
      }
    }

    // ── BACKGROUND SERVICES ───────────────────────────────────────
    // System heartbeat — reports health metrics periodically
    if (cfg.heartbeatEnabled) {
      api.registerService(
        createHeartbeatService({
          enabled: cfg.enabled,
          intervalMs: cfg.heartbeatIntervalMs,
        }),
      );
    }

    // File-system watcher — notifies I24D of changes in watched paths
    api.registerService(
      createWatcherService({
        enabled: cfg.watchedPaths.length > 0,
        paths: cfg.watchedPaths,
      }),
    );
  },
});
