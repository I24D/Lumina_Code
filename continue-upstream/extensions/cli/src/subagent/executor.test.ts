import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";
import { serviceContainer } from "../services/ServiceContainer.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";

import { createChildSession, saveChildSession } from "./childSession.js";
import { executeSubAgent } from "./executor.js";

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn().mockResolvedValue("parent system message"),
    },
    toolPermissions: {
      getState: vi.fn().mockReturnValue({ currentMode: "plan" }),
    },
    chatHistory: {
      isReady: vi.fn().mockReturnValue(true),
    },
  },
}));

vi.mock("../stream/streamChatResponse.js", () => ({
  streamChatResponse: vi.fn(),
}));

vi.mock("./childSession.js", () => ({
  createChildSession: vi.fn(),
  saveChildSession: vi.fn(),
}));

describe("executeSubAgent", () => {
  const permissionState = {
    permissions: {
      policies: [
        { tool: "*", permission: "exclude" },
        { tool: "Read", permission: "allow" },
      ],
    },
    currentMode: "plan",
    isHeadless: false,
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serviceContainer.get).mockResolvedValue(permissionState);
    vi.mocked(services.toolPermissions.getState).mockReturnValue(
      permissionState,
    );
    vi.mocked(createChildSession).mockReturnValue({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-id",
      agentName: "explore",
      status: "queued",
      dateCreated: "2026-01-01T00:00:00.000Z",
      dateUpdated: "2026-01-01T00:00:00.000Z",
      title: "explore: inspect",
      workspaceDirectory: process.cwd(),
      history: [
        {
          message: { role: "user", content: "inspect" },
          contextItems: [],
        },
      ],
    } as any);
    vi.mocked(streamChatResponse).mockImplementation(async (history) => {
      history.push({
        message: { role: "assistant", content: "safe result" },
        contextItems: [],
      } as any);
      return "safe result";
    });
  });

  it("inherits the parent permission state without elevating to allow-all", async () => {
    const result = await executeSubAgent({
      agent: {
        model: {
          name: "explore",
          chatOptions: { baseSystemMessage: "Explore read-only" },
        },
        llmApi: {},
      } as any,
      prompt: "inspect",
      parentSessionId: "parent-session-id",
      abortController: new AbortController(),
    });

    expect(result).toMatchObject({
      success: true,
      status: "completed",
      response: "safe result",
      sessionId: "child-session-id",
      parentSessionId: "parent-session-id",
    });
    expect(serviceContainer.get).toHaveBeenCalledWith("toolPermissions");
    expect(serviceContainer.set).not.toHaveBeenCalled();
    expect(permissionState.permissions.policies).toEqual([
      { tool: "*", permission: "exclude" },
      { tool: "Read", permission: "allow" },
    ]);
    expect(services.systemMessage.getSystemMessage).toHaveBeenCalledWith(
      "plan",
    );
    expect(saveChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "child-session-id",
        status: "completed",
      }),
    );
  });

  it("records a failed child session without changing parent permissions", async () => {
    vi.mocked(streamChatResponse).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    const result = await executeSubAgent({
      agent: {
        model: { name: "explore", chatOptions: {} },
        llmApi: {},
      } as any,
      prompt: "inspect",
      parentSessionId: "parent-session-id",
      abortController: new AbortController(),
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      error: "provider unavailable",
      sessionId: "child-session-id",
    });
    expect(serviceContainer.set).not.toHaveBeenCalled();
    expect(saveChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: "provider unavailable",
      }),
    );
  });
});
