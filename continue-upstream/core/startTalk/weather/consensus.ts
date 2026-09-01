/**
 * Consenso entre dos fuentes independientes.
 *
 * Esto es lo que separa a un asistente honesto de uno que suena seguro por
 * accidente. Dos modelos meteorológicos distintos discrepan a menudo; cuando lo
 * hacen, decir "29 grados" es inventarse una precisión que no existe.
 *
 * La precipitación se trata de forma ASIMÉTRICA a propósito: si cualquiera de
 * las dos anuncia agua, se menciona. Equivocarse hacia "llévate paraguas" es
 * barato; equivocarse al revés deja a alguien empapado.
 */
import { isWetClass } from "./conditions.js";
import type {
  WeatherConfidence,
  WeatherObservation,
} from "./types.js";

/** Hasta aquí las fuentes están de acuerdo y se dice un solo número. */
export const AGREEMENT_C = 1.5;
/** Entre AGREEMENT_C y esto se da un rango en vez de un número. */
export const RANGE_C = 3;

export interface ConsensusResult {
  /** La observación que se usará para responder. */
  observation: WeatherObservation;
  confidence: WeatherConfidence;
  /** Cómo nombrar la temperatura en voz alta ("29 grados" / "entre 28 y 30"). */
  temperaturePhrase: string;
  /** Explicación del desacuerdo, solo cuando lo hay. */
  disagreement?: string;
  /** Verdadero si ALGUNA fuente ve agua, aunque la elegida no. */
  wetRisk: boolean;
  sources: WeatherObservation["source"][];
}

function round(value: number): number {
  return Math.round(value);
}

function freshest(a: WeatherObservation, b: WeatherObservation): WeatherObservation {
  const at = Date.parse(a.observedAt);
  const bt = Date.parse(b.observedAt);
  if (!Number.isFinite(at)) return b;
  if (!Number.isFinite(bt)) return a;
  return at >= bt ? a : b;
}

export function reconcileObservations(
  observations: WeatherObservation[],
): ConsensusResult | undefined {
  const valid = observations.filter((entry) => entry && Number.isFinite(entry.temperatureC));
  if (valid.length === 0) {
    return undefined;
  }

  if (valid.length === 1) {
    const only = valid[0];
    return {
      observation: only,
      // Una sola fuente nunca es "alta": no hay nada que la corrobore.
      confidence: "medium",
      temperaturePhrase: `${round(only.temperatureC)} grados`,
      wetRisk: isWetClass(only.conditionClass),
      sources: [only.source],
    };
  }

  // Con más de dos se comparan los dos extremos, que es donde vive el desacuerdo.
  const sorted = [...valid].sort((a, b) => a.temperatureC - b.temperatureC);
  const coldest = sorted[0];
  const warmest = sorted[sorted.length - 1];
  const spread = warmest.temperatureC - coldest.temperatureC;
  const chosen = freshest(coldest, warmest);
  const sources = valid.map((entry) => entry.source);
  const wetRisk = valid.some((entry) => isWetClass(entry.conditionClass));

  const classes = new Set(valid.map((entry) => entry.conditionClass));
  const classesDisagree =
    classes.size > 1 &&
    valid.some((entry) => isWetClass(entry.conditionClass)) &&
    valid.some((entry) => !isWetClass(entry.conditionClass));

  if (spread <= AGREEMENT_C && !classesDisagree) {
    return {
      observation: chosen,
      confidence: "high",
      temperaturePhrase: `${round(chosen.temperatureC)} grados`,
      wetRisk,
      sources,
    };
  }

  if (spread <= RANGE_C && !classesDisagree) {
    const low = round(coldest.temperatureC);
    const high = round(warmest.temperatureC);
    return {
      observation: chosen,
      confidence: "medium",
      temperaturePhrase:
        low === high ? `${low} grados` : `entre ${low} y ${high} grados`,
      wetRisk,
      sources,
    };
  }

  const reasons: string[] = [];
  if (spread > RANGE_C) {
    reasons.push(
      `las fuentes difieren ${spread.toFixed(1)} grados (${round(coldest.temperatureC)} y ${round(warmest.temperatureC)})`,
    );
  }
  if (classesDisagree) {
    reasons.push("no coinciden en si va a caer agua");
  }

  return {
    observation: chosen,
    confidence: "low",
    temperaturePhrase: `alrededor de ${round(chosen.temperatureC)} grados`,
    disagreement: `${reasons.join(" y ")}; se usa la medición más reciente`,
    wetRisk,
    sources,
  };
}
