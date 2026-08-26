import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { renderWithProviders } from "../util/test/render";
import ConnectionsPage from "./connections";

describe("ConnectionsPage channels", () => {
  it("shows the non-bypassable messaging contract", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    await renderWithProviders(<ConnectionsPage />, { mockIdeMessenger });

    expect(
      await screen.findByTestId("channel-whatsapp_desktop"),
    ).toHaveTextContent("Confirmación explícita obligatoria");
    expect(
      screen.getByText(/Full Access no puede omitir/u),
    ).toBeInTheDocument();
  });

  it("persists suggestion mode and trusted senders through core", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const snapshot = mockIdeMessenger.responses["channels/get"]!;
    mockIdeMessenger.responseHandlers["channels/update"] = async ({
      id,
      patch,
    }) => ({
      ...snapshot,
      channels: snapshot.channels.map((channel) =>
        channel.id === id ? { ...channel, ...patch } : channel,
      ),
    });
    const request = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<ConnectionsPage />, { mockIdeMessenger });

    await userEvent.selectOptions(
      await screen.findByTestId("channel-mode-whatsapp_desktop"),
      "suggest",
    );
    const trusted = screen.getByTestId("channel-trusted-whatsapp_desktop");
    await userEvent.type(trusted, "Ana, José");
    await userEvent.click(screen.getAllByText("Guardar")[0]);

    expect(request).toHaveBeenCalledWith("channels/update", {
      id: "whatsapp_desktop",
      patch: { mode: "suggest" },
    });
    expect(request).toHaveBeenCalledWith("channels/update", {
      id: "whatsapp_desktop",
      patch: { trustedSenders: ["Ana", "José"] },
    });
  });
});
