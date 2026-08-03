/**
 * pc-tools.ts — High-level PC operator tools:
 *
 *   lumina_pc_observe — one rich snapshot of the current desktop state
 *                       (screenshot + foreground app + interactable UIA
 *                       elements + visible windows). Replaces the old
 *                       chain of 4 separate calls.
 *
 *   lumina_pc_scroll  — scroll N "notches" at cursor or at a resolved
 *                       UIA target. Direction: up/down/left/right.
 *
 *   lumina_pc_drag    — drag-and-drop from point A to point B. Both
 *                       endpoints may be coords OR natural-language
 *                       queries (resolved via UIA). Interpolated cursor
 *                       movement so apps that listen to WM_MOUSEMOVE
 *                       (sliders, kanban, canvas) see a real drag.
 *
 * All three reuse the same Bridge `/input_control` endpoint and the
 * same per-process allowlist that smart_click / replay use. Nothing
 * here bypasses security — it just exposes verbs that were missing.
 */
import fs from "node:fs";
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";
import { createBridgeClient, type BridgeClient } from "../shared/bridge-client.js";

type UiaMatch = {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  center: { x: number; y: number } | null;
  enabled: boolean;
  offscreen: boolean;
  score: number;
};

type UiaFindResponse = {
  ok: boolean;
  process?: { pid: number | null; name: string; className: string };
  matches?: UiaMatch[];
  error?: string;
};

type UiaTreeResponse = {
  ok: boolean;
  process?: { pid: number | null; name: string; className: string };
  nodes?: Array<{
    name?: string;
    automationId?: string;
    controlType?: string;
    className?: string;
    bbox?: { x: number; y: number; w: number; h: number };
    center?: { x: number; y: number };
    enabled?: boolean;
    offscreen?: boolean;
  }>;
  error?: string;
};

export type PcToolsDeps = {
  readonly bridgeUrl: string;
  readonly allowedApps: ReadonlyArray<string>;
  readonly fetchImpl?: typeof fetch;
};

function client(deps: PcToolsDeps): BridgeClient {
  return createBridgeClient({ bridgeUrl: deps.bridgeUrl, fetchImpl: deps.fetchImpl });
}

async function resolveUia(query: string, controlType?: string): Promise<UiaFindResponse | null> {
  const args = ["--find", query, "--max-matches", "3"];
  if (controlType) args.push("--control-type", controlType);
  const r = await runPythonSidecarJson<UiaFindResponse>("uia_tree", args, { timeoutMs: 15_000 });
  return r.ok ? r.data ?? null : null;
}

async function pickCenter(query: string, minScore: number): Promise<
  { ok: true; point: { x: number; y: number }; match: UiaMatch; process: { pid: number | null; name: string; className: string } | undefined }
  | { ok: false; error: string; matches?: UiaMatch[] }
> {
  const resolved = await resolveUia(query);
  if (!resolved) return { ok: false, error: "uia_sidecar_failed" };
  const matches = resolved.matches ?? [];
  if (matches.length === 0) return { ok: false, error: "no_match", matches };
  const top = matches[0]!;
  if (top.score < minScore || !top.center) {
    return { ok: false, error: "low_confidence", matches };
  }
  return { ok: true, point: top.center, match: top, process: resolved.process };
}

// ── lumina_pc_observe ─────────────────────────────────────────────────

export function createPcObserveTool(deps: PcToolsDeps): AnyAgentTool {
  return {
    name: "lumina_pc_observe",
    label: "Lumina PC — Observe",
    description:
      "Devuelve un snapshot completo del estado del PC en UNA llamada: screenshot path, " +
      "ventana foreground (proceso + título + bbox), top-N elementos interactables del UIA tree " +
      "con bbox/center/role, lista de ventanas visibles. Reemplaza la cadena vieja de 4 calls " +
      "(screen_capture + ui_tree + window_control). Úsalo SIEMPRE como primer paso de un loop " +
      "observe→act→verify cuando vayas a operar el PC.",
    parameters: Type.Object({
      maxInteractables: Type.Optional(
        Type.Integer({ minimum: 5, maximum: 200, default: 40, description: "Top-N UIA nodes a devolver." }),
      ),
      includeScreenshot: Type.Optional(
        Type.Boolean({ default: true, description: "Capturar PNG (path en `screenshotPath`)." }),
      ),
      includeUia: Type.Optional(
        Type.Boolean({ default: true, description: "Leer árbol UIA (interactables + foreground app)." }),
      ),
      includeWindows: Type.Optional(
        Type.Boolean({ default: true, description: "Listar ventanas visibles via Bridge /window_control list." }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        maxInteractables?: number;
        includeScreenshot?: boolean;
        includeUia?: boolean;
        includeWindows?: boolean;
      };
      const maxInteractables = typeof params.maxInteractables === "number" ? params.maxInteractables : 40;
      const want = {
        screenshot: params.includeScreenshot !== false,
        uia: params.includeUia !== false,
        windows: params.includeWindows !== false,
      };

      const c = client(deps);

      const [screenshotResp, uiaResp, windowsResp] = await Promise.all([
        want.screenshot
          ? c.post<{ ok?: boolean; path?: string }>("/screenshot", {}, 5_000)
          : Promise.resolve(null),
        want.uia
          ? runPythonSidecarJson<UiaTreeResponse>(
              "uia_tree",
              ["--max-depth", "8", "--max-nodes", String(Math.max(maxInteractables * 4, 200))],
              { timeoutMs: 15_000 },
            )
          : Promise.resolve(null),
        want.windows
          ? c.post<{ ok?: boolean; windows?: Array<{ title?: string; pid?: number; process?: string; bbox?: unknown }> }>(
              "/window_control",
              { action: "list" },
              4_000,
            )
          : Promise.resolve(null),
      ]);

      const screenshotPath =
        screenshotResp && typeof screenshotResp.path === "string" ? screenshotResp.path : null;

      // Continuous perception sidecar can keep fresher foreground/frame state than
      // one-shot UIA when the UIA sidecar is flaky. If a latest-state cache exists,
      // use it as a soft supplement (never as the sole source of truth for clicks).
      let perceptionLatest: Record<string, unknown> | null = null;
      try {
        const latestPath = process.env.LUMINA_PERCEPTION_LATEST_STATE;
        if (latestPath && fs.existsSync(latestPath)) {
          const rawLatest = fs.readFileSync(latestPath, "utf8");
          const parsed = JSON.parse(rawLatest) as Record<string, unknown>;
          perceptionLatest = parsed;
        }
      } catch {
        perceptionLatest = null;
      }

      const uiaData = uiaResp && uiaResp.ok ? uiaResp.data ?? null : null;
      const allNodes = uiaData?.nodes ?? [];
      // Trim to interactable + enabled + on-screen with bbox. Sort by area
      // descending so big controls land first (typical pattern: agent
      // cares about toolbar buttons more than 4px sliders).
      const interactables = allNodes
        .filter((n) => n.enabled !== false && n.offscreen !== true && n.bbox)
        .map((n) => ({
          name: n.name ?? "",
          automationId: n.automationId ?? "",
          controlType: n.controlType ?? "",
          bbox: n.bbox ?? null,
          center: n.center ?? null,
        }))
        .slice(0, maxInteractables);

      const windows = (windowsResp?.windows ?? [])
        .map((w) => ({
          title: typeof w.title === "string" ? w.title : "",
          pid: typeof w.pid === "number" ? w.pid : 0,
          process: typeof w.process === "string" ? w.process : "",
        }))
        .filter((w) => w.title.length > 0);

      return jsonResult({
        ok: true,
        screenshotPath,
        foreground: uiaData?.process ?? perceptionLatest?.foreground ?? null,
        interactableCount: interactables.length,
        interactables,
        windowCount: windows.length,
        windows,
        perception: perceptionLatest,
        freshnessMs:
          typeof perceptionLatest?.atISO === "string"
            ? Math.max(0, Date.now() - Date.parse(String(perceptionLatest.atISO)))
            : null,
        hints: {
          nextStep:
            "Para clickear un elemento de `interactables` usa lumina_smart_click({ query: <name> }). " +
            "Para escribir en un campo, lumina_smart_type. Para scroll/drag, lumina_pc_scroll / _drag. " +
            "Si nada calza, intenta lumina_vision_parse({ imagePath: screenshotPath, setOfMarks: true }).",
        },
      });
    },
  };
}

// ── lumina_pc_scroll ──────────────────────────────────────────────────

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

const WHEEL_DELTA = 120;

function scrollVector(direction: ScrollDirection, notches: number): { dx: number; dy: number } {
  const n = Math.max(1, Math.abs(notches)) * WHEEL_DELTA;
  switch (direction) {
    case "up":    return { dx: 0, dy: n };
    case "down":  return { dx: 0, dy: -n };
    case "left":  return { dx: -n, dy: 0 };
    case "right": return { dx: n, dy: 0 };
  }
}

export function createPcScrollTool(deps: PcToolsDeps): AnyAgentTool {
  return {
    name: "lumina_pc_scroll",
    label: "Lumina PC — Scroll",
    description:
      "Hace scroll en la ventana foreground. `direction` = up/down/left/right (default down). " +
      "`amount` = número de notches del wheel (default 3). Si pasas `query`, primero resuelve el target " +
      "via UIA y mueve el cursor allí (útil para hacer scroll DENTRO de un panel concreto, no en lo que " +
      "esté hovered). Si pasas `x`/`y`, mueve el cursor a esa coord antes de scroll. " +
      "Para 'baja media página' usa amount=10, 'una página' ≈ 20. Modo agente: combinar con observe + " +
      "smart_click — scroll hasta que el target aparezca en interactables.",
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union(SCROLL_DIRECTIONS.map((d) => Type.Literal(d)), { default: "down" }),
      ),
      amount: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, default: 3, description: "Notches del wheel (1 ≈ 3 líneas)." }),
      ),
      query: Type.Optional(
        Type.String({ maxLength: 200, description: "Opcional: hover encima de este elemento antes de scroll." }),
      ),
      x: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      y: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      processName: Type.Optional(
        Type.String({ maxLength: 80, description: "Hint: aborta si foreground no es esta app." }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        direction?: ScrollDirection;
        amount?: number;
        query?: string;
        x?: number;
        y?: number;
        processName?: string;
      };
      const direction = params.direction ?? "down";
      const amount = typeof params.amount === "number" ? params.amount : 3;
      const c = client(deps);

      let cursorX: number | undefined = typeof params.x === "number" ? params.x : undefined;
      let cursorY: number | undefined = typeof params.y === "number" ? params.y : undefined;
      let pickedFromQuery: UiaMatch | null = null;

      if (params.query) {
        const picked = await pickCenter(params.query.trim(), 0.5);
        if (!picked.ok) {
          return jsonResult({
            ok: false,
            error: picked.error,
            hint: "No pude resolver el target del scroll. Llama smart_click con allowVision o pasa coords directas.",
          });
        }
        if (params.processName && picked.process && picked.process.name?.toLowerCase() !== params.processName.toLowerCase()) {
          return jsonResult({
            ok: false,
            error: "process_mismatch",
            actualProcess: picked.process.name,
            expectedProcess: params.processName,
          });
        }
        cursorX = picked.point.x;
        cursorY = picked.point.y;
        pickedFromQuery = picked.match;
      }

      const { dx, dy } = scrollVector(direction, amount);
      const body: Record<string, unknown> = {
        action: "mouse_scroll",
        dx,
        dy,
        wait_ms: 80,
        allowedApps: deps.allowedApps,
      };
      if (typeof cursorX === "number" && typeof cursorY === "number") {
        body.x = cursorX;
        body.y = cursorY;
      }
      const resp = await c.post<{ ok?: boolean; allowed?: boolean; error?: string; processName?: string }>(
        "/input_control",
        body,
        6_000,
      );
      if (!resp) {
        return jsonResult({ ok: false, dispatched: false, error: "bridge_unreachable" });
      }
      return jsonResult({
        ok: resp.ok === true,
        dispatched: resp.ok === true,
        direction,
        amount,
        notchDelta: { dx, dy },
        hoverPoint: typeof cursorX === "number" ? { x: cursorX, y: cursorY } : null,
        picked: pickedFromQuery,
        processName: resp.processName,
        error: resp.error,
      });
    },
  };
}

// ── lumina_pc_drag ────────────────────────────────────────────────────

export function createPcDragTool(deps: PcToolsDeps): AnyAgentTool {
  return {
    name: "lumina_pc_drag",
    label: "Lumina PC — Drag & Drop",
    description:
      "Drag-and-drop de un punto A a un punto B. Cada endpoint puede ser `query` (NL → resuelve via UIA) o " +
      "coords brutas `x`/`y`. Movimiento interpolado para que sliders, kanban cards y canvas vean el drag " +
      "real (no un teleport). Casos típicos: mover una card de Trello a otra columna, ajustar volumen, " +
      "reordenar tabs, redimensionar ventana, recortar imagen.",
    parameters: Type.Object({
      fromQuery: Type.Optional(Type.String({ maxLength: 200 })),
      fromX: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      fromY: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      toQuery: Type.Optional(Type.String({ maxLength: 200 })),
      toX: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      toY: Type.Optional(Type.Integer({ minimum: -32768, maximum: 32767 })),
      button: Type.Optional(
        Type.Union(
          [Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")],
          { default: "left" },
        ),
      ),
      steps: Type.Optional(
        Type.Integer({ minimum: 2, maximum: 200, default: 24, description: "Cuántos pasos intermedios para suavizar." }),
      ),
      stepDelayMs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 200, default: 8 }),
      ),
      processName: Type.Optional(Type.String({ maxLength: 80 })),
    }),
    async execute(_id, raw) {
      const params = raw as {
        fromQuery?: string;
        fromX?: number;
        fromY?: number;
        toQuery?: string;
        toX?: number;
        toY?: number;
        button?: "left" | "right" | "middle";
        steps?: number;
        stepDelayMs?: number;
        processName?: string;
      };
      const button = params.button ?? "left";
      const steps = typeof params.steps === "number" ? params.steps : 24;
      const stepDelayMs = typeof params.stepDelayMs === "number" ? params.stepDelayMs : 8;

      // Resolve FROM endpoint.
      let from: { x: number; y: number } | null = null;
      let fromPicked: UiaMatch | null = null;
      if (params.fromQuery) {
        const picked = await pickCenter(params.fromQuery.trim(), 0.5);
        if (!picked.ok) {
          return jsonResult({ ok: false, error: `from:${picked.error}`, alternatives: picked.matches ?? [] });
        }
        from = picked.point;
        fromPicked = picked.match;
        if (params.processName && picked.process && picked.process.name?.toLowerCase() !== params.processName.toLowerCase()) {
          return jsonResult({
            ok: false,
            error: "process_mismatch",
            actualProcess: picked.process.name,
            expectedProcess: params.processName,
          });
        }
      } else if (typeof params.fromX === "number" && typeof params.fromY === "number") {
        from = { x: params.fromX, y: params.fromY };
      } else {
        throw new ToolInputError("Need either fromQuery OR (fromX, fromY).");
      }

      // Resolve TO endpoint.
      let to: { x: number; y: number } | null = null;
      let toPicked: UiaMatch | null = null;
      if (params.toQuery) {
        const picked = await pickCenter(params.toQuery.trim(), 0.5);
        if (!picked.ok) {
          return jsonResult({ ok: false, error: `to:${picked.error}`, alternatives: picked.matches ?? [] });
        }
        to = picked.point;
        toPicked = picked.match;
      } else if (typeof params.toX === "number" && typeof params.toY === "number") {
        to = { x: params.toX, y: params.toY };
      } else {
        throw new ToolInputError("Need either toQuery OR (toX, toY).");
      }

      const c = client(deps);
      const resp = await c.post<{ ok?: boolean; allowed?: boolean; error?: string; processName?: string }>(
        "/input_control",
        {
          action: "mouse_drag",
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          button,
          steps,
          step_delay_ms: stepDelayMs,
          wait_ms: 120,
          allowedApps: deps.allowedApps,
        },
        15_000,
      );
      if (!resp) {
        return jsonResult({ ok: false, dispatched: false, error: "bridge_unreachable" });
      }
      return jsonResult({
        ok: resp.ok === true,
        dispatched: resp.ok === true,
        from,
        to,
        fromPicked,
        toPicked,
        button,
        steps,
        processName: resp.processName,
        error: resp.error,
      });
    },
  };
}
