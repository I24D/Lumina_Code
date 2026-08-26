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
            apiVersion: "1.1.0",
            sessionId: "session-1",
            workingDirectory: process.cwd(),
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

  it("parses split SSE frames from the runtime event stream", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\nevent: run.content\nda"));
        controller.enqueue(
          encoder.encode(
            'ta: {"id":1,"type":"run.content","timestamp":"now","data":{"content":"hi"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const client = new LuminaRuntimeClient({
      baseUrl: "http://127.0.0.1:8000",
      fetch: fetchImpl,
    });
    const events: unknown[] = [];

    await client.subscribeEvents((event) => {
      events.push(event);
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "run.content", data: { content: "hi" } }),
    ]);
  });
});
