// Polls the Windows Bridge for finished Claude Code chat responses so Start Talk
// can read them aloud. Claude Code is a separate process; its `Stop` hook POSTs
// each finished answer to the bridge (/voice/claude-response), and this monitor
// drains them (/voice/claude-response/pending) while a Start Talk session is
// active, handing each one to the orb's existing read-aloud queue.
//
// Mirrors BridgeNotificationMonitor: same bridge base resolution, same tolerant
// polling with a poll-in-flight guard, and the same silent degradation when the
// bridge is briefly unavailable (e.g. a bridge restart).

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_TEXT_LENGTH = 6_000;

function bridgeBaseUrl(explicit?: string): string {
  const configured =
    explicit?.trim() ||
    process.env.LUMINA_WINDOWS_BRIDGE_URL?.trim() ||
    process.env.LUMINA_BRIDGE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  const port = process.env.LUMINA_BRIDGE_PORT?.trim() || "8765";
  return `http://127.0.0.1:${port}`;
}

export interface ClaudeVoiceResponse {
  id: string;
  text: string;
}

export interface ClaudeVoiceMonitorOptions {
  onResponse: (response: ClaudeVoiceResponse) => void;
  bridgeUrl?: string;
  pollIntervalMs?: number;
}

export class ClaudeVoiceMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private readonly base: string;
  private readonly intervalMs: number;

  constructor(private readonly options: ClaudeVoiceMonitorOptions) {
    this.base = bridgeBaseUrl(options.bridgeUrl);
    this.intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.base}/voice/claude-response/pending`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      if (this.stopped || !response.ok) {
        return;
      }
      const data = (await response.json()) as {
        ok?: boolean;
        responses?: unknown[];
      };
      if (data.ok === false || !Array.isArray(data.responses)) {
        return;
      }
      for (const raw of data.responses) {
        if (this.stopped) {
          return;
        }
        const item = this.toResponse(raw);
        if (item) {
          this.options.onResponse(item);
        }
      }
    } catch {
      // Transient bridge unavailability (restart, timeout): drop this poll
      // silently; the next tick retries.
    } finally {
      clearTimeout(timeout);
      this.polling = false;
    }
  }

  private toResponse(raw: unknown): ClaudeVoiceResponse | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const text =
      typeof record.text === "string"
        ? record.text.trim().slice(0, MAX_TEXT_LENGTH)
        : "";
    if (!id || !text) {
      return undefined;
    }
    return { id, text };
  }
}
