import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { RuntimeSection } from "./RuntimeSection";

describe("RuntimeSection device workers", () => {
  it("shows the local-only device and real worker inventory", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    await renderWithProviders(<RuntimeSection />, { mockIdeMessenger });

    expect(await screen.findByText("Development PC")).toBeInTheDocument();
    expect(
      screen.getByText(/Operaciones remotas: desactivadas/u),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/worker local/u)).toHaveLength(3);
  });

  it("requires two clicks and audits a managed runtime restart", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<RuntimeSection />, { mockIdeMessenger });

    const restart = await screen.findByTestId("runtime-restart");
    await userEvent.click(restart);
    expect(screen.getByText("Confirmar reinicio")).toBeInTheDocument();
    expect(
      request.mock.calls.filter(([type]) => type === "lumina/runtimeRestart"),
    ).toHaveLength(0);

    await userEvent.click(restart);
    expect(request).toHaveBeenCalledWith("lumina/runtimeRestart", undefined);
    expect(request).toHaveBeenCalledWith(
      "security/audit/record",
      expect.objectContaining({ action: "runtime_restart_approved" }),
    );
  });
});
