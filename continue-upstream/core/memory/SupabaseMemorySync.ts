import type { MemorySnapshot } from "./types.js";
import {
  emptyMemorySnapshot,
  mergeMemorySnapshots,
  sanitizeMemorySnapshot,
} from "./MemoryPersistence.js";

export interface SupabaseMemoryConfig {
  url?: string;
  publishableKey?: string;
  accessToken?: string;
  table?: string;
  namespace?: string;
}

export interface MemorySyncStatus {
  configured: boolean;
  provider: "local" | "supabase";
  state: "local" | "ready" | "syncing" | "synced" | "error";
  lastSyncAt?: string;
  lastError?: string;
  table?: string;
  namespace?: string;
}

type RemoteRow = { payload?: unknown; updated_at?: string };

function validateConfig(
  config: SupabaseMemoryConfig,
): Required<SupabaseMemoryConfig> {
  if (!config.url || !config.publishableKey || !config.accessToken) {
    throw new Error(
      "Supabase necesita LUMINA_SUPABASE_URL, LUMINA_SUPABASE_PUBLISHABLE_KEY y LUMINA_SUPABASE_ACCESS_TOKEN.",
    );
  }
  const url = new URL(config.url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("La URL remota de Supabase debe usar HTTPS.");
  }
  const table = config.table?.trim() || "lumina_memory_state";
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(table)) {
    throw new Error("El nombre de la tabla Supabase no es válido.");
  }
  const namespace = (config.namespace?.trim() || "default").slice(0, 120);
  return {
    url: url.toString().replace(/\/$/u, ""),
    publishableKey: config.publishableKey,
    accessToken: config.accessToken,
    table,
    namespace,
  };
}

export function getMemorySyncStatus(
  config: SupabaseMemoryConfig,
): MemorySyncStatus {
  const supplied = [
    config.url,
    config.publishableKey,
    config.accessToken,
  ].filter(Boolean).length;
  const configured = Boolean(
    config.url && config.publishableKey && config.accessToken,
  );
  if (supplied > 0 && !configured) {
    return {
      configured: false,
      provider: "supabase",
      state: "error",
      lastError:
        "Configuración incompleta: define URL, publishable key y access token.",
      table: config.table?.trim() || "lumina_memory_state",
      namespace: config.namespace?.trim() || "default",
    };
  }
  return configured
    ? {
        configured: true,
        provider: "supabase",
        state: "ready",
        table: config.table?.trim() || "lumina_memory_state",
        namespace: config.namespace?.trim() || "default",
      }
    : { configured: false, provider: "local", state: "local" };
}

export class SupabaseMemorySync {
  private readonly config: Required<SupabaseMemoryConfig>;

  constructor(
    config: SupabaseMemoryConfig,
    private readonly request: typeof fetch = fetch,
  ) {
    this.config = validateConfig(config);
  }

  async sync(local: MemorySnapshot): Promise<MemorySnapshot> {
    const remote = await this.pull();
    const merged = mergeMemorySnapshots(local, remote);
    await this.push(merged);
    return merged;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.publishableKey,
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: "application/json",
      ...extra,
    };
  }

  private endpoint(query: string): string {
    return `${this.config.url}/rest/v1/${this.config.table}?${query}`;
  }

  private async pull(): Promise<MemorySnapshot> {
    const query = new URLSearchParams({
      select: "payload,updated_at",
      namespace: `eq.${this.config.namespace}`,
      limit: "1",
    });
    const response = await this.request(this.endpoint(query.toString()), {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) throw await this.responseError(response, "leer");
    const rows = (await response.json()) as RemoteRow[];
    return rows[0]?.payload
      ? sanitizeMemorySnapshot(rows[0].payload)
      : emptyMemorySnapshot();
  }

  private async push(snapshot: MemorySnapshot): Promise<void> {
    const response = await this.request(
      this.endpoint("on_conflict=user_id%2Cnamespace"),
      {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify({
          namespace: this.config.namespace,
          payload: snapshot,
          updated_at: snapshot.updatedAt,
        }),
      },
    );
    if (!response.ok) throw await this.responseError(response, "guardar");
  }

  private async responseError(
    response: Response,
    action: string,
  ): Promise<Error> {
    const detail = (await response.text()).slice(0, 500);
    return new Error(
      `Supabase no pudo ${action} la memoria (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
}
