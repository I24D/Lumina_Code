/**
 * Mouse driver — absolute-position click via `SetCursorPos` + `mouse_event`.
 *
 * Coordinates are in physical screen pixels (no DPI scaling). The tool
 * layer accepts a button name (left/right/middle) and an (x, y).
 *
 * Hardening:
 *   - Tool layer caps the call rate (one click per 200 ms minimum).
 *   - The mouse_event flags map only the three buttons we accept; any
 *     other input is rejected before reaching here.
 */
import { runPowerShellVoid } from "../utils/powershell.js";

const PS_SCRIPT = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public static class Ms {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    }
"@ -ErrorAction SilentlyContinue
  $X = [int]$env:LUMINA_MOUSE_X
  $Y = [int]$env:LUMINA_MOUSE_Y
  $DOWN = [uint32]$env:LUMINA_MOUSE_DOWN
  $UP = [uint32]$env:LUMINA_MOUSE_UP
  [void][Ms]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 25
  [Ms]::mouse_event($DOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [Ms]::mouse_event($UP, 0, 0, 0, [IntPtr]::Zero)
`;

export type MouseButton = "left" | "right" | "middle";

function flagsFor(button: MouseButton): { down: number; up: number } {
  switch (button) {
    case "left":
      return { down: 0x0002, up: 0x0004 }; // MOUSEEVENTF_LEFTDOWN/UP
    case "right":
      return { down: 0x0008, up: 0x0010 }; // MOUSEEVENTF_RIGHTDOWN/UP
    case "middle":
      return { down: 0x0020, up: 0x0040 }; // MOUSEEVENTF_MIDDLEDOWN/UP
  }
}

export async function clickAt(
  x: number,
  y: number,
  button: MouseButton,
): Promise<{ ok: boolean; error?: string }> {
  const f = flagsFor(button);
  process.env.LUMINA_MOUSE_X = String(Math.round(x));
  process.env.LUMINA_MOUSE_Y = String(Math.round(y));
  process.env.LUMINA_MOUSE_DOWN = String(f.down);
  process.env.LUMINA_MOUSE_UP = String(f.up);
  try {
    const r = await runPowerShellVoid(PS_SCRIPT, 5_000);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true };
  } finally {
    delete process.env.LUMINA_MOUSE_X;
    delete process.env.LUMINA_MOUSE_Y;
    delete process.env.LUMINA_MOUSE_DOWN;
    delete process.env.LUMINA_MOUSE_UP;
  }
}
