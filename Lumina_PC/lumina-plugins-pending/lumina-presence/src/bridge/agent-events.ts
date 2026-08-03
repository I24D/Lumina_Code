import type { PresenceEvent } from "../types.js";

export const OBSERVATION_PRESENCE_STREAM = "lumina-observation.presence";

type AgentEventLike = {
  readonly runId: string;
  readonly sessionKey?: string;
  readonly stream: string;
  readonly data?: unknown;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runtimeSessionKey(event: AgentEventLike): string {
  return event.sessionKey?.trim() || `run:${event.runId}`;
}

export function mapRuntimeAgentEvent(event: AgentEventLike): PresenceEvent[] {
  const data = asRecord(event.data);
  const sessionKey = runtimeSessionKey(event);

  if (event.stream === "lifecycle") {
    const phase = readString(data, "phase");
    if (phase === "start") {
      return [{ kind: "agent.turn.start", sessionKey }];
    }
    if (phase === "end" || phase === "error" || phase === "aborted") {
      return [{ kind: "agent.turn.end", sessionKey, ok: phase === "end" }];
    }
    return [];
  }

  if (event.stream === "tool") {
    const phase = readString(data, "phase");
    const toolName = readString(data, "name");
    if (!toolName) return [];
    if (phase === "start") {
      if (toolName.includes("consult")) {
        return [
          { kind: "agent.consult.requested", sessionKey },
          { kind: "agent.tool.invoke", toolName, sessionKey },
        ];
      }
      return [{ kind: "agent.tool.invoke", toolName, sessionKey }];
    }
    if (phase === "result") {
      return [
        {
          kind: "agent.tool.complete",
          toolName,
          sessionKey,
          ok: data?.isError !== true,
        },
      ];
    }
  }

  return [];
}

export function mapObservationAgentEvent(event: AgentEventLike): PresenceEvent[] {
  if (event.stream !== OBSERVATION_PRESENCE_STREAM) return [];
  const envelope = asRecord(event.data);
  if (
    envelope?.schemaVersion !== 1 ||
    envelope.source !== "lumina-observation" ||
    !Array.isArray(envelope.changes)
  ) {
    return [];
  }

  const out: PresenceEvent[] = [];
  for (const rawChange of envelope.changes) {
    const change = asRecord(rawChange);
    switch (readString(change, "kind")) {
      case "window.switched": {
        const to = asRecord(change?.to);
        const title = readString(to, "title");
        const processName = readString(to, "processName");
        if (title && processName) {
          out.push({ kind: "observation.window.changed", title, processName });
        }
        break;
      }
      case "user.went.idle": {
        const idleForMs = readNumber(change, "idleForMs");
        if (idleForMs !== null) {
          out.push({ kind: "observation.user.idle", lastActiveMs: idleForMs });
        }
        break;
      }
      case "user.returned": {
        const awayForMs = readNumber(change, "awayForMs");
        if (awayForMs !== null) {
          out.push({ kind: "observation.user.returned", awayForMs });
        }
        break;
      }
      case "process.spiked": {
        const process = asRecord(change?.process);
        const processName = readString(process, "name");
        const workingSetMB = readNumber(process, "workingSetMB");
        const previousMB = readNumber(change, "previousMB");
        if (processName && workingSetMB !== null && previousMB !== null) {
          out.push({
            kind: "observation.process.spiked",
            processName,
            workingSetMB,
            previousMB,
          });
        }
        break;
      }
    }
  }
  return out;
}
