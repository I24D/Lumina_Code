import type { ObservationChange, ObservationSnapshot } from "../types.js";

export const OBSERVATION_PRESENCE_STREAM = "lumina-observation.presence";
export const OBSERVATION_PRESENCE_RUN_ID = "lumina-observation-desktop";

export type ObservationPresenceEnvelope = {
  readonly schemaVersion: 1;
  readonly source: "lumina-observation";
  readonly capturedAtISO: string;
  readonly changes: ObservationChange[];
};

export function buildObservationPresenceEnvelope(
  snapshot: ObservationSnapshot,
  changes: ReadonlyArray<ObservationChange>,
): ObservationPresenceEnvelope {
  return {
    schemaVersion: 1,
    source: "lumina-observation",
    capturedAtISO: snapshot.capturedAtISO,
    changes: [...changes],
  };
}
