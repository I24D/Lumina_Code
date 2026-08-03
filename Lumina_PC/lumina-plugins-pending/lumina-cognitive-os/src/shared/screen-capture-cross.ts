/**
 * screen-capture-cross.ts — Cross-platform screen capture.
 *
 *   Windows (`process.platform === "win32"`)   → in-process PowerShell + .NET
 *   WSL     (Linux kernel, Windows host)        → invoke `powershell.exe` over interop
 *   Linux   (X11/Wayland)                       → try `gnome-screenshot` → `scrot`
 *                                                  → `grim` (wayland) → `import`
 *   macOS                                       → `screencapture`
 *
 * All paths produce a PNG file at the requested path and return its
 * dimensions string (e.g. "1920x1080"). Throws on terminal failure so
 * the caller can decide whether to surface or fallback.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { detectPlatform, toWindowsPath } from "./platform.js";

export type CaptureMode = "primary" | "all";

export type CaptureResult = {
  readonly path: string;
  readonly resolution: string;
  readonly engine:
    | "windows-powershell"
    | "wsl-powershell-interop"
    | "linux-gnome-screenshot"
    | "linux-scrot"
    | "linux-grim"
    | "linux-import"
    | "macos-screencapture";
};

type SpawnResult = { ok: boolean; stdout: string; stderr: string; code: number };

function execOnce(
  cmd: string,
  args: ReadonlyArray<string>,
  timeoutMs = 15_000,
  stdin?: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr, code: -1 });
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, code: -1 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: (code ?? -1) === 0, stdout, stderr, code: code ?? -1 });
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

function powershellScript(outPath: string): string {
  // Single-line PowerShell ES escape-safe. {OUTPATH} replaced later.
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$b = ([System.Windows.Forms.Screen]::PrimaryScreen).Bounds",
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    "$g.Dispose()",
    `$bmp.Save("${outPath.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$bmp.Dispose()",
    'Write-Output ("{0}x{1}" -f $b.Width, $b.Height)',
  ].join("; ");
}

async function captureWindows(outPath: string): Promise<CaptureResult> {
  const r = await execOnce("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", powershellScript(outPath),
  ], 20_000);
  if (!r.ok) throw new Error(`PowerShell capture failed: ${r.stderr || `exit ${r.code}`}`);
  return { path: outPath, resolution: r.stdout.trim(), engine: "windows-powershell" };
}

async function captureWsl(outPath: string): Promise<CaptureResult> {
  // outPath is a WSL path like /mnt/c/.../foo.png — translate to Windows for PowerShell.
  const winPath = toWindowsPath(outPath);
  const r = await execOnce("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", powershellScript(winPath),
  ], 20_000);
  if (!r.ok) {
    throw new Error(`WSL→PowerShell capture failed: ${r.stderr || `exit ${r.code}`}. ` +
      `Make sure powershell.exe is on PATH inside WSL (default in WSL2).`);
  }
  return { path: outPath, resolution: r.stdout.trim(), engine: "wsl-powershell-interop" };
}

async function captureLinux(outPath: string): Promise<CaptureResult> {
  // Try common screenshot tools in order. First one available wins.
  const attempts: Array<{ cmd: string; args: string[]; engine: CaptureResult["engine"] }> = [
    { cmd: "gnome-screenshot", args: ["-f", outPath], engine: "linux-gnome-screenshot" },
    { cmd: "scrot",            args: [outPath],       engine: "linux-scrot" },
    { cmd: "grim",             args: [outPath],       engine: "linux-grim" },
    { cmd: "import",           args: ["-window", "root", outPath], engine: "linux-import" },
  ];
  let lastErr = "no screenshot tool installed (tried gnome-screenshot/scrot/grim/import)";
  for (const a of attempts) {
    const r = await execOnce(a.cmd, a.args, 20_000);
    if (r.ok) {
      // Read dimensions via the file itself — `identify` (ImageMagick) if available.
      const dim = await execOnce("identify", ["-format", "%wx%h", outPath], 5_000);
      const resolution = dim.ok ? dim.stdout.trim() : "unknown";
      return { path: outPath, resolution, engine: a.engine };
    }
    lastErr = `${a.cmd}: ${r.stderr.trim() || `exit ${r.code}`}`;
  }
  throw new Error(`Linux capture failed: ${lastErr}`);
}

async function captureMacos(outPath: string): Promise<CaptureResult> {
  const r = await execOnce("screencapture", ["-x", outPath], 20_000);
  if (!r.ok) throw new Error(`macOS screencapture failed: ${r.stderr || `exit ${r.code}`}`);
  return { path: outPath, resolution: "unknown", engine: "macos-screencapture" };
}

export async function capturePrimaryScreen(outPath: string): Promise<CaptureResult> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const p = detectPlatform();
  if (p === "windows") return captureWindows(outPath);
  if (p === "wsl")     return captureWsl(outPath);
  if (p === "linux")   return captureLinux(outPath);
  if (p === "macos")   return captureMacos(outPath);
  throw new Error(`unsupported platform for screen capture: ${p}`);
}
