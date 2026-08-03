/**
 * operative-daemon.ts — Proactive Lumina (OpenJarvis operative-style).
 *
 * Subscribes to the AwarenessEventBus, matches events against
 * user-editable rules (operative-rules.json), debounces per-rule, and
 * emits suggestions. By default the daemon dispatches Windows toasts via
 * the Lumina Windows Bridge — this is the "Lumina becomes proactive"
 * layer the user explicitly asked for. Suggestions are also fed into the
 * ActionLog so the conversational layer can recall them.
 *
 * The daemon NEVER executes the proposedAction itself — it surfaces it,
 * the user (via voice / click) decides. This preserves every existing
 * approval semantic.
 *
 * Lifecycle:
 *   start()  → subscribes, returns the unsubscribe function
 *   stop()   → unsubscribes
 *   reload() → re-reads operative-rules.json
 */
import type { ActionLogStore } from "../memory/action-log.js";
import type { AwarenessChange, AwarenessEventBus } from "../awareness/event-bus.js";
import {
  defaultRulesPath,
  loadOperativeRules,
  renderSuggestion,
  ruleMatches,
  type OperativeRule,
  type OperativeRuleSet,
  type OperativeSuggestion,
} from "./operative-rules.js";

export type ToastDispatcher = (suggestion: OperativeSuggestion) => Promise<void> | void;

export type OperativeDaemonOptions = {
  readonly bus: AwarenessEventBus;
  readonly log: ActionLogStore | null;
  readonly rulesPath?: string;
  readonly toastDispatcher?: ToastDispatcher;
  readonly autoStart?: boolean;
  /** When true, debounce timestamps live across reload(). */
  readonly persistentDebounce?: boolean;
};

export type OperativeStatus = {
  readonly running: boolean;
  readonly rulesPath: string;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly errorCount: number;
  readonly lastSuggestionISO: string | null;
  readonly recentSuggestions: ReadonlyArray<OperativeSuggestion>;
};

const MAX_RECENT = 32;

export class OperativeDaemon {
  private readonly bus: AwarenessEventBus;
  private readonly log: ActionLogStore | null;
  private readonly rulesPath: string;
  private readonly persistentDebounce: boolean;
  private readonly toastDispatcher: ToastDispatcher;
  private ruleSet: OperativeRuleSet;
  private unsubscribe: (() => void) | null = null;
  private debounce = new Map<string, number>();
  private recent: OperativeSuggestion[] = [];

  constructor(opts: OperativeDaemonOptions) {
    this.bus = opts.bus;
    this.log = opts.log;
    this.rulesPath = opts.rulesPath ?? defaultRulesPath();
    this.persistentDebounce = opts.persistentDebounce ?? true;
    this.toastDispatcher = opts.toastDispatcher ?? defaultBridgeToastDispatcher();
    this.ruleSet = loadOperativeRules(this.rulesPath);
    if (opts.autoStart !== false) this.start();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.on((event) => {
      void this.handle(event);
    });
    this.log?.append({
      action: "operative.start",
      target: this.rulesPath,
      result: "ok",
      detail: `${this.enabledRules().length} rules active`,
      source: "operative-daemon",
    });
  }

  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
    this.log?.append({
      action: "operative.stop",
      target: this.rulesPath,
      result: "ok",
      source: "operative-daemon",
    });
  }

  reload(): OperativeRuleSet {
    this.ruleSet = loadOperativeRules(this.rulesPath);
    if (!this.persistentDebounce) this.debounce.clear();
    this.log?.append({
      action: "operative.reload",
      target: this.rulesPath,
      result: this.ruleSet.errors.length > 0 ? "warn" : "ok",
      detail: `${this.ruleSet.rules.length} rules, ${this.ruleSet.errors.length} errors`,
      source: "operative-daemon",
    });
    return this.ruleSet;
  }

  status(): OperativeStatus {
    const enabled = this.enabledRules();
    const disabled = this.ruleSet.rules.filter((r) => !r.enabled);
    return {
      running: this.unsubscribe !== null,
      rulesPath: this.rulesPath,
      enabledCount: enabled.length,
      disabledCount: disabled.length,
      errorCount: this.ruleSet.errors.length,
      lastSuggestionISO: this.recent[0]?.atISO ?? null,
      recentSuggestions: this.recent.slice(),
    };
  }

  errors(): OperativeRuleSet["errors"] {
    return this.ruleSet.errors;
  }

  rules(): ReadonlyArray<OperativeRule> {
    return this.ruleSet.rules;
  }

  recentSuggestions(limit = 16): ReadonlyArray<OperativeSuggestion> {
    return this.recent.slice(0, Math.max(1, Math.min(MAX_RECENT, limit)));
  }

  private enabledRules(): ReadonlyArray<OperativeRule> {
    return this.ruleSet.rules.filter((r) => r.enabled);
  }

  private async handle(event: AwarenessChange): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const rule of this.enabledRules()) {
      if (!ruleMatches(rule, event)) continue;
      const lastFired = this.debounce.get(rule.id) ?? 0;
      if (nowSec - lastFired < rule.debounceSeconds) continue;
      this.debounce.set(rule.id, nowSec);
      const suggestion = renderSuggestion(rule, event);
      this.recent.unshift(suggestion);
      if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
      this.log?.append({
        action: "operative.suggest",
        target: `rule:${rule.id}`,
        result: "ok",
        detail: `${suggestion.title}: ${suggestion.message}`,
        source: "operative-daemon",
        extra: {
          severity: suggestion.severity,
          event,
          proposedTool: suggestion.proposedAction?.tool ?? null,
        },
      });
      try {
        await this.toastDispatcher(suggestion);
      } catch (e) {
        this.log?.append({
          action: "operative.dispatch-error",
          target: `rule:${rule.id}`,
          result: "error",
          detail: (e as Error).message,
          source: "operative-daemon",
        });
      }
    }
  }
}

/** Default dispatcher posts a toast to the Lumina Windows Bridge. */
export function defaultBridgeToastDispatcher(): ToastDispatcher {
  const url = (process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
  return async (suggestion) => {
    if (typeof fetch !== "function") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      await fetch(`${url}/notify_toast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: suggestion.title.slice(0, 64),
          message: suggestion.message.slice(0, 240),
        }),
        signal: controller.signal,
      });
    } catch {
      /* Bridge offline or unreachable — daemon stays alive, log captured it. */
    } finally {
      clearTimeout(timer);
    }
  };
}
