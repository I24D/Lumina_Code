import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import ChangesWalkthrough from ".";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@ first
-const oldValue = 1;
+const newValue = 2;
 keep();
@@ -10,1 +10,2 @@ second
 existing();
+added();`;

describe("ChangesWalkthrough", () => {
  it("shows a guided hunk and advances one step at a time", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses.getDiff = [DIFF];
    const { user } = await renderWithProviders(<ChangesWalkthrough />, {
      mockIdeMessenger: messenger,
    });

    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(/paso 1 de 2/i)).toBeInTheDocument();
    expect(screen.getByText("const newValue = 2;")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /siguiente/i }));
    expect(screen.getByText(/paso 2 de 2/i)).toBeInTheDocument();
    expect(screen.getByText("added();")).toBeInTheDocument();
  });

  it("shows an explicit empty state", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses.getDiff = [];
    await renderWithProviders(<ChangesWalkthrough />, {
      mockIdeMessenger: messenger,
    });

    await waitFor(() =>
      expect(
        screen.getByText(/no hay cambios para recorrer/i),
      ).toBeInTheDocument(),
    );
  });
});
