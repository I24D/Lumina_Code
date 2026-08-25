import * as fs from "node:fs";

// Type-only: sqlite3 is a native binding, and loading it costs real time at
// import. Session search may never be used in a given run, so the driver is
// pulled in lazily inside connect() rather than sitting in core's startup
// graph. Keep these as `import type`.
import type { Database } from "sqlite";
import type sqlite3 from "sqlite3";

import historyManager from "../util/history.js";
import { renderChatMessage } from "../util/messageContent.js";
import {
  getSessionFilePath,
  getSessionSearchSqlitePath,
} from "../util/paths.js";

type DatabaseConnection = Database<sqlite3.Database>;

/**
 * Messages longer than this are indexed truncated. Pasted files and long tool
 * transcripts would otherwise dominate the index by sheer volume while adding
 * nothing recallable — the useful signal in a long message is at the top.
 */
const MAX_INDEXED_CHARS_PER_MESSAGE = 8_000;

/**
 * Roles worth indexing: the conversation itself. Tool results are deliberately
 * excluded — they are re-derivable, frequently enormous, and searching them
 * surfaces file contents rather than the discussion the user is trying to find.
 */
const INDEXED_ROLES = new Set(["user", "assistant", "thinking"]);

/**
 * Hits to keep from any one session in a discovery result. Without this a
 * single long conversation that repeats a term buries every other session,
 * which is the opposite of what cross-session recall is for.
 */
const MAX_HITS_PER_SESSION = 3;

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  dateCreated: string;
  messageIndex: number;
  role: string;
  /** FTS5-generated excerpt around the match. */
  snippet: string;
  score: number;
}

export interface SessionMessage {
  messageIndex: number;
  role: string;
  content: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  dateCreated: string;
  messageCount: number;
}

export interface SessionSearchQuery {
  query: string;
  limit?: number;
  workspaceDirectory?: string;
}

/** Query words that are FTS5 operators rather than things to search for. */
const FTS_OPERATORS = new Set(["OR", "AND", "NOT", "NEAR"]);

/**
 * True when the user wrote full-text syntax themselves. If they did, their
 * query means exactly what it says and must not be second-guessed.
 */
function usesExplicitSyntax(query: string): boolean {
  return (
    /["()]/u.test(query) ||
    query.split(/\s+/u).some((word) => FTS_OPERATORS.has(word))
  );
}

/**
 * The bare words of a plain query, ready to be quoted back into FTS5. Trailing
 * `*` is preserved because prefix search is the one operator worth keeping in
 * an otherwise literal term.
 */
function bareTerms(query: string): string[] {
  return query
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}_*-]/gu, ""))
    .filter((word) => word !== "" && word !== "*");
}

function quoteTerm(term: string): string {
  return term.endsWith("*")
    ? `"${term.slice(0, -1).replace(/"/gu, '""')}"*`
    : `"${term.replace(/"/gu, '""')}"`;
}

/**
 * Workspace directories reach us from two places that do not agree on form:
 * the GUI records `window.workspacePaths[0]` on the session, while callers pass
 * whatever `ide.getWorkspaceDirs()` returns. Comparing them raw makes the
 * filter silently match nothing, so both sides are folded to the same shape.
 */
function normalizeDir(value: string): string {
  return value.trim().replace(/[\\/]+$/u, "").toLowerCase();
}

function messageText(item: { message?: { content?: unknown } }): string {
  try {
    return renderChatMessage(item.message as never) ?? "";
  } catch {
    return "";
  }
}

/**
 * Full-text recall over past chat sessions.
 *
 * Lumina already keeps every conversation on disk, but until now the only way
 * back into one was to remember its title. This is the episodic half of the
 * learning loop: the agent can find what it worked out three weeks ago instead
 * of solving it again.
 *
 * Ported from Hermes's session search, including its four access shapes and
 * BM25 ranking. Hermes additionally dedupes by session lineage; Lumina does not
 * record session ancestry, so the equivalent guard here is a per-session hit
 * cap — same goal (one conversation cannot crowd out the rest), honestly
 * scoped to what the data supports.
 */
export class SessionSearchIndex {
  private db: DatabaseConnection | undefined;

  constructor(private readonly sqlitePath = getSessionSearchSqlitePath()) {}

  private async connect(): Promise<DatabaseConnection> {
    if (this.db) {
      return this.db;
    }
    const [sqliteModule, sqlite3Module] = await Promise.all([
      import("sqlite"),
      import("sqlite3"),
    ]);
    // sqlite3 is CommonJS, so under esModuleInterop the constructor hangs off
    // `.default`; bundlers that flatten the namespace expose it directly.
    const driver =
      sqlite3Module.default?.Database ??
      (sqlite3Module as unknown as { Database: typeof sqlite3.Database })
        .Database;

    const db = await sqliteModule.open({
      filename: this.sqlitePath,
      driver,
    });
    await db.exec("PRAGMA journal_mode=WAL;");
    await db.exec("PRAGMA busy_timeout = 3000;");
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      content,
      session_id UNINDEXED,
      message_index UNINDEXED,
      role UNINDEXED,
      tokenize = 'porter unicode61'
    )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_directory TEXT NOT NULL DEFAULT '',
      date_created TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      source_mtime_ms INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT ''
    )`);
    this.db = db;
    return db;
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    await db?.close();
  }

  /**
   * Brings the index in line with the session files on disk.
   *
   * Sessions are re-read only when their file's mtime moved, so the common
   * case — one conversation changed since last time — costs one file read
   * rather than a full rebuild.
   */
  async refresh(): Promise<{ indexed: number; removed: number }> {
    const db = await this.connect();
    const sessions = historyManager.list({});

    const knownRows = await db.all<{ session_id: string; source_mtime_ms: number }[]>(
      "SELECT session_id, source_mtime_ms FROM session_meta",
    );
    const known = new Map(
      knownRows.map((row) => [row.session_id, row.source_mtime_ms]),
    );

    let indexed = 0;
    const seen = new Set<string>();

    for (const meta of sessions) {
      const sessionId = meta.sessionId;
      seen.add(sessionId);

      let mtimeMs = 0;
      try {
        mtimeMs = Math.floor(fs.statSync(getSessionFilePath(sessionId)).mtimeMs);
      } catch {
        // The listing outlived the file. Treat it as deleted below.
        seen.delete(sessionId);
        continue;
      }

      if (known.get(sessionId) === mtimeMs) {
        continue;
      }

      const session = historyManager.load(sessionId);
      await this.indexSession(
        db,
        sessionId,
        {
          title: session.title || meta.title || "",
          workspaceDirectory:
            session.workspaceDirectory || meta.workspaceDirectory || "",
          dateCreated: String(meta.dateCreated ?? ""),
        },
        session.history ?? [],
        mtimeMs,
      );
      indexed += 1;
    }

    let removed = 0;
    for (const sessionId of known.keys()) {
      if (seen.has(sessionId)) {
        continue;
      }
      await this.deleteSession(db, sessionId);
      removed += 1;
    }

    return { indexed, removed };
  }

  private async deleteSession(
    db: DatabaseConnection,
    sessionId: string,
  ): Promise<void> {
    await db.run("DELETE FROM session_fts WHERE session_id = ?", [sessionId]);
    await db.run("DELETE FROM session_meta WHERE session_id = ?", [sessionId]);
  }

  private async indexSession(
    db: DatabaseConnection,
    sessionId: string,
    meta: { title: string; workspaceDirectory: string; dateCreated: string },
    history: unknown[],
    mtimeMs: number,
  ): Promise<void> {
    await this.deleteSession(db, sessionId);

    let messageCount = 0;
    for (let index = 0; index < history.length; index++) {
      const item = history[index] as { message?: { role?: string } };
      const role = item?.message?.role;
      if (typeof role !== "string" || !INDEXED_ROLES.has(role)) {
        continue;
      }
      const text = messageText(item as never).trim();
      if (text === "") {
        continue;
      }
      await db.run(
        "INSERT INTO session_fts (content, session_id, message_index, role) VALUES (?, ?, ?, ?)",
        [text.slice(0, MAX_INDEXED_CHARS_PER_MESSAGE), sessionId, index, role],
      );
      messageCount += 1;
    }

    await db.run(
      `INSERT INTO session_meta
        (session_id, title, workspace_directory, date_created, message_count, source_mtime_ms, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title,
         workspace_directory = excluded.workspace_directory,
         date_created = excluded.date_created,
         message_count = excluded.message_count,
         source_mtime_ms = excluded.source_mtime_ms,
         indexed_at = excluded.indexed_at`,
      [
        sessionId,
        meta.title,
        meta.workspaceDirectory,
        meta.dateCreated,
        messageCount,
        mtimeMs,
        new Date().toISOString(),
      ],
    );
  }

  private matchRows(
    match: string,
    scanLimit: number,
    workspaceDirectory: string | undefined,
  ) {
    return this.connect().then((db) =>
      db.all<
        {
          session_id: string;
          message_index: number;
          role: string;
          snippet: string;
          score: number;
          title: string;
          workspace_directory: string;
          date_created: string;
        }[]
      >(
        `SELECT
           session_fts.session_id AS session_id,
           session_fts.message_index AS message_index,
           session_fts.role AS role,
           snippet(session_fts, 0, '', '', '…', 24) AS snippet,
           bm25(session_fts) AS score,
           session_meta.title AS title,
           session_meta.workspace_directory AS workspace_directory,
           session_meta.date_created AS date_created
         FROM session_fts
         JOIN session_meta ON session_meta.session_id = session_fts.session_id
         WHERE session_fts MATCH ?
           ${
             workspaceDirectory
               ? "AND lower(rtrim(session_meta.workspace_directory, '/\\')) = ?"
               : ""
           }
         ORDER BY score
         LIMIT ?`,
        workspaceDirectory
          ? [match, normalizeDir(workspaceDirectory), scanLimit]
          : [match, scanLimit],
      ),
    );
  }

  /** Session ids containing every one of these terms, anywhere in the session. */
  private async sessionsCoveringAllTerms(
    terms: string[],
    workspaceDirectory: string | undefined,
  ): Promise<Set<string>> {
    let covered: Set<string> | undefined;
    for (const term of terms) {
      const rows = await this.matchRows(
        quoteTerm(term),
        10_000,
        workspaceDirectory,
      );
      const ids = new Set(rows.map((row) => row.session_id));
      covered =
        covered === undefined
          ? ids
          : new Set([...covered].filter((id) => ids.has(id)));
      if (covered.size === 0) {
        break;
      }
    }
    return covered ?? new Set<string>();
  }

  /**
   * Discovery: rank messages across every session by BM25.
   *
   * The raw query goes to FTS5 first, so every documented operator (`OR`,
   * `NOT`, `"exact phrase"`, `deploy*`) keeps working exactly as written.
   *
   * When a plain multi-word query finds nothing, it is retried across whole
   * sessions. FTS5 applies AND within a single indexed row, and rows here are
   * individual messages — so "render health" demands one message containing
   * both words, while the user means one *conversation* that covered both.
   * That is the normal shape of cross-session recall and it would otherwise
   * return nothing at all. The retry still requires every term, just anywhere
   * in the session, so a genuinely absent word still yields no result.
   *
   * A query that already uses explicit syntax is never retried: the user said
   * what they meant.
   */
  async search(request: SessionSearchQuery): Promise<SessionSearchHit[]> {
    const limit = Math.max(1, Math.min(request.limit ?? 10, 50));
    // Over-fetch so the per-session cap still has alternatives to promote.
    const scanLimit = limit * MAX_HITS_PER_SESSION * 4;
    const workspaceDirectory = request.workspaceDirectory;

    let rows;
    try {
      rows = await this.matchRows(request.query, scanLimit, workspaceDirectory);
    } catch {
      // Unbalanced quotes and stray parentheses are syntax errors, not a
      // reason to surface SQL noise. Retry the whole thing as one phrase.
      rows = await this.matchRows(
        `"${request.query.replace(/"/gu, '""')}"`,
        scanLimit,
        workspaceDirectory,
      );
    }

    const terms = bareTerms(request.query);
    if (rows.length === 0 && terms.length > 1 && !usesExplicitSyntax(request.query)) {
      const covering = await this.sessionsCoveringAllTerms(
        terms,
        workspaceDirectory,
      );
      if (covering.size > 0) {
        const anyTerm = terms.map(quoteTerm).join(" OR ");
        const candidates = await this.matchRows(
          anyTerm,
          scanLimit * 4,
          workspaceDirectory,
        );
        rows = candidates.filter((row) => covering.has(row.session_id));
      }
    }

    const perSession = new Map<string, number>();
    const hits: SessionSearchHit[] = [];
    for (const row of rows) {
      const taken = perSession.get(row.session_id) ?? 0;
      if (taken >= MAX_HITS_PER_SESSION) {
        continue;
      }
      perSession.set(row.session_id, taken + 1);
      hits.push({
        sessionId: row.session_id,
        title: row.title,
        workspaceDirectory: row.workspace_directory,
        dateCreated: row.date_created,
        messageIndex: row.message_index,
        role: row.role,
        snippet: row.snippet,
        score: row.score,
      });
      if (hits.length >= limit) {
        break;
      }
    }
    return hits;
  }

  /** Scroll: the messages surrounding one hit, for reading it in context. */
  async scroll(
    sessionId: string,
    aroundMessageIndex: number,
    radius = 5,
  ): Promise<SessionMessage[]> {
    const session = historyManager.load(sessionId);
    const history = session.history ?? [];
    const start = Math.max(0, aroundMessageIndex - radius);
    const end = Math.min(history.length, aroundMessageIndex + radius + 1);

    const messages: SessionMessage[] = [];
    for (let index = start; index < end; index++) {
      const item = history[index] as { message?: { role?: string } } | undefined;
      const role = item?.message?.role;
      if (typeof role !== "string") {
        continue;
      }
      const content = messageText(item as never).trim();
      if (content === "") {
        continue;
      }
      messages.push({ messageIndex: index, role, content });
    }
    return messages;
  }

  /** Read: a whole session, head and tail when it is long. */
  async read(
    sessionId: string,
    maxMessages = 40,
  ): Promise<{ summary: SessionSummary; messages: SessionMessage[]; elided: number }> {
    const session = historyManager.load(sessionId);
    const history = session.history ?? [];

    const all: SessionMessage[] = [];
    for (let index = 0; index < history.length; index++) {
      const item = history[index] as { message?: { role?: string } };
      const role = item?.message?.role;
      if (typeof role !== "string" || !INDEXED_ROLES.has(role)) {
        continue;
      }
      const content = messageText(item as never).trim();
      if (content === "") {
        continue;
      }
      all.push({ messageIndex: index, role, content });
    }

    let messages = all;
    let elided = 0;
    if (all.length > maxMessages) {
      const half = Math.floor(maxMessages / 2);
      messages = [...all.slice(0, half), ...all.slice(all.length - half)];
      elided = all.length - messages.length;
    }

    // The session file itself carries no creation date; only the sessions
    // list does. Looking it up keeps `read` from returning a summary with a
    // permanently blank field that callers would have to special-case.
    const metadata = historyManager
      .list({})
      .find((entry) => entry.sessionId === sessionId);

    return {
      summary: {
        sessionId,
        title: session.title ?? "",
        workspaceDirectory: session.workspaceDirectory ?? "",
        dateCreated: String(metadata?.dateCreated ?? ""),
        messageCount: all.length,
      },
      messages,
      elided,
    };
  }

  /** Browse: recent sessions, newest first, no query needed. */
  async browse(
    limit = 20,
    workspaceDirectory?: string,
  ): Promise<SessionSummary[]> {
    const target = workspaceDirectory
      ? normalizeDir(workspaceDirectory)
      : undefined;
    const sessions = historyManager
      .list({})
      .filter(
        (meta) =>
          target === undefined ||
          normalizeDir(meta.workspaceDirectory ?? "") === target,
      );
    return sessions.slice(0, Math.max(1, Math.min(limit, 100))).map((meta) => ({
      sessionId: meta.sessionId,
      title: meta.title,
      workspaceDirectory: meta.workspaceDirectory ?? "",
      dateCreated: String(meta.dateCreated ?? ""),
      messageCount: meta.messageCount ?? 0,
    }));
  }
}

let sharedIndex: SessionSearchIndex | undefined;

export function getSessionSearchIndex(): SessionSearchIndex {
  if (!sharedIndex) {
    sharedIndex = new SessionSearchIndex();
  }
  return sharedIndex;
}
