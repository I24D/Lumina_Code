import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { setAllSessionMetadata } from "../redux/slices/sessionSlice";
import { renderWithProviders } from "../util/test/render";
import { LuminaAppShell } from "./LuminaNavigation";

function CurrentPath() {
  const location = useLocation();
  return <span data-testid="current-path">{location.pathname}</span>;
}

describe("LuminaAppShell", () => {
  it("navigates through the single workspace and exposes the command palette", async () => {
    const { user } = await renderWithProviders(
      <LuminaAppShell>
        <CurrentPath />
      </LuminaAppShell>,
    );

    await user.click(screen.getByRole("button", { name: /trabajo/i }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/work");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.getByRole("dialog", { name: /navegar por lumina code/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Buscar destino")).toHaveFocus();
    });
  });

  it("loads a recent session from the navigation rail", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <LuminaAppShell>
        <CurrentPath />
      </LuminaAppShell>,
    );
    act(() => {
      store.dispatch(
        setAllSessionMetadata([
          {
            sessionId: "recent-session",
            title: "Revisar autenticación",
            dateCreated: "2026-08-24T12:00:00.000Z",
            workspaceDirectory: "C:/workspace",
          },
        ]),
      );
    });
    ideMessenger.responses["history/load"] = {
      sessionId: "recent-session",
      title: "Revisar autenticación",
      workspaceDirectory: "C:/workspace",
      history: [],
    };

    await user.click(
      await screen.findByRole("button", { name: "Revisar autenticación" }),
    );

    await waitFor(() => {
      expect(store.getState().session.id).toBe("recent-session");
    });
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });
});
