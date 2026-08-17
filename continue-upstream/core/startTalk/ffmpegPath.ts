/**
 * ffmpegPath.ts — Localiza el binario de FFmpeg.
 *
 * Vivía dentro de `FfmpegMicrophoneCapture`, que se retiró al mover la captura
 * del micrófono al WebView (getUserMedia con cancelación de eco real). La
 * captura de pantalla y cámara sigue usando FFmpeg, así que la resolución de
 * la ruta queda aquí, ya sin el capturador de audio que la acompañaba.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function findFile(root: string, filename: string, depth: number): string[] {
  if (depth < 0 || !fs.existsSync(root)) {
    return [];
  }

  const matches: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      matches.push(fullPath);
    } else if (entry.isDirectory()) {
      matches.push(...findFile(fullPath, filename, depth - 1));
    }
  }

  return matches;
}

function findFfmpegInWingetPackages(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return undefined;
  }

  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (!fs.existsSync(packagesDir)) {
    return undefined;
  }

  const packageDirs = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("Gyan.FFmpeg_"),
    )
    .map((entry) => path.join(packagesDir, entry.name));

  for (const packageDir of packageDirs) {
    const matches = findFile(packageDir, "ffmpeg.exe", 4);
    if (matches.length > 0) {
      return matches[0];
    }
  }

  return undefined;
}

export function resolveFfmpegPath(): string {
  if (process.env.START_TALK_FFMPEG_PATH) {
    return process.env.START_TALK_FFMPEG_PATH;
  }

  const binaryName = os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // The extension bundles core as CommonJS, where __dirname points at `out`.
  // ESM test/source execution falls back to its working directory.
  const moduleDirectory =
    typeof __dirname === "string" ? __dirname : process.cwd();
  const bundledCandidates = [
    // Packaged VS Code extension: out/extension.js + out/ffmpeg(.exe).
    path.join(moduleDirectory, binaryName),
    // Source/dev execution from core/startTalk.
    path.resolve(moduleDirectory, "../../extensions/vscode/out", binaryName),
    path.resolve(moduleDirectory, "../node_modules/ffmpeg-static", binaryName),
    // Compiled core output (core/dist/startTalk).
    path.resolve(moduleDirectory, "../../node_modules/ffmpeg-static", binaryName),
    // Direct core development/tests and callers launched from the repo root.
    path.resolve(process.cwd(), "node_modules/ffmpeg-static", binaryName),
    path.resolve(process.cwd(), "core/node_modules/ffmpeg-static", binaryName),
    path.resolve(
      process.cwd(),
      "../../core/node_modules/ffmpeg-static",
      binaryName,
    ),
  ];
  const bundledFfmpeg = bundledCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (bundledFfmpeg) {
    return bundledFfmpeg;
  }

  const wingetFfmpeg = findFfmpegInWingetPackages();
  if (wingetFfmpeg) {
    return wingetFfmpeg;
  }

  return "ffmpeg";
}
