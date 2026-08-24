import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentMagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import AcceptRejectDiffButtons from "../../components/AcceptRejectDiffButtons";
import FileIcon from "../../components/FileIcon";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useNavigationListener } from "../../hooks/useNavigationListener";
import { useAppSelector } from "../../redux/hooks";
import { cn } from "../../util/cn";
import {
  flattenWalkthrough,
  parseUnifiedDiff,
  WalkthroughLine,
} from "./parseUnifiedDiff";

function lineStyle(kind: WalkthroughLine["kind"]) {
  if (kind === "add") return "bg-green-500/10 text-green-300";
  if (kind === "remove") return "bg-red-500/10 text-red-300";
  if (kind === "meta") return "italic opacity-60";
  return "opacity-80";
}

function joinWorkspacePath(root: string, relative: string) {
  return `${root.replace(/[\\/]$/, "")}/${relative.replace(/^[/\\]/, "")}`;
}

export default function ChangesWalkthrough() {
  useNavigationListener();
  const navigate = useNavigate();
  const ideMessenger = useContext(IdeMessengerContext);
  const [rawDiff, setRawDiff] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const pendingApplyStates = useMemo(
    () => applyStates.filter((applyState) => applyState.status === "done"),
    [applyStates],
  );

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [diffs, roots] = await Promise.all([
        ideMessenger.ide.getDiff(true),
        ideMessenger.ide.getWorkspaceDirs(),
      ]);
      setRawDiff(diffs.join("\n"));
      setWorkspaceRoot(roots[0] ?? "");
      setCurrentIndex(0);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo leer el diff del proyecto.",
      );
    } finally {
      setLoading(false);
    }
  }, [ideMessenger]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const files = useMemo(() => parseUnifiedDiff(rawDiff), [rawDiff]);
  const steps = useMemo(() => flattenWalkthrough(files), [files]);
  const step = steps[currentIndex];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const openCurrentFile = async () => {
    if (!step) return;
    const filepath = workspaceRoot
      ? joinWorkspacePath(workspaceRoot, step.filepath)
      : step.filepath;
    await ideMessenger.ide.showLines(
      filepath,
      Math.max(step.newStart - 1, 0),
      Math.max(step.newStart + step.lines.length, step.newStart),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Recorrido de cambios"
        onTitleClick={() => navigate(-1)}
        showBorder
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-solid border-[color:var(--vscode-panel-border)] p-3">
          <div>
            <div className="font-semibold">
              {files.length} archivo{files.length === 1 ? "" : "s"} ·{" "}
              {steps.length} paso{steps.length === 1 ? "" : "s"}
            </div>
            <div className="mt-1 text-xs opacity-70">
              <span className="text-green-400">+{additions}</span>{" "}
              <span className="text-red-400">−{deletions}</span>
            </div>
          </div>
          <button
            className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-[color:var(--vscode-button-secondaryBackground)] px-2 py-1 text-[color:var(--vscode-button-secondaryForeground)]"
            onClick={() => void loadDiff()}
            disabled={loading}
          >
            <ArrowPathIcon
              className={cn("h-4 w-4", loading && "animate-spin")}
            />
            Actualizar
          </button>
        </div>

        {pendingApplyStates.length > 0 && (
          <div className="rounded-lg border border-solid border-amber-500/40 bg-amber-500/5 p-3">
            <div className="mb-2 text-xs font-semibold text-amber-300">
              {pendingApplyStates.length} cambio
              {pendingApplyStates.length === 1 ? "" : "s"} pendiente
              {pendingApplyStates.length === 1 ? "" : "s"} de aprobación
            </div>
            <AcceptRejectDiffButtons
              applyStates={pendingApplyStates}
              onAcceptOrReject={() => setTimeout(() => void loadDiff(), 150)}
            />
          </div>
        )}

        {error && (
          <div className="rounded border border-solid border-red-500/40 p-3 text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && !step && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center opacity-70">
            <DocumentMagnifyingGlassIcon className="h-10 w-10" />
            <strong>No hay cambios para recorrer</strong>
            <span className="max-w-sm text-xs">
              Modifica un archivo o aplica un cambio desde el agente y pulsa
              Actualizar.
            </span>
          </div>
        )}

        {step && (
          <>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {steps.map((candidate, index) => (
                <button
                  key={candidate.id}
                  aria-label={`Ir al paso ${index + 1}`}
                  className={cn(
                    "h-1.5 min-w-6 flex-1 cursor-pointer rounded-full border-0",
                    index === currentIndex
                      ? "bg-[color:var(--vscode-focusBorder)]"
                      : index < currentIndex
                        ? "bg-green-500/60"
                        : "bg-white/15",
                  )}
                  onClick={() => setCurrentIndex(index)}
                />
              ))}
            </div>

            <div className="overflow-hidden rounded-lg border border-solid border-[color:var(--vscode-panel-border)]">
              <div className="flex items-center justify-between gap-2 border-0 border-b border-solid border-[color:var(--vscode-panel-border)] bg-[color:var(--vscode-editorWidget-background)] p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileIcon
                    filename={step.filepath}
                    height="20px"
                    width="20px"
                  />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">
                      {step.filepath}
                    </div>
                    <div className="truncate text-xs opacity-60">
                      {step.heading} · paso {currentIndex + 1} de {steps.length}
                    </div>
                  </div>
                </div>
                <button
                  className="cursor-pointer whitespace-nowrap border-0 bg-transparent text-xs text-[color:var(--vscode-textLink-foreground)]"
                  onClick={() => void openCurrentFile()}
                >
                  Abrir archivo
                </button>
              </div>

              <div className="max-h-[55vh] overflow-auto bg-[color:var(--vscode-editor-background)] py-2 font-mono text-xs">
                {step.lines.map((line, index) => (
                  <div
                    key={`${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`}
                    className={cn("flex min-w-max", lineStyle(line.kind))}
                  >
                    <span className="w-10 select-none pr-2 text-right opacity-40">
                      {line.oldLine ?? ""}
                    </span>
                    <span className="w-10 select-none pr-2 text-right opacity-40">
                      {line.newLine ?? ""}
                    </span>
                    <span className="w-5 select-none text-center font-bold">
                      {line.kind === "add"
                        ? "+"
                        : line.kind === "remove"
                          ? "−"
                          : " "}
                    </span>
                    <pre className="m-0 whitespace-pre pr-4">
                      {line.text || " "}
                    </pre>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pb-2">
              <button
                className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent px-3 py-1.5 disabled:cursor-default disabled:opacity-40"
                disabled={currentIndex === 0}
                onClick={() =>
                  setCurrentIndex((index) => Math.max(index - 1, 0))
                }
              >
                <ChevronLeftIcon className="h-4 w-4" /> Anterior
              </button>
              <span className="text-xs opacity-60">
                <span className="text-green-400">+{step.additions}</span> /{" "}
                <span className="text-red-400">−{step.deletions}</span>
              </span>
              <button
                className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-[color:var(--vscode-button-background)] px-3 py-1.5 text-[color:var(--vscode-button-foreground)] disabled:cursor-default disabled:opacity-40"
                disabled={currentIndex === steps.length - 1}
                onClick={() =>
                  setCurrentIndex((index) =>
                    Math.min(index + 1, steps.length - 1),
                  )
                }
              >
                Siguiente <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
