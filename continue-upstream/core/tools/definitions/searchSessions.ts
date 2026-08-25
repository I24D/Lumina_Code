import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

/**
 * search_sessions — episodic recall across past conversations.
 *
 * Ported from Hermes's session search: one tool with four shapes rather than
 * four tools, because which shape you want is fully determined by which
 * arguments you have. Discovery finds the conversation, scroll reads around
 * the hit, read opens the whole thing, browse lists what is recent.
 */
export const searchSessionsTool: Tool = {
  type: "function",
  displayTitle: "Search Sessions",
  wouldLikeTo: "search past conversations",
  isCurrently: "searching past conversations",
  hasAlready: "searched past conversations",
  readonly: true,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.SearchSessions,
    description: `Search Lumina's own past chat sessions — this is how Lumina REMEMBERS across conversations. Use it when the user refers to earlier work ("what did we decide about X", "the fix from last week", "that command you found"), or before re-solving something that may already have been solved.

Four modes, chosen by which arguments you pass:
- Discovery — pass "query": ranked matches across every session.
- Scroll — pass "sessionId" and "aroundMessageIndex": the messages surrounding one hit.
- Read — pass "sessionId" alone: the whole conversation.
- Browse — pass nothing: the most recent sessions.

The query supports full-text operators: multiple words require ALL of them somewhere in the same conversation, "OR" broadens (alpha OR beta), quotes match an exact phrase ("docker networking"), NOT excludes (python NOT java), and a trailing * matches prefixes (deploy*). Writing any operator yourself turns off the widening and searches exactly what you asked for.`,
    parameters: {
      type: "object",
      required: [],
      properties: {
        query: {
          type: "string",
          description:
            "Full-text query for discovery mode. Omit to browse or to read a specific session.",
        },
        sessionId: {
          type: "string",
          description:
            "Open one session. Combine with aroundMessageIndex to read around a specific hit.",
        },
        aroundMessageIndex: {
          type: "number",
          description:
            "Message index from a discovery hit; returns the messages around it.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10).",
        },
        currentWorkspaceOnly: {
          type: "boolean",
          description:
            "Restrict results to sessions from the current workspace (default false).",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To recall what happened in an earlier conversation, call the ${BuiltInToolNames.SearchSessions} tool. For example:`,
    exampleArgs: [["query", "render deploy health check"]],
  },
  toolCallIcon: "ClockIcon",
};
