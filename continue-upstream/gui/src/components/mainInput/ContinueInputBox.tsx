import { Editor, JSONContent } from "@tiptap/react";
import {
  ContextItemWithId,
  InputModifiers,
  RuleMetadata,
  SlashCommandSource,
} from "core";
import type { SessionGoal } from "core/goals/sessionGoal";
import { memo, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { defaultBorderRadius, vscBackground } from "..";
import { buildConfigRoute } from "../../util/navigation";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSlashCommandComboBoxInputs } from "../../redux/selectors";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import {
  clearSessionHistory,
  newSession,
  setMainEditorContentTrigger,
  setMode,
  updateSessionTitle,
} from "../../redux/slices/sessionSlice";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { saveCurrentSession, updateSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { GitHubSessionDialog } from "../dialogs/GitHubSessionDialog";
import { SessionGoalDialog } from "../dialogs/SessionGoalDialog";
import {
  buildBuiltInSlashCommands,
  groupSlashCommands,
} from "./builtInSlashCommands";
import { ContextItemsPeek } from "./belowMainInput/ContextItemsPeek";
import { RulesPeek } from "./belowMainInput/RulesPeek";
import { GradientBorder } from "./GradientBorder";
import { ToolbarOptions } from "./InputToolbar";
import { Lump } from "./Lump";
import { TipTapEditor } from "./TipTapEditor";

interface ContinueInputBoxProps {
  isLastUserInput: boolean;
  isMainInput?: boolean;
  onEnter: (
    editorState: JSONContent,
    modifiers: InputModifiers,
    editor: Editor,
  ) => void;
  editorState?: JSONContent;
  contextItems?: ContextItemWithId[];
  appliedRules?: RuleMetadata[];
  hidden?: boolean;
  inputId: string; // used to keep track of things per input in redux
}

const EDIT_DISALLOWED_CONTEXT_PROVIDERS = [
  "codebase",
  "tree",
  "open",
  "web",
  "diff",
  "folder",
  "search",
  "debugger",
  "repo-map",
];

const EDIT_ALLOWED_SLASH_COMMAND_SOURCES: SlashCommandSource[] = [
  "yaml-prompt-block",
  "mcp-prompt",
  "prompt-file-v1",
  "prompt-file-v2",
  "invokable-rule",
  "json-custom-command",
];

function textToEditorContent(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}

function ContinueInputBox(props: ContinueInputBoxProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const mode = useAppSelector((state) => state.session.mode);
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const sessionId = useAppSelector((state) => state.session.id);
  const title = useAppSelector((state) => state.session.title);
  const compact = useCompactConversation();
  const ideMessenger = useContext(IdeMessengerContext);
  // Meta de la sesión. Se refresca al cambiar de sesión y tras cada turno,
  // porque el bucle la va actualizando por su cuenta en core.
  const [sessionGoal, setSessionGoal] = useState<SessionGoal | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSessionGoal(null);
      return;
    }
    let cancelled = false;
    void ideMessenger
      .request("goals/get", { sessionId })
      .then((res) => {
        if (!cancelled && res.status !== "error") {
          setSessionGoal(res.content ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, sessionId, historyLength, isStreaming]);
  const availableSlashCommands = useAppSelector(
    selectSlashCommandComboBoxInputs,
  );
  const availableContextProviders = useAppSelector(
    (state) => state.config.config.contextProviders,
  );
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const editModeState = useAppSelector((state) => state.editModeState);

  const builtInCommands = useMemo(
    () =>
      buildBuiltInSlashCommands({
        saveAndStartNewSession: () => {
          // Archiva la conversación en el historial antes de abrir otra.
          void dispatch(
            saveCurrentSession({ openNewSession: true, generateTitle: true }),
          );
        },
        clearCurrentSession: () => {
          // Vacía ESTA conversación en su sitio. `newSession` no vale: genera
          // un id nuevo, así que te deja en otra conversación y la anterior
          // sigue ahí llena.
          dispatch(clearSessionHistory());
          // Y se persiste el vaciado, o al recargar vuelven los mensajes.
          // `saveCurrentSession` no sirve aquí: se rinde cuando el historial
          // está vacío, que es justo este caso.
          void dispatch(
            updateSession({
              sessionId,
              title,
              workspaceDirectory: window.workspacePaths?.[0] || "",
              history: [],
              mode,
              chatModelTitle: selectedModel?.title ?? null,
            }),
          );
        },
        compactConversation: () => {
          if (historyLength === 0) {
            return;
          }
          // El compactado de core lee la sesión DEL DISCO
          // (`historyManager.load`), no del estado en vivo. Sin guardar antes,
          // resume una versión vieja y parece que no hace nada.
          void dispatch(
            saveCurrentSession({ openNewSession: false, generateTitle: false }),
          )
            .unwrap()
            .then(() => compact(historyLength - 1))
            .catch(() => undefined);
        },
        historyLength,
        goalSummary: sessionGoal?.text,
        openGitHubSession: () => {
          dispatch(
            setDialogMessage(
              <GitHubSessionDialog
                onSubmit={async (reference) => {
                  const response = await ideMessenger.request(
                    "github/getWorkItem",
                    { reference },
                  );
                  if (response.status === "error") {
                    throw new Error(response.error);
                  }

                  if (historyLength > 0) {
                    await dispatch(
                      saveCurrentSession({
                        openNewSession: true,
                        generateTitle: true,
                      }),
                    ).unwrap();
                  } else {
                    dispatch(newSession());
                  }

                  const item = response.content;
                  dispatch(setMode("agent"));
                  dispatch(
                    updateSessionTitle(
                      `GitHub #${item.reference.number}: ${item.title}`,
                    ),
                  );
                  dispatch(
                    setMainEditorContentTrigger(
                      textToEditorContent(
                        `${item.suggestedPrompt}\n\n` +
                          `<github-context source="${item.url}">\n` +
                          `${item.markdown}\n</github-context>`,
                      ),
                    ),
                  );
                }}
              />,
            ),
          );
          dispatch(setShowDialog(true));
        },
        toggleSessionGoal: () => {
          if (!sessionId) {
            return;
          }
          // Con meta puesta el comando la retira; sin ella, la pide. Un solo
          // comando para los dos gestos, como el resto de la paleta.
          if (sessionGoal) {
            void ideMessenger
              .request("goals/clear", { sessionId })
              .then(() => setSessionGoal(null))
              .catch(() => undefined);
            return;
          }
          dispatch(
            setDialogMessage(
              <SessionGoalDialog
                onSubmit={async (text) => {
                  const response = await ideMessenger.request("goals/set", {
                    sessionId,
                    text,
                  });
                  if (response.status === "error") {
                    throw new Error(response.error);
                  }
                  setSessionGoal(response.content);
                }}
              />,
            ),
          );
          dispatch(setShowDialog(true));
        },
        openConfigTab: (tabId) => {
          // La página de ajustes selecciona pestaña por `?tab=`; usar el mismo
          // constructor tipado que el resto de la app.
          navigate(buildConfigRoute(tabId));
        },
        navigateTo: (route) => navigate(route),
        setMode: (mode) => {
          dispatch(setMode(mode));
        },
        currentMode: mode,
        stopStreaming: () => {
          dispatch(cancelStream());
        },
        isStreaming,
        currentModel: selectedModel?.title,
      }),
    [
      dispatch,
      navigate,
      mode,
      isStreaming,
      selectedModel?.title,
      historyLength,
      sessionId,
      title,
      compact,
      ideMessenger,
      sessionGoal,
    ],
  );

  const filteredSlashCommands = useMemo(() => {
    if (isInEdit) {
      // En modo edición los comandos de sesión no aplican: solo prompts.
      return availableSlashCommands.filter((cmd) =>
        cmd.slashCommandSource
          ? EDIT_ALLOWED_SLASH_COMMAND_SOURCES.includes(cmd.slashCommandSource)
          : false,
      );
    }
    return groupSlashCommands([...builtInCommands, ...availableSlashCommands]);
  }, [isInEdit, availableSlashCommands, builtInCommands]);

  const filteredContextProviders = useMemo(() => {
    if (isInEdit) {
      return (
        availableContextProviders?.filter(
          (provider) =>
            !EDIT_DISALLOWED_CONTEXT_PROVIDERS.includes(provider.title),
        ) ?? []
      );
    }

    return availableContextProviders ?? [];
  }, [availableContextProviders, isInEdit]);

  const historyKey = isInEdit ? "edit" : "chat";
  const placeholder = isInEdit ? "Edit selected code" : undefined;

  const toolbarOptions: ToolbarOptions = useMemo(() => {
    if (isInEdit) {
      return {
        hideAddContext: false,
        hideImageUpload: false,
        hideUseCodebase: true,
        hideSelectModel: false,
        enterText:
          editModeState.applyState.status === "done" ? "Retry" : "Edit",
      } as ToolbarOptions;
    }
    // Stable empty object to avoid re-renders from identity changes
    return {} as ToolbarOptions;
  }, [isInEdit, editModeState.applyState.status]);

  const { appliedRules = [], contextItems = [] } = props;

  return (
    <div
      className={`${props.hidden ? "hidden" : ""}`}
      data-testid={`continue-input-box-${props.inputId}`}
    >
      <div className={`relative flex flex-col px-2`}>
        {props.isMainInput && <Lump />}
        <GradientBorder
          loading={isStreaming && (props.isLastUserInput || isInEdit) ? 1 : 0}
          borderColor={
            isStreaming && (props.isLastUserInput || isInEdit)
              ? undefined
              : vscBackground
          }
          borderRadius={defaultBorderRadius}
        >
          <TipTapEditor
            editorState={props.editorState}
            onEnter={props.onEnter}
            placeholder={placeholder}
            isMainInput={props.isMainInput ?? false}
            availableContextProviders={filteredContextProviders}
            availableSlashCommands={filteredSlashCommands}
            historyKey={historyKey}
            toolbarOptions={toolbarOptions}
            inputId={props.inputId}
          />
        </GradientBorder>
      </div>

      {(appliedRules.length > 0 || contextItems.length > 0) && (
        <div className="mt-2 flex flex-col">
          <RulesPeek appliedRules={props.appliedRules} />
          <ContextItemsPeek
            contextItems={props.contextItems}
            isCurrentContextPeek={props.isLastUserInput}
          />
        </div>
      )}
    </div>
  );
}

export default memo(ContinueInputBox);
