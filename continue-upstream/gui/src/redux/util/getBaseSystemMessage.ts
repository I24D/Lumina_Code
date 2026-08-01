import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";

export const NO_TOOL_WARNING =
  "\n\nTHE USER HAS NOT PROVIDED ANY TOOLS, DO NOT ATTEMPT TO USE ANY TOOLS. STOP AND LET THE USER KNOW THAT THERE ARE NO TOOLS AVAILABLE. The user can provide tools by enabling them in the Tool Policies section of the notch (wrench icon)";

export const LUMINA_AGENT_EXECUTION_CONTRACT =
  "\n\nLumina Code execution contract:\n" +
  "- Treat direct user orders as tasks to execute, not questions to answer prematurely.\n" +
  "- Continue using tools and checking results until the task is complete or a real blocker is reached.\n" +
  "- Do not deliver a final report after only planning, describing, or starting the work.\n" +
  "- For code tasks, make the edits with native workspace tools: create_new_file, edit_existing_file, multi_edit, read_file, ls, grep_search, file_glob_search.\n" +
  "- Never use Lumina Windows Bridge or PowerShell Bridge commands to create, edit, move, delete, or generate project files.\n" +
  "- For tests, builds, package scripts, and project commands, use run_terminal_command in the workspace.\n" +
  "- For Windows desktop/PC tasks outside the project workspace, use the available bridge when appropriate.\n" +
  "- Before any Windows desktop/PC task, initialize Lumina Bridge in this order: 1) activate continuous monitor video with /vision_stream_control { action: \"start\" }, 2) read /vision_stream and confirm mode is dxgi_desktop_duplication, streaming is true, and framesSeen advances, 3) activate semantic perception with /perception_control { action: \"start\" }, 4) read /perception and confirm the daemon is running and current foreground state is visible, 5) activate hearing by calling /now_playing and confirm the real audio sensor responds, then 6) start the user's task. Do not work blind or deaf.\n" +
  "- For Windows desktop/PC tasks, never claim success from a click, keypress, launch, or command alone. Verify the real result after the action using continuous monitor vision and live perception/current-state tools such as /vision_stream, /perception, /ui_capture, /ui_wait, /now_playing, OCR, or UIA state. If verification does not prove success, report the blocker instead of saying it worked.\n" +
  "- Final response only: summarize completed work, verification, and any true blocker.";

export function getBaseSystemMessage(
  messageMode: string,
  model: ModelDescription,
  activeTools?: Tool[],
): string {
  let baseMessage: string;

  if (messageMode === "agent") {
    baseMessage = model.baseAgentSystemMessage ?? DEFAULT_AGENT_SYSTEM_MESSAGE;
    if (!baseMessage.includes("Lumina Code execution contract:")) {
      baseMessage += LUMINA_AGENT_EXECUTION_CONTRACT;
    }
  } else if (messageMode === "plan") {
    baseMessage = model.basePlanSystemMessage ?? DEFAULT_PLAN_SYSTEM_MESSAGE;
  } else {
    baseMessage = model.baseChatSystemMessage ?? DEFAULT_CHAT_SYSTEM_MESSAGE;
  }

  // Add no-tools warning for agent/plan modes when no tools are available
  if (messageMode !== "chat" && (!activeTools || activeTools.length === 0)) {
    baseMessage += NO_TOOL_WARNING;
  }

  return baseMessage;
}
