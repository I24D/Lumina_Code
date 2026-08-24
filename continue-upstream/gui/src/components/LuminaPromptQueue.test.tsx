import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../util/test/render";
import { LuminaPromptQueue } from "./LuminaPromptQueue";

describe("LuminaPromptQueue", () => {
  it("shows queued work and lets the user remove it", async () => {
    const onRemove = vi.fn();
    const { user } = await renderWithProviders(
      <LuminaPromptQueue
        prompts={[{ id: "one", preview: "Ejecutar las pruebas" }]}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("Ejecutar las pruebas")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Quitar de la cola: Ejecutar las pruebas",
      }),
    );
    expect(onRemove).toHaveBeenCalledWith("one");
  });
});
