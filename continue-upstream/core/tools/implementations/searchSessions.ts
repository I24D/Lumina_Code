import { ToolImpl } from ".";
import {
  getSessionSearchIndex,
  SessionMessage,
} from "../../learning/SessionSearchIndex";

/** Keeps a single recalled message from swamping the turn it was recalled into. */
const MAX_MESSAGE_CHARS = 1_200;

function formatDate(value: string): string {
  const asNumber = Number(value);
  const date = Number.isFinite(asNumber) && asNumber > 0 ? new Date(asNumber) : new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown date" : date.toISOString().slice(0, 10);
}

function renderMessages(messages: SessionMessage[]): string {
  return messages
    .map((message) => {
      const body =
        message.content.length > MAX_MESSAGE_CHARS
          ? `${message.content.slice(0, MAX_MESSAGE_CHARS)}…`
          : message.content;
      return `[${message.messageIndex}] ${message.role}: ${body}`;
    })
    .join("\n\n");
}

/**
 * search_sessions — the four recall shapes over Lumina's own history.
 *
 * The mode is inferred from the arguments rather than asked for, so the model
 * cannot pick a mode inconsistent with the data it has: a hit gives you a
 * sessionId and a message index, and those are exactly what scroll needs.
 */
export const searchSessionsImpl: ToolImpl = async (args, extras) => {
  const index = getSessionSearchIndex();

  const query = typeof args.query === "string" ? args.query.trim() : "";
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() !== ""
      ? args.sessionId.trim()
      : undefined;
  const aroundMessageIndex =
    typeof args.aroundMessageIndex === "number" &&
    Number.isFinite(args.aroundMessageIndex)
      ? Math.max(0, Math.floor(args.aroundMessageIndex))
      : undefined;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.floor(args.limit)
      : undefined;

  // Opt-in, and deliberately forgiving: a session's workspaceDirectory is
  // whatever the GUI recorded, which need not match the IDE's URI form. If the
  // two cannot be reconciled the filter is dropped rather than silently
  // returning nothing, because "searched everything" is a recoverable answer
  // and "found nothing" is not.
  let workspaceDirectory: string | undefined;
  if (args.currentWorkspaceOnly === true) {
    const dirs = await extras.ide.getWorkspaceDirs();
    workspaceDirectory = dirs[0];
  }

  if (sessionId && aroundMessageIndex !== undefined) {
    const messages = await index.scroll(sessionId, aroundMessageIndex);
    return [
      {
        name: `Session context (${sessionId.slice(0, 8)})`,
        description: `Messages around #${aroundMessageIndex}`,
        content:
          messages.length === 0
            ? `No messages found around index ${aroundMessageIndex} in session ${sessionId}.`
            : renderMessages(messages),
      },
    ];
  }

  if (sessionId) {
    const { summary, messages, elided } = await index.read(sessionId);
    const header = `Session "${summary.title || "untitled"}" (${summary.messageCount} messages)`;
    const note =
      elided > 0
        ? `\n\n… ${elided} messages omitted from the middle. Use aroundMessageIndex to read a specific stretch.`
        : "";
    return [
      {
        name: header,
        description: summary.workspaceDirectory || "",
        content:
          messages.length === 0
            ? `Session ${sessionId} has no readable messages.`
            : `${header}\n\n${renderMessages(messages)}${note}`,
      },
    ];
  }

  if (query !== "") {
    try {
      await index.refresh();
    } catch {
      // A failed refresh only means results may be stale; the existing index
      // is still worth searching.
    }
    const hits = await index.search({ query, limit, workspaceDirectory });
    if (hits.length === 0) {
      return [
        {
          name: "No matching sessions",
          description: query,
          content:
            `Nothing in past sessions matched "${query}". Note that multiple words ` +
            "require ALL of them — try fewer words, or OR between them.",
        },
      ];
    }
    const rendered = hits
      .map(
        (hit, position) =>
          `${position + 1}. "${hit.title || "untitled"}" — ${formatDate(hit.dateCreated)}\n` +
          `   sessionId: ${hit.sessionId}  aroundMessageIndex: ${hit.messageIndex}  (${hit.role})\n` +
          `   ${hit.snippet.replace(/\s+/gu, " ").trim()}`,
      )
      .join("\n\n");
    return [
      {
        name: `${hits.length} past session${hits.length === 1 ? "" : "s"} matched`,
        description: query,
        content:
          `${rendered}\n\nTo read one in context, call this tool again with its ` +
          "sessionId and aroundMessageIndex.",
      },
    ];
  }

  try {
    await index.refresh();
  } catch {
    // Browse reads the session list directly, so a stale index costs nothing.
  }
  const sessions = await index.browse(limit ?? 20, workspaceDirectory);
  if (sessions.length === 0) {
    return [
      {
        name: "No past sessions",
        description: "",
        content: "There are no saved sessions to browse yet.",
      },
    ];
  }
  return [
    {
      name: `${sessions.length} recent session${sessions.length === 1 ? "" : "s"}`,
      description: "",
      content: sessions
        .map(
          (session) =>
            `- "${session.title || "untitled"}" — ${formatDate(session.dateCreated)}, ` +
            `${session.messageCount} messages, sessionId: ${session.sessionId}`,
        )
        .join("\n"),
    },
  ];
};
