import type { StartTalkCoreEvent } from "core/startTalk";

export interface SpeakerInfo {
  turnId: number;
  identityId?: string;
  name?: string;
  score?: number;
  matched: boolean;
}

type SpeakerEvent = Extract<StartTalkCoreEvent, { type: "speaker" }>;

/**
 * Applies an asynchronous biometric result only when it belongs to the newest
 * user turn seen by the UI. A slow response for turn N must never overwrite
 * the identity already shown for turn N+1.
 */
export function resolveSpeakerUpdate(
  latestTurnId: number,
  event: SpeakerEvent,
): { latestTurnId: number; speaker: SpeakerInfo } | undefined {
  if (event.turnId < latestTurnId) {
    return undefined;
  }
  return {
    latestTurnId: event.turnId,
    speaker: {
      turnId: event.turnId,
      identityId: event.identityId,
      name: event.name,
      score: event.score,
      matched: event.matched,
    },
  };
}
