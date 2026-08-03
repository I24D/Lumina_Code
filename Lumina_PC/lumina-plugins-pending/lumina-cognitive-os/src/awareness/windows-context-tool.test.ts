import { describe, expect, it } from "vitest";
import type { BridgeClient } from "../shared/bridge-client.js";
import { createWindowsContextTool } from "./windows-context-tool.js";

function bridgeReturning(value: unknown): BridgeClient {
  return {
    bridgeUrl: "http://127.0.0.1:8765",
    get: async () => value,
    post: async () => null,
  };
}

describe("lumina_windows_context", () => {
  it("returns current system facts without network addresses or session paths", async () => {
    const tool = createWindowsContextTool(
      bridgeReturning({
        ok: true,
        clock: { localDisplay: "Saturday, July 18, 2026" },
        location: { source: "network", approximate: true, city: "Greeneville" },
        network: {
          online: true,
          wifi: { connected: true, ssid: "Lumina WiFi" },
          profiles: [{ name: "Lumina WiFi" }],
          addresses: [{ address: "10.0.0.20" }],
        },
        session: { homeDirectory: "C:/Users/test" },
      }),
    );

    const result = await tool.execute("test", {});
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.ok).toBe(true);
    expect(payload.location.approximate).toBe(true);
    expect(payload.network.wifi.ssid).toBe("Lumina WiFi");
    expect(payload.network.addresses).toBeUndefined();
    expect(payload.session).toBeUndefined();
  });

  it("returns an actionable error when the Windows Bridge is unavailable", async () => {
    const tool = createWindowsContextTool(bridgeReturning(null));
    const result = await tool.execute("test", {});
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({ ok: false, error: "windows_context_unavailable" });
  });
});
