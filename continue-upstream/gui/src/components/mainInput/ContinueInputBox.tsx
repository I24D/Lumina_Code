import { Editor, JSONContent } from "@tiptap/react";
import {
  ContextItemWithId,
  InputModifiers,
  RuleMetadata,
  SlashCommandSource,
} from "core";
import { memo, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { defaultBorderRadius, vscBackground } from "..";
import { buildConfigRoute } from "../../util/navigation";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSlashCommandComboBoxInputs } from "../../redux/selectors";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { newSession, setMode } from "../../redux/slices/sessionSlice";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { saveCurrentSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
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

function ContinueInputBox(props: ContinueInputBoxProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const mode = useAppSelector((state) => state.session.mode);
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const compact = useCompactConversation();
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
          // Sin guardar: es "vaciar la pizarra", no "archivarla".
          dispatch(newSession(undefined));
        },
        compactConversation: () => {
          // Compacta desde el último mensaje, que es lo que libera ventana.
          if (historyLength > 1) {
            void compact(historyLength - 1);
          }
        },
        historyLength,
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
      compact,
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
