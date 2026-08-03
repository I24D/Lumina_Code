/**
 * Router — clasifica un transcript de voz hacia uno de los tres destinos.
 *
 * Phase 1 (esta versión): keyword matching ES/EN. Determinístico, sin LLM.
 *
 * Phase 2 (futuro): el caller puede inyectar un classifier LLM-backed
 * (ej. Ollama local) implementando `RouterClassifier` y pasándolo a
 * `createRouter()`. El contrato es estable.
 *
 * Reglas de prioridad:
 *   1. Si hay `forceTarget` o `hint`, gana.
 *   2. Patterns explícitos de Claude Code (palabras de código, ruta de archivo,
 *      verbos como "refactor/test/debug").
 *   3. Patterns de Cowork (poco probables pero documentados).
 *   4. Fallback a chat-app (la voz casual del user va a Claude App).
 */
import type { ClaudeTarget, DispatchInput, RouteDecision } from "./types.js";

const CODE_KEYWORDS_EN = [
  "code", "refactor", "debug", "fix bug", "implement", "function", "class",
  "test", "unit test", "commit", "pull request", "pr ", "branch",
  "typescript", "javascript", "python", "rust", "go ", "java ", "compile",
  "build", "deploy", "lint", "import", "export ", "type ", "interface",
];
const CODE_KEYWORDS_ES = [
  "código", "codigo", "refactoriza", "depura", "implementa", "función", "funcion",
  "clase", "test", "prueba unitaria", "commit", "rama", "compila", "compilar",
  "build", "deploy", "tipo ", "interfaz",
];
const CODE_PATH_PATTERNS = [
  /\b[a-z]:[\\/][\w\\/.\-]+\.\w+\b/i, // C:\path\to\file.ts
  /[\w/]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|c|h|md|json|yaml|yml)\b/i,
  /\bsrc\/[\w/.-]+/,
];

const COWORK_KEYWORDS = [
  "cowork", "co-work", "colaboración con cowork", "anthropic cowork",
];

export interface RouterClassifier {
  classify(input: DispatchInput): Promise<RouteDecision>;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function matchesAny(text: string, keywords: ReadonlyArray<string>): string | null {
  const normalized = normalize(text);
  for (const kw of keywords) {
    const nkw = normalize(kw);
    if (normalized.includes(nkw)) return kw;
  }
  return null;
}

function matchesAnyRe(text: string, patterns: ReadonlyArray<RegExp>): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function createKeywordRouter(): RouterClassifier {
  return {
    async classify(input: DispatchInput): Promise<RouteDecision> {
      const t = input.transcript.trim();

      // 1. forceTarget gana
      if (input.forceTarget) {
        return {
          target: input.forceTarget,
          payload: t,
          attachments: input.attachments,
          reasoning: "forceTarget override del caller",
          confidence: 1,
        };
      }

      // 1b. hint del usuario
      if (input.hint) {
        const map: Record<typeof input.hint, ClaudeTarget> = {
          chat: "chat-app",
          code: "code-cli",
          cowork: "cowork",
        };
        return {
          target: map[input.hint],
          payload: t,
          attachments: input.attachments,
          reasoning: `hint del usuario: ${input.hint}`,
          confidence: 0.95,
        };
      }

      // 2. Cowork (chequeado primero porque es muy específico)
      const cowork = matchesAny(t, COWORK_KEYWORDS);
      if (cowork) {
        return {
          target: "cowork",
          payload: t,
          attachments: input.attachments,
          reasoning: `palabra clave de Cowork: "${cowork}"`,
          confidence: 0.85,
        };
      }

      // 3. Claude Code CLI — mira keywords + patrones de path
      const codeKw = matchesAny(t, [...CODE_KEYWORDS_EN, ...CODE_KEYWORDS_ES]);
      const codePath = matchesAnyRe(t, CODE_PATH_PATTERNS);
      if (codeKw || codePath) {
        const reasons: string[] = [];
        if (codeKw) reasons.push(`keyword de código: "${codeKw}"`);
        if (codePath) reasons.push(`mención de archivo: "${codePath}"`);
        return {
          target: "code-cli",
          payload: t,
          attachments: input.attachments,
          reasoning: reasons.join(" + "),
          confidence: codeKw && codePath ? 0.9 : 0.7,
        };
      }

      // 4. Default → chat-app
      return {
        target: "chat-app",
        payload: t,
        attachments: input.attachments,
        reasoning: "no se detectaron señales de código ni cowork; default chat-app",
        confidence: 0.5,
      };
    },
  };
}
