/**
 * app-tools.ts — High-level "apps de Windows" suite:
 *
 *   lumina_app_list   — enumera apps instaladas (Get-StartApps) o filtra
 *                       por substring. Cacheable.
 *   lumina_app_launch — lanza por alias curado O por fuzzy match contra
 *                       Get-StartApps. Soporta TODO lo del Start menu sin
 *                       hardcodear cada app.
 *   lumina_app_close  — cierra graceful (WM_CLOSE) y opcionalmente fuerza
 *                       Stop-Process. Acepta pid / title / processName.
 *
 * Todo pasa por el Bridge `/window_control`, así que se preserva auditoría
 * y allowlist por proceso para clicks/keys.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { createBridgeClient, type BridgeClient } from "../shared/bridge-client.js";

export type AppToolsDeps = {
  readonly bridgeUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly clientOverride?: BridgeClient;
};

function client(deps: AppToolsDeps): BridgeClient {
  return deps.clientOverride ?? createBridgeClient({ bridgeUrl: deps.bridgeUrl, fetchImpl: deps.fetchImpl });
}

export function createAppListTool(deps: AppToolsDeps): AnyAgentTool {
  return {
    name: "lumina_app_list",
    label: "Lumina Apps — List Installed",
    description:
      "Devuelve las apps instaladas en Windows que están en el Start menu (Get-StartApps). Acepta " +
      "`filter` substring para filtrar por nombre (case-insensitive). Sirve para descubrir qué hay " +
      "antes de pedir `lumina_app_launch`. Útil cuando Dal dice 'abre la app X' y no sabes el alias " +
      "exacto. Cachear el resultado por sesión — la lista cambia raramente.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({ maxLength: 80, description: "Substring opcional. 'office' → Word, Excel, etc." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 10, maximum: 500, default: 200 }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { filter?: string; limit?: number };
      const resp = await client(deps).post<{ ok?: boolean; count?: number; apps?: Array<{ name: string; appId: string }>; error?: string }>(
        "/window_control",
        { action: "discover", filter: params.filter, limit: params.limit ?? 200 },
        15_000,
      );
      if (!resp) {
        return jsonResult({ ok: false, error: "bridge_unreachable" });
      }
      return jsonResult({
        ok: resp.ok !== false,
        count: resp.count ?? (Array.isArray(resp.apps) ? resp.apps.length : 0),
        apps: resp.apps ?? [],
        error: resp.error,
      });
    },
  };
}

export function createAppLaunchTool(deps: AppToolsDeps): AnyAgentTool {
  return {
    name: "lumina_app_launch",
    label: "Lumina Apps — Launch",
    description:
      "Lanza una app de Windows. Acepta uno de:\n" +
      "  - Alias curado: 'word', 'excel', 'chrome', 'spotify', 'vscode', 'youtube', etc. (~70 aliases).\n" +
      "  - Nombre del Start menu: 'Visual Studio Code', 'Adobe Acrobat', 'Krita'. Fuzzy match — " +
      "    si hay un hit único, lanza. Si hay varios, devuelve alternativas para que decidas.\n" +
      "Si la app no se encuentra, devuelve { ok: false, error: 'no_match' } con candidatos para que " +
      "el agente pida `lumina_app_list({ filter })` y precise. SIN coordenadas, sin teclas — solo " +
      "el dispatch a Start-Process via Bridge.",
    parameters: Type.Object({
      application: Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Alias o nombre completo. Case-insensitive.",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { application: string };
      const rawApp = params.application?.trim();
      if (!rawApp) throw new ToolInputError("application is required");
      // Lowercase for alias matching; fuzzy Start-Apps search in the Bridge
      // is also case-insensitive, so this is safe end-to-end.
      const app = rawApp.toLowerCase();
      const resp = await client(deps).post<{
        ok?: boolean;
        launched?: boolean;
        application?: string;
        display_name?: string;
        via?: string;
        picked?: { name: string; appId: string };
        alternativeCount?: number;
        alternatives?: Array<{ name: string; appId: string }>;
        error?: string;
      }>("/window_control", { action: "launch", application: app }, 18_000);
      if (!resp) {
        return jsonResult({ ok: false, error: "bridge_unreachable" });
      }
      return jsonResult({
        ok: resp.ok !== false,
        launched: resp.launched === true,
        request: rawApp,
        normalized: app,
        via: resp.via,
        application: resp.application,
        displayName: resp.display_name,
        picked: resp.picked,
        alternativeCount: resp.alternativeCount,
        alternatives: resp.alternatives,
        error: resp.error,
        hint:
          resp.ok === false && resp.error === "no_match"
            ? "Pide a Dal el nombre exacto, O llama lumina_app_list({ filter }) para ver candidatos."
            : undefined,
      });
    },
  };
}

export function createAppCloseTool(deps: AppToolsDeps): AnyAgentTool {
  return {
    name: "lumina_app_close",
    label: "Lumina Apps — Close",
    description:
      "Cierra una app/ventana. Acepta UNO de: `pid` (más preciso), `title` (substring del título de " +
      "la ventana), `processName` (nombre del .exe sin extensión, e.g. 'notepad', 'chrome'). " +
      "Default: WM_CLOSE graceful (la app puede preguntar 'guardar cambios?'). Si `force: true`, " +
      "después de 1.5s mata el proceso con Stop-Process -Force. Devuelve { ok, closed, count, killed }. " +
      "USAR cuando Dal diga 'cierra X', 'mata X', 'apaga X'.",
    parameters: Type.Object({
      pid: Type.Optional(Type.Integer({ minimum: 1 })),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      processName: Type.Optional(Type.String({ maxLength: 80 })),
      force: Type.Optional(
        Type.Boolean({
          default: false,
          description: "true = mata con Stop-Process si WM_CLOSE no funcionó en 1.5s. Sin guardar.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { pid?: number; title?: string; processName?: string; force?: boolean };
      if (!params.pid && !params.title && !params.processName) {
        throw new ToolInputError("close requires pid OR title OR processName");
      }
      const resp = await client(deps).post<{
        ok?: boolean;
        closed?: boolean;
        count?: number;
        killed?: number;
        force?: boolean;
        error?: string;
      }>(
        "/window_control",
        {
          action: "close",
          pid: params.pid,
          title: params.title,
          processName: params.processName,
          force: params.force === true,
        },
        15_000,
      );
      if (!resp) {
        return jsonResult({ ok: false, error: "bridge_unreachable" });
      }
      return jsonResult({
        ok: resp.ok !== false,
        closed: resp.closed === true,
        matchCount: resp.count,
        killed: resp.killed,
        force: resp.force,
        request: { pid: params.pid, title: params.title, processName: params.processName, force: params.force === true },
        error: resp.error,
        hint:
          resp.ok !== false && resp.closed !== true
            ? "Nada cerró. Si la app preguntó por guardar y no se confirmó, reintenta con force: true."
            : undefined,
      });
    },
  };
}
