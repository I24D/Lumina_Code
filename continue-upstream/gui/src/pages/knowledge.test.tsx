import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { renderWithProviders } from "../util/test/render";
import KnowledgePage from "./knowledge";

describe("KnowledgePage memory", () => {
  it("shows local memory and lets the user forget one experience", async () => {
    const messenger = new MockIdeMessenger();
    const experience = {
      id: "experience-1",
      goal: "Repair activation",
      summary: "Copied the native SQLite binding during the dev build.",
      outcome: "success" as const,
      toolNames: ["run_terminal_command"],
      tags: ["activation"],
      createdAt: "2026-08-25T12:00:00.000Z",
    };
    const overview = (experiences = [experience]) => ({
      snapshot: {
        version: 1 as const,
        experiences,
        insights: [],
        skillCandidates: [],
        tombstones: [],
        updatedAt: "2026-08-25T12:00:00.000Z",
      },
      matches: [],
      sync: {
        configured: false as const,
        provider: "local" as const,
        state: "local" as const,
      },
    });
    messenger.responseHandlers["memory/get"] = async () => overview();
    messenger.responseHandlers["memory/delete"] = async ({ id }) => {
      expect(id).toBe(experience.id);
      return overview([]);
    };

    await renderWithProviders(<KnowledgePage />, {
      mockIdeMessenger: messenger,
    });

    expect(await screen.findByText("Repair activation")).toBeInTheDocument();
    expect(screen.getByText(/toda la memoria continúa/i)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Olvidar Repair activation/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Repair activation")).not.toBeInTheDocument(),
    );
  });
});
