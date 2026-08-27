import { slugifyName } from "../util/text.js";
import { ReflectionInsight, SkillCandidate } from "./types.js";

export class ConsolidationService {
  consolidate(insights: ReflectionInsight[]): SkillCandidate[] {
    return insights
      .filter((insight) => insight.severity !== "info")
      .map((insight) => {
        const name = slugifyName(
          insight.title,
          "lumina-learned-recovery",
          48,
        );
        return {
          name,
          description: insight.summary,
          sourceInsightIds: [insight.id],
          createdAt: new Date().toISOString(),
          markdown: [
            "---",
            `name: ${name}`,
            `description: ${JSON.stringify(insight.summary)}`,
            "---",
            "",
            "# Learned Recovery",
            "",
            insight.summary,
            "",
            "## Operating Rule",
            "",
            "- Verify observable state before reporting success.",
            "- If the same failure appears again, stop and report the blocker with evidence.",
            "- Prefer the proven tools and windows from the source experiences.",
            "",
          ].join("\n"),
        };
      });
  }
}
