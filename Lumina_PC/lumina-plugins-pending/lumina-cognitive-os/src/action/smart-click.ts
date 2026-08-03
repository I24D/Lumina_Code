/**
 * smart-click.ts — Tools: lumina_smart_click + lumina_smart_type
 *
 * Single high-level "do the right thing" tool for clicking/typing on a
 * named UI element. Closes the loop that, until now, the agent had to
 * stitch together by hand and frequently got wrong:
 *
 *     vision_ui_resolve(query)              ← resolve
 *           │
 *           ▼   (if 0 matches AND allowVision)
 *     vision_parse(setOfMarks=true)         ← fallback
 *           │
 *           ▼
 *     screen_capture()                      ← pre-state
 *           │
 *           ▼
 *     input_control(mouse_click x,y)        ← dispatch
 *           │
 *           ▼
 *     vision_ui_tree() + screen_capture()   ← post-state
 *           │
 *           ▼
 *     verifyPostAction(uia_recheck | screenshot_diff)
 *
 * The agent only has to call ONE tool. If verification fails, the result
 * is { ok: false, dispatched: true, verification: { ok: false } } and the
 * agent can decide to retry, ask Dal, or escalate.
 *
 * Design notes:
 * - The Bridge HTTP path is the SAME `/input_control` used by
 *   lumina_input_control and the replay engine — the per-process
 *   allowlist still applies. We do NOT bypass security.
 * - `allowVision` is OPT-IN: clicking based on Set-of-Marks needs the
 *   user (or a separate LLM call) to first pick a number from the
 *   labeled screenshot. By default smart-click stays UIA-only.
 * - `dryRun: true` returns the candidates WITHOUT dispatching — useful
 *   for voice ("¿qué vas a clickear?") and HIGH_RISK gating.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";
import { verifyPostAction } from "../replay/verifier.js";
import type { LiveContext, LiveUiaNode, VerifyPolicy } from "../replay/strategies/types.js";

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
  nodesScanned?: number;
  error?: string;
};

type UiaTreeResponse = {
  ok: boolean;
  nodes?: LiveUiaNode[];
  error?: string;
};

type ScreenshotResponse = { ok?: boolean; path?: string };

type DispatchResult = { ok: boolean; allowed?: boolean; error?: string; processName?: string };

export type SmartClickDeps = {
  readonly bridgeUrl: string;
  readonly allowedApps: ReadonlyArray<string>;
  readonly fetchImpl?: typeof fetch;
};

const PICK_REASON_LABELS: Record<string, string> = {
  high_score: "top UIA match with score ≥ minScore",
  process_hint_boost: "top match after applying processName filter",
  vision_grounded: "selected from OmniParser Set-of-Marks (vision fallback)",
  index_override: "picked by explicit candidateIndex",
};

function getFetch(deps: SmartClickDeps): typeof fetch | null {
  const f = deps.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  return f ?? null;
}

async function bridgeJson<T>(
  deps: SmartClickDeps,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  const f = getFetch(deps);
  if (!f) return null;
  const base = deps.bridgeUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await f(`${base}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function captureScreenshot(deps: SmartClickDeps): Promise<string | null> {
  const body = await bridgeJson<ScreenshotResponse>(deps, "/screenshot", {}, 5_000);
  if (!body) return null;
  return typeof body.path === "string" && body.path.length > 0 ? body.path : null;
}

async function fetchLiveUiaTree(): Promise<LiveUiaNode[] | null> {
  const r = await runPythonSidecarJson<UiaTreeResponse>(
    "uia_tree",
    ["--max-depth", "8", "--max-nodes", "600"],
    { timeoutMs: 15_000 },
  );
  if (!r.ok) return null;
  const nodes = r.data?.nodes;
  return Array.isArray(nodes) ? nodes : null;
}

async function resolveUia(params: {
  query: string;
  controlType?: string;
  pid?: number;
  maxMatches: number;
}): Promise<UiaFindResponse | null> {
  const args = ["--find", params.query, "--max-matches", String(params.maxMatches)];
  if (params.controlType) args.push("--control-type", params.controlType);
  if (typeof params.pid === "number") args.push("--pid", String(params.pid));
  const r = await runPythonSidecarJson<UiaFindResponse>("uia_tree", args, {
    timeoutMs: 15_000,
  });
  if (!r.ok || !r.data) return null;
  return r.data;
}

function filterByProcess(
  matches: UiaMatch[],
  processName: string | undefined,
  procFromUia: { name: string } | undefined,
): UiaMatch[] {
  if (!processName) return matches;
  const norm = processName.trim().toLowerCase();
  if (!norm) return matches;
  if (procFromUia && procFromUia.name.trim().toLowerCase() === norm) {
    return matches;
  }
  return [];
}

function pickBest(
  matches: UiaMatch[],
  minScore: number,
  candidateIndex: number | undefined,
): { picked: UiaMatch | null; reason: keyof typeof PICK_REASON_LABELS | null } {
  if (typeof candidateIndex === "number") {
    if (candidateIndex < 0 || candidateIndex >= matches.length) {
      return { picked: null, reason: null };
    }
    return { picked: matches[candidateIndex] ?? null, reason: "index_override" };
  }
  if (matches.length === 0) return { picked: null, reason: null };
  const best = matches[0]!;
  if (!best.center) return { picked: null, reason: null };
  if (best.score < minScore) return { picked: null, reason: null };
  return { picked: best, reason: "high_score" };
}

async function dispatchClick(
  deps: SmartClickDeps,
  params: {
    x: number;
    y: number;
    button: "left" | "right" | "middle";
    clicks: number;
  },
): Promise<DispatchResult> {
  const body = await bridgeJson<DispatchResult>(
    deps,
    "/input_control",
    {
      action: "mouse_click",
      x: params.x,
      y: params.y,
      button: params.button,
      clicks: params.clicks,
      wait_ms: 120,
      allowedApps: deps.allowedApps,
    },
    8_000,
  );
  if (!body) return { ok: false, error: "bridge_unreachable" };
  return body;
}

async function dispatchType(
  deps: SmartClickDeps,
  text: string,
): Promise<DispatchResult> {
  const body = await bridgeJson<DispatchResult>(
    deps,
    "/input_control",
    {
      action: "type_text",
      text,
      wait_ms: 80,
      allowedApps: deps.allowedApps,
    },
    8_000,
  );
  if (!body) return { ok: false, error: "bridge_unreachable" };
  return body;
}

async function runVerification(params: {
  pickedMatch: UiaMatch;
  preScreenshotPath: string | null;
  postLive: LiveContext;
  policyKind: "auto" | "screenshot" | "uia" | "none";
}): Promise<ReturnType<typeof verifyPostAction>> {
  const { pickedMatch, preScreenshotPath, postLive, policyKind } = params;
  let policy: VerifyPolicy;
  if (policyKind === "none") {
    policy = { kind: "none" };
  } else if (policyKind === "uia") {
    policy = {
      kind: "uia_recheck",
      expect: { automationId: pickedMatch.automationId, name: pickedMatch.name },
    };
  } else if (policyKind === "screenshot") {
    policy = { kind: "screenshot_diff", minChangeRatio: 0.005 };
  } else {
    // auto: prefer screenshot_diff (catches "the view changed"), fall back
    // to uia_recheck if no screenshots available.
    if (preScreenshotPath && postLive.screenshotPath) {
      policy = { kind: "screenshot_diff", minChangeRatio: 0.005 };
    } else if (postLive.uiaNodes) {
      policy = {
        kind: "uia_recheck",
        expect: { automationId: pickedMatch.automationId, name: pickedMatch.name },
      };
    } else {
      policy = { kind: "none" };
    }
  }
  return verifyPostAction({ policy, preScreenshotPath, postLive });
}

const ClickParams = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description:
      "Etiqueta natural del elemento a clickear: 'Play', 'Guardar', 'campo de búsqueda', 'botón rojo Enviar'.",
  }),
  controlType: Type.Optional(
    Type.String({
      maxLength: 40,
      description: "Filtro UIA opcional: Button, Edit, Hyperlink, MenuItem, CheckBox, ComboBox, ...",
    }),
  ),
  processName: Type.Optional(
    Type.String({
      maxLength: 80,
      description:
        "Hint para limitar la búsqueda al proceso foreground esperado (e.g. 'chrome.exe'). " +
        "Si la app foreground NO coincide, smart-click no envía clicks (evita clickear en la app equivocada).",
    }),
  ),
  button: Type.Optional(
    Type.Union(
      [Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")],
      { default: "left" },
    ),
  ),
  clicks: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 3, default: 1, description: "1=click, 2=doble-click, 3=triple." }),
  ),
  minScore: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, default: 0.5, description: "Umbral de confianza UIA." }),
  ),
  candidateIndex: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 9,
      description:
        "Si el agente ya conoce los candidatos (de una llamada previa), puede forzar este índice " +
        "en lugar del 'mejor por score'. Útil cuando hay varios botones 'Play'.",
    }),
  ),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
  allowVision: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Si UIA devuelve 0 matches Y allowVision=true, intenta OmniParser. NO clickea directo: " +
        "devuelve el Set-of-Marks y candidatos visuales para que el agente decida con un segundo turno.",
    }),
  ),
  verify: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("screenshot"), Type.Literal("uia"), Type.Literal("none")],
      { default: "auto" },
    ),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Resolve + devolver candidatos SIN clickear. Bueno para preview por voz.",
    }),
  ),
});

const TypeParams = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Etiqueta del campo donde escribir: 'campo de búsqueda', 'caja de mensaje'.",
  }),
  text: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "Texto Unicode a escribir DESPUÉS de hacer focus al campo.",
  }),
  controlType: Type.Optional(Type.String({ maxLength: 40, default: "Edit" })),
  processName: Type.Optional(Type.String({ maxLength: 80 })),
  minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.5 })),
  candidateIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
  pressEnter: Type.Optional(
    Type.Boolean({ default: false, description: "Si true, manda ENTER al final (submit del campo)." }),
  ),
  verify: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("screenshot"), Type.Literal("uia"), Type.Literal("none")],
      { default: "auto" },
    ),
  ),
  dryRun: Type.Optional(Type.Boolean({ default: false })),
});

export function createSmartClickTool(deps: SmartClickDeps): AnyAgentTool {
  return {
    name: "lumina_smart_click",
    label: "Lumina Smart Click",
    description:
      "Clickea un elemento por NOMBRE (NL), no por coordenadas a ciegas. Internamente: resuelve via " +
      "UI Automation tree → opcionalmente OmniParser → dispatch via Bridge → verifica el efecto. " +
      "USA ESTE en lugar de lumina_input_control cuando sabes QUÉ clickear pero no DÓNDE está en " +
      "pixels. Devuelve { ok, dispatched, picked, alternatives, verification }. Si dryRun=true " +
      "no clickea, solo devuelve candidatos.",
    parameters: ClickParams,
    async execute(_id, raw) {
      const params = raw as {
        query: string;
        controlType?: string;
        processName?: string;
        button?: "left" | "right" | "middle";
        clicks?: number;
        minScore?: number;
        candidateIndex?: number;
        maxMatches?: number;
        allowVision?: boolean;
        verify?: "auto" | "screenshot" | "uia" | "none";
        dryRun?: boolean;
      };
      const query = params.query?.trim();
      if (!query) throw new ToolInputError("query is required");

      const minScore = typeof params.minScore === "number" ? params.minScore : 0.5;
      const maxMatches = typeof params.maxMatches === "number" ? params.maxMatches : 5;
      const button = params.button ?? "left";
      const clicks = typeof params.clicks === "number" ? params.clicks : 1;
      const verifyKind = params.verify ?? "auto";
      const dryRun = params.dryRun === true;

      const resolved = await resolveUia({
        query,
        controlType: params.controlType,
        maxMatches,
      });
      if (!resolved) {
        return jsonResult({
          ok: false,
          dispatched: false,
          strategy: "none",
          error: "uia_sidecar_failed",
          hint:
            "El sidecar UIA no respondió. Verifica Python y `pip install uiautomation`. " +
            "Como fallback puedes usar lumina_screen_capture + lumina_vision_parse con allowVision=true.",
        });
      }

      const filtered = filterByProcess(resolved.matches ?? [], params.processName, resolved.process);
      if (params.processName && filtered.length === 0) {
        return jsonResult({
          ok: false,
          dispatched: false,
          strategy: "uia",
          error: "process_mismatch",
          actualProcess: resolved.process?.name ?? null,
          expectedProcess: params.processName,
          hint:
            "La ventana foreground NO es la esperada. Trae al frente la app correcta (lumina_window_control focus) " +
            "y vuelve a llamar smart_click.",
        });
      }

      const pickResult = pickBest(filtered, minScore, params.candidateIndex);
      const picked = pickResult.picked;

      if (!picked) {
        if (params.allowVision) {
          return jsonResult({
            ok: false,
            dispatched: false,
            strategy: "uia",
            uiaMatchCount: filtered.length,
            topUiaScore: filtered[0]?.score ?? 0,
            visionFallbackRecommended: true,
            hint:
              "UIA no encontró match con confianza suficiente. Llama lumina_screen_capture y luego " +
              "lumina_vision_parse({ imagePath, setOfMarks: true }) para decidir por números (Set-of-Marks). " +
              "Después vuelve a smart_click con candidateIndex o usa lumina_input_control con las " +
              "coordenadas elegidas.",
            alternatives: filtered.slice(0, 3),
          });
        }
        return jsonResult({
          ok: false,
          dispatched: false,
          strategy: "uia",
          uiaMatchCount: filtered.length,
          topUiaScore: filtered[0]?.score ?? 0,
          error: "no_confident_match",
          hint:
            `UIA encontró ${filtered.length} matches pero ninguno supera minScore=${minScore}. ` +
            "Refina el query, añade processName, sube maxMatches o pasa allowVision=true.",
          alternatives: filtered.slice(0, 3),
        });
      }

      const alternatives = filtered.slice(0, 4).filter((m) => m !== picked).slice(0, 3);

      if (dryRun) {
        return jsonResult({
          ok: true,
          dispatched: false,
          dryRun: true,
          strategy: "uia",
          process: resolved.process,
          picked,
          pickReason: pickResult.reason ? PICK_REASON_LABELS[pickResult.reason] : null,
          alternatives,
        });
      }

      const center = picked.center!;
      const preScreenshot = verifyKind === "uia" || verifyKind === "none"
        ? null
        : await captureScreenshot(deps);

      const dispatch = await dispatchClick(deps, {
        x: center.x,
        y: center.y,
        button,
        clicks,
      });

      if (!dispatch.ok) {
        return jsonResult({
          ok: false,
          dispatched: false,
          strategy: "uia",
          picked,
          alternatives,
          error: dispatch.error ?? "dispatch_failed",
          processName: dispatch.processName,
        });
      }

      // Give the OS a beat to repaint before we re-snapshot.
      await new Promise((r) => setTimeout(r, 180));

      let postScreenshot: string | null = null;
      let postUiaNodes: ReadonlyArray<LiveUiaNode> | null = null;
      if (verifyKind === "screenshot") {
        postScreenshot = await captureScreenshot(deps);
      } else if (verifyKind === "uia") {
        postUiaNodes = await fetchLiveUiaTree();
      } else if (verifyKind === "auto") {
        postScreenshot = await captureScreenshot(deps);
        // Only spend a UIA tree fetch when screenshots can't carry the verification.
        if (!postScreenshot || !preScreenshot) {
          postUiaNodes = await fetchLiveUiaTree();
        }
      }

      const postLive: LiveContext = {
        screenshotPath: postScreenshot,
        uiaNodes: postUiaNodes,
        windows: [],
      };
      const verification = await runVerification({
        pickedMatch: picked,
        preScreenshotPath: preScreenshot,
        postLive,
        policyKind: verifyKind,
      });

      return jsonResult({
        ok: verification.ok,
        dispatched: true,
        strategy: "uia",
        process: resolved.process,
        picked,
        pickReason: pickResult.reason ? PICK_REASON_LABELS[pickResult.reason] : null,
        alternatives,
        verification,
        hint:
          verification.ok
            ? undefined
            : "El click se envió pero la verificación no confirma cambio en pantalla. " +
              "El elemento podría estar oculto, deshabilitado o fuera de foco. Re-snapshot con " +
              "lumina_vision_ui_tree para decidir el siguiente paso.",
      });
    },
  };
}

export function createSmartTypeTool(deps: SmartClickDeps): AnyAgentTool {
  return {
    name: "lumina_smart_type",
    label: "Lumina Smart Type",
    description:
      "Hace focus a un campo de texto por NOMBRE y escribe el texto dado. Internamente: resuelve " +
      "via UIA → click en el centro del campo → type_text → opcionalmente ENTER → verifica. " +
      "USA ESTE en lugar de lumina_input_control type_text cuando no sabes si el foco está donde toca. " +
      "controlType default 'Edit' para apuntar a inputs.",
    parameters: TypeParams,
    async execute(_id, raw) {
      const params = raw as {
        query: string;
        text: string;
        controlType?: string;
        processName?: string;
        minScore?: number;
        candidateIndex?: number;
        pressEnter?: boolean;
        verify?: "auto" | "screenshot" | "uia" | "none";
        dryRun?: boolean;
      };
      const query = params.query?.trim();
      if (!query) throw new ToolInputError("query is required");
      const text = params.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new ToolInputError("text is required");
      }

      const minScore = typeof params.minScore === "number" ? params.minScore : 0.5;
      const verifyKind = params.verify ?? "auto";
      const dryRun = params.dryRun === true;

      const resolved = await resolveUia({
        query,
        controlType: params.controlType ?? "Edit",
        maxMatches: 5,
      });
      if (!resolved) {
        return jsonResult({
          ok: false,
          dispatched: false,
          error: "uia_sidecar_failed",
        });
      }
      const filtered = filterByProcess(resolved.matches ?? [], params.processName, resolved.process);
      const pickResult = pickBest(filtered, minScore, params.candidateIndex);
      const picked = pickResult.picked;
      if (!picked) {
        return jsonResult({
          ok: false,
          dispatched: false,
          uiaMatchCount: filtered.length,
          topUiaScore: filtered[0]?.score ?? 0,
          error: "no_confident_field",
          alternatives: filtered.slice(0, 3),
          hint:
            "No encontré un campo claro. Considera controlType='Edit' o pasa el processName de la app.",
        });
      }
      if (dryRun) {
        return jsonResult({
          ok: true,
          dispatched: false,
          dryRun: true,
          picked,
          alternatives: filtered.slice(0, 4).filter((m) => m !== picked).slice(0, 3),
        });
      }
      const center = picked.center!;

      const preScreenshot = verifyKind === "uia" || verifyKind === "none"
        ? null
        : await captureScreenshot(deps);

      const focus = await dispatchClick(deps, {
        x: center.x,
        y: center.y,
        button: "left",
        clicks: 1,
      });
      if (!focus.ok) {
        return jsonResult({
          ok: false,
          dispatched: false,
          picked,
          error: focus.error ?? "focus_click_failed",
        });
      }
      await new Promise((r) => setTimeout(r, 120));

      const typed = await dispatchType(deps, text);
      if (!typed.ok) {
        return jsonResult({
          ok: false,
          dispatched: true,
          stage: "type_text",
          picked,
          error: typed.error ?? "type_failed",
        });
      }

      if (params.pressEnter) {
        const f = getFetch(deps);
        if (f) {
          const base = deps.bridgeUrl.replace(/\/+$/, "");
          try {
            await f(`${base}/input_control`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "key_press",
                keys: ["ENTER"],
                wait_ms: 100,
                allowedApps: deps.allowedApps,
              }),
            });
          } catch {
            /* best-effort */
          }
        }
      }

      await new Promise((r) => setTimeout(r, 200));
      let postScreenshot: string | null = null;
      let postUiaNodes: ReadonlyArray<LiveUiaNode> | null = null;
      if (verifyKind === "screenshot") {
        postScreenshot = await captureScreenshot(deps);
      } else if (verifyKind === "uia") {
        postUiaNodes = await fetchLiveUiaTree();
      } else if (verifyKind === "auto") {
        postScreenshot = await captureScreenshot(deps);
        if (!postScreenshot || !preScreenshot) {
          postUiaNodes = await fetchLiveUiaTree();
        }
      }
      const postLive: LiveContext = {
        screenshotPath: postScreenshot,
        uiaNodes: postUiaNodes,
        windows: [],
      };
      const verification = await runVerification({
        pickedMatch: picked,
        preScreenshotPath: preScreenshot,
        postLive,
        policyKind: verifyKind,
      });
      return jsonResult({
        ok: verification.ok,
        dispatched: true,
        picked,
        pressedEnter: params.pressEnter === true,
        verification,
      });
    },
  };
}
