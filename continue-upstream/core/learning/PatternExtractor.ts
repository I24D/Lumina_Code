import { LearnedPattern, RecordedAction } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class PatternExtractor {
  extract(actions: RecordedAction[], minimumLength = 3): LearnedPattern[] {
    if (actions.length < minimumLength) {
      return [];
    }

    const signature = actions
      .slice(-minimumLength)
      .map((action) => `${action.app ?? "app"}:${action.type}:${action.target ?? action.value ?? "target"}`)
      .join(" -> ");

    return [
      {
        id: createId("pattern"),
        name: signature.slice(0, 80),
        actions: actions.slice(-minimumLength),
        confidence: Math.min(0.95, 0.5 + minimumLength * 0.1),
        createdAt: new Date().toISOString(),
      },
    ];
  }
}
