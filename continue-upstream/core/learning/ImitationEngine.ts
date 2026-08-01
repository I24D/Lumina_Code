import { LearnedPattern, RecordedAction } from "./types.js";

export class ImitationEngine {
  replayPlan(pattern: LearnedPattern): Array<Pick<RecordedAction, "type" | "target" | "value" | "app">> {
    return pattern.actions.map((action) => ({
      type: action.type,
      target: action.target,
      value: action.value,
      app: action.app,
    }));
  }
}
