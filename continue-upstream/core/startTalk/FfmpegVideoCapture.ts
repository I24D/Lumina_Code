import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import os from "node:os";
import type { Readable } from "node:stream";

import { resolveFfmpegPath } from "./ffmpegPath.js";
import type { StartTalkVideoRegion, StartTalkVideoSource } from "./types.js";

export type VideoCaptureHandlers = {
  /** Un fotograma JPEG completo (base64) listo para enviar a Gemini Live. */
  onFrame: (jpegBase64: string) => void;
  onError: (message: string) => void;
  onStop: (reason: "requested" | "ended") => void;
};

export type VideoCaptureOptions = {
  /** Solo pantalla: recorta a un monitor concreto del escritorio virtual. */
  region?: StartTalkVideoRegion;
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

/**
 * Filtro que descarta fotogramas casi idénticos al anterior. La Live API cobra
 * ~258 tokens por fotograma y la ventana de contexto es de 128k, así que enviar
 * 1 fps de una pantalla estática agota la sesión en pocos minutos sin aportar
 * nada. `frac` es la fracción de bloques 8x8 que deben cambiar para conservar
 * el fotograma: con 0.01 un cursor parpadeando se descarta, pero escribir una
 * línea de código sí se envía.
 */
function buildDecimateFilter(): string {
  const custom = process.env.START_TALK_VIDEO_DECIMATE;
  if (custom === "false" || custom === "0" || custom === "off") {
    return "";
  }
  return custom && custom !== "true"
    ? `mpdecimate=${custom}`
    : "mpdecimate=hi=768:lo=320:frac=0.01";
}

function resolveMaxWidth(source: StartTalkVideoSource): number {
  const raw = Number(process.env.START_TALK_VIDEO_MAX_WIDTH);
  if (Number.isFinite(raw) && raw >= 320 && raw <= 3840) {
    return Math.floor(raw);
  }
  // La pantalla lleva texto pequeño: más píxeles antes del reescalado del
  // servidor mejora la lectura. La cámara no necesita tanto detalle.
  return source === "screen" ? 1280 : 1024;
}

/**
 * Enumera los monitores físicos mediante WinForms. Sirve para compartir UN
 * monitor en lugar del escritorio virtual completo, que en multi-monitor genera
 * una imagen panorámica en la que no se lee nada tras escalarla.
 */
export function listDisplayMonitors(): {
  id: string;
  label: string;
  region: StartTalkVideoRegion;
  primary: boolean;
}[] {
  if (os.platform() !== "win32") {
    return [];
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    name = $_.DeviceName
    primary = [bool]$_.Primary
    x = $_.Bounds.X
    y = $_.Bounds.Y
    width = $_.Bounds.Width
    height = $_.Bounds.Height
  }
}
ConvertTo-Json -InputObject @($screens) -Compress
`.trim();

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 8000 },
  );

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      primary: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    }[];

    return parsed.map((screen, index) => ({
      id: screen.name || `display-${index}`,
      label: `${screen.primary ? "Monitor principal" : `Monitor ${index + 1}`} (${screen.width}×${screen.height})`,
      region: {
        x: screen.x,
        y: screen.y,
        width: screen.width,
        height: screen.height,
      },
      primary: Boolean(screen.primary),
    }));
  } catch {
    return [];
  }
}

/** Cámaras DirectShow disponibles, por nombre. */
export function listVideoInputDevices(): string[] {
  return listDirectShowVideoDevices(resolveFfmpegPath());
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

function buildScreenInputArgs(
  framerate: string,
  region: StartTalkVideoRegion | undefined,
): string[] {
  const args = ["-f", "gdigrab", "-framerate", framerate];
  if (region && region.width > 0 && region.height > 0) {
    // gdigrab recorta con offset + tamaño, en coordenadas del escritorio
    // virtual (un monitor secundario a la izquierda tiene x negativa).
    args.push(
      "-offset_x",
      String(region.x),
      "-offset_y",
      String(region.y),
      "-video_size",
      `${region.width}x${region.height}`,
    );
  }
  args.push("-i", "desktop");
  return args;
}

/**
 * Construye la línea de comando del stream continuo. Está separada y exportada
 * porque un error aquí es SILENCIOSO: si falta `-fps_mode vfr`, FFmpeg vuelve a
 * duplicar los fotogramas que `mpdecimate` acaba de descartar y la decimación
 * deja de existir sin que nada falle visiblemente.
 */
export function buildStreamArgs(
  ffmpegPath: string,
  source: StartTalkVideoSource,
  deviceName: string | undefined,
  region: StartTalkVideoRegion | undefined,
): string[] {
  let inputArgs: string[];

  if (source === "screen") {
    inputArgs = buildScreenInputArgs("1", region);
  } else {
    const camera =
      deviceName ??
      process.env.START_TALK_VIDEO_DEVICE ??
      listDirectShowVideoDevices(ffmpegPath)[0];

    if (!camera) {
      throw new Error("No DirectShow camera device was found.");
    }

    // Sin -framerate en la entrada: se limita a 1 fps en la salida con `fps=1`.
    inputArgs = ["-f", "dshow", "-i", `video=${camera}`];
  }

  // La cámara (dshow) no acepta forzar el framerate de entrada a 1 fps: la
  // webcam solo expone modos nativos (30/15…) y falla con "Could not set video
  // options". Por eso se limita a 1 fps en la SALIDA con el filtro `fps=1`.
  // gdigrab (pantalla) sí acepta `-framerate 1` en la entrada.
  const scale = `scale='min(${resolveMaxWidth(source)},iw)':-2`;
  // Solo la pantalla se decima: una webcam siempre tiene ruido de sensor, así
  // que la decimación nunca dispararía y además ahí sí interesa la continuidad.
  const decimate = source === "screen" ? buildDecimateFilter() : "";
  const vf = [source === "camera" ? "fps=1" : "", scale, decimate]
    .filter(Boolean)
    .join(",");

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputArgs,
    "-vf",
    vf,
    ...(decimate ? ["-fps_mode", "vfr"] : []),
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "7",
    "pipe:1",
  ];
}

/**
 * Captura UN fotograma y termina (~215 ms medidos en Windows). El stream
 * continuo descarta los fotogramas repetidos, lo que significa que con una
 * pantalla quieta no emite nada — ni siquiera el primero. Esta captura puntual
 * es la que garantiza que el modelo SIEMPRE tenga una vista actual: se usa al
 * arrancar y para refrescar bajo demanda.
 *
 * Usa `-framerate 30` en la entrada a propósito: con `-framerate 1` gdigrab
 * espera un segundo entero antes de entregar el fotograma (2.1 s frente a
 * 0.2 s medidos).
 */
export function grabSingleFrame(
  source: StartTalkVideoSource,
  deviceName?: string,
  region?: StartTalkVideoRegion,
  timeoutMs = 6000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    const input =
      source === "screen"
        ? buildScreenInputArgs("30", region)
        : [
            "-f",
            "dshow",
            "-i",
            `video=${
              deviceName ??
              process.env.START_TALK_VIDEO_DEVICE ??
              listDirectShowVideoDevices(ffmpegPath)[0] ??
              ""
            }`,
          ];

    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...input,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${resolveMaxWidth(source)},iw)':-2`,
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "7",
        "pipe:1",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      // Un JPEG válido empieza por SOI (FFD8); si no, la captura falló.
      if (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        resolve(buffer.toString("base64"));
      } else {
        reject(
          new Error(
            stderr.trim() || "FFmpeg no devolvió ningún fotograma válido.",
          ),
        );
      }
    });
  });
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
    options: VideoCaptureOptions = {},
  ): void {
    this.stop();
    this.stopRequested = false;
    this.buffer = Buffer.alloc(0);

    const ffmpegPath = resolveFfmpegPath();
    const args = buildStreamArgs(
      ffmpegPath,
      source,
      deviceName,
      options.region,
    );

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
