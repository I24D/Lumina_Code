import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LuminaEnergyCore } from "./LuminaEnergyCore";

describe("LuminaEnergyCore", () => {
  it("centra el núcleo entre dos tenazas simétricas", () => {
    const { container } = render(
      <LuminaEnergyCore
        large
        micLevel={0.5}
        roomy={false}
        status="listening"
      />,
    );

    expect(screen.getByTestId("lumina-energy-core")).toHaveAttribute(
      "data-status",
      "listening",
    );
    expect(container.querySelectorAll("[data-claw]")).toHaveLength(2);
    expect(container.querySelector(".energy-core-level")).toBeInTheDocument();
  });

  it("conserva el estado de habla para activar su animación", () => {
    render(
      <LuminaEnergyCore large={false} micLevel={0} roomy status="speaking" />,
    );

    expect(screen.getByTestId("lumina-energy-core")).toHaveAttribute(
      "data-status",
      "speaking",
    );
  });
});
