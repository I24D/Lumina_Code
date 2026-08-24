import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_API_OPERATIONS } from "./generated/runtimeOperations.generated.js";
import { createRuntimeApiRouter } from "./runtimeApi.js";
import { runtimeEventBus } from "./runtimeEvents.js";
import { runtimeOpenApiDocument } from "./runtimeOpenApi.js";

describe("Lumina runtime API v1", () => {
  const deps = {
    sessionId: "session-1",
    workingDirectory: process.cwd(),
    getState: vi.fn(() => ({ sessionId: "session-1", isProcessing: false })),
    listChildren: vi.fn(() => []),
    cancelChild: vi.fn(() => true),
    retryChild: vi.fn(async () => ({ sessionId: "retry-1" }) as any),
    getChildDiff: vi.fn(() => ({ diff: "+child", status: "ready" })),
    applyChildDiff: vi.fn(() => ({ applied: true as const, diff: "+child" })),
    queueMessage: vi.fn(async () => ({ position: 1 })),
    resolvePermission: vi.fn(() => ({ success: true })),
    pause: vi.fn(() => ({ success: true, message: "Agent run paused" })),
    getDiff: vi.fn(async () => ({ repoFound: true, diff: "+change" })),
  };

  const createApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createRuntimeApiRouter(deps));
    return app;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeEventBus.resetForTests();
  });

  it("exposes health and the OpenAPI contract", async () => {
    const app = createApp();
    const health = await request(app).get("/api/v1/health").expect(200);
    const contract = await request(app).get("/api/v1/openapi.json").expect(200);

    expect(health.body).toMatchObject({
      status: "ok",
      apiVersion: "1.1.0",
      sessionId: "session-1",
      workingDirectory: process.cwd(),
    });
    expect(contract.body).toEqual(runtimeOpenApiDocument);
    expect(contract.body.paths["/events"].get.operationId).toBe("streamEvents");
    const contractOperationIds = Object.values(runtimeOpenApiDocument.paths)
      .flatMap((item) => Object.values(item))
      .map((operation) => operation.operationId)
      .sort();
    expect(Object.keys(RUNTIME_API_OPERATIONS).sort()).toEqual(
      contractOperationIds,
    );
  });

  it("validates and queues messages with an observable event", async () => {
    const events: unknown[] = [];
    runtimeEventBus.subscribe((event) => events.push(event));
    const app = createApp();

    await request(app)
      .post("/api/v1/messages")
      .send({ message: " " })
      .expect(400);
    const response = await request(app)
      .post("/api/v1/messages")
      .send({ message: "inspect repository" })
      .expect(202);

    expect(response.body).toEqual({ queued: true, position: 1 });
    expect(deps.queueMessage).toHaveBeenCalledWith("inspect repository");
    expect(events).toEqual([
      expect.objectContaining({
        id: 1,
        type: "message.queued",
        data: { sessionId: "session-1", position: 1 },
      }),
    ]);
  });

  it("preserves permission, pause, child-session, and diff operations", async () => {
    const app = createApp();

    await request(app)
      .post("/api/v1/permissions")
      .send({ requestId: "permission-1", approved: true })
      .expect(200, { success: true, approved: true });
    await request(app)
      .post("/api/v1/pause")
      .expect(200, { success: true, message: "Agent run paused" });
    await request(app)
      .get("/api/v1/sessions/session-1/children")
      .expect(200, []);
    await request(app)
      .post("/api/v1/sessions/child-1/cancel")
      .expect(200, { success: true, sessionId: "child-1" });
    await request(app)
      .post("/api/v1/sessions/child-1/retry")
      .expect(202, { sessionId: "retry-1" });
    await request(app)
      .get("/api/v1/sessions/child-1/diff")
      .expect(200, { diff: "+child", status: "ready" });
    await request(app)
      .post("/api/v1/sessions/child-1/apply")
      .expect(200, { applied: true, diff: "+child" });
    await request(app).get("/api/v1/diff").expect(200, { diff: "+change" });

    expect(deps.resolvePermission).toHaveBeenCalledWith("permission-1", true);
    expect(deps.pause).toHaveBeenCalledOnce();
    expect(deps.listChildren).toHaveBeenCalledWith("session-1");
    expect(deps.cancelChild).toHaveBeenCalledWith("child-1");
    expect(deps.retryChild).toHaveBeenCalledWith("child-1");
    expect(deps.getChildDiff).toHaveBeenCalledWith("child-1");
    expect(deps.applyChildDiff).toHaveBeenCalledWith("child-1");
  });
});
