/**
 * event-bus.ts — Tiny pub/sub for environment change events.
 *
 * The snapshot service produces one event per significant change
 * (battery dropped under 20%, network went offline, a monitor was
 * plugged in, ram > 90%, etc). Consumers — including the agent via
 * lumina_awareness_subscribe — read from here without polling.
 */

export type AwarenessChange =
  | { readonly kind: "battery.low"; readonly percent: number }
  | { readonly kind: "battery.critical"; readonly percent: number }
  | { readonly kind: "battery.charging.changed"; readonly charging: boolean }
  | { readonly kind: "network.offline" }
  | { readonly kind: "network.online"; readonly latencyMs: number }
  | { readonly kind: "monitor.added"; readonly index: number }
  | { readonly kind: "monitor.removed"; readonly index: number }
  | { readonly kind: "disk.low"; readonly drive: string; readonly freePct: number }
  | { readonly kind: "cpu.high"; readonly pct: number }
  | { readonly kind: "ram.high"; readonly pct: number }
  | { readonly kind: "gpu.changed"; readonly count: number }
  | { readonly kind: "device.added"; readonly className: string; readonly name: string }
  | { readonly kind: "device.removed"; readonly className: string; readonly name: string };

export type AwarenessListener = (e: AwarenessChange) => void;

export class AwarenessEventBus {
  private readonly listeners = new Set<AwarenessListener>();
  private readonly recent: Array<{ event: AwarenessChange; atISO: string }> = [];
  private readonly maxRecent = 128;

  emit(event: AwarenessChange): void {
    this.recent.unshift({ event, atISO: new Date().toISOString() });
    if (this.recent.length > this.maxRecent) {
      this.recent.length = this.maxRecent;
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* never let a listener break the bus */
      }
    }
  }

  on(listener: AwarenessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recentEvents(limit = 32): ReadonlyArray<{ event: AwarenessChange; atISO: string }> {
    return this.recent.slice(0, Math.max(1, Math.min(this.maxRecent, limit)));
  }
}
