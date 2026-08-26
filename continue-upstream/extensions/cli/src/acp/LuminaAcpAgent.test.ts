import {
  AGENT_METHODS,
  client,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../api/runtimeEvents.js";

import {
  createLuminaAcpAgent,
  promptToRuntimeText,
  type AcpRuntimeClient,
} from "./LuminaAcpAgent.js";

class FakeRuntime implements AcpRuntimeClient {
  listener?: (event: RuntimeEvent) => void | Promise<void>;
  resolvePermission = vi.fn(async () => ({
    success: true as const,
    approved: true,
  }));
  pause = vi.fn(async () => ({ success: true, message: "paused" }));
  queueMessage = vi.fn(async (_message: string) => ({
    queued: true as const,
    position: 1,
  }));

  async getHealth() {
    return {
      status: "ok" as const,
      apiVersion: "1.1.0",
      sessionId: "rt-1",
      workingDirectory: process.cwd(),
    };
  }

  subscribeEvents(
    listener: (event: RuntimeEvent) => void | Promise<void>,
    options: { signal?: AbortSignal; onOpen?: () => void } = {},
  ): Promise<void> {
    this.listener = listener;
    options.onOpen?.();
    return new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  async emit(type: RuntimeEvent["type"], data: unknown): Promise<void> {
    await this.listener?.({
      id: 1,
      timestamp: new Date(0).toISOString(),
      type,
      data,
    });
  }
}

function createHarness(runtime: FakeRuntime) {
  const updates: unknown[] = [];
  const permission = vi.fn(async (_params: unknown) => ({
    outcome: { outcome: "selected" as const, optionId: "allow_once" },
  }));
  const clientApp = client({ name: "test-client" })
    .onRequest(CLIENT_METHODS.session_request_permission, ({ params }) => {
      permission(params);
      return {
        outcome: { outcome: "selected" as const, optionId: "allow_once" },
      };
    })
    .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
      updates.push(params);
    });
  const connection = clientApp.connect(createLuminaAcpAgent(runtime));
  return { connection, permission, updates };
}

async function startSession(runtime: FakeRuntime) {
  const harness = createHarness(runtime);
  const initialized = await harness.connection.agent.request(
    AGENT_METHODS.initialize,
    { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
  );
  const session = await harness.connection.agent.request(
    AGENT_METHODS.session_new,
    { cwd: process.cwd(), mcpServers: [] },
  );
  return { ...harness, initialized, session };
}

describe("Lumina ACP agent", () => {
  it("converts baseline ACP content without accepting hidden binary input", () => {
    expect(
      promptToRuntimeText([
        { type: "text", text: "Review this" },
        { type: "resource_link", name: "file", uri: "file:///tmp/a.ts" },
      ]),
    ).toContain("file:///tmp/a.ts");
    expect(() =>
      promptToRuntimeText([
        { type: "image", data: "AA==", mimeType: "image/png" },
      ]),
    ).toThrow("Unsupported ACP prompt content: image");
  });

  it("streams runtime output and completes an ACP prompt turn", async () => {
    const runtime = new FakeRuntime();
    const { connection, initialized, session, updates } =
      await startSession(runtime);
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);

    const prompt = connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() =>
      expect(runtime.queueMessage).toHaveBeenCalledWith("hello"),
    );
    await runtime.emit("run.content", {
      sessionId: "rt-1",
      content: "Hello from Lumina",
    });
    await runtime.emit("run.tool.started", {
      sessionId: "rt-1",
      toolName: "Read",
      toolArgs: { filepath: "README.md" },
    });
    await runtime.emit("run.tool.result", {
      sessionId: "rt-1",
      toolName: "Read",
      result: "contents",
      status: "completed",
    });
    await runtime.emit("run.completed", { sessionId: "rt-1" });

    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionId: session.sessionId,
        update: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from Lumina" },
        }),
      }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: "tool_call_update",
          status: "completed",
          rawOutput: "contents",
        }),
      }),
    );
    connection.close();
  });

  it("relays runtime permission prompts to the ACP client", async () => {
    const runtime = new FakeRuntime();
    const { connection, permission, session } = await startSession(runtime);
    const prompt = connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "edit a file" }],
    });
    await vi.waitFor(() => expect(runtime.queueMessage).toHaveBeenCalled());
    await runtime.emit("permission.requested", {
      sessionId: "rt-1",
      requestId: "permission-1",
      toolName: "Write",
      toolArgs: { path: "a.ts" },
    });
    await runtime.emit("run.completed", { sessionId: "rt-1" });

    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(permission).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.sessionId }),
    );
    expect(runtime.resolvePermission).toHaveBeenCalledWith(
      "permission-1",
      true,
    );
    connection.close();
  });

  it("cancels the matching runtime turn", async () => {
    const runtime = new FakeRuntime();
    const { connection, session } = await startSession(runtime);
    const prompt = connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await vi.waitFor(() => expect(runtime.queueMessage).toHaveBeenCalled());
    await connection.agent.notify(AGENT_METHODS.session_cancel, {
      sessionId: session.sessionId,
    });

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(runtime.pause).toHaveBeenCalledOnce();
    connection.close();
  });
});
