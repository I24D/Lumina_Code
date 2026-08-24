import { portableLspManager } from "../lsp/PortableLspManager.js";
import { resolveAgentPath } from "../stream/executionContext.js";

import { formatToolArgument } from "./formatters.js";
import type { Tool } from "./types.js";

const SEVERITY = ["unknown", "error", "warning", "information", "hint"];

export const diagnosticsTool: Tool = {
  name: "Diagnostics",
  displayName: "Diagnostics",
  description:
    "Get compiler-quality diagnostics for a file from a portable language server, including outside VS Code",
  parameters: {
    type: "object",
    required: ["filepath"],
    properties: {
      filepath: {
        type: "string",
        description: "Path to the source file to diagnose",
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  preprocess: async (args) => {
    const filepath = resolveAgentPath(args.filepath);
    return {
      args: { ...args, filepath },
      preview: [
        {
          type: "text",
          content: `Will diagnose ${formatToolArgument(filepath)}`,
        },
      ],
    };
  },
  run: async ({ filepath }: { filepath: string }): Promise<string> => {
    const resolved = resolveAgentPath(filepath);
    try {
      const result = await portableLspManager.getDiagnostics(resolved);
      if (result.timedOut) {
        return `${result.serverId} did not publish diagnostics within the timeout.`;
      }
      if (result.diagnostics.length === 0) {
        return `No diagnostics from ${result.serverId}.`;
      }
      return result.diagnostics
        .map((diagnostic) => {
          const line = diagnostic.range.start.line + 1;
          const column = diagnostic.range.start.character + 1;
          const severity = SEVERITY[diagnostic.severity ?? 0] ?? "unknown";
          const source = diagnostic.source ? ` ${diagnostic.source}` : "";
          const code =
            diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
          return `${resolved}:${line}:${column} [${severity}]${source}${code} ${diagnostic.message}`;
        })
        .join("\n");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      // CLI tool calls are short-lived; do not leave a language server keeping
      // the process alive after diagnostics have been returned.
      await portableLspManager.dispose();
    }
  },
};
