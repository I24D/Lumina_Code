# Typed CLI plugin API

Lumina's CLI normalizes built-in and custom tools, connected MCP tools,
Markdown skills, and configured hooks into one typed registry. Existing user
formats remain valid; they are adapters, not separate execution systems.

Every contribution records a stable plugin ID, contribution ID, origin, kind,
and typed payload. Tool names are globally unique. If an MCP server or custom
plugin attempts to replace an existing tool, the first tool remains active and
the registry emits a diagnostic. Registration never changes the shared
permission policy: custom and MCP tools still pass through normal permission
evaluation and hook events.

Embedders can register programmatic plugins before starting a CLI session:

```ts
import { registerCliPlugin } from "@continuedev/cli";

const unregister = registerCliPlugin({
  id: "example:quality",
  version: "1.0.0",
  origin: "custom",
  activate({ register }) {
    register({
      id: "tool:quality_check",
      kind: "tool",
      origin: "custom",
      tool: {
        name: "quality_check",
        displayName: "Quality check",
        description: "Run the host's read-only quality check",
        parameters: { type: "object", properties: {} },
        readonly: true,
        isBuiltIn: false,
        async run() {
          return "ok";
        },
      },
    });
  },
});
```

The returned async function unregisters future activations and runs
`deactivate`. A plugin may also
contribute typed hooks and implement `deactivate`. Hook contributions are
overlaid on file-based Continue/Claude-compatible hooks without duplicating
them when tool availability is refreshed.

For security, Lumina does not auto-import executable JavaScript from a cloned
repository. User-facing extensions should continue to use explicit MCP server,
skill, and hook configuration; trusted embedding code can use the programmatic
API above.
