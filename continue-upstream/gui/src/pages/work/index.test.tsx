import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import WorkPanel from ".";

describe("WorkPanel", () => {
  it("combines runtime tasks, goals, sessions and token usage", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["lumina/assistantState"] = {
      memory: [],
      tools: [],
      steps: [
        {
          id: "task-1",
          title: "Run tests",
          status: "running",
          detail: "Executing npm test",
        },
        {
          id: "task-2",
          title: "Build GUI",
          status: "succeeded",
          durationMs: 1200,
        },
      ],
      settings: {
        fullAccess: false,
        requireVerification: true,
        continuousVision: false,
      },
      stateDir: "C:/tmp/lumina",
    };
    messenger.responses["goals/list"] = [
      {
        sessionId: "goal-session",
        text: "Terminar el panel",
        status: "active",
        turnsUsed: 2,
        maxTurns: 12,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    messenger.responses["history/list"] = [
      {
        sessionId: "past-session",
        title: "Sesión anterior",
        dateCreated: new Date().toISOString(),
        workspaceDirectory: "C:/repo",
      },
    ];
    messenger.responses["stats/getTokensPerDay"] = [
      {
        day: new Date().toISOString().slice(0, 10),
        promptTokens: 1200,
        generatedTokens: 300,
      },
    ];

    await renderWithProviders(<WorkPanel />, { mockIdeMessenger: messenger });

    expect(await screen.findByText("Run tests")).toBeInTheDocument();
    expect(screen.getByText("Terminar el panel")).toBeInTheDocument();
    expect(screen.getByText("Sesión anterior")).toBeInTheDocument();
    expect(
      screen.getByText(/tokens totales/i).previousSibling,
    ).toHaveTextContent(/1[.,]?5\s*k/i);
    expect(
      screen.getByText(/no informa una tarifa verificable/i),
    ).toBeInTheDocument();
  });
});
