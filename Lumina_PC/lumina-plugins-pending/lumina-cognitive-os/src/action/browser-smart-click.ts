/**
 * browser-smart-click.ts — DOM/accessibility-aware browser operator tools.
 *
 *   lumina_browser_smart_click — click an element BY NAME using the
 *     accessibility tree (getByRole + name) with a fallback chain:
 *         role:button → role:link → role:menuitem → role:tab →
 *         getByText → [aria-label*=name] → [placeholder*=name]
 *     This is dramatically more reliable than UIA on web pages —
 *     YouTube, Gmail, Notion, X, etc. expose proper ARIA labels that
 *     UIA reads as opaque "Document".
 *
 *   lumina_browser_smart_type — fill a labeled input by NAME, with
 *     fallbacks (role:textbox/searchbox/combobox → label → placeholder).
 *
 *   lumina_browser_dom_observe — returns the top-N visible interactables
 *     with role + accessible name + bbox. The browser equivalent of
 *     lumina_pc_observe.
 *
 * All three reuse the existing Playwright sidecar (`browser_drive`) and
 * persistent profile, so cookies/login survive across calls.
 */
import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

function profileDir(profile: string): string {
  const base =
    process.env.APPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".lumina-cognitive-os");
  return path.join(base, "lumina-cognitive-os", "browser-profile", profile);
}

type SidecarResponse = { ok: boolean; [k: string]: unknown };

async function callSidecar(payload: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; data?: SidecarResponse; error?: string }> {
  return runPythonSidecarJson<SidecarResponse>(
    "browser_drive",
    [],
    { timeoutMs, stdin: JSON.stringify(payload) },
  );
}

export type BrowserSmartConfig = { enabled: boolean };

export function createBrowserSmartClickTool(opts: BrowserSmartConfig): AnyAgentTool {
  return {
    name: "lumina_browser_smart_click",
    label: "Lumina Browser — Smart Click",
    description:
      "Clickea un elemento en la pestaña Playwright activa POR NOMBRE usando el accessibility tree del DOM. " +
      "Cadena de fallback: getByRole({button,link,menuitem,tab,checkbox,radio,option}, name) → getByText → " +
      "[aria-label*=name] → [placeholder*=name]. Dramáticamente más fiable que UIA en YouTube/Gmail/Notion/X " +
      "porque lee ARIA labels reales. Verifica con cambio de URL o cambio del DOM > 2%. Devuelve " +
      "{ ok, strategy, candidateCount, urlBefore, urlAfter, verified }.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      role: Type.Optional(
        Type.String({
          maxLength: 30,
          description: "Opcional ARIA role hint (button, link, menuitem, tab, checkbox, radio, option, textbox, searchbox).",
        }),
      ),
      exact: Type.Optional(
        Type.Boolean({ default: false, description: "Si true, match exacto del name (caso-sensitive)." }),
      ),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      headless: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 60_000, default: 6_000 })),
    }),
    async execute(_id, raw) {
      if (!opts.enabled) {
        return jsonResult({
          ok: false,
          error: "browser driver is disabled. Set browserDriverEnabled=true in plugin config.",
        });
      }
      const params = raw as {
        query: string;
        role?: string;
        exact?: boolean;
        profile?: string;
        headless?: boolean;
        timeoutMs?: number;
      };
      const query = params.query?.trim();
      if (!query) throw new ToolInputError("query is required");
      const payload = {
        action: "smart_click",
        userDataDir: profileDir(params.profile?.trim() || "default"),
        args: {
          query,
          role: params.role,
          exact: params.exact === true,
          headless: params.headless !== false,
          timeoutMs: params.timeoutMs ?? 6_000,
        },
      };
      const r = await callSidecar(payload, Math.max(20_000, (params.timeoutMs ?? 6_000) + 10_000));
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint: "If Playwright is missing run: pip install playwright && playwright install chromium",
        });
      }
      return jsonResult(r.data);
    },
  };
}

export function createBrowserSmartTypeTool(opts: BrowserSmartConfig): AnyAgentTool {
  return {
    name: "lumina_browser_smart_type",
    label: "Lumina Browser — Smart Type",
    description:
      "Escribe en un campo BY NAME usando el accessibility tree. Cadena: getByRole({textbox,searchbox,combobox}, name) " +
      "→ getByLabel → [placeholder*=name]. Opcional pressEnter para submit.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      text: Type.String({ minLength: 1, maxLength: 4_096 }),
      pressEnter: Type.Optional(Type.Boolean({ default: false })),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      headless: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 60_000, default: 6_000 })),
    }),
    async execute(_id, raw) {
      if (!opts.enabled) {
        return jsonResult({ ok: false, error: "browser driver is disabled." });
      }
      const params = raw as {
        query: string;
        text: string;
        pressEnter?: boolean;
        profile?: string;
        headless?: boolean;
        timeoutMs?: number;
      };
      const query = params.query?.trim();
      if (!query) throw new ToolInputError("query is required");
      if (!params.text) throw new ToolInputError("text is required");
      const payload = {
        action: "smart_type",
        userDataDir: profileDir(params.profile?.trim() || "default"),
        args: {
          query,
          text: params.text,
          pressEnter: params.pressEnter === true,
          headless: params.headless !== false,
          timeoutMs: params.timeoutMs ?? 6_000,
        },
      };
      const r = await callSidecar(payload, Math.max(20_000, (params.timeoutMs ?? 6_000) + 10_000));
      if (!r.ok) return jsonResult({ ok: false, error: r.error });
      return jsonResult(r.data);
    },
  };
}

export function createBrowserDomScreenshotTool(opts: BrowserSmartConfig): AnyAgentTool {
  return {
    name: "lumina_browser_dom_screenshot",
    label: "Lumina Browser — DOM Screenshot",
    description:
      "Captura un PNG del viewport de la pestaña Playwright activa y lo guarda en disco. " +
      "Devuelve { path, url, sizeBytes }. MÁS RÁPIDO que lumina_screen_capture cuando el target es " +
      "una página web — sin roundtrip PowerShell, captura solo el viewport del browser. Útil dentro " +
      "del PC Operator Loop cuando foregroundProcess es chrome/edge/firefox. Pasar fullPage=true para " +
      "capturar toda la página (scroll incluido).",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ default: false })),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      headless: Type.Optional(Type.Boolean({ default: true })),
      outDir: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    async execute(_id, raw) {
      if (!opts.enabled) {
        return jsonResult({ ok: false, error: "browser driver is disabled." });
      }
      const params = raw as { fullPage?: boolean; profile?: string; headless?: boolean; outDir?: string };
      const payload = {
        action: "dom_screenshot",
        userDataDir: profileDir(params.profile?.trim() || "default"),
        args: {
          fullPage: params.fullPage === true,
          headless: params.headless !== false,
          outDir: params.outDir,
        },
      };
      const r = await callSidecar(payload, 25_000);
      if (!r.ok) return jsonResult({ ok: false, error: r.error });
      return jsonResult(r.data);
    },
  };
}

export function createBrowserDomObserveTool(opts: BrowserSmartConfig): AnyAgentTool {
  return {
    name: "lumina_browser_dom_observe",
    label: "Lumina Browser — DOM Observe",
    description:
      "Devuelve los top-N elementos interactables visibles de la página actual: role, accessible name, " +
      "href (si link), bbox y center. Ordenados por área desc (los grandes primero). " +
      "Equivalente browser de lumina_pc_observe. Úsalo antes de browser_smart_click cuando no sepas " +
      "qué hay disponible.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 5, maximum: 200, default: 30 })),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      headless: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, raw) {
      if (!opts.enabled) {
        return jsonResult({ ok: false, error: "browser driver is disabled." });
      }
      const params = raw as { limit?: number; profile?: string; headless?: boolean };
      const payload = {
        action: "dom_observe",
        userDataDir: profileDir(params.profile?.trim() || "default"),
        args: {
          limit: params.limit ?? 30,
          // For persistent user-visible browser automation we must attach to
          // the already-open browser window, not silently create a hidden one.
          headless: false,
        },
      };
      const r = await callSidecar(payload, 20_000);
      if (!r.ok) return jsonResult({ ok: false, error: r.error });
      return jsonResult(r.data);
    },
  };
}
