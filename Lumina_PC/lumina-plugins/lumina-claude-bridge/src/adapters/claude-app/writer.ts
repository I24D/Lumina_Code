/**
 * Writer — escribe el prompt en el chat input de Claude App.
 *
 * Strategy:
 *   1. Trae la ventana al foreground (WScript.Shell.AppActivate).
 *   2. Asume el cursor está en el chat input (Claude App lo enfoca por
 *      default al activar la ventana). Si no está, futuro fix: click
 *      en el rect inferior usando coordenadas de la ventana.
 *   3. Pega el texto con clipboard + Ctrl+V (más rápido y robusto que
 *      typing carácter por carácter — además respeta el unicode).
 *   4. Envía con Enter.
 *
 * Por qué clipboard + Ctrl+V en vez de SendKeys typing:
 *   - SendKeys typing es lento (~10-20 chars/seg) y rompe con caracteres
 *     especiales (`+`, `^`, `%`, `~`, `(`, `)`, `{`, `}`).
 *   - Clipboard preserva el texto exacto sin escapes.
 *
 * Restaura el clipboard original al finalizar para no contaminar al usuario.
 */
import { runPowerShellJson, runPowerShellVoid } from "../../utils/powershell.js";

export type WriterResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly clipboardRestored: boolean;
};

const SAFE_PROC_NAME = /^[\w-]{1,32}$/;

export async function writePromptToClaudeApp(
  processName: string,
  prompt: string,
  pid: number,
): Promise<WriterResult> {
  if (!SAFE_PROC_NAME.test(processName)) {
    return { ok: false, error: `unsafe processName: ${processName}`, clipboardRestored: false };
  }
  if (!prompt.trim()) {
    return { ok: false, error: "empty prompt", clipboardRestored: false };
  }

  // 1. Guarda clipboard actual.
  const savedClipboard = await readClipboard();

  // 2. Pone el prompt en clipboard.
  const setOk = await writeClipboard(prompt);
  if (!setOk) {
    await restoreClipboard(savedClipboard);
    return { ok: false, error: "failed to set clipboard", clipboardRestored: false };
  }

  // 3. Focus + Ctrl+V + Enter.
  const script = `
    $shell = New-Object -ComObject "Wscript.Shell"
    # AppActivate by PID is more reliable than by title for apps with dynamic titles.
    $activated = $shell.AppActivate(${pid})
    Start-Sleep -Milliseconds 250
    if (-not $activated) {
      # Fallback: by process name.
      $proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($proc) { $shell.AppActivate($proc.MainWindowTitle); Start-Sleep -Milliseconds 250 }
    }
    Add-Type -AssemblyName System.Windows.Forms
    # Ctrl+V (paste)
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 200
    # Enter (send)
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  `;
  const r = await runPowerShellVoid(script, 8_000);

  // 4. Restaura clipboard original.
  const restored = await restoreClipboard(savedClipboard);

  if (!r.ok) {
    return { ok: false, error: r.error, clipboardRestored: restored };
  }
  return { ok: true, clipboardRestored: restored };
}

async function readClipboard(): Promise<string | null> {
  const r = await runPowerShellJson<{ text?: string }>(
    `[pscustomobject]@{ text = (Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue) }`,
    5_000,
  );
  if (!r.ok || !r.data) return null;
  return typeof r.data.text === "string" ? r.data.text : null;
}

async function writeClipboard(text: string): Promise<boolean> {
  // Use a temp file so we don't have to escape `text` into PowerShell.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `lumina-cb-${Date.now()}-${process.pid}.txt`);
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8" });
    process.env.LUMINA_CB_FILE = tmp;
    const r = await runPowerShellVoid(
      `Set-Clipboard -Value (Get-Content -LiteralPath $env:LUMINA_CB_FILE -Raw -Encoding UTF8)`,
      5_000,
    );
    return r.ok;
  } finally {
    delete process.env.LUMINA_CB_FILE;
    try { await fs.unlink(tmp); } catch { /* noop */ }
  }
}

async function restoreClipboard(saved: string | null): Promise<boolean> {
  if (saved === null) {
    // We had nothing to restore (clipboard was empty or non-text).
    const r = await runPowerShellVoid(`Set-Clipboard -Value $null`, 3_000);
    return r.ok;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `lumina-cbr-${Date.now()}-${process.pid}.txt`);
  try {
    await fs.writeFile(tmp, saved, { encoding: "utf8" });
    process.env.LUMINA_CB_FILE = tmp;
    const r = await runPowerShellVoid(
      `Set-Clipboard -Value (Get-Content -LiteralPath $env:LUMINA_CB_FILE -Raw -Encoding UTF8)`,
      3_000,
    );
    return r.ok;
  } finally {
    delete process.env.LUMINA_CB_FILE;
    try { await fs.unlink(tmp); } catch { /* noop */ }
  }
}
