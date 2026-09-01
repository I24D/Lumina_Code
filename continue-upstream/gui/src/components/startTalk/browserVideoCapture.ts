import type { StartTalkVideoSource } from "core/startTalk";

export interface BrowserVideoFrame {
  data: string;
  mimeType: "image/jpeg";
}

export interface BrowserVideoSelection {
  sourceId: string;
  label: string;
}

interface DisplayMediaOptions extends DisplayMediaStreamOptions {
  monitorTypeSurfaces?: "include" | "exclude";
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
}

type CaptureCallbacks = {
  onEnded: () => void;
  onError: (message: string) => void;
  onFrame: (frame: BrowserVideoFrame) => Promise<void>;
};

const FRAME_INTERVAL_MS = 1_000;
const MAX_FRAME_EDGE = 1_280;
const JPEG_QUALITY = 0.76;

function displaySurfaceLabel(track: MediaStreamTrack): string {
  const settings = track.getSettings() as MediaTrackSettings & {
    displaySurface?: "browser" | "monitor" | "window";
  };
  const surface = settings.displaySurface;
  if (surface === "browser") return "Pestaña compartida";
  if (surface === "window") return "Ventana compartida";
  if (surface === "monitor") return "Pantalla compartida";
  return track.label || "Pantalla compartida";
}

export function formatVideoCaptureError(
  error: unknown,
  source: StartTalkVideoSource,
): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") {
    return source === "camera"
      ? "No se autorizó el acceso a la cámara. Puedes volver a intentarlo desde el botón de cámara."
      : "No se autorizó compartir la pantalla. Puedes volver a intentarlo desde el botón de compartir.";
  }
  if (name === "NotFoundError") {
    return source === "camera"
      ? "No se encontró ninguna cámara disponible."
      : "No se encontró una pantalla o ventana disponible para compartir.";
  }
  if (name === "NotReadableError") {
    return source === "camera"
      ? "La cámara está siendo usada por otra aplicación o Windows bloqueó el acceso."
      : "El navegador no pudo leer la superficie seleccionada.";
  }
  if (name === "AbortError") {
    return "La selección se canceló antes de iniciar la captura.";
  }
  return error instanceof Error
    ? error.message
    : "No se pudo iniciar la captura visual.";
}

/**
 * Captura pantalla o cámara con el selector y los permisos nativos del
 * navegador. El stream nunca cruza el puente: solo se envía un JPEG reducido
 * por segundo al modelo, y se descartan ticks si el anterior sigue en vuelo.
 */
export class BrowserVideoCapture {
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private timer?: ReturnType<typeof setInterval>;
  private callbacks?: CaptureCallbacks;
  private frameInFlight = false;
  private generation = 0;

  async startScreen(
    callbacks: CaptureCallbacks,
  ): Promise<BrowserVideoSelection> {
    this.stop();
    const requestGeneration = this.generation;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Este navegador no permite compartir pantalla.");
    }

    // Esta llamada debe ser la primera operación asíncrona tras el clic. Los
    // navegadores exigen activación transitoria y muestran su propio selector.
    const options: DisplayMediaOptions = {
      audio: false,
      video: {
        width: { ideal: 1_920 },
        height: { ideal: 1_080 },
        frameRate: { ideal: 5, max: 10 },
      },
      monitorTypeSurfaces: "include",
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "exclude",
    };
    const stream = await mediaDevices.getDisplayMedia(options);
    return this.attach(stream, "screen", callbacks, requestGeneration);
  }

  async startCamera(
    callbacks: CaptureCallbacks,
  ): Promise<BrowserVideoSelection> {
    this.stop();
    const requestGeneration = this.generation;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("Este navegador no permite usar la cámara.");
    }

    const stream = await mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1_280 },
        height: { ideal: 720 },
        frameRate: { ideal: 15, max: 30 },
      },
    });
    return this.attach(stream, "camera", callbacks, requestGeneration);
  }

  private async attach(
    stream: MediaStream,
    source: StartTalkVideoSource,
    callbacks: CaptureCallbacks,
    requestGeneration: number,
  ): Promise<BrowserVideoSelection> {
    if (this.generation !== requestGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException(
        "A newer video request replaced this one.",
        "AbortError",
      );
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((candidate) => candidate.stop());
      throw new Error("La fuente seleccionada no proporcionó vídeo.");
    }

    const generation = this.generation;
    this.stream = stream;
    this.callbacks = callbacks;
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    this.canvas = document.createElement("canvas");

    track.addEventListener(
      "ended",
      () => {
        if (this.generation !== generation) return;
        this.stop();
        callbacks.onEnded();
      },
      { once: true },
    );

    try {
      await video.play();
    } catch (error) {
      this.stop();
      throw error;
    }

    this.timer = setInterval(() => void this.captureFrame(), FRAME_INTERVAL_MS);
    return {
      sourceId: track.id,
      label:
        source === "screen"
          ? displaySurfaceLabel(track)
          : track.label || "Cámara activa",
    };
  }

  async captureFrame(): Promise<void> {
    if (this.frameInFlight || !this.video || !this.canvas || !this.callbacks) {
      return;
    }
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    this.frameInFlight = true;
    try {
      const scale = Math.min(
        1,
        MAX_FRAME_EDGE / Math.max(sourceWidth, sourceHeight),
      );
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      this.canvas.width = width;
      this.canvas.height = height;
      const context = this.canvas.getContext("2d", { alpha: false });
      if (!context)
        throw new Error("No se pudo preparar el fotograma de vídeo.");
      context.drawImage(this.video, 0, 0, width, height);
      const encoded = this.canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const comma = encoded.indexOf(",");
      if (comma < 0)
        throw new Error("El navegador devolvió un fotograma inválido.");
      await this.callbacks.onFrame({
        data: encoded.slice(comma + 1),
        mimeType: "image/jpeg",
      });
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.frameInFlight = false;
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.video) this.video.srcObject = null;
    this.video = undefined;
    this.canvas = undefined;
    this.callbacks = undefined;
    this.frameInFlight = false;
  }
}
