/**
 * brain-gemini.ts — Vision LLM client for the PC Operator loop.
 *
 * Wraps a single Gemini multimodal call: given the goal, history of prior
 * steps, current observation (foreground app + top interactables) and a
 * screenshot, returns the SINGLE next action to take.
 *
 * Uses the raw REST API (no `google-generativeai` install needed). Image
 * is read from disk, base64-encoded, sent as inline_data. Response is
 * forced to `application/json` so we can JSON.parse it.
 *
 * Pluggable via `BrainClient` interface — tests inject a fake brain that
 * returns canned actions, so we never burn real Gemini quota in CI.
 */
import fs from "node:fs";

export type LoopActionCommon = { reasoning: string };

export type LoopAction =
  | (LoopActionCommon & { kind: "open_application"; application: string })
  | (LoopActionCommon & { kind: "close_application"; pid?: number; title?: string; processName?: string; force?: boolean })
  | (LoopActionCommon & { kind: "open_url"; url: string; browser?: "default" | "edge" })
  | (LoopActionCommon & { kind: "smart_click"; query: string; processName?: string; clicks?: number; allowVision?: boolean; controlType?: string })
  | (LoopActionCommon & { kind: "smart_type"; query: string; text: string; pressEnter?: boolean })
  | (LoopActionCommon & { kind: "pc_scroll"; direction: "up" | "down" | "left" | "right"; amount?: number; query?: string })
  | (LoopActionCommon & { kind: "pc_drag"; fromQuery?: string; fromX?: number; fromY?: number; toQuery?: string; toX?: number; toY?: number; button?: "left" | "right" | "middle" })
  | (LoopActionCommon & { kind: "browser_smart_click"; query: string; role?: string; exact?: boolean })
  | (LoopActionCommon & { kind: "browser_smart_type"; query: string; text: string; pressEnter?: boolean })
  | (LoopActionCommon & { kind: "key_press"; keys: string[] })
  | (LoopActionCommon & { kind: "shortcut"; keys: string[] })
  | (LoopActionCommon & { kind: "window_focus"; title: string })
  | (LoopActionCommon & { kind: "wait"; ms: number })
  | { kind: "done"; summary: string; reasoning?: string }
  | { kind: "stuck"; ask: string; reasoning?: string };

export type ObservationDigest = {
  readonly foregroundProcess?: string | null;
  readonly foregroundTitle?: string | null;
  readonly isBrowser?: boolean;
  readonly interactables?: ReadonlyArray<{
    name?: string;
    controlType?: string;
    role?: string;
    bbox?: { x: number; y: number; w: number; h: number } | null;
    href?: string | null;
  }>;
  readonly windowTitles?: ReadonlyArray<string>;
};

export type StepHistoryEntry = {
  readonly iteration: number;
  readonly action: LoopAction;
  readonly outcome: "ok" | "verify_failed" | "tool_error" | "skipped" | "aborted";
  readonly errorMessage?: string;
};

export type BrainProviderName = "auto" | "gemini" | "openai" | "anthropic" | "ollama";

export type ThinkParams = {
  readonly goal: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly observation: ObservationDigest;
  readonly screenshotPath: string | null;
  readonly history: ReadonlyArray<StepHistoryEntry>;
  readonly brainProvider?: BrainProviderName;
  readonly brainModel?: string;
};

export type ThinkResult = {
  readonly action: LoopAction;
  readonly rawText?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly brainProvider?: Exclude<BrainProviderName, "auto">;
  readonly brainModel?: string;
  readonly cached?: boolean; // True if result was served from LRU cache
};

export interface BrainClient {
  think(params: ThinkParams): Promise<ThinkResult>;
}

export type GeminiBrainOptions = {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly temperature?: number;
};

export const SYSTEM_PROMPT = `You are Lumina's PC Operator brain.

Your job: given a GOAL and the CURRENT screen state, decide the SINGLE next action.
You will be called repeatedly in a loop until you emit {"kind":"done"} or {"kind":"stuck"}.

Output STRICTLY one JSON object — no markdown fences, no commentary, no prefix.

Available actions:
- {"kind":"open_application","application":"<alias OR Start menu name>","reasoning":"..."}
- {"kind":"close_application","title":"<window title substring>","processName":"<exe name>","force":false,"reasoning":"..."}
- {"kind":"open_url","url":"https://www.youtube.com","browser":"default","reasoning":"..."}
- {"kind":"smart_click","query":"<NL label>","processName":"<exe>","reasoning":"..."}
- {"kind":"smart_type","query":"<field name>","text":"<...>","pressEnter":false,"reasoning":"..."}
- {"kind":"pc_scroll","direction":"down","amount":3,"query":"<panel?>","reasoning":"..."}
- {"kind":"pc_drag","fromQuery":"<...>","toQuery":"<...>","reasoning":"..."}
- {"kind":"browser_smart_click","query":"<...>","role":"button|link|searchbox|textbox","reasoning":"..."}
- {"kind":"browser_smart_type","query":"<...>","text":"<...>","pressEnter":true,"reasoning":"..."}
- {"kind":"key_press","keys":["ENTER"],"reasoning":"..."}
- {"kind":"shortcut","keys":["CTRL","S"],"reasoning":"..."}
- {"kind":"window_focus","title":"Chrome","reasoning":"..."}
- {"kind":"wait","ms":1500,"reasoning":"<why we wait>"}
- {"kind":"done","summary":"<what was accomplished>"}
- {"kind":"stuck","ask":"<question for Dal>"}

Rules:
1. Pick the simplest action that makes visible progress toward GOAL.
2. If the goal requires an app or website that is not already visible, start with open_application or open_url.
3. open_application: pasa un alias curado (browser, edge, chrome, firefox, brave, vivaldi, opera, arc, youtube, google, gmail, drive, github, word, excel, powerpoint, outlook, onenote, access, publisher, visio, project, teams, onedrive, slack, discord, telegram, whatsapp, signal, zoom, notion, obsidian, spotify, vlc, obs, vscode, cursor, sublime, notepadpp, postman, docker, gimp, blender, inkscape, figma, steam, epic, notepad, calculator, explorer, settings, store, photos, camera, mail, calendar, paint, taskmanager, controlpanel, regedit, terminal, powershell, pwsh, cmd, wsl) — O el nombre tal como aparece en el Start menu de Windows ("Adobe Acrobat", "Krita"). El Bridge primero busca alias, después fuzzy-match en Get-StartApps.
4. close_application: cierra una app por title (substring del título), processName (e.g. "notepad" sin .exe) o pid. Por default es graceful (WM_CLOSE); pasa force: true SOLO si Dal explícitamente dijo "mata" o "fuerza".
5. If foregroundProcess is chrome.exe / msedge.exe / firefox.exe / brave.exe -> prefer browser_* tools (DOM/ARIA is more reliable than UIA on web).
5b. On YouTube search/results pages, the search field may be exposed as textbox/searchbox or a raw input#search; using browser_smart_type with query "Search" is valid.
5c. On YouTube results pages, video results are usually links/thumbnails, not buttons. Prefer browser_smart_click with role:"link" and query like "first video result" when the goal is to play the first result.
6. Otherwise prefer smart_* tools (UIA-grounded).
7. If the SAME action failed twice in HISTORY, try a different approach (different query, different tool, scroll first).
8. Emit "done" only when the goal is VISIBLY achieved on screen. Do not assume.
9. Emit "stuck" if you genuinely cannot progress (missing app, unknown UI, ambiguous goal).
10. Use processName whenever the foreground app is known. It prevents clicking in the wrong window.`;

export function buildUserPrompt(p: ThinkParams): string {
  const obs = p.observation;
  const fg = obs.foregroundProcess ? `${obs.foregroundProcess}${obs.foregroundTitle ? ` — "${obs.foregroundTitle}"` : ""}` : "unknown";
  const interactables = (obs.interactables ?? [])
    .slice(0, 20)
    .map((i) => {
      const label = i.name?.trim() || "(no name)";
      const ct = i.controlType ?? i.role ?? "?";
      const bbox = i.bbox ? `[${i.bbox.x},${i.bbox.y}+${i.bbox.w}×${i.bbox.h}]` : "[no bbox]";
      const href = i.href ? ` href=${i.href}` : "";
      return `  - ${ct}: "${label}" ${bbox}${href}`;
    })
    .join("\n");
  const windows = (obs.windowTitles ?? []).slice(0, 8).map((t) => `  - ${t}`).join("\n");
  const history = p.history.length === 0
    ? "  (none — this is the first iteration)"
    : p.history
        .slice(-6)
        .map((h) => {
          const a = h.action;
          const desc = a.kind === "done" || a.kind === "stuck"
            ? a.kind
            : `${a.kind}(${("query" in a && a.query) || ("text" in a && a.text) || ""})`;
          const err = h.errorMessage ? ` err=${h.errorMessage}` : "";
          return `  ${h.iteration}. ${desc} → ${h.outcome}${err}`;
        })
        .join("\n");

  return [
    `GOAL: ${p.goal}`,
    `ITERATION: ${p.iteration}/${p.maxIterations}`,
    `FOREGROUND: ${fg}${obs.isBrowser ? " (browser — use browser_* tools)" : ""}`,
    `INTERACTABLES (top by area):`,
    interactables || "  (none reported)",
    `VISIBLE WINDOWS:`,
    windows || "  (none reported)",
    `HISTORY (last 6):`,
    history,
    `Return STRICTLY one JSON object as defined in the system prompt.`,
  ].join("\n");
}

export function extractJson(raw: string): unknown {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  }
  // If the model added prose, grab the first top-level {...} block.
  if (!text.startsWith("{")) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
  }
  return JSON.parse(text);
}

export function coerceAction(parsed: unknown): LoopAction {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("brain returned non-object");
  }
  const obj = parsed as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string") throw new Error("brain returned no kind");
  if (!("reasoning" in obj) && kind !== "done" && kind !== "stuck") {
    obj.reasoning = "";
  }
  return obj as unknown as LoopAction;
}

export function createGeminiBrain(opts: GeminiBrainOptions): BrainClient {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("fetch is unavailable; pass fetchImpl explicitly");
  const endpoint =
    opts.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const temperature = opts.temperature ?? 0.2;

  return {
    async think(params: ThinkParams): Promise<ThinkResult> {
      const userPrompt = buildUserPrompt(params);
      const parts: Array<Record<string, unknown>> = [{ text: userPrompt }];
      if (params.screenshotPath) {
        try {
          const buf = await fs.promises.readFile(params.screenshotPath);
          parts.push({
            inline_data: {
              mime_type: "image/png",
              data: buf.toString("base64"),
            },
          });
        } catch {
          // If screenshot read fails, still send text-only — Gemini will work
          // off the textual observation alone.
        }
      }
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
        },
      };
      const url = `${endpoint}?key=${encodeURIComponent(opts.apiKey)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let raw: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      try {
        const resp = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          throw new Error(`gemini http ${resp.status}: ${errText.slice(0, 300)}`);
        }
        raw = await resp.json() as typeof raw;
      } finally {
        clearTimeout(timer);
      }
      const text = raw.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text ?? "";
      if (!text) throw new Error("gemini returned no text");
      const parsed = extractJson(text);
      const action = coerceAction(parsed);
      return {
        action,
        rawText: text,
        tokensIn: raw.usageMetadata?.promptTokenCount,
        tokensOut: raw.usageMetadata?.candidatesTokenCount,
        brainProvider: "gemini",
        brainModel: opts.model,
      };
    },
  };
}
