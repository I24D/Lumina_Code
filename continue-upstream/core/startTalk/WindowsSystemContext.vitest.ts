import { describe, expect, it } from "vitest";

import {
  formatWindowsSystemContextForPrompt,
  loadWindowsSystemContext,
} from "./WindowsSystemContext.js";

describe("WindowsSystemContext", () => {
  it("loads the normalized context from Windows Bridge", async () => {
    const result = await loadWindowsSystemContext({
      bridgeUrl: "http://127.0.0.1:8765/",
      fetchImpl: async (input) => {
        expect(String(input)).toBe("http://127.0.0.1:8765/system_context");
        return new Response(
          JSON.stringify({
            ok: true,
            capturedAt: "2026-07-18T04:00:00.000Z",
            network: { wifi: { connected: true, ssid: "Lumina WiFi" } },
          }),
          { status: 200 },
        );
      },
    });

    expect(result.bridge).toEqual({ available: true });
    expect((result.network as any).wifi.ssid).toBe("Lumina WiFi");
  });

  it("keeps local clock context when Bridge is unavailable", async () => {
    const result = await loadWindowsSystemContext({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      now: new Date("2026-07-18T04:00:00.000Z"),
    });

    expect(result.ok).toBe(false);
    expect((result.bridge as any).available).toBe(false);
    expect((result.clock as any).utcIso).toBe("2026-07-18T04:00:00.000Z");
  });

  it("labels network location as approximate in the model prompt", () => {
    const prompt = formatWindowsSystemContextForPrompt({
      capturedAt: "2026-07-18T04:00:00.000Z",
      clock: { localDisplay: "Friday, July 18, 2026 at 12:00 AM" },
      location: {
        source: "network",
        approximate: true,
        precise: false,
        city: "Greeneville",
        region: "Tennessee",
        country: "United States",
      },
      network: { online: true, wifi: { connected: true, ssid: "Lumina WiFi" } },
      services: [{ capability: "location", status: "Running" }],
      permissions: { notifications: "allowed" },
    });

    expect(prompt).toContain("Greeneville, Tennessee, United States");
    expect(prompt).toContain("approximate=true; precise=false");
    expect(prompt).toContain("SSID=Lumina WiFi");
    expect(prompt).toContain("notifications=allowed");
    expect(prompt).toContain("location=Running");
  });
});
