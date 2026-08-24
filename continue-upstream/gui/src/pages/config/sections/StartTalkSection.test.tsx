import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartTalkConfigUpdate } from "core/startTalk/env";
import { renderWithProviders } from "../../../util/test/render";
import { StartTalkSection } from "./StartTalkSection";

describe("StartTalkSection", () => {
  it("shows safe configuration state and stores a replacement secret", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <StartTalkSection />,
    );
    let saved: StartTalkConfigUpdate | undefined;
    ideMessenger.responseHandlers["startTalk/configure"] = vi.fn(
      async (input) => {
        saved = input;
        return {
          configured: true,
          source: "secureStorage" as const,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          voiceName: input.voiceName,
        };
      },
    );

    await screen.findByText("Listo para conversar");
    expect(screen.queryByDisplayValue(/AIza/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Gemini API key"), "new-secret");
    await user.click(
      screen.getByRole("button", { name: "Guardar configuración" }),
    );

    await waitFor(() => expect(saved?.apiKey).toBe("new-secret"));
    expect(
      screen.getByText("Configuración guardada de forma segura."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
  });
});
