import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { VerificationRecipe } from "core/verify/types";
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

  it("creates a durable workboard card and renders activity", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["lumina/assistantState"] = {
      memory: [],
      tools: [],
      steps: [],
      settings: {
        fullAccess: false,
        requireVerification: true,
        continuousVision: false,
      },
      stateDir: "C:/tmp/lumina",
    };
    messenger.responses["goals/list"] = [];
    messenger.responses["history/list"] = [];
    messenger.responses["stats/getTokensPerDay"] = [];
    messenger.responses["verify/recipe"] = undefined;

    const card = {
      id: "board-1",
      title: "Publicar fase 2",
      description: "",
      column: "backlog" as const,
      priority: "high" as const,
      tags: [],
      sessionId: "session-id",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    let created = false;
    messenger.responseHandlers["workboard/create"] = async (input) => {
      expect(input).toMatchObject({
        title: "Publicar fase 2",
        priority: "high",
      });
      created = true;
      return card;
    };
    messenger.responseHandlers["workboard/get"] = async () => ({
      cards: created ? [card] : [],
      activity: created
        ? [
            {
              id: "activity-1",
              cardId: card.id,
              kind: "created",
              summary: "Publicar fase 2: Creada en backlog.",
              createdAt: card.createdAt,
            },
          ]
        : [],
      counts: {
        backlog: created ? 1 : 0,
        ready: 0,
        in_progress: 0,
        review: 0,
        blocked: 0,
        done: 0,
      },
    });

    await renderWithProviders(<WorkPanel />, { mockIdeMessenger: messenger });
    fireEvent.change(
      await screen.findByLabelText("Título de la nueva tarjeta"),
      { target: { value: "Publicar fase 2" } },
    );
    fireEvent.change(screen.getByLabelText("Prioridad de la nueva tarjeta"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: /añadir/i }));

    await waitFor(() =>
      expect(screen.getByText("Publicar fase 2")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/actividad reciente/i));
    expect(screen.getByText(/Creada en backlog/i)).toBeInTheDocument();
  });

  describe("comandos del proyecto", () => {
    function messengerWithRecipe(recipe: VerificationRecipe | undefined) {
      const messenger = new MockIdeMessenger();
      messenger.responses["lumina/assistantState"] = {
        memory: [],
        tools: [],
        steps: [],
        settings: {
          fullAccess: false,
          requireVerification: true,
          continuousVision: false,
        },
        stateDir: "C:/tmp/lumina",
      };
      messenger.responses["goals/list"] = [];
      messenger.responses["history/list"] = [];
      messenger.responses["stats/getTokensPerDay"] = [];
      messenger.responses["verify/recipe"] = recipe;
      return messenger;
    }

    it("muestra los comandos detectados y de dónde salieron", async () => {
      const messenger = messengerWithRecipe({
        name: "Node.js (Vite)",
        kind: "node-vite",
        bootstrap: ["pnpm install"],
        build: ["npm run build"],
        test: ["npm test"],
        start: "npm run dev",
        port: 5173,
        readinessPath: "/",
        evidence: ["package.json", "pnpm-lock.yaml"],
      });

      await renderWithProviders(<WorkPanel />, { mockIdeMessenger: messenger });

      expect(await screen.findByText("Node.js (Vite)")).toBeInTheDocument();
      expect(screen.getByText("pnpm install")).toBeInTheDocument();
      expect(screen.getByText("npm test")).toBeInTheDocument();
      // Sin la evidencia no hay forma de distinguir una detección acertada de
      // una equivocada.
      expect(
        screen.getByText(/package\.json, pnpm-lock\.yaml/),
      ).toBeInTheDocument();
    });

    it("omite las filas que el proyecto no tiene", async () => {
      const messenger = messengerWithRecipe({
        name: "Python",
        kind: "python",
        bootstrap: ["pip install -r requirements.txt"],
        build: [],
        test: ["pytest"],
        evidence: ["requirements.txt"],
      });

      await renderWithProviders(<WorkPanel />, { mockIdeMessenger: messenger });

      expect(await screen.findByText("Python")).toBeInTheDocument();
      expect(screen.queryByText("Compilar")).not.toBeInTheDocument();
      expect(screen.queryByText("Arrancar")).not.toBeInTheDocument();
    });

    it("no pinta la tarjeta cuando no se detecta nada", async () => {
      const messenger = messengerWithRecipe(undefined);

      await renderWithProviders(<WorkPanel />, { mockIdeMessenger: messenger });

      // Una tarjeta vacía sugeriría que el proyecto no tiene comandos, que no
      // es lo mismo que no haberlos podido deducir.
      await screen.findByText(/Metas de sesión/i);
      expect(
        screen.queryByTestId("work-project-recipe"),
      ).not.toBeInTheDocument();
    });
  });
});
