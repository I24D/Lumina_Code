import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../util/test/render";
import { LuminaWorkspaceSwitcher } from "./LuminaWorkspaceSwitcher";

describe("LuminaWorkspaceSwitcher", () => {
  it("shows live runtime state for Lumina Code", async () => {
    await renderWithProviders(<LuminaWorkspaceSwitcher />);

    await waitFor(() => {
      expect(screen.getByText("Runtime connected")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Lumina Code")).toBeInTheDocument();
  });
});
