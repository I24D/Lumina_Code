/**
 * window-classify.ts — §3 window classifier + strategy router.
 *
 * The spec's order-of-decision says: classify each window FIRST
 * (Win32 / WPF / UWP / Chromium-Electron / elevated), and let that class pick
 * the interaction strategy — native APIs when they exist, OmniParser vision
 * only when they don't. This module is that classifier.
 *
 * It is intentionally pure + signal-driven so it can be unit-tested and reused:
 *   - `classifyWindow(signals)` → { kind, elevated, isBrowser, ... }
 *   - `strategyOrder(classification)` → ordered engine preference (§3)
 *   - `classifyForegroundWindow(bridgeUrl)` → async convenience over /perception
 *
 * The loop engine's observe() consumes `classifyWindow` to decide whether to
 * pull the DOM via CDP (chromium) vs. trust UIA (native) vs. fall to vision.
 */

export type WindowKind = "chromium" | "uwp" | "wpf" | "win32" | "unknown";

/** §3 interaction strategies, in canonical priority order. */
export type Strategy =
  | "app_adapter"
  | "uia"
  | "cdp"
  | "win32_api"
  | "com"
  | "shell"
  | "iaccessible2"
  | "powershell"
  | "omniparser"
  | "mouse"
  | "ocr";

export type WindowSignals = {
  readonly processName?: string;
  readonly className?: string;
  readonly title?: string;
  /** Whether the target runs at a higher integrity level than us (UIPI). */
  readonly elevated?: boolean;
};

export type WindowClassification = {
  readonly kind: WindowKind;
  readonly elevated: boolean;
  /** Chromium-family browser (Chrome/Edge/Brave…) — DOM reachable via CDP. */
  readonly isBrowser: boolean;
  /** Electron app (VS Code/Slack/Discord…) — also Chromium under the hood. */
  readonly isElectron: boolean;
  /**
   * True when native access is blocked by a higher integrity level: UIA does
   * not cross integrity boundaries without a uiAccess build (§9). Callers
   * should either elevate (dev-all:admin) or fall to vision + physical input.
   */
  readonly nativeBlockedByIntegrity: boolean;
  readonly confidence: number;
  readonly signals: WindowSignals;
};

// Chromium-family browsers — DOM truth lives behind CDP, not UIA.
const BROWSER_PROCESSES = new Set([
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
]);

// Electron apps: Chromium renderer, so UIA only sees the window chrome. Treat
// them like chromium (prefer CDP / DOM) rather than native UIA.
const ELECTRON_PROCESSES = new Set([
  "code.exe",
  "slack.exe",
  "discord.exe",
  "teams.exe",
  "ms-teams.exe",
  "notion.exe",
  "spotify.exe",
  "whatsapp.exe",
  "signal.exe",
  "obsidian.exe",
  "figma.exe",
  "postman.exe",
]);

// Shells / hosts that identify UWP-hosted content.
const UWP_HOST_PROCESSES = new Set([
  "applicationframehost.exe",
  "systemsettings.exe",
  "shellexperiencehost.exe",
  "searchhost.exe",
  "startmenuexperiencehost.exe",
  "textinputhost.exe",
]);

function norm(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Classify a window from whatever signals are available. className is the
 * strongest signal when present; processName is the reliable fallback.
 */
export function classifyWindow(signals: WindowSignals): WindowClassification {
  const proc = norm(signals.processName);
  const cls = norm(signals.className);
  const elevated = signals.elevated === true;

  let kind: WindowKind = "unknown";
  let isBrowser = false;
  let isElectron = false;
  let confidence = 0.3;

  // 1) className is authoritative when we have it.
  if (cls) {
    if (cls.includes("chrome_widgetwin")) {
      kind = "chromium";
      confidence = 0.9;
    } else if (cls.includes("applicationframewindow") || cls.includes("windows.ui.core.corewindow")) {
      kind = "uwp";
      confidence = 0.9;
    } else if (cls.startsWith("hwndwrapper[") || cls.includes("hwndwrapper")) {
      kind = "wpf";
      confidence = 0.85;
    }
  }

  // 2) processName refines / fills in.
  if (proc) {
    if (BROWSER_PROCESSES.has(proc)) {
      isBrowser = true;
      if (kind === "unknown" || kind === "chromium") kind = "chromium";
      confidence = Math.max(confidence, 0.85);
    } else if (ELECTRON_PROCESSES.has(proc)) {
      isElectron = true;
      if (kind === "unknown" || kind === "chromium") kind = "chromium";
      confidence = Math.max(confidence, 0.8);
    } else if (UWP_HOST_PROCESSES.has(proc)) {
      if (kind === "unknown") kind = "uwp";
      confidence = Math.max(confidence, 0.75);
    }
  }

  // 3) Default: a plain native window. Prefer win32 unless className said WPF.
  if (kind === "unknown") {
    kind = proc || cls ? "win32" : "unknown";
    if (kind === "win32") confidence = Math.max(confidence, 0.5);
  }

  return {
    kind,
    elevated,
    isBrowser,
    isElectron,
    nativeBlockedByIntegrity: elevated,
    confidence,
    signals,
  };
}

const BASE_ORDER: readonly Strategy[] = [
  "app_adapter",
  "uia",
  "cdp",
  "win32_api",
  "com",
  "shell",
  "iaccessible2",
  "powershell",
  "omniparser",
  "mouse",
  "ocr",
];

function moveBefore(order: Strategy[], move: Strategy, before: Strategy): Strategy[] {
  const without = order.filter((s) => s !== move);
  const idx = without.indexOf(before);
  if (idx < 0) return [move, ...without];
  return [...without.slice(0, idx), move, ...without.slice(idx)];
}

/**
 * The engine preference order for a classified window (§3). Always starts from
 * app-adapter/UIA-first, then tunes by kind:
 *   - chromium/electron → CDP is promoted above UIA (the DOM is the truth).
 *   - elevated → native engines are unreliable (UIPI); vision + physical input
 *     are promoted so the agent can still act.
 */
export function strategyOrder(classification: WindowClassification): Strategy[] {
  let order: Strategy[] = [...BASE_ORDER];

  if (classification.kind === "chromium" || classification.isElectron) {
    order = moveBefore(order, "cdp", "uia");
  }

  if (classification.nativeBlockedByIntegrity) {
    // Native APIs can't cross the integrity boundary — bias to what still works.
    order = moveBefore(order, "omniparser", "app_adapter");
    order = moveBefore(order, "mouse", "app_adapter");
  }

  return order;
}

/**
 * Convenience: classify the current foreground window using the Bridge's cheap
 * /perception snapshot (foreground process). className/elevation aren't in that
 * snapshot, so this is process-name-level classification — pass explicit
 * signals to `classifyWindow` when you have the window class.
 */
export async function classifyForegroundWindow(
  bridgeUrl: string,
): Promise<WindowClassification & { foreground: { process?: string; title?: string } | null }> {
  const base = bridgeUrl.replace(/\/+$/u, "");
  try {
    const res = await fetch(`${base}/perception`, { method: "GET" });
    const data = (await res.json()) as {
      foreground?: { process?: string; title?: string } | null;
    };
    const fg = data.foreground ?? null;
    const classification = classifyWindow({
      processName: fg?.process,
      title: fg?.title,
    });
    return { ...classification, foreground: fg };
  } catch {
    return { ...classifyWindow({}), foreground: null };
  }
}
