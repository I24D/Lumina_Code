import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import HistoryPage from "../../pages/history/index";
import { renderWithProviders } from "../../util/test/render";

function makeMessenger() {
  const messenger = new MockIdeMessenger();
  messenger.responses["history/list"] = [
    {
      title: "Render deployment",
      sessionId: "session-1",
      dateCreated: new Date().toString(),
      workspaceDirectory: "/tmp",
    },
  ];
  messenger.responses["sessions/search"] = {
    hits: [
      {
        sessionId: "session-9",
        title: "Database notes",
        workspaceDirectory: "/tmp",
        dateCreated: new Date().toString(),
        messageIndex: 3,
        role: "assistant",
        snippet: "Porter stemming suits prose better than trigram",
        score: -4.2,
      },
    ],
    recent: [],
  };
  return messenger;
}

describe("searching inside past conversations", () => {
  it("searches titles by default and never asks core", async () => {
    const mockIdeMessenger = makeMessenger();
    const spy = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<HistoryPage />, { mockIdeMessenger });

    await userEvent.type(
      screen.getByPlaceholderText("Search session titles"),
      "Render",
    );

    // Title search is client-side over metadata already in the store. A round
    // trip here would be a regression, not an implementation detail.
    expect(
      spy.mock.calls.filter((call) => call[0] === "sessions/search"),
    ).toHaveLength(0);
  });

  it("searches message contents once that scope is chosen", async () => {
    const mockIdeMessenger = makeMessenger();
    await renderWithProviders(<HistoryPage />, { mockIdeMessenger });

    await userEvent.click(screen.getByTestId("history-scope-messages"));
    await userEvent.type(
      screen.getByPlaceholderText("Search inside conversations"),
      "trigram",
    );

    const hit = await screen.findByText(
      /Porter stemming suits prose/u,
      {},
      { timeout: 3000 },
    );
    expect(hit).toBeInTheDocument();
  });

  it("does not query core until the user has typed something", async () => {
    const mockIdeMessenger = makeMessenger();
    const spy = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<HistoryPage />, { mockIdeMessenger });

    await userEvent.click(screen.getByTestId("history-scope-messages"));

    // An empty query would match everything and index the whole history for
    // nothing.
    await waitFor(() => {
      expect(
        spy.mock.calls.filter((call) => call[0] === "sessions/search"),
      ).toHaveLength(0);
    });
  });

  it("explains why nothing matched instead of showing a blank pane", async () => {
    const mockIdeMessenger = makeMessenger();
    mockIdeMessenger.responses["sessions/search"] = { hits: [], recent: [] };
    await renderWithProviders(<HistoryPage />, { mockIdeMessenger });

    await userEvent.click(screen.getByTestId("history-scope-messages"));
    await userEvent.type(
      screen.getByPlaceholderText("Search inside conversations"),
      "nothingmatchesthis",
    );

    const empty = await screen.findByTestId(
      "session-search-empty",
      {},
      { timeout: 3000 },
    );
    expect(empty).toBeInTheDocument();
  });
});
