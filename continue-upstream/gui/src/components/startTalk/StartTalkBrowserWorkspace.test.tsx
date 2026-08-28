import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StartTalkBrowserWorkspace } from "./StartTalkBrowserWorkspace";

describe("StartTalkBrowserWorkspace", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("separa voz, acciones, respuestas y fuentes sin perder datos reales", async () => {
    const openUrl = vi.fn();
    render(
      <StartTalkBrowserWorkspace
        assistantTranscript=""
        micLevel={0.45}
        onOpenUrl={openUrl}
        status="speaking"
        toolActivities={[
          {
            id: "search",
            label: "Buscando en Internet",
            detail: "Consultando información actual",
            status: "done",
            webSearch: {
              query: "información actual",
              visibility: "payload",
              sources: [
                {
                  title: "Fuente comprobada",
                  url: "https://example.com/report#result",
                },
              ],
            },
          },
        ]}
        transcriptEntries={[
          {
            id: "user-1",
            role: "user",
            text: "Busca esta información",
            createdAt: Date.now() - 1_000,
          },
          {
            id: "assistant-1",
            role: "assistant",
            text: "Encontré una respuesta",
            createdAt: Date.now(),
          },
        ]}
        userTranscript=""
      />,
    );

    expect(screen.getByText("TÚ HABLAS")).toBeInTheDocument();
    expect(screen.getByText("ACCIONES EN CURSO")).toBeInTheDocument();
    expect(screen.getByText("START TALK RESPONDE")).toBeInTheDocument();
    expect(screen.getByText("Busca esta información")).toBeInTheDocument();
    expect(screen.getByText("Encontré una respuesta")).toBeInTheDocument();
    expect(screen.getByText("FUENTES CONSULTADAS")).toBeInTheDocument();

    const details = screen.getByRole("button", {
      name: /ver detalles de acciones/iu,
    });
    await userEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(
      screen.getByRole("button", { name: /Fuente comprobada/iu }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://example.com/report");
  });
});
