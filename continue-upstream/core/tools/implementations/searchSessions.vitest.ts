import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchSessionsImpl } from "./searchSessions.js";

const { search, browse, refresh } = vi.hoisted(() => ({
  search: vi.fn(),
  browse: vi.fn(),
  refresh: vi.fn(async () => ({ indexed: 0, removed: 0 })),
}));

vi.mock("../../learning/SessionSearchIndex", () => ({
  getSessionSearchIndex: () => ({ search, browse, refresh }),
}));

const CURRENT = "file:///c%3A/repo";

function extras(dirs: string[] = [CURRENT]) {
  return { ide: { getWorkspaceDirs: async () => dirs } } as never;
}

function hit(sessionId: string) {
  return {
    sessionId,
    title: "Deploy notes",
    workspaceDirectory: "file:///c%3A/repo-worktrees/feature",
    dateCreated: "2026-08-01T00:00:00.000Z",
    messageIndex: 3,
    role: "user",
    snippet: "how do I deploy this",
    score: -1,
  };
}

beforeEach(() => {
  search.mockReset();
  browse.mockReset();
  refresh.mockClear();
});

describe("search_sessions workspace filter", () => {
  it("searches everything when the workspace filter finds nothing", async () => {
    // Una sesión bifurcada a un worktree guarda la ruta del worktree, mientras
    // que el IDE informa de la carpeta abierta: para el usuario es el mismo
    // proyecto. Decir "no encontré nada" manda al agente a resolver otra vez
    // algo que ya estaba resuelto.
    search
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([hit("session-in-worktree")]);

    const [result] = await searchSessionsImpl(
      { query: "deploy", currentWorkspaceOnly: true },
      extras(),
    );

    expect(search).toHaveBeenNthCalledWith(1, {
      query: "deploy",
      limit: undefined,
      workspaceDirectory: CURRENT,
    });
    expect(search).toHaveBeenNthCalledWith(2, {
      query: "deploy",
      limit: undefined,
    });
    expect(result.content).toContain("session-in-worktree");
    expect(result.content).toContain("every saved session");
  });

  it("does not widen a search that was never filtered", async () => {
    search.mockResolvedValueOnce([]);

    const [result] = await searchSessionsImpl({ query: "deploy" }, extras());

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.name).toBe("No matching sessions");
  });

  it("keeps the filtered result when the filter does find something", async () => {
    search.mockResolvedValueOnce([hit("session-here")]);

    const [result] = await searchSessionsImpl(
      { query: "deploy", currentWorkspaceOnly: true },
      extras(),
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.content).not.toContain("every saved session");
  });

  it("widens browse the same way", async () => {
    browse.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        sessionId: "older",
        title: "Older work",
        workspaceDirectory: "file:///elsewhere",
        dateCreated: "2026-07-01T00:00:00.000Z",
        messageCount: 4,
      },
    ]);

    const [result] = await searchSessionsImpl(
      { currentWorkspaceOnly: true },
      extras(),
    );

    expect(browse).toHaveBeenNthCalledWith(1, 20, CURRENT);
    expect(browse).toHaveBeenNthCalledWith(2, 20);
    expect(result.content).toContain("Older work");
    expect(result.content).toContain("every saved session");
  });
});
