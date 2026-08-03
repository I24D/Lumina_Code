/**
 * ClaudeApp adapter — orquesta locator → writer → reader.
 *
 * Capability profile:
 *   - streaming: false (la respuesta llega cuando el clipboard se estabiliza,
 *                no token-a-token).
 *   - toolUse: false (Claude App ejecuta sus propias tools internamente; no
 *              podemos inyectar las de Lumina).
 *   - vision: false (drag-and-drop de imágenes está fuera del scope inicial).
 *   - fileAttach: false (idem).
 *   - structuredOutput: false (devolvemos texto plano del chat).
 */
import type { AdapterCapabilities, ClaudeAdapter, ClaudeTarget } from "../../types.js";
import { locateClaudeApp, type ClaudeAppWindow } from "./locator.js";
import { readClaudeAppResponse } from "./reader.js";
import { writePromptToClaudeApp } from "./writer.js";
import { runPowerShellJson } from "../../utils/powershell.js";

const CHAT_APP_CAPS: AdapterCapabilities = {
  streaming: false,
  toolUse: false,
  vision: false,
  fileAttach: false,
  structuredOutput: false,
};

export type ClaudeAppAdapterOptions = {
  readonly processName: string;
  readonly responseWaitMaxMs: number;
  readonly responseStableMs: number;
};

export class ClaudeAppAdapter implements ClaudeAdapter {
  readonly target: ClaudeTarget = "chat-app";
  readonly capabilities: AdapterCapabilities = CHAT_APP_CAPS;

  constructor(private readonly opts: ClaudeAppAdapterOptions) {}

  async available(): Promise<boolean> {
    const w = await locateClaudeApp(this.opts.processName);
    return w !== null && w.isVisible;
  }

  async locate(): Promise<ClaudeAppWindow | null> {
    return locateClaudeApp(this.opts.processName);
  }

  async send(
    payload: string,
    attachments: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<{ response: string; meta?: Record<string, unknown> }> {
    if (attachments.length > 0) {
      throw new Error("ClaudeApp adapter does not support attachments yet");
    }
    const window = await locateClaudeApp(this.opts.processName);
    if (!window) {
      throw new Error(`Claude App (process "${this.opts.processName}") is not running`);
    }
    if (signal?.aborted) throw new Error("aborted");

    // 1. Snapshot inicial del clipboard del chat (Ctrl+A+C) — necesario para
    //    diff al final.
    await selectAllAndCopy(window.processId, window.processName);
    const initialSnapshot = await readClipboardText();

    if (signal?.aborted) throw new Error("aborted");

    // 2. Escribe el prompt + Enter.
    const wRes = await writePromptToClaudeApp(window.processName, payload, window.processId);
    if (!wRes.ok) {
      throw new Error(`writer failed: ${wRes.error ?? "unknown"}`);
    }

    // 3. Espera + lee la respuesta.
    const rRes = await readClaudeAppResponse({
      pid: window.processId,
      processName: window.processName,
      initialClipboardSnapshot: initialSnapshot,
      maxWaitMs: this.opts.responseWaitMaxMs,
      stableMs: this.opts.responseStableMs,
      signal,
    });

    if (!rRes.ok) {
      throw new Error(`reader failed: ${rRes.error ?? "unknown"}`);
    }

    return {
      response: rRes.response,
      meta: {
        window: {
          processId: window.processId,
          monitorIndex: window.monitor.index,
          monitorName: window.monitor.name,
        },
        waitedMs: rRes.waitedMs,
        snapshots: rRes.snapshots,
      },
    };
  }
}

async function selectAllAndCopy(pid: number, processName: string): Promise<void> {
  // Same script as reader's, duplicated minimal helper to avoid coupling
  // adapter.ts to reader.ts internals.
  const script = `
    $shell = New-Object -ComObject "Wscript.Shell"
    [void]$shell.AppActivate(${pid})
    Start-Sleep -Milliseconds 150
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds 120
  `;
  await runPowerShellJson(`& { ${script} }; [pscustomobject]@{ ok = $true }`, 5_000);
}

async function readClipboardText(): Promise<string | null> {
  const r = await runPowerShellJson<{ text?: string }>(
    `[pscustomobject]@{ text = (Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue) }`,
    4_000,
  );
  if (!r.ok || !r.data) return null;
  return typeof r.data.text === "string" ? r.data.text : null;
}
