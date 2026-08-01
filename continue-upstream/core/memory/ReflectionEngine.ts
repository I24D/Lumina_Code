import { ExperienceRecord, ReflectionInsight } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ReflectionEngine {
  reflect(records: ExperienceRecord[]): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    const recent = records.slice(-10);
    const failures = recent.filter((record) => record.outcome === "failure");

    if (failures.length >= 2) {
      insights.push({
        id: createId("insight"),
        title: "Repeated task failures detected",
        summary: `Lumina saw ${failures.length} failures in the last ${recent.length} experiences. Prefer verification before reporting success and create a reusable recovery path.`,
        severity: failures.some((record) => record.tags.includes("critical")) ? "critical" : "warning",
        tags: [...new Set(failures.flatMap((record) => record.tags))],
        sourceExperienceIds: failures.map((record) => record.id),
        createdAt: new Date().toISOString(),
      });
    }

    const successfulTools = recent
      .filter((record) => record.outcome === "success")
      .flatMap((record) => record.toolNames);
    const toolCounts = new Map<string, number>();
    for (const tool of successfulTools) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }

    for (const [tool, count] of toolCounts) {
      if (count >= 3) {
        insights.push({
          id: createId("insight"),
          title: `Reliable tool pattern: ${tool}`,
          summary: `${tool} succeeded ${count} times recently. Consider promoting this sequence into a Lumina skill when the surrounding steps repeat.`,
          severity: "info",
          tags: ["tool-pattern", tool.toLowerCase()],
          sourceExperienceIds: recent
            .filter((record) => record.toolNames.includes(tool))
            .map((record) => record.id),
          createdAt: new Date().toISOString(),
        });
      }
    }

    return insights;
  }
}
