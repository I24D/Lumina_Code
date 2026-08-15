import { afterEach, describe, expect, it } from "vitest";

import { buildStreamArgs, splitMjpegStream } from "./FfmpegVideoCapture.js";

/** Devuelve el valor que sigue a una bandera en la línea de comando. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** Un "JPEG" mínimo: SOI + payload + EOI. */
function frame(...payload: number[]): Buffer {
  return Buffer.from([...SOI, ...payload, ...EOI]);
}

describe("splitMjpegStream", () => {
  it("extrae dos fotogramas completos consecutivos", () => {
    const a = frame(1, 2, 3);
    const b = frame(4, 5);
    const { frames, rest } = splitMjpegStream(Buffer.concat([a, b]));

    expect(frames).toHaveLength(2);
    expect(frames[0].equals(a)).toBe(true);
    expect(frames[1].equals(b)).toBe(true);
    expect(rest).toHaveLength(0);
  });

  it("conserva un fotograma incompleto como resto", () => {
    const complete = frame(1, 2);
    const partial = Buffer.from([...SOI, 9, 9]); // sin EOI
    const { frames, rest } = splitMjpegStream(
      Buffer.concat([complete, partial]),
    );

    expect(frames).toHaveLength(1);
    expect(rest.equals(partial)).toBe(true);
  });

  it("descarta ruido previo al primer SOI", () => {
    const noise = Buffer.from([0x00, 0x11, 0x22]);
    const a = frame(7);
    const { frames, rest } = splitMjpegStream(Buffer.concat([noise, a]));

    expect(frames).toHaveLength(1);
    expect(frames[0].equals(a)).toBe(true);
    expect(rest).toHaveLength(0);
  });

  it("sin SOI no devuelve nada y limpia el buffer", () => {
    const { frames, rest } = splitMjpegStream(Buffer.from([0x00, 0x01, 0x02]));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(0);
  });

  it("reensambla un fotograma partido entre dos chunks", () => {
    const full = frame(1, 2, 3, 4);
    const cut = 3;
    const first = splitMjpegStream(full.subarray(0, cut));
    expect(first.frames).toHaveLength(0);

    const second = splitMjpegStream(
      Buffer.concat([first.rest, full.subarray(cut)]),
    );
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].equals(full)).toBe(true);
    expect(second.rest).toHaveLength(0);
  });
});

describe("buildStreamArgs", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("empareja siempre la decimación con -fps_mode vfr", () => {
    // Sin VFR, FFmpeg reconstruye el frame rate constante duplicando los
    // fotogramas que mpdecimate descarta: la decimación queda anulada y NADA
    // falla visiblemente. Este test existe para que ese fallo no vuelva.
    const args = buildStreamArgs("ffmpeg", "screen", undefined, undefined);
    const vf = valueAfter(args, "-vf") ?? "";

    expect(vf).toContain("mpdecimate");
    expect(valueAfter(args, "-fps_mode")).toBe("vfr");
  });

  it("no fuerza VFR cuando la decimación está desactivada", () => {
    process.env.START_TALK_VIDEO_DECIMATE = "false";
    const args = buildStreamArgs("ffmpeg", "screen", undefined, undefined);

    expect(valueAfter(args, "-vf")).not.toContain("mpdecimate");
    expect(args).not.toContain("-fps_mode");
  });

  it("no decima la cámara y le limita el framerate en la salida", () => {
    // Una webcam siempre tiene ruido de sensor, así que decimar no ahorraría
    // nada; y dshow falla si se le fuerza -framerate 1 en la entrada.
    const args = buildStreamArgs("ffmpeg", "camera", "HD Webcam", undefined);
    const vf = valueAfter(args, "-vf") ?? "";

    expect(vf).toContain("fps=1");
    expect(vf).not.toContain("mpdecimate");
    expect(args).not.toContain("-fps_mode");
    expect(valueAfter(args, "-i")).toBe("video=HD Webcam");
  });

  it("pasa el nombre de cámara literal, sin comillas ni escapes", () => {
    // Los nombres reales llevan espacios y paréntesis ("moto g stylus 5G - 2024
    // (Windows Virtual Camera)"). Se lanza con un array de argumentos, sin
    // shell de por medio, así que citarlo lo ROMPERÍA: FFmpeg buscaría un
    // dispositivo cuyo nombre incluye las comillas.
    const name = "moto g stylus 5G - 2024 (Windows Virtual Camera)";
    const args = buildStreamArgs("ffmpeg", "camera", name, undefined);

    expect(valueAfter(args, "-i")).toBe(`video=${name}`);
  });

  it("recorta al monitor pedido, con offsets negativos incluidos", () => {
    // Un monitor a la izquierda del principal tiene X negativa en el
    // escritorio virtual; gdigrab lo acepta y hay que pasarlo tal cual.
    const args = buildStreamArgs("ffmpeg", "screen", undefined, {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    });

    expect(valueAfter(args, "-offset_x")).toBe("-1920");
    expect(valueAfter(args, "-offset_y")).toBe("0");
    expect(valueAfter(args, "-video_size")).toBe("1920x1080");
    expect(valueAfter(args, "-i")).toBe("desktop");
  });

  it("captura el escritorio completo cuando no se pide región", () => {
    const args = buildStreamArgs("ffmpeg", "screen", undefined, undefined);

    expect(args).not.toContain("-offset_x");
    expect(args).not.toContain("-video_size");
    expect(valueAfter(args, "-i")).toBe("desktop");
  });

  it("ignora una región degenerada en vez de pasarle 0x0 a gdigrab", () => {
    const args = buildStreamArgs("ffmpeg", "screen", undefined, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });

    expect(args).not.toContain("-video_size");
  });

  it("emite MJPEG por stdout en ambas fuentes", () => {
    for (const source of ["screen", "camera"] as const) {
      const args = buildStreamArgs("ffmpeg", source, "Cam", undefined);
      expect(args.slice(-6)).toEqual([
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "7",
        "pipe:1",
      ]);
    }
  });
});
