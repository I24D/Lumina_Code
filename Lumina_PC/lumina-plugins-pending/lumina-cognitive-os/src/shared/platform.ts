/**
 * platform.ts — Resolve where we're really running.
 *
 * Important for screen capture because the gateway often runs in WSL
 * (its `process.platform === "linux"`) while the *display* is on Windows.
 * To capture the Windows screen from inside WSL we need to invoke
 * `powershell.exe` over WSL→Windows interop, NOT a Linux screenshot tool.
 *
 * Detection order:
 *   1. `process.platform === "win32"`               → "windows"
 *   2. `/proc/version` contains "microsoft"|"WSL"   → "wsl"   (linux kernel
 *                                                    but Windows host)
 *   3. `process.platform === "linux"` otherwise     → "linux"
 *   4. `process.platform === "darwin"`              → "macos"
 *   5. anything else                                → "unknown"
 *
 * Cached after first call — `/proc/version` is read at most once.
 */
import fs from "node:fs";

export type LuminaPlatform = "windows" | "wsl" | "linux" | "macos" | "unknown";

let cached: LuminaPlatform | null = null;

export function detectPlatform(): LuminaPlatform {
  if (cached !== null) return cached;
  if (process.platform === "win32") {
    cached = "windows";
    return cached;
  }
  if (process.platform === "darwin") {
    cached = "macos";
    return cached;
  }
  if (process.platform === "linux") {
    try {
      const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
      if (v.includes("microsoft") || v.includes("wsl")) {
        cached = "wsl";
        return cached;
      }
    } catch {
      /* ignore — not WSL */
    }
    cached = "linux";
    return cached;
  }
  cached = "unknown";
  return cached;
}

/** Returns true when Windows-targeted tools (PowerShell, UIA, etc.) can run.
 *  True on real Windows AND on WSL (where powershell.exe is on the PATH). */
export function canRunWindowsHostTools(): boolean {
  const p = detectPlatform();
  return p === "windows" || p === "wsl";
}

/** Convert a WSL path like `/mnt/c/Users/x/foo.png` to Windows `C:\\Users\\x\\foo.png`.
 *  No-op on non-WSL. Returns the input if the path is not under `/mnt/<drive>/...`. */
export function toWindowsPath(p: string): string {
  if (detectPlatform() !== "wsl") return p;
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (!m) return p;
  const drive = m[1]!.toUpperCase();
  const rest = (m[2] ?? "").replace(/\//g, "\\");
  return `${drive}:${rest}`;
}

/** Convert a Windows path like `C:\\Users\\x\\foo.png` to WSL `/mnt/c/Users/x/foo.png`.
 *  No-op on non-WSL. Returns the input if the path is not a drive-rooted Windows path. */
export function toWslPath(p: string): string {
  if (detectPlatform() !== "wsl") return p;
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

/** Where to put temp files that BOTH WSL and the Windows host can see.
 *  - WSL: `/mnt/c/Users/<user>/AppData/Local/Temp/lumina-cognitive-os`
 *  - Windows: `%TEMP%\\lumina-cognitive-os`
 *  - Linux/macOS: `/tmp/lumina-cognitive-os` */
export function sharedTempDir(): string {
  const p = detectPlatform();
  if (p === "windows") {
    return (process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp") + "\\lumina-cognitive-os";
  }
  if (p === "wsl") {
    const home = process.env.WIN_HOME ?? "/mnt/c/Users/dal_n";
    return `${home}/AppData/Local/Temp/lumina-cognitive-os`;
  }
  return "/tmp/lumina-cognitive-os";
}
