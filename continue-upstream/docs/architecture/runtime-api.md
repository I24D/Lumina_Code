# Lumina Runtime API

`cn serve` exposes a stable local API under `/api/v1`. Existing unversioned
routes remain available for older clients, but new integrations should use the
versioned contract.

## Discovery and events

- `GET /api/v1/health` reports API version, session health, and the absolute
  runtime working directory.
- `GET /api/v1/openapi.json` returns the OpenAPI 3.1 contract.
- `GET /api/v1/events` streams typed server-sent events (SSE), including
  assistant content, tool activity, permission requests, message,
  child-session, state, and shutdown lifecycle changes.

The remaining operations expose state, child sessions, message queuing,
targeted child cancellation/retry, permission resolution, pause, and Git diff.
Write-capable child sessions additionally expose
`GET /api/v1/sessions/{id}/diff` for review and
`POST /api/v1/sessions/{id}/apply` for an explicit, conflict-checked apply to
the primary working tree. Fetching a diff never applies it.
The OpenAPI document is the source for generated operation metadata. Regenerate
it after contract changes with:

```bash
cd extensions/cli
npm run generate:runtime-api
```

TypeScript integrations can use `LuminaRuntimeClient` from
`extensions/cli/src/api/runtimeClient.ts`. Its HTTP paths come from the checked-in
generated operation map, and a contract test prevents drift.

The server binds to localhost by default. The API does not grant extra tool
authority: messages still use the active Lumina permission policy, and pending
tool actions must be resolved through the permission endpoint.

The stable ACP v1 adapter is documented in [acp.md](acp.md).
