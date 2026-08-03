/**
 * operative-rules.ts — Rule loader + matcher for the Operative Daemon.
 *
 * Rules live as JSON in c:/I24D_WhatsApp/operative-rules.json (override
 * via LUMINA_OPERATIVE_RULES). Each rule fires when a specific
 * AwarenessChange event reaches the bus AND its predicate matches, then
 * emits a structured "suggestion" the daemon turns into a Windows toast
 * (and optionally a spoken line via lumina_tts_speak).
 *
 * Rule shape:
 *
 *   {
 *     id: "battery-low",                  // unique; also used for debounce
 *     enabled: true,                       // optional, default true
 *     trigger: { kind: "battery.low" },    // event kind from AwarenessChange
 *     condition: {                         // optional extra guards
 *       maxPercent: 20,
 *       requireUnplugged: true             // skill-style flags handled below
 *     },
 *     debounceSeconds: 600,                // optional, default 300
 *     suggestion: {
 *       title: "Batería baja",
 *       message: "Estás al {percent}%. ¿Te paso a modo ahorro?",
 *       speak: true,                       // call lumina_tts_speak too
 *       severity: "warn"                   // ok | warn | critical
 *     },
 *     proposedAction: {                    // optional; YOU as the agent
 *       tool: "lumina_window_control",     // can offer this as a one-tap
 *       params: { action: "launch", application: "settings" }
 *     }
 *   }
 *
 * Templating: {percent}, {drive}, {freePct}, {pct}, {className}, {name}
 * are replaced with the matching event field.
 */
import fs from "node:fs";
import path from "node:path";
import type { AwarenessChange } from "../awareness/event-bus.js";

export type OperativeSeverity = "ok" | "warn" | "critical";

export type OperativeProposedAction = {
  readonly tool: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type OperativeRule = {
  readonly id: string;
  readonly enabled: boolean;
  readonly trigger: { readonly kind: AwarenessChange["kind"] };
  readonly condition: Readonly<Record<string, unknown>>;
  readonly debounceSeconds: number;
  readonly suggestion: {
    readonly title: string;
    readonly message: string;
    readonly speak: boolean;
    readonly severity: OperativeSeverity;
  };
  readonly proposedAction?: OperativeProposedAction;
  readonly sourcePath: string;
};

export type RuleLoadError = {
  readonly id: string;
  readonly error: string;
};

const SEVERITIES: ReadonlyArray<OperativeSeverity> = ["ok", "warn", "critical"];

function safeId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export type OperativeSuggestion = {
  readonly rule: OperativeRule;
  readonly title: string;
  readonly message: string;
  readonly speak: boolean;
  readonly severity: OperativeSeverity;
  readonly event: AwarenessChange;
  readonly proposedAction?: OperativeProposedAction;
  readonly atISO: string;
};

const KNOWN_EVENT_KINDS = new Set<AwarenessChange["kind"]>([
  "battery.low", "battery.critical", "battery.charging.changed",
  "network.offline", "network.online",
  "monitor.added", "monitor.removed",
  "disk.low",
  "cpu.high", "ram.high",
  "gpu.changed",
  "device.added", "device.removed",
]);

function parseRule(raw: unknown): OperativeRule | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "rule must be an object" };
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return { error: "rule.id is required (kebab-case)" };
  const trigger = r.trigger as { kind?: string } | undefined;
  if (!trigger || typeof trigger.kind !== "string") {
    return { error: `rule '${id}': trigger.kind is required` };
  }
  if (!KNOWN_EVENT_KINDS.has(trigger.kind as AwarenessChange["kind"])) {
    return { error: `rule '${id}': unknown trigger.kind '${trigger.kind}'` };
  }
  const suggestion = (r.suggestion as Record<string, unknown> | undefined) ?? {};
  const title = typeof suggestion.title === "string" ? suggestion.title.trim() : "";
  const message = typeof suggestion.message === "string" ? suggestion.message.trim() : "";
  if (!title) return { error: `rule '${id}': suggestion.title is required` };
  if (!message) return { error: `rule '${id}': suggestion.message is required` };
  const severityRaw = typeof suggestion.severity === "string" ? suggestion.severity : "warn";
  const severity: OperativeSeverity = SEVERITIES.includes(severityRaw as OperativeSeverity)
    ? (severityRaw as OperativeSeverity)
    : "warn";
  const speak = suggestion.speak === true;
  const debounceSeconds = Math.max(5, Math.min(86400, Number(r.debounceSeconds) || 300));
  const enabled = r.enabled !== false;
  const condition =
    r.condition && typeof r.condition === "object" && !Array.isArray(r.condition)
      ? (r.condition as Record<string, unknown>)
      : {};
  let proposedAction: OperativeProposedAction | undefined;
  if (r.proposedAction && typeof r.proposedAction === "object") {
    const pa = r.proposedAction as Record<string, unknown>;
    if (typeof pa.tool === "string" && pa.tool.trim()) {
      proposedAction = {
        tool: pa.tool.trim(),
        params:
          pa.params && typeof pa.params === "object" && !Array.isArray(pa.params)
            ? (pa.params as Record<string, unknown>)
            : {},
      };
    }
  }
  return {
    id,
    enabled,
    trigger: { kind: trigger.kind as AwarenessChange["kind"] },
    condition,
    debounceSeconds,
    suggestion: { title, message, speak, severity },
    proposedAction,
    sourcePath: "",
  };
}

export type OperativeRuleSet = {
  readonly rules: ReadonlyArray<OperativeRule>;
  readonly errors: ReadonlyArray<RuleLoadError>;
  readonly sourcePath: string;
};

export function loadOperativeRules(filePath: string): OperativeRuleSet {
  if (!fs.existsSync(filePath)) {
    return { rules: [], errors: [], sourcePath: filePath };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return {
      rules: [],
      errors: [{ id: "(file)", error: `cannot read rules file: ${(e as Error).message}` }],
      sourcePath: filePath,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      rules: [],
      errors: [{ id: "(file)", error: `invalid JSON: ${(e as Error).message}` }],
      sourcePath: filePath,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      rules: [],
      errors: [{ id: "(file)", error: "rules file must be a JSON array of rules" }],
      sourcePath: filePath,
    };
  }
  const rules: OperativeRule[] = [];
  const errors: RuleLoadError[] = [];
  for (const item of parsed) {
    const result = parseRule(item);
    if ("error" in result) {
      const candidateId =
        item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? ((item as { id: string }).id as string)
          : "(unknown)";
      errors.push({ id: candidateId, error: result.error });
      continue;
    }
    rules.push({ ...result, sourcePath: filePath });
  }
  return { rules, errors, sourcePath: filePath };
}

/** Evaluate the optional `condition:` block against the live event. */
export function ruleMatches(rule: OperativeRule, event: AwarenessChange): boolean {
  if (!rule.enabled) return false;
  if (rule.trigger.kind !== event.kind) return false;
  const c = rule.condition;

  // Numeric thresholds across common event shapes.
  if (event.kind === "battery.low" || event.kind === "battery.critical") {
    if (typeof c.maxPercent === "number" && event.percent > c.maxPercent) return false;
  }
  if (event.kind === "disk.low") {
    if (typeof c.maxFreePct === "number" && event.freePct > c.maxFreePct) return false;
    if (typeof c.drive === "string" && c.drive.toUpperCase() !== event.drive.toUpperCase()) return false;
  }
  if (event.kind === "cpu.high" || event.kind === "ram.high") {
    if (typeof c.minPct === "number" && event.pct < c.minPct) return false;
  }
  if (event.kind === "device.added" || event.kind === "device.removed") {
    if (typeof c.className === "string" && c.className.toLowerCase() !== event.className.toLowerCase()) return false;
    if (typeof c.nameContains === "string" && !event.name.toLowerCase().includes(c.nameContains.toLowerCase())) {
      return false;
    }
  }
  if (event.kind === "battery.charging.changed") {
    if (typeof c.expectCharging === "boolean" && c.expectCharging !== event.charging) return false;
  }
  return true;
}

export function renderSuggestion(rule: OperativeRule, event: AwarenessChange): OperativeSuggestion {
  const map: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k !== "kind") map[k] = v as string | number | boolean;
  }
  const apply = (template: string): string => template.replace(/\{([a-zA-Z_]+)\}/g, (_m, key) => {
    return map[key] !== undefined ? String(map[key]) : `{${key}}`;
  });
  return {
    rule,
    title: apply(rule.suggestion.title),
    message: apply(rule.suggestion.message),
    speak: rule.suggestion.speak,
    severity: rule.suggestion.severity,
    event,
    proposedAction: rule.proposedAction,
    atISO: new Date().toISOString(),
  };
}

export function defaultRulesPath(): string {
  const env = (process.env.LUMINA_OPERATIVE_RULES ?? "").trim();
  if (env) return path.resolve(env);
  return path.resolve("c:/I24D_WhatsApp/operative-rules.json");
}
