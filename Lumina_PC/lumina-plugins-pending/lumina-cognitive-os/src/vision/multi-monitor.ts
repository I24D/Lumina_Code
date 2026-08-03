/**
 * multi-monitor.ts — Tool: lumina_vision_multimonitor
 *
 * Captures ALL attached displays (not just the primary) and returns them
 * as a list of PNG paths + base64. Lumina needs this because the user
 * often has the action on monitor B while monitor A shows the chat.
 *
 * Implementation: a single PowerShell pass that walks
 * [System.Windows.Forms.Screen]::AllScreens and dumps each Bitmap.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPowerShell } from "../shared/powershell.js";
import {
  canRunWindowsHostTools,
  detectPlatform,
  sharedTempDir,
  toWindowsPath,
  toWslPath,
} from "../shared/platform.js";

const PS_TEMPLATE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$results = @()
$screens = [System.Windows.Forms.Screen]::AllScreens
for ($i = 0; $i -lt $screens.Count; $i++) {
  $s = $screens[$i]
  $bounds = $s.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $outPath = Join-Path "{OUTDIR}" ("monitor-{0}.png" -f $i)
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $results += [pscustomobject]@{
    Index = $i
    Path = $outPath
    Primary = $s.Primary
    Width = $bounds.Width
    Height = $bounds.Height
    X = $bounds.X
    Y = $bounds.Y
  }
}
$results | ConvertTo-Json -Depth 4 -Compress
`;

export type MonitorCapture = {
  readonly index: number;
  readonly primary: boolean;
  readonly path: string;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly base64?: string;
};

export function createMultiMonitorTool(config: { screenshotDir?: string } = {}): AnyAgentTool {
  return {
    name: "lumina_vision_multimonitor",
    label: "Lumina Vision — Multimonitor",
    description:
      "Captures EVERY attached display (not just the primary). Returns one entry per monitor with index, " +
      "primary flag, bounds and PNG path. Use this when the user references 'la otra pantalla' or when an " +
      "OCR / UI tool result on the primary screen looks empty.",
    parameters: Type.Object({
      includeBase64: Type.Optional(
        Type.Boolean({ description: "If true, include base64-encoded PNG for each monitor." }),
      ),
      maxMonitors: Type.Optional(
        Type.Number({ minimum: 1, maximum: 8, default: 4 }),
      ),
    }),
    async execute(_id, params) {
      const platform = detectPlatform();
      if (!canRunWindowsHostTools()) {
        return jsonResult({
          ok: false,
          error: `multimonitor capture needs Windows or WSL (current platform: ${platform}). ` +
            `On native Linux/macOS use the single-monitor lumina_screen_capture tool which has ` +
            `cross-platform fallbacks (gnome-screenshot/scrot/grim/screencapture).`,
        });
      }
      // On WSL we need a path Windows can see AND that we can read back from Linux.
      // sharedTempDir() returns /mnt/c/Users/.../Temp/lumina-cognitive-os on WSL,
      // or %TEMP%\\lumina-cognitive-os on Windows.
      const dir =
        config.screenshotDir && config.screenshotDir.length > 0
          ? config.screenshotDir
          : (platform === "wsl" || platform === "windows"
              ? sharedTempDir() + "/lumina-multimonitor"
              : path.join(os.tmpdir(), "lumina-multimonitor"));
      await fs.mkdir(dir, { recursive: true });
      // PowerShell needs the Windows form of the path even when called from WSL.
      const winDir = toWindowsPath(dir);
      const escapedDir = winDir.replace(/\\/g, "\\\\");
      const script = PS_TEMPLATE.replace("{OUTDIR}", escapedDir);
      const r = await runPowerShell(script, 12_000);
      if (!r.ok) {
        return jsonResult({ ok: false, error: r.error ?? r.stderr ?? `exit ${r.code}` });
      }
      const text = r.stdout.trim();
      if (text.length === 0) {
        return jsonResult({ ok: false, error: "no monitor data captured" });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        return jsonResult({
          ok: false,
          error: `failed to parse capture output: ${(err as Error).message}`,
        });
      }
      const arr = Array.isArray(raw) ? raw : [raw];
      const cap = Math.max(1, Math.min(arr.length, params.maxMonitors ?? 4));
      const includeBase64 = params.includeBase64 === true;
      const out: MonitorCapture[] = [];
      for (let i = 0; i < cap; i++) {
        const entry = arr[i] as {
          Index: number;
          Path: string;
          Primary: boolean;
          Width: number;
          Height: number;
          X: number;
          Y: number;
        };
        // PowerShell returns Windows paths; on WSL we need the /mnt/c form to read the file.
        const fsPath = platform === "wsl" ? toWslPath(entry.Path) : entry.Path;
        const base: MonitorCapture = {
          index: entry.Index,
          primary: entry.Primary,
          path: fsPath,
          bounds: { x: entry.X, y: entry.Y, width: entry.Width, height: entry.Height },
        };
        if (includeBase64) {
          try {
            const buf = await fs.readFile(fsPath);
            out.push({ ...base, base64: buf.toString("base64") });
          } catch {
            out.push(base);
          }
        } else {
          out.push(base);
        }
      }
      return jsonResult({ ok: true, monitors: out });
    },
  };
}
