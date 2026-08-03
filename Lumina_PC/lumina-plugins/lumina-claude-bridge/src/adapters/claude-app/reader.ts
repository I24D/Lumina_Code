/**
 * Reader — captura la respuesta de Claude App cuando termina de generar.
 *
 * Strategy:
 *   1. Poll Ctrl+A + Ctrl+C cada `pollIntervalMs` para snapshotar el
 *      clipboard (TODO el chat selected).
 *   2. Diff vs el snapshot anterior. Si el clipboard se mantiene IGUAL
 *      durante `stableMs` consecutivos, asumimos que Claude terminó.
 *   3. Diff snapshot final vs snapshot inicial (antes del prompt) para
 *      extraer SOLO el bloque nuevo = la respuesta del asistente + el
 *      eco del prompt del usuario.
 *   4. Parsea el bloque nuevo para devolver solo el último mensaje del
 *      asistente (descarta el prompt del usuario).
 *
 * Limitaciones conocidas (documentadas, hay que iterar con test real):
 *   - Ctrl+A en Claude App selecciona TODO el chat actual, incluido el
 *     historial. Por eso necesitamos el snapshot INICIAL — para diff.
 *   - Si Claude termina de generar pero el clipboard del user es polled
 *     por otra app entre nuestros polls, hay race. Mitigación: guardamos
 *     y restauramos el clipboard al final.
 *   - Si el user escribió DURANTE la generación, los snapshots se rompen.
 *     Por ahora asumimos el user espera.
 *
 * Fallback OCR (Phase 2): si el clipboard no cambia (Claude App podría
 * en futuro deshabilitar Ctrl+A?), usar lumina_screen_capture para OCR
 * del rect inferior. NO implementado en este archivo — TODO.
 */
import { runPowerShellJson, runPowerShellVoid } from "../../utils/powershell.js";

export type ReaderOptions = {
  readonly pid: number;
  readonly processName: string;
  readonly initialClipboardSnapshot: string | null;
  readonly maxWaitMs: number;
  readonly stableMs: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
};

export type ReaderResult = {
  readonly ok: boolean;
  readonly response: string;
  readonly error?: string;
  readonly waitedMs: number;
  readonly snapshots: number;
  /** Tira completa que copiamos del chat (debug). */
  readonly debugFullChat?: string;
};

const SAFE_PROC_NAME = /^[\w-]{1,32}$/;
const DEFAULT_POLL_MS = 800;

export async function readClaudeAppResponse(opts: ReaderOptions): Promise<ReaderResult> {
  if (!SAFE_PROC_NAME.test(opts.processName)) {
    return { ok: false, response: "", error: "unsafe processName", waitedMs: 0, snapshots: 0 };
  }
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const t0 = Date.now();
  let lastSnapshot = opts.initialClipboardSnapshot ?? "";
  let stableSince: number | null = null;
  let snapshots = 0;

  while (Date.now() - t0 < opts.maxWaitMs) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        response: "",
        error: "aborted",
        waitedMs: Date.now() - t0,
        snapshots,
      };
    }

    await selectAllAndCopy(opts.pid, opts.processName);
    const snap = (await readClipboardText()) ?? "";
    snapshots += 1;

    if (snap === lastSnapshot) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= opts.stableMs && snap.length > (opts.initialClipboardSnapshot?.length ?? 0)) {
        // Estable + clipboard creció vs el snapshot inicial → respuesta lista.
        const newContent = diffNewContent(opts.initialClipboardSnapshot ?? "", snap);
        const responseOnly = extractAssistantResponse(newContent);
        return {
          ok: true,
          response: responseOnly,
          waitedMs: Date.now() - t0,
          snapshots,
          debugFullChat: snap,
        };
      }
    } else {
      // Cambió → reset stability counter.
      lastSnapshot = snap;
      stableSince = null;
    }

    await sleep(pollMs);
  }

  return {
    ok: false,
    response: lastSnapshot,
    error: `max wait ${opts.maxWaitMs}ms reached without stable response`,
    waitedMs: Date.now() - t0,
    snapshots,
  };
}

async function selectAllAndCopy(pid: number, processName: string): Promise<void> {
  const script = `
    $shell = New-Object -ComObject "Wscript.Shell"
    $activated = $shell.AppActivate(${pid})
    if (-not $activated) {
      $proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($proc) { $shell.AppActivate($proc.MainWindowTitle) }
    }
    Start-Sleep -Milliseconds 120
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds 120
  `;
  await runPowerShellVoid(script, 5_000);
}

async function readClipboardText(): Promise<string | null> {
  const r = await runPowerShellJson<{ text?: string }>(
    `[pscustomobject]@{ text = (Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue) }`,
    4_000,
  );
  if (!r.ok || !r.data) return null;
  return typeof r.data.text === "string" ? r.data.text : null;
}

function diffNewContent(before: string, after: string): string {
  // Asumimos que el nuevo contenido es un APPEND al final del chat.
  if (after.startsWith(before)) {
    return after.slice(before.length).trim();
  }
  // Si no es append puro (raro), devolvemos todo lo nuevo desde el último
  // párrafo común. Como heurística simple, devolvemos el tail entero.
  return after.trim();
}

function extractAssistantResponse(newBlock: string): string {
  // El newBlock típicamente es:
  //   "<prompt del user>\n\n<respuesta del assistant>"
  // Heurística simple: si hay un doble salto, devolver lo que viene después.
  // Si no, devolver todo (el user puede pedir mejorar más adelante).
  const splits = newBlock.split(/\n\s*\n/);
  if (splits.length >= 2) {
    return splits.slice(1).join("\n\n").trim();
  }
  return newBlock.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
