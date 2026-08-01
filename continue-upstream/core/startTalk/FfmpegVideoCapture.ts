import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import os from "node:os";
import type { Readable } from "node:stream";

import { resolveFfmpegPath } from "./FfmpegMicrophoneCapture.js";
import type { StartTalkVideoSource } from "./types.js";

export type VideoCaptureHandlers = {
  /** Un fotograma JPEG completo (base64) listo para enviar a Gemini Live. */
  onFrame: (jpegBase64: string) => void;
  onError: (message: string) => void;
  onStop: (reason: "requested" | "ended") => void;
};

const SOI = Buffer.from([0xff, 0xd8]); // Start Of Image
const EOI = Buffer.from([0xff, 0xd9]); // End Of Image

/**
 * Trocea un stream MJPEG en fotogramas JPEG completos. Devuelve los fotogramas
 * cerrados (SOI…EOI) y el resto sin consumir (fotograma incompleto), para
 * concatenar con el siguiente chunk. Función pura → testeable.
 */
export function splitMjpegStream(buffer: Buffer): {
  frames: Buffer[];
  rest: Buffer;
} {
  const frames: Buffer[] = [];
  let cursor = 0;

  while (true) {
    const start = buffer.indexOf(SOI, cursor);
    if (start < 0) {
      // Sin inicio de imagen: nada aprovechable, descarta lo acumulado.
      return { frames, rest: Buffer.alloc(0) };
    }

    const end = buffer.indexOf(EOI, start + 2);
    if (end < 0) {
      // Fotograma incompleto: conserva desde el SOI y espera más datos.
      return { frames, rest: buffer.subarray(start) };
    }

    frames.push(buffer.subarray(start, end + 2));
    cursor = end + 2;
  }
}

function listDirectShowVideoDevices(ffmpegPath: string): string[] {
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
  const matcher = /"([^"]+)"\s+\(video\)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(output))) {
    devices.push(match[1]);
  }

  return devices;
}

/**
 * Captura vídeo (pantalla o cámara) en core con FFmpeg y emite fotogramas JPEG
 * a ~1 fps, que es la resolución temporal que consume la Gemini Live API.
 *
 * Se hace en core —igual que el micrófono— porque el WebView de VS Code bloquea
 * `getUserMedia`/`getDisplayMedia`. En Windows: `gdigrab` para pantalla, `dshow`
 * para cámara.
 */
export class FfmpegVideoCapture {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private stopRequested = false;
  private buffer: Buffer = Buffer.alloc(0);

  start(
    source: StartTalkVideoSource,
    deviceName: string | undefined,
    handlers: VideoCaptureHandlers,
  ): void {
    this.stop();
    this.stopRequested = false;
    this.buffer = Buffer.alloc(0);

    const ffmpegPath = resolveFfmpegPath();
    const inputArgs = this.buildInputArgs(ffmpegPath, source, deviceName);

    // La cámara (dshow) no acepta forzar el framerate de entrada a 1 fps: la
    // webcam solo expone modos nativos (30/15…) y falla con "Could not set
    // video options". Por eso limitamos a 1 fps en la SALIDA con el filtro
    // `fps=1`. gdigrab (pantalla) sí acepta `-framerate 1` en la entrada.
    const scale = "scale='min(1024,iw)':-2";
    const vf = source === "camera" ? `fps=1,${scale}` : scale;

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs,
      // Escala a un ancho máximo razonable manteniendo alto par (-2).
      "-vf",
      vf,
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "7",
      "pipe:1",
    ];

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = child;

    child.stdout.on("data", (data: Buffer) => this.ingest(data, handlers));
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

  private buildInputArgs(
    ffmpegPath: string,
    source: StartTalkVideoSource,
    deviceName: string | undefined,
  ): string[] {
    if (source === "screen") {
      return ["-f", "gdigrab", "-framerate", "1", "-i", "desktop"];
    }

    const camera =
      deviceName ??
      process.env.START_TALK_VIDEO_DEVICE ??
      listDirectShowVideoDevices(ffmpegPath)[0];

    if (!camera) {
      throw new Error("No DirectShow camera device was found.");
    }

    // Sin -framerate en la entrada: se limita a 1 fps en la salida (ver start()).
    return ["-f", "dshow", "-i", `video=${camera}`];
  }

  /** Trocea el stream MJPEG en fotogramas JPEG completos (SOI…EOI). */
  private ingest(data: Buffer, handlers: VideoCaptureHandlers): void {
    const { frames, rest } = splitMjpegStream(
      Buffer.concat([this.buffer, data]),
    );
    this.buffer = rest;
    for (const frame of frames) {
      handlers.onFrame(frame.toString("base64"));
    }
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
