import { MCPManagerSingleton } from "./MCPManagerSingleton";

/**
 * On-demand MCP lifecycle
 *
 * Some MCP servers wrap heavy backends (e.g. Lumina CAI: 26 agents + LLM calls)
 * that we do NOT want resident when idle, to avoid loading the PC. These servers
 * are kept "on-demand":
 *
 *  - Their cached tool schemas keep being advertised to the model even while the
 *    backend process is down (see doLoadConfig), so a tool call is always
 *    possible.
 *  - The first tool call transparently reconnects the backend
 *    (`ensureOnDemandMcpReady`) and (re)arms an idle-shutdown timer.
 *  - After `LUMINA_MCP_IDLE_MS` with no further use, the backend is disconnected
 *    (`setEnabled(id, false)` → the stdio subprocess is killed), reclaiming its
 *    memory. The next call spins it back up.
 *
 * Which servers are on-demand: "lumina-cai" by default, plus any comma-separated
 * ids in `LUMINA_MCP_ONDEMAND`. For YAML config the server id equals its name.
 */

const DEFAULT_IDLE_MS = 5 * 60_000;
const MIN_IDLE_MS = 10_000;

function idleMs(): number {
  const raw = Number(process.env.LUMINA_MCP_IDLE_MS);
  return Number.isFinite(raw) && raw >= MIN_IDLE_MS ? raw : DEFAULT_IDLE_MS;
}

function onDemandServerIds(): Set<string> {
  const extra = (process.env.LUMINA_MCP_ONDEMAND ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set<string>(["lumina-cai", ...extra]);
}

export function isOnDemandMcpServer(idOrName: string): boolean {
  return onDemandServerIds().has(idOrName);
}

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * (Re)arm the idle-shutdown timer for an on-demand server. When it fires, the
 * server is disconnected so its subprocess is killed. No-op for other servers.
 */
export function armOnDemandIdleShutdown(serverId: string): void {
  if (!isOnDemandMcpServer(serverId)) {
    return;
  }
  const existing = idleTimers.get(serverId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    idleTimers.delete(serverId);
    void MCPManagerSingleton.getInstance()
      .setEnabled(serverId, false)
      .catch(() => undefined);
  }, idleMs());
  // Never keep the host process alive just for this timer.
  timer.unref?.();
  idleTimers.set(serverId, timer);
}

/**
 * Ensure an on-demand server is connected before a tool call, then (re)arm its
 * idle-shutdown timer. Safe to call for any server id; a no-op for servers that
 * are not marked on-demand.
 */
export async function ensureOnDemandMcpReady(serverId: string): Promise<void> {
  if (!isOnDemandMcpServer(serverId)) {
    return;
  }
  const manager = MCPManagerSingleton.getInstance();
  const connection = manager.getConnection(serverId);
  if (connection && connection.status !== "connected") {
    await manager.setEnabled(serverId, true);
  }
  armOnDemandIdleShutdown(serverId);
}
