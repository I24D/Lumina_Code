/**
 * skill-auto-heal.ts — Auto-reparación de skills aprendidas.
 * 
 * Monitorea el éxito/fracaso de skills aprendidas (learned-*) y cuando detecta
 * fallos consecutivos, notifica al usuario sugiriendo una re-grabación.
 * 
 * Integrado con el sistema de Skill Health Tracker existente.
 */

import type { SkillEvalStore } from '../memory/skill-eval-store.js';
import type { NotificationSender } from '../shared/types.js';

export type SkillHealthStatus = 'healthy' | 'degraded' | 'failing';

export type SkillHealParams = {
  readonly skillId: string;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: string;
  readonly failureRate: number;
};

export type HealSuggestion = {
  readonly skillId: string;
  readonly status: SkillHealthStatus;
  readonly suggestion: string;
  readonly autoRetry: boolean;
  readonly needsReRecord: boolean;
};

/**
 * Umbral para considerar una skill como "degradada".
 * Si falla más del 40% de las veces en las últimas 10 ejecuciones.
 */
const DEGRADED_THRESHOLD = 0.4;

/**
 * Umbral para considerar una skill como "fallando".
 * Si tiene 3 o más fallos consecutivos.
 */
const FAILING_CONSECUTIVE_THRESHOLD = 3;

/**
 * Evalúa la salud de una skill aprendida y genera una sugerencia de reparación.
 */
export async function evaluateSkillHealth(
  skillId: string,
  evalStore: SkillEvalStore,
): Promise<HealSuggestion | null> {
  if (!skillId.startsWith('learned-')) {
    return null; // Solo aplica a skills aprendidas por demostración
  }

  const recentRuns = await evalStore.getRecentRuns(skillId, 10);
  
  if (recentRuns.length === 0) {
    return null; // Sin datos suficientes
  }

  const failures = recentRuns.filter(r => r.status !== 'success');
  const successes = recentRuns.filter(r => r.status === 'success');
  const failureRate = failures.length / recentRuns.length;
  
  // Calcular fallos consecutivos (desde el más reciente hacia atrás)
  let consecutiveFailures = 0;
  for (let i = recentRuns.length - 1; i >= 0; i--) {
    if (recentRuns[i].status !== 'success') {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const lastSuccess = successes.length > 0 
    ? successes[successes.length - 1].timestamp 
    : undefined;

  // Determinar estado
  let status: SkillHealthStatus = 'healthy';
  let needsReRecord = false;
  let autoRetry = false;

  if (consecutiveFailures >= FAILING_CONSECUTIVE_THRESHOLD) {
    status = 'failing';
    needsReRecord = true;
  } else if (failureRate >= DEGRADED_THRESHOLD) {
    status = 'degraded';
    autoRetry = true; // Intentar con estrategia alternativa
  }

  if (status === 'healthy') {
    return null; // No necesita acción
  }

  // Generar sugerencia
  const suggestion = generateSuggestion(skillId, status, failureRate, consecutiveFailures, lastSuccess);

  return {
    skillId,
    status,
    suggestion,
    autoRetry,
    needsReRecord,
  };
}

function generateSuggestion(
  skillId: string,
  status: SkillHealthStatus,
  failureRate: number,
  consecutiveFailures: number,
  lastSuccessAt?: string,
): string {
  const skillName = skillId.replace('learned-', '');
  
  if (status === 'failing') {
    return `⚠️ La skill "${skillName}" ha fallado ${consecutiveFailures} veces seguidas. ` +
           `Último éxito: ${lastSuccessAt ? new Date(lastSuccessAt).toLocaleString() : 'Nunca'}. ` +
           `Se recomienda RE-GRABAR la demostración para actualizar los anclajes visuales.`;
  }
  
  if (status === 'degraded') {
    return `⚡ La skill "${skillName}" tiene una tasa de fallo del ${(failureRate * 100).toFixed(0)}%. ` +
           `Puede deberse a cambios en la UI de la aplicación. ` +
           `Se intentará usar estrategia alternativa (UIA → Vision → Híbrida). ` +
           `Si persiste, considera re-grabar.`;
  }
  
  return '';
}

/**
 * Notifica al usuario sobre problemas de salud en skills aprendidas.
 * Se integra con el sistema de notificaciones Toast de Windows.
 */
export async function notifySkillHealthIssue(
  heal: HealSuggestion,
  notify: NotificationSender,
): Promise<void> {
  const title = heal.status === 'failing' ? '🔴 Skill Fallando' : '🟡 Skill Degradada';
  
  notify({
    title,
    message: heal.suggestion,
    app_id: 'Lumina · Auto-Heal',
  });
}

/**
 * Hook para integrar en el loop del PC Operator.
 * Se llama después de cada ejecución de una acción learned-*.
 */
export async function onLearnedSkillActionComplete(params: {
  readonly skillName: string;
  readonly ok: boolean;
  readonly verified?: boolean | null;
  readonly runId: string;
  readonly iteration: number;
}, deps: {
  readonly evalStore: SkillEvalStore;
  readonly notifyToast?: NotificationSender;
}): Promise<void> {
  const skillId = `learned-${params.skillName}`;
  
  // Registrar el resultado en el store de evaluación
  await deps.evalStore.appendRun({
    skillId,
    runId: params.runId,
    status: params.ok && params.verified !== false ? 'success' : 'failed',
    stepCount: params.iteration,
    dispatched: params.ok ? 1 : 0,
    failed: params.ok ? 0 : 1,
    verifyFailed: params.verified === false ? 1 : 0,
    avgLatencyMs: 0, // Se puede calcular si se pasa el tiempo
    strategy: 'hybrid',
    mode: 'production',
  });

  // Evaluar salud y notificar si hay problema
  const heal = await evaluateSkillHealth(skillId, deps.evalStore);
  
  if (heal && deps.notifyToast) {
    await notifySkillHealthIssue(heal, deps.notifyToast);
  }
}
