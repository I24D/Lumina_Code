/**
 * screen-capture.ts
 * Tool: lumina_screen_capture
 *
 * In hybrid DEV, OpenClaw runs in WSL and delegates Windows screenshots to
 * Lumina Windows Bridge. In native Windows mode it captures locally.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { imageResultFromFile, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { psEscape, runPowerShell } from "../utils/powershell.js";
import {
  bridgePost,
  isWindowsBridgeMode,
  windowsPathToWslPath,
} from "../utils/windows-bridge.js";

export type ScreenCaptureConfig = {
  screenshotDir?: string;
};

export function createScreenCaptureTool(config: ScreenCaptureConfig = {}): AnyAgentTool {
  return {
    name: "lumina_screen_capture",
    description:
      "Takes a screenshot of the Windows PC and returns it as an image. " +
      "In WSL dev mode this uses Lumina Windows Bridge.",
    parameters: Type.Object({
      ocr: Type.Optional(
        Type.Boolean({
          description:
            "If true, also extract visible text via Windows OCR when available. Default: false.",
        }),
      ),
      return_image: Type.Optional(
        Type.Boolean({
          description: "If true (default), include the screenshot image in the result.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (isWindowsBridgeMode()) {
        const response = await bridgePost("/screenshot");
        if (response.ok !== true || typeof response.path !== "string") {
          return jsonResult({
            ok: false,
            error: response.error ?? "windows_bridge_screenshot_failed",
          });
        }

        const windowsPath = response.path;
        const outPath = windowsPathToWslPath(windowsPath);
        if (params.return_image !== false) {
          return imageResultFromFile({
            label: "Screenshot",
            path: outPath,
            extraText: `Screenshot captured through Lumina Windows Bridge at ${new Date().toISOString()}`,
            details: {
              path: outPath,
              windows_path: windowsPath,
              via: "lumina-windows-bridge",
              timestamp: new Date().toISOString(),
            },
          });
        }

        return jsonResult({
          ok: true,
          path: outPath,
          windows_path: windowsPath,
          via: "lumina-windows-bridge",
          timestamp: new Date().toISOString(),
        });
      }

      if (process.platform !== "win32") {
        return jsonResult({
          ok: false,
          error: "lumina_screen_capture requires Windows or Lumina Windows Bridge.",
        });
      }

      const screenshotDir = config.screenshotDir ?? path.join(os.tmpdir(), "lumina-pc-screenshots");
      await fs.mkdir(screenshotDir, { recursive: true });

      const outPath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
      const screenshot = await runPowerShell(
        `$bounds = ([System.Windows.Forms.Screen]::PrimaryScreen).Bounds; ` +
          `Add-Type -AssemblyName System.Windows.Forms; ` +
          `Add-Type -AssemblyName System.Drawing; ` +
          `$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); ` +
          `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
          `$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); ` +
          `$g.Dispose(); ` +
          `$bmp.Save("${psEscape(outPath)}", [System.Drawing.Imaging.ImageFormat]::Png); ` +
          `$bmp.Dispose(); ` +
          `Write-Output "$($bounds.Width)x$($bounds.Height)"`,
        20_000,
      );

      if (!screenshot.ok) {
        return jsonResult({
          ok: false,
          error: `Screenshot failed: ${screenshot.error ?? screenshot.stderr}`,
        });
      }

      const resolution = screenshot.stdout.trim();
      let ocrText: string | undefined;
      if (params.ocr === true) {
        const ocr = await runPowerShell(
          `Add-Type -AssemblyName System.Runtime.WindowsRuntime; ` +
            `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); ` +
            `if ($engine) { ` +
            `  $file = [Windows.Storage.StorageFile]::GetFileFromPathAsync("${psEscape(outPath)}").GetAwaiter().GetResult(); ` +
            `  $stream = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read).GetAwaiter().GetResult(); ` +
            `  $decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult(); ` +
            `  $bitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult(); ` +
            `  $result = $engine.RecognizeAsync($bitmap).GetAwaiter().GetResult(); ` +
            `  $stream.Dispose(); ` +
            `  $result.Lines | ForEach-Object { $_.Text } | Join-String -Separator " " ` +
            `} else { Write-Output "" }`,
          30_000,
        );
        ocrText = ocr.ok ? ocr.stdout.trim() : undefined;
      }

      if (params.return_image !== false) {
        return imageResultFromFile({
          label: "Screenshot",
          path: outPath,
          extraText: [
            `Screenshot captured at ${new Date().toISOString()}`,
            resolution ? `Resolution: ${resolution}` : "",
            ocrText ? `\nOCR text:\n${ocrText}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          details: {
            resolution,
            path: outPath,
            ocr_text: ocrText,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return jsonResult({
        ok: true,
        path: outPath,
        resolution,
        ocr_text: ocrText,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
