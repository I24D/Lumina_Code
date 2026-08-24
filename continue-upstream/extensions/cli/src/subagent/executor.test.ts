import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";
import { serviceContainer } from "../services/ServiceContainer.js";
import {
  getAgentExecutionContext,
  runWithAgentExecutionContext,
} from "../stream/executionContext.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";

import {
  createChildSession,
  saveChildSession,
  trackChildSessionUsage,
} from "./childSession.js";
import { executeSubAgent } from "./executor.js";

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(),
    getSync: vi.fn(),
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
  trackChildSessionUsage: vi.fn(),
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
    vi.mocked(serviceContainer.getSync).mockReturnValue({
      state: "ready",
      value: permissionState,
      error: null,
    });
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
    expect(serviceContainer.getSync).toHaveBeenCalledWith("toolPermissions");
    expect(serviceContainer.get).not.toHaveBeenCalled();
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

  it("runs sibling subagents concurrently with isolated request state", async () => {
    let activeStreams = 0;
    let maxActiveStreams = 0;
    const contexts: Array<ReturnType<typeof getAgentExecutionContext>> = [];
    let releaseStreams!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseStreams = resolve;
    });

    vi.mocked(createChildSession).mockImplementation(
      (parent, agent, prompt) =>
        ({
          sessionId: `child-${prompt}`,
          parentSessionId: parent,
          agentName: agent,
          status: "queued",
          dateCreated: "2026-01-01T00:00:00.000Z",
          dateUpdated: "2026-01-01T00:00:00.000Z",
          title: `${agent}: ${prompt}`,
          workspaceDirectory: process.cwd(),
          history: [
            { message: { role: "user", content: prompt }, contextItems: [] },
          ],
          usage: {
            totalCost: 0,
            promptTokens: 0,
            completionTokens: 0,
            promptTokensDetails: {},
          },
        }) as any,
    );
    vi.mocked(streamChatResponse).mockImplementation(async (history) => {
      activeStreams += 1;
      maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
      contexts.push(getAgentExecutionContext());
      if (activeStreams === 2) releaseStreams();
      await release;
      activeStreams -= 1;
      history.push({
        message: { role: "assistant", content: "done" },
        contextItems: [],
      } as any);
      return "done";
    });

    const run = (prompt: string) =>
      executeSubAgent({
        agent: {
          model: { name: "explore", chatOptions: {} },
          llmApi: {},
        } as any,
        prompt,
        parentSessionId: "parent-session-id",
        abortController: new AbortController(),
      });

    const results = await Promise.all([run("one"), run("two")]);

    expect(maxActiveStreams).toBe(2);
    expect(contexts.map((context) => context?.sessionId).sort()).toEqual([
      "child-one",
      "child-two",
    ]);
    expect(contexts.every((context) => context?.kind === "subagent")).toBe(
      true,
    );
    expect(contexts.every((context) => !context?.useChatHistoryService)).toBe(
      true,
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(serviceContainer.set).not.toHaveBeenCalled();
  });

  it("attributes usage through the child request context", async () => {
    vi.mocked(streamChatResponse).mockImplementationOnce(async (history) => {
      getAgentExecutionContext()?.onUsage?.(0.05, {
        promptTokens: 10,
        completionTokens: 4,
      });
      history.push({
        message: { role: "assistant", content: "safe result" },
        contextItems: [],
      } as any);
      return "safe result";
    });

    await executeSubAgent({
      agent: {
        model: { name: "explore", chatOptions: {} },
        llmApi: {},
      } as any,
      prompt: "inspect",
      parentSessionId: "parent-session-id",
      abortController: new AbortController(),
    });

    expect(trackChildSessionUsage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-session-id" }),
      0.05,
      { promptTokens: 10, completionTokens: 4 },
    );
  });

  it("rejects nested delegation instead of creating an unbounded tree", async () => {
    const result = await runWithAgentExecutionContext(
      {
        sessionId: "already-a-child",
        parentSessionId: "parent-session-id",
        kind: "subagent",
        permissionState,
        useChatHistoryService: false,
      },
      () =>
        executeSubAgent({
          agent: {
            model: { name: "nested", chatOptions: {} },
            llmApi: {},
          } as any,
          prompt: "delegate again",
          parentSessionId: "already-a-child",
          abortController: new AbortController(),
        }),
    );

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      error: expect.stringContaining("Nested subagents"),
    });
    expect(streamChatResponse).not.toHaveBeenCalled();
  });
});
