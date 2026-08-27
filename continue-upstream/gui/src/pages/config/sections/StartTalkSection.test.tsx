import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartTalkConfigUpdate } from "core/startTalk/env";
import { renderWithProviders } from "../../../util/test/render";
import { StartTalkSection } from "./StartTalkSection";

const SAVED_STATUS = {
  configured: true,
  provider: "openai-realtime" as const,
  source: "secureStorage" as const,
  geminiConfigured: true,
  openAiConfigured: true,
};

describe("StartTalkSection", () => {
  it("shows safe configuration state and stores a replacement OpenAI secret", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <StartTalkSection />,
    );
    let saved: StartTalkConfigUpdate | undefined;
    ideMessenger.responseHandlers["startTalk/configure"] = vi.fn(
      async (input) => {
        saved = input;
        return {
          ...SAVED_STATUS,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          voiceName: input.voiceName,
          openAiVoiceName: input.openAiVoiceName,
        };
      },
    );

    await screen.findByText(/Listo para conversar/);
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("OpenAI API key"), "new-secret");
    await user.click(
      screen.getByRole("button", { name: "Guardar configuración" }),
    );

    await waitFor(() => expect(saved?.openAiApiKey).toBe("new-secret"));
    // La voz por defecto de Lumina en OpenAI es femenina joven, y la clave de
    // Gemini no se toca al guardar el otro proveedor.
    expect(saved?.provider).toBe("openai-realtime");
    expect(saved?.openAiVoiceName).toBe("marin");
    expect(saved?.apiKey).toBeUndefined();
    expect(
      screen.getByText("Configuración guardada de forma segura."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  });

  it("switches the whole voice stack when the provider changes", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <StartTalkSection />,
    );
    let saved: StartTalkConfigUpdate | undefined;
    ideMessenger.responseHandlers["startTalk/configure"] = vi.fn(
      async (input) => {
        saved = input;
        return { ...SAVED_STATUS, provider: "gemini-live" as const };
      },
    );

    await screen.findByText(/Listo para conversar/);
    await user.click(screen.getByRole("radio", { name: /Gemini Live/ }));

    // Enviar `Leda` a OpenAI (o `marin` a Gemini) es un error que la API
    // rechaza, así que cambiar de proveedor tiene que arrastrar modelo y voz.
    expect(screen.getByLabelText("Gemini API key")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Guardar configuración" }),
    );

    await waitFor(() => expect(saved?.provider).toBe("gemini-live"));
    expect(saved?.model).toBe("gemini-3.1-flash-live-preview");
    expect(saved?.voiceName).toBe("Leda");
    expect(saved?.openAiVoiceName).toBeUndefined();
  });
});
