# OpenCode adoption in Lumina Code

Lumina Code selectively adopts proven OpenCode runtime concepts inside this
repository. OpenCode is an architectural reference and an optional integration
target; it does not replace Lumina's Continue-based core, VS Code experience,
Start Talk, or Windows capabilities.

## Principles

1. New runtime capabilities belong in `continue-upstream`, close to the code
   that owns them (`core`, `extensions/cli`, `extensions/vscode`, or `gui`).
2. Start Talk and other voice inputs never bypass Lumina's authorization and
   tool-permission checks.
3. A delegated agent cannot gain permissions that its parent does not have.
4. Sessions and tool actions must remain traceable to their origin.
5. OpenCode code copied or substantially adapted under its MIT license must
   retain the required copyright and license notice.
6. Ports are incremental and covered by regression tests; the OpenCode
   monorepo is not merged wholesale into Continue.

## Implemented foundation

### Secure delegated agents

The CLI subagent executor inherits the active permission policy. It no longer
replaces that policy with `allow *`. This applies equally to normal, Plan, Auto,
headless, command-line, and personal permission policies.

The current stream still temporarily changes process-global system-message and
chat-history services. Subagent execution is therefore serialized until these
services become request-scoped. Nested delegation fails explicitly rather than
deadlocking or silently escalating privileges.

### Child sessions

Each subagent run is persisted as a child-session record containing:

- its own session ID;
- the parent session ID;
- agent name and lifecycle status (`queued`, `running`, `completed`, `failed`,
  or `canceled`);
- prompt and generated history;
- failure or cancellation information.

Child records are stored under the CLI session directory's `children` folder.
They do not pollute the top-level chat list. `cn serve` exposes them through
`GET /session/:id/children`, establishing the first stable session-tree API.

## Next ports

1. Make system messages, permissions, tool results, and chat history fully
   request-scoped so independent child sessions can run in parallel safely.
2. Extend `cn serve` with a versioned API, event stream, health endpoint, and an
   OpenAPI document; generate a TypeScript client from that contract.
3. Render parent/child sessions in the CLI and Lumina chat UI, including agent,
   status, permissions, diff, cancellation, and retry controls.
4. Isolate write-capable delegated work in Git worktrees and require review
   before merging results into the user's working tree.
5. Move permission policy types and evaluation into a shared core package used
   by CLI, VS Code, Start Talk, and Windows Bridge.
6. Expose diagnostics through a portable LSP manager when no IDE language
   server is available.
7. Unify CLI hooks, MCP, skills, and custom tools behind a typed plugin API.
8. Add ACP support after the versioned runtime API is stable.

## Explicit non-goals

- Sending recognized voice directly to a full-access agent.
- Enabling public session sharing by default.
- Depending on OpenCode cloud services for Lumina's local operation.
- Copying OpenCode branding, billing, telemetry, or its complete build system.
