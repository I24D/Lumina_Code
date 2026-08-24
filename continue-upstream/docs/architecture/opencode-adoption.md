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
headless, command-line, and personal permission policies. Delegated policies
are deep snapshots, so a later mode switch cannot elevate an in-flight child.

### Request-scoped parallel execution

System messages, permission state, chat history, streaming terminal output,
tool results, compaction writes, and usage accounting are request-scoped with
Node's asynchronous context storage. Independent child sessions can therefore
run concurrently without mutating the active primary session or one another.
Nested delegation still fails explicitly to prevent unbounded agent trees.

### Child sessions

Each subagent run is persisted as a child-session record containing:

- its own session ID;
- the parent session ID;
- agent name and lifecycle status (`queued`, `running`, `completed`, `failed`,
  or `canceled`);
- prompt and generated history;
- token and cost usage attributed to that child only;
- failure or cancellation information.

Child records are stored under the CLI session directory's `children` folder.
They do not pollute the top-level chat list. `cn serve` exposes them through
`GET /session/:id/children`, establishing the first stable session-tree API.

### Versioned runtime API

`cn serve` now preserves its legacy endpoints while exposing `/api/v1` with a
health check, session state and child operations, message and permission
commands, pause and diff operations, and a typed SSE lifecycle stream. The
OpenAPI 3.1 document is available at `/api/v1/openapi.json`; generated operation
metadata backs the TypeScript runtime client and is checked against the
contract in tests. See [runtime-api.md](runtime-api.md).

## Next ports

1. Render parent/child sessions in the CLI and Lumina chat UI, including agent,
   status, permissions, diff, cancellation, and retry controls.
2. Isolate write-capable delegated work in Git worktrees and require review
   before merging results into the user's working tree.
3. Move permission policy types and evaluation into a shared core package used
   by CLI, VS Code, Start Talk, and Windows Bridge.
4. Expose diagnostics through a portable LSP manager when no IDE language
   server is available.
5. Unify CLI hooks, MCP, skills, and custom tools behind a typed plugin API.
6. Add ACP support after the versioned runtime API is stable.

## Explicit non-goals

- Sending recognized voice directly to a full-access agent.
- Enabling public session sharing by default.
- Depending on OpenCode cloud services for Lumina's local operation.
- Copying OpenCode branding, billing, telemetry, or its complete build system.
