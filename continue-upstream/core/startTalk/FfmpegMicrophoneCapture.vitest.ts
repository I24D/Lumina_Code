import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveFfmpegPath } from "./FfmpegMicrophoneCapture";

describe("resolveFfmpegPath", () => {
  it("resolves the repository-managed FFmpeg binary", () => {
    const ffmpegPath = resolveFfmpegPath();

    expect(fs.existsSync(ffmpegPath)).toBe(true);
    const result = spawnSync(ffmpegPath, ["-hide_banner", "-version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/ffmpeg version/i);
  });
});
