import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
  LUMINA_AGENT_EXECUTION_INSTRUCTIONS,
} from "core/llm/defaultSystemMessages";

export const NO_TOOL_WARNING =
  "\n\nTHE USER HAS NOT PROVIDED ANY TOOLS, DO NOT ATTEMPT TO USE ANY TOOLS. STOP AND LET THE USER KNOW THAT THERE ARE NO TOOLS AVAILABLE. The user can provide tools by enabling them in the Tool Policies section of the notch (wrench icon)";

/**
 * El mismo contrato que ya lleva `DEFAULT_AGENT_SYSTEM_MESSAGE`, para cuando el
 * modelo trae su propio `baseAgentSystemMessage` y por tanto no lo incluye.
 *
 * Se reexporta en vez de reescribirse: las dos copias existieron por separado y
 * divergieron, así que tocar solo ésta no cambiaba nada en el camino por defecto.
 * La fuente única está en `core/llm/defaultSystemMessages.ts`.
 */
export const LUMINA_AGENT_EXECUTION_CONTRACT = `\n\n${LUMINA_AGENT_EXECUTION_INSTRUCTIONS}`;

export const KIMI_K3_IDENTITY_CONTRACT =
  "\n\nModel identity:\n" +
  "- The active model is Kimi K3 by Moonshot AI, served through Ollama Cloud.\n" +
  "- When the user asks which model you are, answer explicitly that you are Kimi K3.\n" +
  "- Do not identify yourself as Kimi K2, Kimi K2.5, another Kimi variant, or only as the generic Kimi family.";

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

  if (/^kimi-k3(?::cloud)?$/i.test(model.model ?? "")) {
    baseMessage += KIMI_K3_IDENTITY_CONTRACT;
  }

  // Add no-tools warning for agent/plan modes when no tools are available
  if (messageMode !== "chat" && (!activeTools || activeTools.length === 0)) {
    baseMessage += NO_TOOL_WARNING;
  }

  return baseMessage;
}
