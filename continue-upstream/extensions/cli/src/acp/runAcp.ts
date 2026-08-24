import { Readable, Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { LuminaRuntimeClient } from "../api/runtimeClient.js";

import { createLuminaAcpAgent } from "./LuminaAcpAgent.js";

export interface AcpOptions {
  runtimeUrl?: string;
}

/** Serve ACP v1 over stdio while delegating all execution to `/api/v1`. */
export async function runAcp(options: AcpOptions = {}): Promise<void> {
  const runtimeUrl =
    options.runtimeUrl ??
    process.env.LUMINA_RUNTIME_URL ??
    "http://127.0.0.1:8000";
  const runtime = new LuminaRuntimeClient({ baseUrl: runtimeUrl });
  await runtime.getHealth();

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = createLuminaAcpAgent(runtime).connect(stream);
  await connection.closed;
}
