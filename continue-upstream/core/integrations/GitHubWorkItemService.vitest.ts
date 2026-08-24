import { describe, expect, it, vi } from "vitest";
import {
  GitHubWorkItemService,
  parseGitHubWorkItemReference,
} from "./GitHubWorkItemService.js";

describe("parseGitHubWorkItemReference", () => {
  it("accepts issue and pull request URLs plus shorthand", () => {
    expect(
      parseGitHubWorkItemReference("https://github.com/acme/app/issues/12"),
    ).toEqual({ owner: "acme", repo: "app", number: 12, kind: "issue" });
    expect(
      parseGitHubWorkItemReference("https://github.com/acme/app/pull/7"),
    ).toEqual({ owner: "acme", repo: "app", number: 7, kind: "pull" });
    expect(parseGitHubWorkItemReference("acme/app#3")).toEqual({
      owner: "acme",
      repo: "app",
      number: 3,
      kind: undefined,
    });
  });

  it("rejects other hosts and malformed references", () => {
    expect(() =>
      parseGitHubWorkItemReference("https://example.com/acme/app/issues/1"),
    ).toThrow(/github\.com/i);
    expect(() => parseGitHubWorkItemReference("../../etc#1")).toThrow();
  });
});

describe("GitHubWorkItemService", () => {
  it("loads an issue and formats its comments without exposing credentials", async () => {
    const client = {
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 12,
            title: "Fix login",
            body: "Login fails on Windows",
            state: "open",
            html_url: "https://github.com/acme/app/issues/12",
            user: { login: "ana" },
            labels: [{ name: "bug" }],
          },
        }),
        listComments: vi.fn().mockResolvedValue({
          data: [{ user: { login: "bob" }, body: "Reproduced" }],
        }),
      },
      pulls: {},
    } as any;

    const item = await new GitHubWorkItemService(undefined, client).get(
      "acme/app#12",
    );

    expect(item.reference.kind).toBe("issue");
    expect(item.markdown).toContain("Login fails on Windows");
    expect(item.markdown).toContain("Reproduced");
    expect(item.suggestedPrompt).toMatch(/atiende el issue/i);
  });

  it("loads PR branches, changed files and reviews", async () => {
    const client = {
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 5,
            title: "Improve cache",
            body: "Adds an LRU",
            state: "open",
            html_url: "https://github.com/acme/app/pull/5",
            user: { login: "ana" },
            labels: [],
            pull_request: {},
          },
        }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { head: { ref: "cache" }, base: { ref: "main" } },
        }),
        listFiles: vi.fn().mockResolvedValue({
          data: [
            {
              status: "modified",
              filename: "src/cache.ts",
              additions: 20,
              deletions: 2,
            },
          ],
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: [
            {
              user: { login: "reviewer" },
              body: "Looks good",
              state: "APPROVED",
            },
          ],
        }),
      },
    } as any;

    const item = await new GitHubWorkItemService(undefined, client).get(
      "https://github.com/acme/app/pull/5",
    );

    expect(item.reference.kind).toBe("pull");
    expect(item.markdown).toContain("cache → main");
    expect(item.markdown).toContain("src/cache.ts (+20/-2)");
    expect(item.markdown).toContain("Looks good");
  });
});
