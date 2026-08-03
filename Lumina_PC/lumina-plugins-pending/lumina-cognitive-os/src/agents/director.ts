/**
 * director.ts — Intent → SpecialisedAgent router.
 *
 * Pure scoring function: tokenises the utterance, counts keyword hits per
 * agent, normalises by keyword-list length, and returns the top K. Ties
 * are broken by a fixed agent priority (system > security > ...).
 *
 * The Director NEVER calls a tool itself. It returns a structured
 * suggestion that the main agent uses to set its persona, focus its
 * tool selection and seed its system prompt.
 */
import { SPECIALISED_AGENTS, type SpecialisedAgent, type SpecialisedAgentId } from "./catalog.js";

const PRIORITY_ORDER: ReadonlyArray<SpecialisedAgentId> = [
  "security-agent",
  "system-agent",
  "voice-agent",
  "vision-agent",
  "browser-agent",
  "email-agent",
  "calendar-agent",
  "file-agent",
  "coding-agent",
  "automation-agent",
  "desktop-agent",
  "research-agent",
];

function priority(id: SpecialisedAgentId): number {
  const idx = PRIORITY_ORDER.indexOf(id);
  return idx === -1 ? PRIORITY_ORDER.length : idx;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export type RouteCandidate = {
  readonly agent: SpecialisedAgent;
  readonly score: number;
  readonly hits: ReadonlyArray<string>;
};

export type RouteResult = {
  readonly intent: string;
  readonly top: RouteCandidate | null;
  readonly candidates: ReadonlyArray<RouteCandidate>;
  readonly ambiguous: boolean;
};

export function routeIntent(intent: string, topK = 3): RouteResult {
  const tokens = new Set(tokenize(intent));
  if (tokens.size === 0) {
    return { intent, top: null, candidates: [], ambiguous: false };
  }
  const ranked: RouteCandidate[] = [];
  for (const agent of SPECIALISED_AGENTS) {
    const hits: string[] = [];
    for (const kw of agent.keywords) {
      const kwTokens = tokenize(kw);
      const all = kwTokens.every((t) => tokens.has(t));
      if (all) hits.push(kw);
    }
    if (hits.length === 0) continue;
    const score = hits.length / Math.max(1, agent.keywords.length);
    ranked.push({ agent, score, hits });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return priority(a.agent.id) - priority(b.agent.id);
  });
  const cap = ranked.slice(0, Math.max(1, Math.min(topK, ranked.length)));
  const ambiguous = cap.length >= 2 && Math.abs(cap[0]!.score - cap[1]!.score) < 0.05;
  return {
    intent,
    top: cap[0] ?? null,
    candidates: cap,
    ambiguous,
  };
}
