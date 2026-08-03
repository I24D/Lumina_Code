/**
 * SendKeys driver — typing + hotkeys via `[System.Windows.Forms.SendKeys]`.
 *
 * We deliberately use SendKeys (the .NET API) instead of raw keybd_event
 * because SendKeys handles dead keys, IME, and unicode characters
 * correctly for typing prose. For hotkey combos we accept the standard
 * SendKeys notation (e.g. "^c" = Ctrl+C, "%{F4}" = Alt+F4, "+a" = Shift+A).
 *
 * Hardening:
 *   - Length cap enforced by the caller (tool layer).
 *   - We escape SendKeys metacharacters in plain typing so a literal "+"
 *     or "%" doesn't become a modifier.
 */
import { runPowerShellVoid } from "../utils/powershell.js";

/** Characters that SendKeys treats as control. */
const ESCAPE_RE = /[+^%~(){}]/g;

function escapeForSendKeys(s: string): string {
  return s.replace(ESCAPE_RE, (ch) => `{${ch}}`);
}

/**
 * Type a literal string into the focused window. Newlines become {ENTER}.
 * Tabs become {TAB}. Other control characters are stripped.
 */
export async function typeText(text: string): Promise<{ ok: boolean; error?: string }> {
  // Strip control characters except \n and \t.
  const cleaned = text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  // Split on \n so we can interleave {ENTER}; then escape each chunk.
  const lines = cleaned.split("\n");
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const withTabs = line.replace(/\t/g, "{TAB}");
    // For pieces that DON'T match {TAB}, escape SendKeys metachars.
    // We split around the literal {TAB} sentinel so we don't escape its braces.
    const segments = withTabs.split(/(\{TAB\})/g);
    for (const seg of segments) {
      if (seg === "{TAB}") parts.push(seg);
      else parts.push(escapeForSendKeys(seg));
    }
    if (i < lines.length - 1) parts.push("{ENTER}");
  }
  const final = parts.join("");
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait([System.IO.File]::ReadAllText($env:LUMINA_INPUT_PATH))
  `;
  // Write the payload to a temp file to avoid quoting hell.
  return await withTempInput(final, script);
}

/**
 * Send a SendKeys-notation hotkey combo, e.g. "^c", "%{F4}", "+{TAB}".
 * We do NOT escape — callers explicitly opt in to control semantics.
 */
export async function hotkeyCombo(combo: string): Promise<{ ok: boolean; error?: string }> {
  // Light validation: empty or absurdly long combos are rejected here.
  if (!combo || combo.length > 64) {
    return { ok: false, error: "combo missing or too long" };
  }
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait([System.IO.File]::ReadAllText($env:LUMINA_INPUT_PATH))
  `;
  return await withTempInput(combo, script);
}

/**
 * Materialize the payload to a temp file (UTF-8 no BOM), set
 * LUMINA_INPUT_PATH in the env, run the script, and remove the file.
 */
async function withTempInput(
  payload: string,
  script: string,
): Promise<{ ok: boolean; error?: string }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const file = path.join(os.tmpdir(), `lumina-input-${Date.now()}-${process.pid}.txt`);
  try {
    await fs.writeFile(file, payload, { encoding: "utf8" });
    process.env.LUMINA_INPUT_PATH = file;
    const r = await runPowerShellVoid(script, 8_000);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await fs.unlink(file);
    } catch {
      /* best effort */
    }
    delete process.env.LUMINA_INPUT_PATH;
  }
}
