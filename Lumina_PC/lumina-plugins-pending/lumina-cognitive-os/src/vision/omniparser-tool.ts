/**
 * omniparser-tool.ts — Tool: lumina_vision_parse
 *
 * Runs the OmniParser sidecar over a screenshot and returns a list of
 * detected UI elements with bounding boxes, semantic labels and
 * interactivity hints. Used as a FALLBACK when lumina_vision_ui_resolve
 * (UIA tree) doesn't find a match — typical for Electron apps,
 * canvas-based UIs, games.
 *
 * Includes a `setOfMarks: true` option that returns the SoM-formatted
 * description directly, ready to inject into an LLM prompt for
 * vision-grounded actions.
 *
 * NOTE: the sidecar is OPT-IN. If the model weights aren't installed,
 * the tool returns ok=false with hint to run install-omniparser.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";
import { buildSetOfMarks, type DetectedElement } from "./set-of-marks.js";

type SidecarResponse = {
  ok: boolean;
  device?: string;
  durationMs?: number;
  elements?: DetectedElement[];
  iconCount?: number;
  textCount?: number;
  meta?: Record<string, unknown>;
  error?: string;
  hint?: string;
};

export function createOmniParserTool(): AnyAgentTool {
  return {
    name: "lumina_vision_parse",
    label: "Lumina Vision — Parse (OmniParser)",
    description:
      "Runs Microsoft OmniParser over a screenshot (PNG path or via lumina_screen_capture) and returns " +
      "detected UI elements: icons, buttons, text regions with bounding boxes, centers and confidences. " +
      "Use as a FALLBACK when lumina_vision_ui_resolve (UIA) returns no match — typical for Electron, " +
      "canvas, or games. Set `setOfMarks: true` to also get a numbered text description ready to inject " +
      "into an LLM prompt for 'which numbered element should I click?' queries.",
    parameters: Type.Object({
      imagePath: Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "Absolute path to a PNG/JPEG screenshot to parse.",
      }),
      device: Type.Optional(
        Type.Union([Type.Literal("cuda"), Type.Literal("cpu")], {
          description: "Override the device. Default auto-detects CUDA.",
        }),
      ),
      includeOcr: Type.Optional(
        Type.Boolean({ default: true, description: "Run the OCR pass for text regions. Disable for speed." }),
      ),
      maxElements: Type.Optional(
        Type.Number({ minimum: 5, maximum: 300, default: 60 }),
      ),
      setOfMarks: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Also return a numbered description + index suitable for LLM Set-of-Marks grounding.",
        }),
      ),
      minConfidence: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, default: 0 }),
      ),
    }),
    async execute(_id, p) {
      const imagePath = p.imagePath?.trim();
      if (!imagePath) throw new ToolInputError("imagePath is required");

      const args: string[] = ["--image", imagePath];
      if (typeof p.device === "string") args.push("--device", p.device);
      if (!p.includeOcr) args.push("--no-ocr");
      if (typeof p.maxElements === "number") args.push("--max-elements", String(p.maxElements));

      const r = await runPythonSidecarJson<SidecarResponse>("omniparser", args, { timeoutMs: 90_000 });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          refused: "sidecar",
          error: r.error,
          hint:
            "OmniParser is opt-in. Install with: " +
            "`python -m pip install -r Lumina_PC/Open_PC/extensions/lumina-cognitive-os/sidecars/requirements-omniparser.txt` " +
            "then `python Lumina_PC/Open_PC/extensions/lumina-cognitive-os/sidecars/omniparser.py --download` " +
            "or run the helper script `scripts/install-omniparser.ps1`.",
        });
      }
      const data = r.data;
      if (!data?.ok) {
        return jsonResult({
          ok: false,
          refused: "sidecar",
          error: data?.error ?? "unknown sidecar error",
          hint: data?.hint,
        });
      }
      const elements = (data.elements ?? []).filter((e) => {
        if (typeof p.minConfidence === "number" && typeof e.confidence === "number") {
          return e.confidence >= p.minConfidence;
        }
        return true;
      });

      const payload: Record<string, unknown> = {
        ok: true,
        device: data.device,
        durationMs: data.durationMs,
        iconCount: data.iconCount,
        textCount: data.textCount,
        elementCount: elements.length,
        elements,
      };

      if (p.setOfMarks) {
        const marks = buildSetOfMarks(elements, {
          maxElements: p.maxElements ?? 30,
          minConfidence: p.minConfidence,
        });
        payload.setOfMarks = {
          description: marks.description,
          count: marks.count,
        };
      }
      return jsonResult(payload);
    },
  };
}

/** Healthcheck — TS-side wrapper around `--health`. Optional convenience. */
export function createOmniParserHealthTool(): AnyAgentTool {
  return {
    name: "lumina_vision_parse_health",
    label: "Lumina Vision — Parse Health",
    description:
      "Returns whether OmniParser is ready on this machine: model weights present, torch installed, " +
      "device available. Useful for the install onboarding.",
    parameters: Type.Object({}),
    async execute() {
      const r = await runPythonSidecarJson<{
        ok: boolean; ready: boolean; device: string; modelDir: string;
        haveYoloWeights: boolean; haveFlorenceLocal: boolean; haveTorch: boolean;
      }>("omniparser", ["--health"], { timeoutMs: 10_000 });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          ready: false,
          error: r.error,
          hint: "Run scripts/install-omniparser.ps1 or follow sidecars/README.md.",
        });
      }
      return jsonResult({ ok: true, ...r.data });
    },
  };
}
