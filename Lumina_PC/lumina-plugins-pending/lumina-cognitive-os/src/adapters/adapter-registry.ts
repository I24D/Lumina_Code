/**
 * adapter-registry.ts — App Adapter Registry (§4 / §5).
 *
 * Before Lumina falls back to generic UIA or vision, she checks whether the
 * target app has a *specialized* adapter — a structural API that's faster and
 * more reliable than poking the UI (Office COM, Shell, browser CDP…). This
 * registry is the lookup: process name → best adapter + the tools that drive it.
 *
 * It composes with window-classify.ts: the classifier says what KIND of window
 * it is (Win32/UWP/Chromium…); this says which specific APP adapter to prefer.
 * New adapters are added by appending to ADAPTERS — nothing else changes.
 */

export type AdapterId =
  | "office"
  | "shell"
  | "vscode"
  | "terminal"
  | "browser"
  | "uia"
  | "omniparser";

export type AppAdapter = {
  readonly id: AdapterId;
  readonly label: string;
  /** Lowercased process exe names this adapter claims. */
  readonly matchProcesses: readonly string[];
  /** Agent tools that drive this adapter, if any. */
  readonly tools: readonly string[];
  readonly note: string;
};

const ADAPTERS: readonly AppAdapter[] = [
  {
    id: "office",
    label: "Microsoft Office (COM Automation)",
    matchProcesses: ["winword.exe", "excel.exe", "outlook.exe", "powerpnt.exe"],
    tools: ["lumina_office"],
    note: "Drive Word/Excel/Outlook/PowerPoint via COM — reads/writes documents regardless of focus.",
  },
  {
    id: "shell",
    label: "Windows Explorer / Shell",
    matchProcesses: ["explorer.exe"],
    tools: [],
    note: "Prefer Shell APIs (IShellDispatch) / file-system tools over clicking Explorer.",
  },
  {
    id: "vscode",
    label: "VS Code",
    matchProcesses: ["code.exe"],
    tools: [],
    note: "Prefer the `code` CLI / extension API; UIA only sees window chrome (Electron).",
  },
  {
    id: "terminal",
    label: "Terminal / PowerShell",
    matchProcesses: ["windowsterminal.exe", "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe"],
    tools: [],
    note: "Drive via direct command invocation rather than typing into the window.",
  },
  {
    id: "browser",
    label: "Chromium browser / Electron (CDP)",
    matchProcesses: [
      "chrome.exe",
      "msedge.exe",
      "brave.exe",
      "opera.exe",
      "vivaldi.exe",
      "arc.exe",
      "slack.exe",
      "discord.exe",
      "teams.exe",
      "ms-teams.exe",
      "notion.exe",
      "spotify.exe",
      "whatsapp.exe",
    ],
    tools: ["lumina_browser_smart_click", "lumina_browser_smart_type", "lumina_browser_dom_observe"],
    note: "The DOM is the truth — use CDP/Playwright, not UIA (Chromium hides the DOM from UIA).",
  },
];

const UIA_FALLBACK: AppAdapter = {
  id: "uia",
  label: "Generic UI Automation",
  matchProcesses: [],
  tools: ["lumina_sight", "lumina_ui_inspect", "lumina_ui_invoke", "lumina_smart_click"],
  note: "No specialized adapter — use the live UIA tree (name/automationId) then vision as fallback.",
};

/**
 * Best adapter for a process. Falls back to generic UIA when no specialized
 * adapter claims the process (never null — there is always a path).
 */
export function resolveAdapter(processName?: string): AppAdapter {
  const proc = (processName ?? "").trim().toLowerCase();
  if (!proc) return UIA_FALLBACK;
  for (const adapter of ADAPTERS) {
    if (adapter.matchProcesses.includes(proc)) return adapter;
  }
  return UIA_FALLBACK;
}

export function listAdapters(): AppAdapter[] {
  return [...ADAPTERS, UIA_FALLBACK];
}
