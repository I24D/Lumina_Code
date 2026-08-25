import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CodeBracketIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { WorktreeInfo } from "core/worktrees/WorktreeService";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import ConfirmationDialog from "../dialogs/ConfirmationDialog";
import { Button } from "../ui";

function shortHead(head: string) {
  return head ? head.slice(0, 8) : "unknown";
}

export function Worktrees() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const showError = (message: string) =>
    ideMessenger.post("showToast", ["error", message]);

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await ideMessenger.request("worktrees/list", undefined);
      if (response.status === "error") {
        throw new Error(response.error);
      }
      setWorktrees(response.content);
    } catch (error) {
      showError(
        `No se pudieron cargar los worktrees: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const createWorktree = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!branchName.trim() || creating) return;
    setCreating(true);
    try {
      const response = await ideMessenger.request("worktrees/create", {
        branchName: branchName.trim(),
        baseRef: baseRef.trim() || "HEAD",
      });
      if (response.status === "error") {
        throw new Error(response.error);
      }
      setBranchName("");
      setWorktrees((current) => [...current, response.content]);
      ideMessenger.post("showToast", [
        "info",
        `Worktree creado para ${response.content.branch ?? branchName}.`,
      ]);
    } catch (error) {
      showError(
        `No se pudo crear el worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setCreating(false);
    }
  };

  const confirmRemove = (worktree: WorktreeInfo) => {
    dispatch(
      setDialogMessage(
        <ConfirmationDialog
          title="Eliminar worktree"
          text={`Se eliminará el worktree ${worktree.branch ?? worktree.path}. Git rechazará la operación si contiene cambios sin guardar.`}
          onConfirm={async () => {
            try {
              const response = await ideMessenger.request("worktrees/remove", {
                path: worktree.path,
              });
              if (response.status === "error") {
                throw new Error(response.error);
              }
              setWorktrees((current) =>
                current.filter((candidate) => candidate.path !== worktree.path),
              );
            } catch (error) {
              showError(
                `No se pudo eliminar el worktree: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }}
        />,
      ),
    );
    dispatch(setShowDialog(true));
  };

  return (
    <div className="thin-scrollbar flex flex-1 flex-col overflow-y-auto px-2 pb-4">
      <section className="border-border bg-input/30 my-3 rounded-xl border border-solid p-3">
        <div className="mb-3 flex items-start gap-2">
          <CodeBracketIcon className="text-description mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="m-0 text-sm font-semibold">Entornos aislados</h2>
            <p className="text-description m-0 mt-1 text-xs leading-relaxed">
              Crea una rama y un directorio independiente para trabajar en
              paralelo sin mezclar cambios con tu árbol principal.
            </p>
          </div>
        </div>

        <form className="flex flex-col gap-2" onSubmit={createWorktree}>
          <label className="text-description text-xs" htmlFor="worktree-branch">
            Nueva rama
          </label>
          <input
            id="worktree-branch"
            className="bg-vsc-input-background text-vsc-foreground rounded-md border border-none px-2 py-1.5 text-sm outline-none"
            placeholder="feature/nueva-capacidad"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
          />
          <div className="flex items-end gap-2">
            <label className="text-description flex flex-1 flex-col gap-1 text-xs">
              Crear desde
              <input
                className="bg-vsc-input-background text-vsc-foreground rounded-md border border-none px-2 py-1.5 text-sm outline-none"
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              disabled={creating || branchName.trim().length === 0}
            >
              {creating ? "Creando…" : "Crear worktree"}
            </Button>
          </div>
        </form>
      </section>

      <div className="mb-2 flex items-center justify-between">
        <span className="text-description text-xs">
          {worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <span className="flex items-center gap-1">
            <ArrowPathIcon
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Actualizar
          </span>
        </Button>
      </div>

      {loading && worktrees.length === 0 ? (
        <div className="text-description py-8 text-center text-sm">
          Consultando Git…
        </div>
      ) : worktrees.length === 0 ? (
        <div className="text-description py-8 text-center text-sm">
          No hay worktrees disponibles en el repositorio activo.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {worktrees.map((worktree) => (
            <article
              key={worktree.path}
              className="border-border bg-input/20 rounded-xl border border-solid p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="truncate text-sm">
                      {worktree.branch ?? "HEAD separado"}
                    </strong>
                    {worktree.isMain && (
                      <span className="bg-vsc-background text-2xs rounded-full px-2 py-0.5">
                        principal
                      </span>
                    )}
                    {worktree.isDirty !== undefined && (
                      <span
                        className={`text-2xs rounded-full px-2 py-0.5 ${
                          worktree.isDirty
                            ? "bg-warning/15 text-warning"
                            : "bg-success/15 text-success"
                        }`}
                      >
                        {worktree.isDirty ? "con cambios" : "limpio"}
                      </span>
                    )}
                  </div>
                  <div
                    className="text-description mt-1 truncate text-xs"
                    title={worktree.path}
                  >
                    {worktree.path}
                  </div>
                  <div className="text-description-muted text-2xs mt-1">
                    commit {shortHead(worktree.head)}
                    {worktree.locked ? ` · bloqueado: ${worktree.locked}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Abrir en una nueva ventana de VS Code"
                    onClick={() =>
                      ideMessenger.post("worktrees/open", {
                        path: worktree.path,
                      })
                    }
                  >
                    <span className="flex items-center gap-1">
                      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                      Abrir
                    </span>
                  </Button>
                  {!worktree.isMain && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Eliminar worktree"
                      onClick={() => confirmRemove(worktree)}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
