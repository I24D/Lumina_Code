import { SparklesIcon } from "@heroicons/react/24/outline";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setFullAccess } from "../../redux/slices/uiSlice";
import { ActiveToolsView } from "./ActiveToolsView";
import { AgentSettings } from "./AgentSettings";
import { MemoryView } from "./MemoryView";
import { TaskProgressView } from "./TaskProgressView";
import {
  AssistantMemoryItem,
  AssistantSettingsState,
  AssistantTaskStep,
  AssistantToolState,
} from "./types";

export type AssistantPanelProps = {
  memory?: AssistantMemoryItem[];
  tools?: AssistantToolState[];
  steps?: AssistantTaskStep[];
  settings?: AssistantSettingsState;
  onSettingsChange?: (settings: AssistantSettingsState) => void;
};

const defaultSettings: AssistantSettingsState = {
  fullAccess: false,
  requireVerification: true,
  continuousVision: true,
};

type AssistantRuntimeState = {
  memory: AssistantMemoryItem[];
  tools: AssistantToolState[];
  steps: AssistantTaskStep[];
  settings: AssistantSettingsState;
  stateDir?: string;
};

export function AssistantPanel({
  memory = [],
  tools = [],
  steps = [],
  settings = defaultSettings,
  onSettingsChange,
}: AssistantPanelProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const fullAccess = useAppSelector((state) => state.ui.fullAccess);
  const [runtimeState, setRuntimeState] =
    useState<AssistantRuntimeState | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      const response = await ideMessenger.request(
        "lumina/assistantState",
        undefined,
      );
      if (active && response.status === "success") {
        setRuntimeState(response.content);
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [ideMessenger]);

  const effectiveSettings = useMemo<AssistantSettingsState>(
    () => ({
      ...(runtimeState?.settings ?? settings),
      fullAccess,
    }),
    [fullAccess, runtimeState?.settings, settings],
  );

  const handleSettingsChange = (nextSettings: AssistantSettingsState) => {
    if (nextSettings.fullAccess !== fullAccess) {
      dispatch(setFullAccess(nextSettings.fullAccess));
    }
    onSettingsChange?.(nextSettings);
  };

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--vscode-editor-background)] text-[color:var(--vscode-editor-foreground)]">
      <header className="flex flex-none items-center gap-2 border-0 border-b border-solid border-[color:var(--vscode-panel-border)] p-3">
        <SparklesIcon className="h-5 w-5 text-[color:var(--vscode-progressBar-background)]" />
        <div className="min-w-0">
          <h1 className="m-0 truncate text-sm font-semibold">Lumina Assistant</h1>
          <p className="m-0 truncate text-xs text-[color:var(--vscode-descriptionForeground)]">Agent state</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskProgressView steps={runtimeState?.steps ?? steps} />
        <ActiveToolsView tools={runtimeState?.tools ?? tools} />
        <MemoryView items={runtimeState?.memory ?? memory} />
        <AgentSettings
          settings={effectiveSettings}
          onChange={handleSettingsChange}
        />
      </div>
    </main>
  );
}

export default AssistantPanel;
