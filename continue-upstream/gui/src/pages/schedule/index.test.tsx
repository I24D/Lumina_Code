import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import SchedulePage from ".";

describe("SchedulePage", () => {
  it("renders persistent tasks and queues a manual run", async () => {
    const messenger = new MockIdeMessenger();
    const task = {
      id: "task-1",
      name: "Pruebas diarias",
      prompt: "Ejecuta npm test",
      enabled: true,
      schedule: { kind: "daily" as const, time: "08:30" },
      runAsGoal: false,
      createdAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:00.000Z",
      nextRunAt: "2026-08-24T12:30:00.000Z",
    };
    messenger.responses["scheduler/list"] = { tasks: [task], runs: [] };
    const runNow = vi.fn().mockResolvedValue({
      id: "run-1",
      taskId: task.id,
      scheduledFor: "2026-08-23T11:00:00.000Z",
      status: "queued",
      createdAt: "2026-08-23T11:00:00.000Z",
    });
    messenger.responseHandlers["scheduler/runNow"] = runNow;

    const { user } = await renderWithProviders(<SchedulePage />, {
      mockIdeMessenger: messenger,
    });
    expect(await screen.findByText("Pruebas diarias")).toBeInTheDocument();
    expect(screen.getByText(/cada día/i)).toHaveTextContent("08:30");

    await user.click(screen.getByRole("button", { name: /ejecutar ahora/i }));
    expect(runNow).toHaveBeenCalledWith({ id: "task-1" });
  });
});
