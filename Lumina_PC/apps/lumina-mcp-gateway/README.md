# Lumina MCP Gateway

Remote **MCP server** (Streamable HTTP) that fronts the Lumina brain so the
**Claude app custom connector** can drive it. It lets Claude:

- **write in the Lumina Code chat** and get the agent's final answer
  (`lumina_code_chat`) — via the local WS surface the VS Code extension
  publishes (`luminaMcpBridge.ts` → `OrbBridgeServer`, the same path Start Talk
  uses);
- **act on the PC** through the Windows bridge (`whatsapp_respond`,
  `pc_system_context`, `pc_open_application`, `pc_ui_inspect`, `pc_ui_interact`);
- **share the unified memory** (`memory_recall`, `memory_save`).

Direction is **Claude → Lumina** (Claude is the MCP client and drives). Lumina
can answer within a tool call but cannot spontaneously push a new turn into the
Claude app — that is a limitation of the Claude app connector, not of this
gateway.

## Run

Runs as a managed service under `pnpm dev:all` (service `lumina-mcp-gateway`).
Standalone:

```bash
node --experimental-strip-types src/server.ts
```

TypeScript only, Node 22 native type-stripping (no bundler), matching the
windows-bridge. The single canonical env file at the repo root is the only
config source.

## Auth & exposure

The Claude app requires **OAuth 2.1** for remote MCP connectors, so the gateway
implements the full flow (`oauth.ts`): OAuth metadata discovery, Dynamic Client
Registration (RFC 7591), Authorization Code + PKCE (S256), and refresh tokens.

- Binds to `127.0.0.1:8808` (env `MCP_GATEWAY_PORT` / `MCP_GATEWAY_HOST`).
- The **authorization step is gated by the connector secret**: Claude opens
  `/authorize` in the user's browser, the user enters the secret once, and only
  then is a code issued. The secret is generated once and stored at
  `~/.lumina/mcp-gateway-secret.txt` (override with `MCP_GATEWAY_SECRET`).
- The `/mcp` endpoint requires a bearer token the gateway issued. The static
  secret is also accepted (in the path `/<secret>/mcp` or as a bearer) for local
  testing.
- Clients + refresh tokens persist to `~/.lumina/mcp-oauth.json` so a restart
  does not force Claude to reconnect.
- Exposed to the internet only through the Cloudflare tunnel as
  `mcp.luminaopenia.com` (ingress in `~/.cloudflared/config.yml`).

Connector URL (paste into the Claude app; leave OAuth fields empty):

```
https://mcp.luminaopenia.com/mcp
```

`GET /health` is unauthenticated (liveness only; reports whether the chat bridge
is configured). OAuth discovery endpoints (`/.well-known/*`) are public by design.

## Env (all optional; sensible defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `MCP_GATEWAY_PORT` | `8808` | Local listen port |
| `MCP_GATEWAY_HOST` | `127.0.0.1` | Local bind |
| `MCP_GATEWAY_SECRET` | generated | Connector secret |
| `MCP_GATEWAY_PUBLIC_HOST` | `mcp.luminaopenia.com` | Printed public host |
| `LUMINA_BRIDGE_URL` | `http://127.0.0.1:8765` | Windows bridge |
| `LUMINA_CORE_URL` | `http://127.0.0.1:3000` | I24D backend (memory) |
| `LUMINA_DEFAULT_USER_ID` | `owner` | Default memory identity |

## Tools

| Tool | Upstream |
|------|----------|
| `lumina_code_chat` | WS → Lumina Code chat (`delegateToMain`) |
| `whatsapp_respond` | `POST :8765/whatsapp/reply` |
| `pc_system_context` | `GET :8765/system_context` |
| `pc_open_application` | `POST :8765/open_application` |
| `pc_ui_inspect` | `POST :8765/ui_inspect` |
| `pc_ui_interact` | `POST :8765/ui_interact` |
| `memory_recall` | `GET :3000/api/memory/search` |
| `memory_save` | `POST :3000/api/memory` |

Resources: `lumina://pc/status`, `lumina://bridge/health`,
`lumina://memory/brief`.

`lumina_code_chat` requires the **Lumina Code sidebar to be open** in the Dev
Host (that is where the delegation bridge runs). Coordinates are published to
`~/.lumina/mcp-bridge.json` by the extension on activation.
