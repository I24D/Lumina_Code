import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import type { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

export type MicrophoneCaptureHandlers = {
  onAudio: (data: Buffer) => void;
  onError: (message: string) => void;
  onStop: (reason: "requested" | "ended") => void;
};

function findFfmpegInWingetPackages(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return undefined;
  }

  const packagesDir = path.join(
    localAppData,
    "Microsoft",
    "WinGet",
    "Packages",
  );
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
    path.resolve(
      moduleDirectory,
      "../../node_modules/ffmpeg-static",
      binaryName,
    ),
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

function listDirectShowAudioDevices(ffmpegPath: string): string[] {
  if (os.platform() !== "win32") {
    return [];
  }

  const result = spawnSync(
    ffmpegPath,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const devices: string[] = [];
  const matcher = /"([^"]+)"\s+\(audio\)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(output))) {
    devices.push(match[1]);
  }

  return devices;
}

/** Parses macOS AVFoundation audio input devices (name preserves its index). */
function listAvFoundationAudioDevices(ffmpegPath: string): string[] {
  const result = spawnSync(
    ffmpegPath,
    ["-hide_banner", "-list_devices", "true", "-f", "avfoundation", "-i", ""],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const devices: string[] = [];
  let inAudioSection = false;
  for (const rawLine of output.split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(rawLine)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(rawLine)) {
      inAudioSection = false;
      continue;
    }
    if (inAudioSection) {
      const match = rawLine.match(/\[(\d+)\]\s+(.+?)\s*$/);
      if (match) {
        devices.push(match[2]);
      }
    }
  }
  return devices;
}

/** Lists PulseAudio sources on Linux via `pactl` (falls back to "default"). */
function listPulseAudioDevices(): string[] {
  const result = spawnSync("pactl", ["list", "short", "sources"], {
    encoding: "utf8",
  });
  const output = result.stdout ?? "";
  const devices: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.split(/\t/);
    if (columns.length >= 2 && columns[1]) {
      devices.push(columns[1]);
    }
  }
  return devices.length ? devices : ["default"];
}

/** Lists microphone input devices for the current platform. */
export function listAudioInputDevices(
  ffmpegPath: string = resolveFfmpegPath(),
): string[] {
  switch (os.platform()) {
    case "win32":
      return listDirectShowAudioDevices(ffmpegPath);
    case "darwin":
      return listAvFoundationAudioDevices(ffmpegPath);
    default:
      return listPulseAudioDevices();
  }
}

/**
 * Builds the FFmpeg input format + input specifier for the current platform.
 * On macOS the device is addressed by its AVFoundation index, resolved from the
 * device name when necessary.
 */
function buildCaptureInput(
  ffmpegPath: string,
  selectedDevice: string,
): { format: string; input: string } {
  switch (os.platform()) {
    case "win32":
      return { format: "dshow", input: `audio=${selectedDevice}` };
    case "darwin": {
      // Accept a raw index (":0") or resolve a device name to its index.
      let index = "0";
      if (/^\d+$/.test(selectedDevice)) {
        index = selectedDevice;
      } else {
        const devices = listAvFoundationAudioDevices(ffmpegPath);
        const found = devices.findIndex((name) => name === selectedDevice);
        if (found >= 0) {
          index = String(found);
        }
      }
      return { format: "avfoundation", input: `:${index}` };
    }
    default:
      return { format: "pulse", input: selectedDevice || "default" };
  }
}

export class FfmpegMicrophoneCapture {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private stopRequested = false;

  start(
    deviceName: string | undefined,
    handlers: MicrophoneCaptureHandlers,
  ): void {
    this.stop();
    this.stopRequested = false;

    const ffmpegPath = resolveFfmpegPath();
    const selectedDevice =
      deviceName ??
      process.env.START_TALK_AUDIO_DEVICE ??
      listAudioInputDevices(ffmpegPath)[0];

    if (!selectedDevice) {
      throw new Error("No microphone input device was found.");
    }

    const { format, input } = buildCaptureInput(ffmpegPath, selectedDevice);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      format,
      "-i",
      input,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ];

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = child;

    child.stdout.on("data", handlers.onAudio);
    child.stderr.on("data", (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        handlers.onError(message);
      }
    });
    child.on("error", (error) => handlers.onError(error.message));
    child.on("close", () => {
      const reason = this.stopRequested ? "requested" : "ended";
      if (this.process === child) {
        this.process = undefined;
      }
      this.stopRequested = false;
      handlers.onStop(reason);
    });
  }

  stop(): void {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.stopRequested = true;
    this.process = undefined;
    child.kill("SIGTERM");
  }
}
