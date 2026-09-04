import { fetchwithRequestOptions } from "@continuedev/fetch";
import { ChatMessage, IDE, PromptLog } from "..";
import { ConfigHandler } from "../config/ConfigHandler";
import { FromCoreProtocol, ToCoreProtocol } from "../protocol";
import { IMessenger, Message } from "../protocol/messenger";
import { announceAssistantResponse } from "../util/luminaVoiceBridge";

export async function* llmStreamChat(
  configHandler: ConfigHandler,
  abortController: AbortController,
  msg: Message<ToCoreProtocol["llm/streamChat"][0]>,
  ide: IDE,
  messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
): AsyncGenerator<ChatMessage, PromptLog> {
  const { config } = await configHandler.loadConfig();
  if (!config) {
    throw new Error("Config not loaded");
  }

  const {
    legacySlashCommandData,
    completionOptions,
    messages,
    messageOptions,
  } = msg.data;

  const model = config.selectedModelByRole.chat;

  if (!model) {
    throw new Error("No chat model selected");
  }

  // Log to return in case of error
  const errorPromptLog = {
    modelTitle: model?.title ?? model?.model,
    modelProvider: model?.underlyingProviderName ?? "unknown",
    completion: "",
    prompt: "",
    completionOptions: {
      ...msg.data.completionOptions,
      model: model?.model,
    },
  };

  try {
    if (legacySlashCommandData) {
      const { command, contextItems, historyIndex, input, selectedCode } =
        legacySlashCommandData;
      const slashCommand = config.slashCommands?.find(
        (sc) => sc.name === command.name,
      );
      if (!slashCommand) {
        throw new Error(`Unknown slash command ${command.name}`);
      }
      if (!slashCommand.run) {
        console.error(
          `Slash command ${command.name} (${command.source}) has no run function`,
        );
        throw new Error(`Slash command not found`);
      }

      const gen = slashCommand.run({
        input,
        history: messages,
        llm: model,
        contextItems,
        params: command.params,
        ide,
        addContextItem: (item) => {
          void messenger.request("addContextItem", {
            item,
            historyIndex,
          });
        },
        selectedCode,
        config,
        fetch: (url, init) =>
          fetchwithRequestOptions(
            url,
            {
              ...init,
              signal: abortController.signal,
            },
            model.requestOptions,
          ),
        completionOptions,
        abortController,
      });
      let next = await gen.next();
      while (!next.done) {
        if (abortController.signal.aborted) {
          next = await gen.return(errorPromptLog);
          break;
        }
        if (next.value) {
          yield {
            role: "assistant",
            content: next.value,
          };
        }
        next = await gen.next();
      }
      if (!next.done) {
        throw new Error("Will never happen");
      }

      return next.value;
    } else {
      const gen = model.streamChat(
        messages,
        abortController.signal,
        completionOptions,
        messageOptions,
      );
      let next = await gen.next();
      // En modo agente esta función se ejecuta una vez por ronda del modelo, y
      // las rondas intermedias sólo piden herramientas. Anunciar cada una sería
      // narrar el trabajo en vez de dar el resultado, así que sólo se lee en voz
      // alta el turno que no pide nada más: ese es la respuesta de verdad.
      let requestedTools = false;
      while (!next.done) {
        if (abortController.signal.aborted) {
          next = await gen.return(errorPromptLog);
          break;
        }

        const chunk = next.value;
        if (chunk.role === "assistant" && chunk.toolCalls?.length) {
          requestedTools = true;
        }

        yield chunk;
        next = await gen.next();
      }
      if (!next.done) {
        throw new Error("Will never happen");
      }

      if (!requestedTools && !abortController.signal.aborted) {
        announceAssistantResponse(next.value.completion);
      }

      return next.value;
    }
  } catch (error) {
    // Moved error handling that was here to GUI, keeping try/catch for clean diff
    throw error;
  }
}
