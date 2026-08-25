import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { PrivacySection } from "./PrivacySection";

describe("PrivacySection security audit", () => {
  it("shows the local audit without exposing redacted values", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["security/audit/list"] = {
      total: 1,
      storage: "local",
      events: [
        {
          id: "event-1",
          timestamp: "2026-08-25T12:00:00.000Z",
          category: "tools",
          action: "approved",
          actor: "user",
          outcome: "allowed",
          summary: "El usuario aprobó runTerminalCommand.",
          redactions: ["vendor-token"],
        },
      ],
    };

    await renderWithProviders(<PrivacySection />, { mockIdeMessenger });

    expect(
      await screen.findByText("El usuario aprobó runTerminalCommand."),
    ).toBeInTheDocument();
    expect(screen.getByText(/datos ocultados/u)).toBeInTheDocument();
    expect(screen.getByText(/1 evento local/u)).toBeInTheDocument();
  });

  it("requires a second click before clearing the audit", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["security/audit/list"] = {
      total: 1,
      storage: "local",
      events: [
        {
          id: "event-1",
          timestamp: "2026-08-25T12:00:00.000Z",
          category: "system",
          action: "startup",
          actor: "system",
          outcome: "succeeded",
          summary: "Lumina inició.",
          redactions: [],
        },
      ],
    };
    mockIdeMessenger.responses["security/audit/clear"] = { removed: 1 };
    const request = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<PrivacySection />, { mockIdeMessenger });

    const clear = await screen.findByTestId("security-audit-clear");
    await userEvent.click(clear);
    expect(screen.getByText("Confirmar borrado")).toBeInTheDocument();
    expect(
      request.mock.calls.filter(([type]) => type === "security/audit/clear"),
    ).toHaveLength(0);

    await userEvent.click(clear);
    expect(request).toHaveBeenCalledWith("security/audit/clear", undefined);
    expect(await screen.findByText(/Aún no hay eventos/u)).toBeInTheDocument();
  });
});
