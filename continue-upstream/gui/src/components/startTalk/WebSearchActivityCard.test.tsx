import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  safeSearchSourceUrl,
  WebSearchActivityCard,
} from "./WebSearchActivityCard";

describe("WebSearchActivityCard", () => {
  it("rejects active schemes and strips credentials from source links", () => {
    expect(safeSearchSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(
      safeSearchSourceUrl("https://user:secret@example.com/page#private"),
    ).toBe("https://example.com/page");
  });

  it("shows the exact query, synthesis and source excerpts by default", async () => {
    const open = vi.fn();
    render(
      <WebSearchActivityCard
        roomy
        onOpenUrl={open}
        activity={{
          id: "search-1",
          label: "Búsqueda web",
          status: "done",
          webSearch: {
            query: "número de cuenta de prueba",
            provider: "tavily",
            answer: "La cuenta de prueba es 123.",
            visibility: "payload",
            sources: [
              {
                title: "Documentación de prueba",
                url: "https://example.com/account",
                snippet: "El número publicado es 123.",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("La cuenta de prueba es 123.")).toBeInTheDocument();
    expect(screen.getByText("El número publicado es 123.")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Documentación/u }),
    );
    expect(open).toHaveBeenCalledWith("https://example.com/account");
  });

  it("explains the visibility limit of native Google grounding", () => {
    render(
      <WebSearchActivityCard
        roomy={false}
        onOpenUrl={() => undefined}
        activity={{
          id: "search-2",
          label: "Búsqueda web",
          status: "done",
          webSearch: {
            query: "latest information",
            provider: "google",
            visibility: "metadata-only",
            sources: [],
          },
        }}
      />,
    );
    expect(screen.getByText(/no expuso los extractos/u)).toBeInTheDocument();
  });
});
