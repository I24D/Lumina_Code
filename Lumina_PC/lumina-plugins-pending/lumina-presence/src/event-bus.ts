/**
 * Typed event bus for the Lumina Presence layer.
 *
 * Wraps Node's built-in EventEmitter with strict typing so handlers receive
 * the exact payload for the event kind they subscribed to (no `as` casting,
 * no runtime checks).
 *
 * Why a dedicated bus instead of reusing the OpenClaw plugin SDK event hub:
 *   - We want presence events to be a CLOSED set (PresenceEvent union),
 *     not a string-keyed map. The type system enforces this on both
 *     publishers and subscribers.
 *   - Decoupling lets us mock the bus in tests without spinning the runtime.
 *   - Future phases can swap the in-process bus for a cross-process one
 *     (e.g. when an avatar process needs to subscribe) by reimplementing
 *     this interface.
 */
import { EventEmitter } from "node:events";
import type { PresenceEvent, PresenceEventOf } from "./types.js";

export type PresenceEventKind = PresenceEvent["kind"];

export type PresenceEventListener<K extends PresenceEventKind> = (
  event: PresenceEventOf<K>,
) => void;

export interface PresenceEventBus {
  emit(event: PresenceEvent): void;
  on<K extends PresenceEventKind>(kind: K, listener: PresenceEventListener<K>): () => void;
  once<K extends PresenceEventKind>(kind: K, listener: PresenceEventListener<K>): () => void;
  listenerCount(kind: PresenceEventKind): number;
  removeAll(): void;
}

export function createPresenceEventBus(): PresenceEventBus {
  // `setMaxListeners(0)` removes the default 10-listener warning. Phase 1 has
  // ~4-6 subscribers; future phases may add an avatar bridge, narrator, etc.
  const inner = new EventEmitter();
  inner.setMaxListeners(0);

  function emit(event: PresenceEvent): void {
    inner.emit(event.kind, event);
  }

  function on<K extends PresenceEventKind>(
    kind: K,
    listener: PresenceEventListener<K>,
  ): () => void {
    inner.on(kind, listener as (e: PresenceEvent) => void);
    return () => {
      inner.off(kind, listener as (e: PresenceEvent) => void);
    };
  }

  function once<K extends PresenceEventKind>(
    kind: K,
    listener: PresenceEventListener<K>,
  ): () => void {
    inner.once(kind, listener as (e: PresenceEvent) => void);
    return () => {
      inner.off(kind, listener as (e: PresenceEvent) => void);
    };
  }

  function listenerCount(kind: PresenceEventKind): number {
    return inner.listenerCount(kind);
  }

  function removeAll(): void {
    inner.removeAllListeners();
  }

  return { emit, on, once, listenerCount, removeAll };
}
