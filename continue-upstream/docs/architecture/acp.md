# Agent Client Protocol (ACP)

Lumina Code implements the stable ACP v1 protocol with the official
`@agentclientprotocol/sdk`. This lets ACP-compatible editors use Lumina without
creating a second execution or permission path: the adapter queues prompts,
observes streaming output, resolves permissions, and cancels work through the
versioned Lumina Runtime API.

ACP v2 is deliberately not enabled because it is still experimental in the
official SDK.

## Start the adapter

Run both processes from the same workspace directory:

```bash
# Terminal 1
cn serve --port 8000

# ACP client command
cn acp --runtime-url http://127.0.0.1:8000
```

`--runtime-url` defaults to `LUMINA_RUNTIME_URL`, then to
`http://127.0.0.1:8000`. The ACP process communicates over newline-delimited
JSON-RPC on stdin/stdout, as required by the standard. Runtime events travel
over the typed `/api/v1/events` SSE stream.

For safety, `session/new` rejects a relative working directory, a workspace
that differs from the connected runtime, additional workspace roots, and
per-session MCP definitions. Configure MCP servers in Lumina itself so they
remain subject to Lumina's plugin registry and permission policy.

## Supported behavior

- ACP v1 initialization and capability negotiation;
- new sessions mapped to the connected Lumina runtime session;
- text and resource-link prompts;
- streamed assistant text and tool-start updates;
- interactive permission requests relayed to the ACP client;
- turn cancellation through the runtime pause endpoint.

Images, audio, embedded resources, session loading, and ACP-supplied MCP
servers are not advertised. Unsupported input fails explicitly instead of
being silently discarded.
