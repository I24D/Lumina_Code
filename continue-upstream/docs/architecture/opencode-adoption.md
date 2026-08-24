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

### Child-session controls and UI

The CLI renders delegated output with lifecycle status and a traceable child
identifier. Lumina's chat GUI recognizes `Subagent` tool calls and shows a
dedicated task card with agent, description, status, output or error, and Stop
or Retry controls. The v1 API implements targeted cancellation and linked
retries; retry records retain `retryOfSessionId` for auditing. Hosts without a
runtime API connection keep Retry disabled and use the normal safe stream abort
fallback for Stop.

### Isolated delegated writes

Write-capable child agents run in detached Git worktrees that begin with an
exact snapshot of the user's staged, unstaged, and untracked files. Relative
file tools reject paths outside that worktree, and terminal commands start
there as well. A completed task cannot change the primary working tree by
itself: the child card first exposes its unified diff for review and only then
offers an explicit Apply action. The v1 runtime API provides the same two-step
review/apply flow for non-GUI clients. Read-only delegation avoids the worktree
cost, while any policy that enables file editing or Bash is treated as
write-capable.

This is change isolation, not an operating-system sandbox: an explicitly
authorized terminal command can still address absolute paths. Lumina's normal
permission prompt remains the authority for that action.

### Shared permission policy

`@continuedev/terminal-security` now owns host-neutral permission types,
first-match tool and argument evaluation, core-policy conversion, and explicit
authorization rules. The CLI consumes that evaluator instead of maintaining a
private copy. VS Code, Start Talk, core, and Windows Bridge use the same surface
authorization boundary.

Start Talk delegation is checked independently by the orb UI, authenticated
extension bridge, core relay, and main chat. Model output is never accepted as
approval evidence. A missing or excluded authorization fails closed, while the
host remains responsible for showing its native prompt. Windows Bridge routes
its endpoint capability through the same decision model and retains its hard
block against workspace-file mutation through Bridge PowerShell.

## Next ports

1. Expose diagnostics through a portable LSP manager when no IDE language
   server is available.
2. Unify CLI hooks, MCP, skills, and custom tools behind a typed plugin API.
3. Add ACP support after the versioned runtime API is stable.

## Explicit non-goals

- Sending recognized voice directly to a full-access agent.
- Enabling public session sharing by default.
- Depending on OpenCode cloud services for Lumina's local operation.
- Copying OpenCode branding, billing, telemetry, or its complete build system.
