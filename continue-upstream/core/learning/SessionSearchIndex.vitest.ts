import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Session } from "../index.js";
import historyManager from "../util/history.js";

import { SessionSearchIndex } from "./SessionSearchIndex";

/**
 * Unique per run so these fixtures can never collide with sessions another
 * test left behind in the shared CONTINUE_GLOBAL_DIR.
 */
const TAG = `zz${Date.now().toString(36)}`;

function makeSession(
  suffix: string,
  title: string,
  messages: Array<[string, string]>,
  workspaceDirectory = "file:///workspace/alpha",
): Session {
  return {
    sessionId: `${TAG}-${suffix}`,
    title,
    workspaceDirectory,
    history: messages.map(([role, content]) => ({
      message: { role, content },
      contextItems: [],
    })) as Session["history"],
  };
}

let dir: string;
let index: SessionSearchIndex;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-session-search-"));
  index = new SessionSearchIndex(path.join(dir, "sessionSearch.sqlite"));

  historyManager.save(
    makeSession("deploy", "Render deployment", [
      ["user", "how do I deploy this service to Render"],
      ["assistant", "Push to main and Render rebuilds automatically."],
      ["user", "and the health check?"],
      ["assistant", "It must return 200 on /health before traffic shifts."],
    ]),
  );
  historyManager.save(
    makeSession(
      "sqlite",
      "Database notes",
      [
        ["user", "which tokenizer should the search index use"],
        ["assistant", "Porter stemming suits prose better than trigram."],
      ],
      "file:///workspace/beta",
    ),
  );
  historyManager.save(
    makeSession("repeat", "Repetitive session", [
      ["user", "kubernetes kubernetes"],
      ["assistant", "kubernetes"],
      ["user", "kubernetes again"],
      ["assistant", "still kubernetes"],
      ["user", "kubernetes once more"],
    ]),
  );

  await index.refresh();
});

afterAll(async () => {
  await index.close();
  for (const suffix of ["deploy", "sqlite", "repeat"]) {
    try {
      historyManager.delete(`${TAG}-${suffix}`);
    } catch {
      // Already gone; nothing to clean up.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionSearchIndex", () => {
  it("finds a session by something said inside it, not just its title", async () => {
    const hits = await index.search({ query: "Render" });
    const ours = hits.filter((hit) => hit.sessionId.startsWith(TAG));

    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0].sessionId).toBe(`${TAG}-deploy`);
    // The hit has to carry the anchor the caller needs to read it in context.
    expect(ours[0].messageIndex).toBeGreaterThanOrEqual(0);
    expect(ours[0].snippet).toMatch(/Render/iu);
  });

  it("requires every word, but spread across the session rather than one message", async () => {
    // "Render" is in the first message and "health" in the third. Demanding
    // both in a single message would return nothing for the exact
    // conversation the user is trying to find.
    const both = await index.search({ query: "Render health" });
    expect(both.some((hit) => hit.sessionId === `${TAG}-deploy`)).toBe(true);
  });

  it("still returns nothing when a word appears in no session", async () => {
    // The widened search must not become an implicit OR: one session has
    // "Render", another has "kubernetes", and neither has both.
    const impossible = await index.search({ query: "Render kubernetes" });
    expect(impossible.filter((hit) => hit.sessionId.startsWith(TAG))).toEqual(
      [],
    );
  });

  it("does not widen a query that already uses explicit syntax", async () => {
    // Quotes mean the user asked for an exact phrase; silently relaxing that
    // would return matches they deliberately excluded.
    const exact = await index.search({ query: '"Render health"' });
    expect(exact.filter((hit) => hit.sessionId.startsWith(TAG))).toEqual([]);
  });

  it("broadens with an explicit OR", async () => {
    const hits = await index.search({ query: "Render OR kubernetes" });
    const sessions = new Set(
      hits
        .filter((hit) => hit.sessionId.startsWith(TAG))
        .map((hit) => hit.sessionId),
    );

    expect(sessions.has(`${TAG}-deploy`)).toBe(true);
    expect(sessions.has(`${TAG}-repeat`)).toBe(true);
  });

  it("stops one repetitive session from crowding out the rest", async () => {
    const hits = await index.search({ query: "kubernetes", limit: 20 });
    const fromRepeat = hits.filter(
      (hit) => hit.sessionId === `${TAG}-repeat`,
    );

    // Five messages mention it; without the cap all five would take the page.
    expect(fromRepeat.length).toBeLessThanOrEqual(3);
  });

  it("survives a query that is not valid full-text syntax", async () => {
    // An unbalanced quote is an FTS5 syntax error, not a reason to fail.
    const hits = await index.search({ query: 'Render "unbalanced' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it("filters to one workspace when asked", async () => {
    const hits = await index.search({
      query: "tokenizer OR Render",
      workspaceDirectory: "file:///workspace/beta",
    });
    const ours = hits.filter((hit) => hit.sessionId.startsWith(TAG));

    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((hit) => hit.sessionId === `${TAG}-sqlite`)).toBe(true);
  });

  it("matches a workspace whose trailing slash differs", async () => {
    const hits = await index.search({
      query: "tokenizer",
      workspaceDirectory: "file:///workspace/beta/",
    });

    expect(hits.some((hit) => hit.sessionId === `${TAG}-sqlite`)).toBe(true);
  });

  it("re-indexes only what changed", async () => {
    // Nothing moved since beforeAll, so a second pass must do no work.
    expect(await index.refresh()).toEqual({ indexed: 0, removed: 0 });
  });

  it("picks up an edit to an already-indexed session", async () => {
    const updated = makeSession("deploy", "Render deployment", [
      ["user", "how do I deploy this service to Render"],
      ["assistant", "Push to main and Render rebuilds automatically."],
      ["user", "one more thing about pgbouncer"],
    ]);
    historyManager.save(updated);

    const { indexed } = await index.refresh();
    expect(indexed).toBeGreaterThanOrEqual(1);

    const hits = await index.search({ query: "pgbouncer" });
    expect(hits.some((hit) => hit.sessionId === `${TAG}-deploy`)).toBe(true);
  });

  it("scrolls to the messages around a hit", async () => {
    const messages = await index.scroll(`${TAG}-sqlite`, 1, 1);

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.map((message) => message.messageIndex)).toContain(1);
  });

  it("reads a whole session", async () => {
    const { summary, messages, elided } = await index.read(`${TAG}-sqlite`);

    expect(summary.title).toBe("Database notes");
    expect(messages.length).toBe(2);
    expect(elided).toBe(0);
  });

  it("browses recent sessions without a query", async () => {
    const recent = await index.browse(100);
    expect(recent.some((s) => s.sessionId === `${TAG}-repeat`)).toBe(true);
  });

  it("drops a session from the index once its file is gone", async () => {
    historyManager.delete(`${TAG}-repeat`);

    const { removed } = await index.refresh();
    expect(removed).toBeGreaterThanOrEqual(1);

    const hits = await index.search({ query: "kubernetes" });
    expect(hits.filter((hit) => hit.sessionId.startsWith(TAG))).toEqual([]);
  });
});
