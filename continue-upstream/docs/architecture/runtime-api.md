# Lumina Runtime API

`cn serve` exposes a stable local API under `/api/v1`. Existing unversioned
routes remain available for older clients, but new integrations should use the
versioned contract.

## Discovery and events

- `GET /api/v1/health` reports runtime and session health.
- `GET /api/v1/openapi.json` returns the OpenAPI 3.1 contract.
- `GET /api/v1/events` streams typed server-sent events (SSE), including run,
  permission, message, child-session, state, and shutdown lifecycle changes.

The remaining operations expose state, child sessions, message queuing,
permission resolution, pause, and Git diff. The OpenAPI document is the source
for generated operation metadata. Regenerate it after contract changes with:

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

