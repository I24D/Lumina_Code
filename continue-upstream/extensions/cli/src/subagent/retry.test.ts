import { beforeEach, describe, expect, it, vi } from "vitest";

import { serviceContainer } from "../services/ServiceContainer.js";

import { createChildSession, loadChildSession } from "./childSession.js";
import { executeSubAgent } from "./executor.js";
import { getSubagent } from "./get-agents.js";
import { retryChildSession } from "./retry.js";

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: { get: vi.fn() },
}));
vi.mock("./childSession.js", () => ({
  createChildSession: vi.fn(),
  loadChildSession: vi.fn(),
}));
vi.mock("./executor.js", () => ({ executeSubAgent: vi.fn() }));
vi.mock("./get-agents.js", () => ({ getSubagent: vi.fn() }));

describe("retryChildSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadChildSession).mockReturnValue({
      sessionId: "original",
      parentSessionId: "parent",
      agentName: "review",
      history: [
        { message: { role: "user", content: "review this" }, contextItems: [] },
      ],
    } as any);
    vi.mocked(serviceContainer.get).mockResolvedValue({} as any);
    vi.mocked(getSubagent).mockReturnValue({ model: {}, llmApi: {} } as any);
    vi.mocked(createChildSession).mockReturnValue({
      sessionId: "retry",
      parentSessionId: "parent",
      agentName: "review",
    } as any);
    vi.mocked(executeSubAgent).mockResolvedValue({ success: true } as any);
  });

  it("creates a linked replacement and starts it asynchronously", async () => {
    await expect(retryChildSession("original")).resolves.toMatchObject({
      sessionId: "retry",
    });

    expect(createChildSession).toHaveBeenCalledWith(
      "parent",
      "review",
      "review this",
      "original",
    );
    expect(executeSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "review this",
        parentSessionId: "parent",
      }),
      expect.objectContaining({ sessionId: "retry" }),
    );
  });

  it("returns null for an unknown child", async () => {
    vi.mocked(loadChildSession).mockReturnValue(null);
    await expect(retryChildSession("missing")).resolves.toBeNull();
    expect(executeSubAgent).not.toHaveBeenCalled();
  });
});
