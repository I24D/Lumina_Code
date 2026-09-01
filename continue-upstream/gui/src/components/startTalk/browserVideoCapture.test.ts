import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserVideoCapture,
  formatVideoCaptureError,
} from "./browserVideoCapture";

function mockCaptureEnvironment(source: "screen" | "camera") {
  let ended: (() => void) | undefined;
  const track = {
    id: `${source}-track`,
    label: source === "camera" ? "Lumina Camera" : "Entire Screen",
    getSettings: () =>
      source === "screen" ? { displaySurface: "monitor" } : {},
    addEventListener: (_name: string, listener: () => void) => {
      ended = listener;
    },
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const getDisplayMedia = vi.fn().mockResolvedValue(stream);
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia, getUserMedia },
  });

  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    videoWidth: 1_920,
    videoHeight: 1_080,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement;
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toDataURL: () => "data:image/jpeg;base64,frame-data",
  } as unknown as HTMLCanvasElement;
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName === "video") return video;
    if (tagName === "canvas") return canvas;
    return originalCreateElement(tagName);
  });

  return {
    canvas,
    drawImage,
    ended: () => ended?.(),
    getDisplayMedia,
    getUserMedia,
    track,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("BrowserVideoCapture", () => {
  it("uses the browser screen picker and sends reduced JPEG frames", async () => {
    const environment = mockCaptureEnvironment("screen");
    const onFrame = vi.fn().mockResolvedValue(undefined);
    const capture = new BrowserVideoCapture();

    const pending = capture.startScreen({
      onEnded: vi.fn(),
      onError: vi.fn(),
      onFrame,
    });
    // The picker is requested synchronously from the user click call stack.
    expect(environment.getDisplayMedia).toHaveBeenCalledTimes(1);
    const selection = await pending;
    await capture.captureFrame();

    expect(selection).toEqual({
      sourceId: "screen-track",
      label: "Pantalla compartida",
    });
    expect(environment.canvas.width).toBe(1_280);
    expect(environment.canvas.height).toBe(720);
    expect(environment.drawImage).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({
      data: "frame-data",
      mimeType: "image/jpeg",
    });
    capture.stop();
    expect(environment.track.stop).toHaveBeenCalled();
  });

  it("stops when the browser sharing indicator ends the track", async () => {
    const environment = mockCaptureEnvironment("camera");
    const onEnded = vi.fn();
    const capture = new BrowserVideoCapture();
    await capture.startCamera({
      onEnded,
      onError: vi.fn(),
      onFrame: vi.fn().mockResolvedValue(undefined),
    });

    environment.ended();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(environment.track.stop).toHaveBeenCalled();
  });

  it("turns native permission failures into actionable messages", () => {
    expect(
      formatVideoCaptureError(
        new DOMException("denied", "NotAllowedError"),
        "camera",
      ),
    ).toContain("No se autorizó el acceso a la cámara");
    expect(
      formatVideoCaptureError(
        new DOMException("missing", "NotFoundError"),
        "screen",
      ),
    ).toContain("No se encontró una pantalla");
  });
});
