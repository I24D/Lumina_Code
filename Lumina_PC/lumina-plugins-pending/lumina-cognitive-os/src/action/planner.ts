/**
 * planner.ts — Action Planner.
 *
 * Takes a voice instruction like "abre Chrome, ve a youtube.com, busca
 * 'cumbias 2026' y reproduce el primero" and decomposes it into an
 * ordered list of tool calls each with the right risk classification.
 *
 * Phase 1 (this file): a deterministic plan validator + executor with
 * abort-on-failure semantics. The LLM produces the plan via the
 * lumina_action_plan tool; here we only validate and record it. The
 * actual execution loop is owned by the agent so existing tool semantics
 * (cancellation, audit, approval) are preserved.
 */

export type PlanStep = {
  readonly id: string;
  readonly toolName: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Human-readable description shown on the Transparency panel. */
  readonly description: string;
  /** Pre-classified risk so the user knows what's coming. */
  readonly risk?: "SAFE" | "WARNING" | "HIGH_RISK" | "CRITICAL";
};

export type ActionPlan = {
  readonly id: string;
  readonly goal: string;
  readonly steps: ReadonlyArray<PlanStep>;
  readonly createdAtISO: string;
  readonly stopOnError: boolean;
};

export type PlanValidation =
  | { readonly ok: true; readonly plan: ActionPlan }
  | { readonly ok: false; readonly error: string };

/** Tool names we know about and trust to appear in plans. Keep this in
 *  sync with the contracts of every Lumina extension. */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  // lumina-pc
  "lumina_screen_capture",
  "lumina_clipboard",
  "lumina_window_control",
  "lumina_process_list",
  "lumina_system_metrics",
  "lumina_shell_run",
  "lumina_file_ops",
  "lumina_code",
  "lumina_notify_toast",
  "lumina_input_control",
  // lumina-input-control
  "lumina_input_focus_window",
  "lumina_input_type",
  "lumina_input_hotkey",
  "lumina_input_mouse_click",
  // lumina-observation
  "lumina_observation_snapshot",
  "lumina_narration_recent",
  // lumina-memory
  "lumina_memory_recall",
  "lumina_memory_remember",
  "lumina_memory_profile_read",
  "lumina_memory_profile_update",
  // lumina-presence
  "lumina_presence_status",
  // lumina-cognitive-os
  "lumina_risk_evaluate",
  "lumina_risk_recent",
  "lumina_awareness_snapshot",
  "lumina_awareness_subscribe",
  "lumina_windows_context",
  "lumina_phone_link_status",
  "lumina_phone_link_reply",
  "lumina_harness_health",
  "lumina_harness_task",
  "lumina_kill_switch",
  "lumina_working_memory_get",
  "lumina_working_memory_set",
  "lumina_episodic_remember",
  "lumina_episodic_recall",
  "lumina_vision_ui_tree",
  "lumina_vision_ui_resolve",
  "lumina_vision_multimonitor",
  "lumina_workflow_list",
  "lumina_workflow_run",
  "lumina_working_memory_recall",
  "lumina_working_memory_log",
  "lumina_skill_list",
  "lumina_skill_describe",
  "lumina_skill_read_asset",
  "lumina_skill_run",
  "lumina_code_execute",
  "lumina_operative_status",
  "lumina_operative_enable",
  "lumina_operative_disable",
  "lumina_operative_reload",
  "lumina_operative_recent",
  "lumina_codeact_start",
  "lumina_codeact_step",
  "lumina_codeact_status",
  "lumina_codeact_end",
  // LfD + Vision (2026-06-28)
  "lumina_vision_parse",
  "lumina_vision_parse_health",
  "lumina_recorder_start",
  "lumina_recorder_stop",
  "lumina_recorder_pause",
  "lumina_recorder_resume",
  "lumina_recorder_status",
  "lumina_recorder_list",
  "lumina_recorder_get",
  "lumina_recorder_delete",
  "lumina_replay_run",
  "lumina_replay_status",
  "lumina_replay_list",
  "lumina_replay_abort",
  "lumina_replay_strategies",
  "lumina_recording_to_skill",
  "lumina_skill_eval",
  "lumina_skill_eval_record",
  "lumina_browser_drive",
  "lumina_browser_natural",
  "lumina_browser_screencast",
  "lumina_browser_session",
  "lumina_action_plan",
  "lumina_director_route",
  "lumina_intent_run",
  "lumina_gmail",
  "lumina_calendar",
  "lumina_drive",
  "lumina_boot_greeting",
  "lumina_wake_word",
  // lumina-pc — alarms (2026-07-03)
  "lumina_alarm",
  // lumina-claude-bridge — Phase 7 delegation (2026-07-03)
  "lumina_claude_dispatch",
  "lumina_claude_app_send_prompt",
  "lumina_claude_app_status",
  // App control (2026-07-03) — Start Menu / Get-StartApps launch/close/list
  "lumina_app_launch",
  "lumina_app_close",
  "lumina_app_list",
  "lumina_adapter_resolve",
  "lumina_audio",
  "lumina_office",
  "lumina_registry",
  "lumina_governance_evaluate",
  "lumina_governance_policy",
  "lumina_memory_status",
  "lumina_memory_search",
  "lumina_warehouse_catalog",
  "lumina_supabase_status",
  "lumina_supabase_schema",
  "lumina_supabase_query",
  "lumina_supabase_mutate",
  "lumina_supabase_memory_remember",
  // Browser smart tools (2026-07-03) — DOM-aware click/type via Playwright sidecar
  "lumina_browser_smart_click",
  "lumina_browser_smart_type",
  "lumina_browser_dom_observe",
  "lumina_browser_dom_screenshot",
  // PC Operator Loop (lumina_pc_do family) — brain-driven multi-step autonomy
  "lumina_pc_do",
  "lumina_pc_do_abort",
  "lumina_pc_do_status",
  "lumina_pc_do_list",
  "lumina_pc_do_cost_summary",
  "lumina_pc_do_skill_health",
  "lumina_pc_do_skill_reset",
  // PC gestures + observation (visual+coord low-level primitives)
  "lumina_pc_drag",
  "lumina_pc_scroll",
  "lumina_pc_observe",
  "lumina_sight",
  "lumina_ui_invoke",
  "lumina_window_classify",
  // Vision-classified smart gestures
  "lumina_smart_click",
  "lumina_smart_type",
  // Continuous Perception sidecar (mss + Pillow)
  "lumina_perception_start",
  "lumina_perception_stop",
  "lumina_perception_pause",
  "lumina_perception_resume",
  "lumina_perception_status",
  "lumina_perception_health",
  "lumina_perception_recent",
  "lumina_perception_tune",
  // Transparency panel — audit stream published to the UI
  "lumina_transparency_publish",
  "lumina_transparency_recent",
]);

export function validatePlan(input: unknown): PlanValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "plan must be an object" };
  }
  const obj = input as Record<string, unknown>;
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  if (!goal) return { ok: false, error: "plan.goal is required" };
  const stepsIn = obj.steps;
  if (!Array.isArray(stepsIn) || stepsIn.length === 0) {
    return { ok: false, error: "plan.steps must be a non-empty array" };
  }
  if (stepsIn.length > 32) {
    return { ok: false, error: "plan.steps cannot exceed 32 entries" };
  }
  const steps: PlanStep[] = [];
  for (let i = 0; i < stepsIn.length; i++) {
    const raw = stepsIn[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `step #${i} is not an object` };
    }
    const s = raw as Record<string, unknown>;
    const toolName = typeof s.toolName === "string" ? s.toolName : "";
    if (!toolName) return { ok: false, error: `step #${i}.toolName missing` };
    if (!KNOWN_TOOLS.has(toolName)) {
      return { ok: false, error: `step #${i} references unknown tool '${toolName}'` };
    }
    const description = typeof s.description === "string" ? s.description.trim() : "";
    if (!description) return { ok: false, error: `step #${i}.description missing` };
    const params =
      s.params && typeof s.params === "object" && !Array.isArray(s.params)
        ? (s.params as Record<string, unknown>)
        : {};
    const risk = s.risk as PlanStep["risk"];
    steps.push({
      id: `step-${i + 1}`,
      toolName,
      params,
      description,
      risk,
    });
  }
  const stopOnError = obj.stopOnError !== false;
  const plan: ActionPlan = {
    id: `plan-${Date.now().toString(36)}`,
    goal,
    steps,
    createdAtISO: new Date().toISOString(),
    stopOnError,
  };
  return { ok: true, plan };
}
