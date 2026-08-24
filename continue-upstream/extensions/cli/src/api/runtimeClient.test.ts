import { describe, expect, it, vi } from "vitest";

import { LuminaRuntimeClient } from "./runtimeClient.js";

describe("LuminaRuntimeClient", () => {
  it("targets versioned operations and reports API errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ok",
            apiVersion: "1.0.0",
            sessionId: "session-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const client = new LuminaRuntimeClient({
      baseUrl: "http://127.0.0.1:8000/",
      fetch: fetchImpl,
    });

    await expect(client.getHealth()).resolves.toMatchObject({ status: "ok" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8000/api/v1/health",
      expect.any(Object),
    );
    await expect(client.pause()).rejects.toThrow("Runtime API 403: denied");
    expect(client.eventUrl()).toBe("http://127.0.0.1:8000/api/v1/events");
  });
});
