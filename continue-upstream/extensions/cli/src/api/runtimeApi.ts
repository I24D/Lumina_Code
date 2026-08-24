import type { NextFunction, Request, Response } from "express";
import express from "express";

import type { ChildSessionRecord } from "../subagent/childSession.js";

import { runtimeEventBus } from "./runtimeEvents.js";
import {
  RUNTIME_API_VERSION,
  runtimeOpenApiDocument,
} from "./runtimeOpenApi.js";

export interface RuntimeApiDependencies {
  sessionId: string;
  workingDirectory: string;
  getState: () => unknown;
  listChildren: (parentSessionId: string) => ChildSessionRecord[];
  cancelChild: (sessionId: string) => boolean;
  retryChild: (sessionId: string) => Promise<ChildSessionRecord | null>;
  getChildDiff: (sessionId: string) => { diff: string; status: string } | null;
  applyChildDiff: (sessionId: string) => { applied: true; diff: string } | null;
  queueMessage: (message: string) => Promise<{ position: number }>;
  resolvePermission: (
    requestId: string,
    approved: boolean,
  ) => { success: boolean; error?: string };
  pause: () => { success: boolean; message: string };
  getDiff: () => Promise<{ repoFound: boolean; diff: string }>;
}

function writeSseEvent(res: Response, event: unknown): void {
  const typedEvent = event as { id: number; type: string };
  res.write(`id: ${typedEvent.id}\n`);
  res.write(`event: ${typedEvent.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createRuntimeApiRouter(deps: RuntimeApiDependencies) {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      apiVersion: RUNTIME_API_VERSION,
      sessionId: deps.sessionId,
      workingDirectory: deps.workingDirectory,
    });
  });

  router.get("/openapi.json", (_req, res) => {
    res.json(runtimeOpenApiDocument);
  });

  router.get("/state", (_req, res) => {
    res.json(deps.getState());
  });

  router.get("/sessions/:id/children", (req, res) => {
    res.json(deps.listChildren(req.params.id));
  });

  router.post("/sessions/:id/cancel", (req, res) => {
    if (!deps.cancelChild(req.params.id)) {
      res.status(404).json({ error: "Child session is not running" });
      return;
    }
    res.json({ success: true, sessionId: req.params.id });
  });

  router.post("/sessions/:id/retry", async (req, res) => {
    const child = await deps.retryChild(req.params.id);
    if (!child) {
      res.status(404).json({ error: "Child session cannot be retried" });
      return;
    }
    res.status(202).json(child);
  });

  router.get("/sessions/:id/diff", (req, res) => {
    const review = deps.getChildDiff(req.params.id);
    if (!review) {
      res.status(404).json({ error: "Child session has no worktree diff" });
      return;
    }
    res.json(review);
  });

  router.post("/sessions/:id/apply", (req, res) => {
    const result = deps.applyChildDiff(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Child session has no worktree diff" });
      return;
    }
    res.json(result);
  });

  router.get("/events", (req: Request, res: Response) => {
    res.status(200);
    res.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    writeSseEvent(
      res,
      runtimeEventBus.publish("state.changed", deps.getState()),
    );
    const unsubscribe = runtimeEventBus.subscribe((event) =>
      writeSseEvent(res, event),
    );
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post("/messages", async (req, res) => {
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "Message field is required" });
      return;
    }

    const result = await deps.queueMessage(message);
    runtimeEventBus.publish("message.queued", {
      sessionId: deps.sessionId,
      position: result.position,
    });
    res.status(202).json({ queued: true, position: result.position });
  });

  router.post("/permissions", (req, res) => {
    const requestId =
      typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    const approved = req.body?.approved;
    if (!requestId || typeof approved !== "boolean") {
      res.status(400).json({ error: "requestId and approved are required" });
      return;
    }

    const result = deps.resolvePermission(requestId, approved);
    if (!result.success) {
      res
        .status(400)
        .json({ error: result.error ?? "Permission request failed" });
      return;
    }
    runtimeEventBus.publish("permission.resolved", { requestId, approved });
    res.json({ success: true, approved });
  });

  router.post("/pause", (_req, res) => {
    const result = deps.pause();
    if (result.success) {
      runtimeEventBus.publish("run.paused", { sessionId: deps.sessionId });
    }
    res.json(result);
  });

  router.get("/diff", async (_req, res) => {
    const result = await deps.getDiff();
    if (!result.repoFound) {
      res.status(404).json({
        error: "Not in a git repository or main branch does not exist",
        diff: "",
      });
      return;
    }
    res.json({ diff: result.diff });
  });

  router.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = error instanceof Error ? error.message : "Runtime error";
      res.status(500).json({ error: message });
    },
  );

  return router;
}
