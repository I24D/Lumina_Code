import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setupStore } from "../../redux/store";
import { addAndSelectMockLlm } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import { ScheduledTaskBridge } from "./ScheduledTaskBridge";

describe("ScheduledTaskBridge", () => {
  it("claims authorized work, runs it in a new agent session and reports completion", async () => {
    const messenger = new MockIdeMessenger();
    messenger.setChatResponseText("Tests completed successfully");
    messenger.responses["goals/get"] = undefined;
    const store = setupStore({ ideMessenger: messenger });

    let claimed = false;
    messenger.responseHandlers["scheduler/claimDue"] = vi.fn(async () => {
      if (!store.getState().config.config.selectedModelByRole.chat) {
        return undefined;
      }
      if (claimed) return undefined;
      claimed = true;
      return {
        task: {
          id: "task-1",
          name: "Nightly tests",
          prompt: "Run the tests",
          enabled: true,
          schedule: { kind: "daily" as const, time: "23:00" },
          runAsGoal: false,
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:00.000Z",
        },
        run: {
          id: "run-1",
          taskId: "task-1",
          scheduledFor: "2026-08-23T23:00:00.000Z",
          status: "running" as const,
          createdAt: "2026-08-23T23:00:00.000Z",
          startedAt: "2026-08-23T23:00:01.000Z",
        },
      };
    });
    const report = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["scheduler/reportRun"] = report;

    await renderWithProviders(<ScheduledTaskBridge />, {
      mockIdeMessenger: messenger,
      store,
    });
    await act(async () => {
      addAndSelectMockLlm(store, messenger);
    });

    await waitFor(
      () =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: "run-1",
            status: "completed",
            sessionId: expect.any(String),
          }),
        ),
      { timeout: 10_000 },
    );
    expect(store.getState().session.title).toBe("Programada: Nightly tests");
    expect(store.getState().session.mode).toBe("agent");
  }, 20_000);
});
