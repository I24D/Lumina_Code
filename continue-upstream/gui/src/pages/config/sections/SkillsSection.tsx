import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  PlusIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarIconSolid } from "@heroicons/react/24/solid";
import type { LuminaPluginCatalogEntry } from "core/config/PluginCatalogService";
import type {
  SkillDraft,
  SkillScope,
} from "core/learning/SkillWorkshopService";
import type { SkillLintFinding } from "core/learning/types";
import type { SkillCurateAction, SkillWithUsage } from "core/protocol/core";
import { useCallback, useContext, useEffect, useState } from "react";

import HeaderButtonWithToolTip from "../../../components/gui/HeaderButtonWithToolTip";
import { Card, EmptyState } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { fontSize } from "../../../util";
import { ConfigHeader } from "../components/ConfigHeader";

/**
 * The one-line summary of what a skill has done for the user.
 *
 * A skill with no telemetry is reported as "not used yet" rather than
 * "used 0 times": the first means Lumina has never reached for it, which is
 * also true of every hand-written skill the moment it is added, and reading
 * that as a failing grade would be wrong.
 */
function usageSummary(skill: SkillWithUsage): string {
  const usage = skill.usage;
  if (!usage) {
    return "Not used yet";
  }
  const parts: string[] = [
    usage.useCount === 0
      ? "Not used yet"
      : `Used ${usage.useCount} time${usage.useCount === 1 ? "" : "s"}`,
  ];
  if (usage.patchCount > 0) {
    parts.push(
      `revised ${usage.patchCount} time${usage.patchCount === 1 ? "" : "s"}`,
    );
  }
  if (usage.lastUsedAt) {
    parts.push(`last ${new Date(usage.lastUsedAt).toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-vsc-background text-description-muted rounded-full px-1.5 py-0.5"
      style={{ fontSize: fontSize(-4) }}
    >
      {children}
    </span>
  );
}

const EMPTY_DRAFT: SkillDraft = {
  name: "",
  description: "",
  content:
    "## When to Use\n\nDescribe cuándo debe activarse.\n\n## Procedure\n\n1. ",
  scope: "workspace",
};

function SkillCard({
  skill,
  onCurate,
  onEdit,
}: {
  skill: SkillWithUsage;
  onCurate: (name: string, action: SkillCurateAction) => void;
  onEdit: (skill: SkillWithUsage) => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const usage = skill.usage;
  const archived = usage?.state === "archived";
  const pinned = usage?.pinned === true;

  const openSkillFile = () => {
    ideMessenger.post("openFile", { path: skill.path });
  };

  return (
    <div
      className={`border-border hover:bg-list-active hover:text-list-active-foreground flex flex-col rounded-sm px-2 py-1.5 transition-colors hover:cursor-pointer ${
        archived ? "opacity-50" : ""
      }`}
      onClick={openSkillFile}
      data-testid={`skill-card-${skill.name}`}
    >
      <div className="flex flex-row items-start justify-between gap-2">
        <span
          className="text-vscForeground line-clamp-1 font-medium"
          style={{ fontSize: fontSize(-2) }}
        >
          {skill.name}
        </span>
        <div className="flex flex-none flex-row items-center">
          <HeaderButtonWithToolTip
            testId={`skill-edit-${skill.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(skill);
            }}
            text="Editar en Skill Workshop"
          >
            <PencilSquareIcon className="h-3 w-3 text-gray-400" />
          </HeaderButtonWithToolTip>
          <HeaderButtonWithToolTip
            testId={`skill-pin-${skill.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCurate(skill.name, pinned ? "unpin" : "pin");
            }}
            text={
              pinned
                ? "Unpin — allow this skill to be flagged stale when unused"
                : "Pin — never flag this skill as stale"
            }
          >
            {pinned ? (
              <StarIconSolid className="h-3 w-3 text-yellow-500" />
            ) : (
              <StarIcon className="h-3 w-3 text-gray-400" />
            )}
          </HeaderButtonWithToolTip>
          <HeaderButtonWithToolTip
            testId={`skill-archive-${skill.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCurate(skill.name, archived ? "unarchive" : "archive");
            }}
            text={
              archived
                ? "Restore — show this skill to Lumina again"
                : "Archive — hide from Lumina's skill list without deleting the file"
            }
          >
            {archived ? (
              <ArchiveBoxXMarkIcon className="h-3 w-3 text-gray-400" />
            ) : (
              <ArchiveBoxArrowDownIcon className="h-3 w-3 text-gray-400" />
            )}
          </HeaderButtonWithToolTip>
          <HeaderButtonWithToolTip
            onClick={(e) => {
              e.stopPropagation();
              openSkillFile();
            }}
            text="Open SKILL.md"
          >
            <ArrowTopRightOnSquareIcon className="h-3 w-3 text-gray-400" />
          </HeaderButtonWithToolTip>
        </div>
      </div>

      <span
        className="mt-0.5 line-clamp-2 text-gray-400"
        style={{ fontSize: fontSize(-3) }}
      >
        {skill.description}
      </span>

      <div className="mt-1 flex flex-row flex-wrap items-center gap-1">
        <span
          className="text-gray-500"
          style={{ fontSize: fontSize(-4) }}
          data-testid={`skill-usage-${skill.name}`}
        >
          {usageSummary(skill)}
        </span>
        {usage?.createdBy === "agent" && <Badge>Learned by Lumina</Badge>}
        {usage?.state === "stale" && <Badge>Stale</Badge>}
        {archived && <Badge>Archived</Badge>}
      </div>

      <code
        className="mt-1 line-clamp-1 text-gray-500"
        style={{ fontSize: fontSize(-4) }}
      >
        {skill.path}
      </code>
    </div>
  );
}

export function SkillsSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const configLoading = useAppSelector((store) => store.config.loading);
  // The config copy carries no telemetry, but its reference changes whenever a
  // skill is created or edited on disk — which is exactly when this list goes
  // stale. Selected without a `?? []` default on purpose: that would allocate a
  // fresh array every render, and as an effect dependency it would re-fetch
  // forever.
  const configSkills = useAppSelector((store) => store.config.config.skills);

  const [skills, setSkills] = useState<SkillWithUsage[]>([]);
  const [plugins, setPlugins] = useState<LuminaPluginCatalogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [workshopOpen, setWorkshopOpen] = useState(false);
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [overwrite, setOverwrite] = useState(false);
  const [findings, setFindings] = useState<SkillLintFinding[]>([]);
  const [validated, setValidated] = useState(false);
  const [workshopError, setWorkshopError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      ideMessenger.request("skills/list", undefined),
      ideMessenger.request("plugins/list", undefined),
    ]).then(([skillsResult, pluginsResult]) => {
      if (cancelled) return;
      if (skillsResult.status === "success") setSkills(skillsResult.content);
      if (pluginsResult.status === "success") setPlugins(pluginsResult.content);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, configSkills]);

  const onCurate = useCallback(
    (name: string, action: SkillCurateAction) => {
      void ideMessenger
        .request("skills/curate", { name, action })
        .then((result) => {
          if (result.status === "success") {
            setSkills(result.content);
          }
        });
    },
    [ideMessenger],
  );

  const openNewWorkshop = () => {
    setDraft(EMPTY_DRAFT);
    setOverwrite(false);
    setFindings([]);
    setValidated(false);
    setWorkshopError(undefined);
    setWorkshopOpen(true);
  };

  const editSkill = (skill: SkillWithUsage) => {
    const scope: SkillScope = skill.path
      .replace(/\\/gu, "/")
      .startsWith(".continue/")
      ? "workspace"
      : "global";
    setDraft({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      scope,
    });
    setOverwrite(true);
    setFindings([]);
    setValidated(false);
    setWorkshopError(undefined);
    setWorkshopOpen(true);
  };

  const lintDraft = async () => {
    const result = await ideMessenger.request("skills/workshop/lint", draft);
    if (result.status === "success") {
      setFindings(result.content);
      setValidated(true);
      setWorkshopError(undefined);
    } else {
      setWorkshopError(result.error);
    }
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      const lint = await ideMessenger.request("skills/workshop/lint", draft);
      if (lint.status === "error") throw new Error(lint.error);
      setFindings(lint.content);
      setValidated(true);
      if (lint.content.some((finding) => finding.severity === "error")) return;
      const result = await ideMessenger.request("skills/workshop/save", {
        draft,
        overwrite,
      });
      if (result.status === "error") throw new Error(result.error);
      setSkills(result.content.skills);
      setWorkshopOpen(false);
      setWorkshopError(undefined);
    } catch (cause) {
      setWorkshopError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setPluginEnabled = async (id: string, enabled: boolean) => {
    const result = await ideMessenger.request("plugins/setEnabled", {
      id,
      enabled,
    });
    if (result.status === "success") setPlugins(result.content);
  };

  return (
    <>
      <ConfigHeader
        title="Skills"
        onAddClick={openNewWorkshop}
        addButtonTooltip="Nueva habilidad"
      />

      <div className="space-y-4">
        <p className="text-gray-400" style={{ fontSize: fontSize(-3) }}>
          Skills are reusable step-by-step procedures Lumina learns and recalls
          (procedural memory). Lumina saves them automatically with the{" "}
          <code>create_skill</code> tool after solving multi-step tasks, and
          reads them back with <code>read_skill</code>. You can also add them by
          hand as <code>SKILL.md</code> files under{" "}
          <code>.continue/skills</code> or <code>.claude/skills</code>.
        </p>
        <p className="text-gray-400" style={{ fontSize: fontSize(-3) }}>
          Archiving hides a skill from Lumina without deleting the file — she
          can still open it by name, and using it again restores it.
        </p>

        {workshopOpen && (
          <Card className="border-border border border-solid">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Skill Workshop</div>
                <div className="text-xs text-gray-400">
                  Diseña, valida y guarda procedimientos reutilizables sin salir
                  de Lumina Code.
                </div>
              </div>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-inherit"
                onClick={() => setWorkshopOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                Nombre
                <input
                  data-testid="skill-workshop-name"
                  className="border-border bg-vsc-background rounded border border-solid px-2 py-1.5 text-inherit"
                  value={draft.name}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                    setValidated(false);
                  }}
                  placeholder="release-checklist"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Alcance
                <select
                  data-testid="skill-workshop-scope"
                  className="border-border bg-vsc-background rounded border border-solid px-2 py-1.5 text-inherit"
                  value={draft.scope}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      scope: event.target.value as SkillScope,
                    });
                    setValidated(false);
                  }}
                >
                  <option value="workspace">Proyecto actual</option>
                  <option value="global">Global</option>
                </select>
              </label>
            </div>

            <label className="mt-3 flex flex-col gap-1 text-xs">
              Descripción de activación
              <input
                data-testid="skill-workshop-description"
                className="border-border bg-vsc-background rounded border border-solid px-2 py-1.5 text-inherit"
                value={draft.description}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                  setValidated(false);
                }}
                placeholder="Cuándo debe Lumina utilizar esta habilidad"
              />
            </label>

            <label className="mt-3 flex flex-col gap-1 text-xs">
              Procedimiento Markdown
              <textarea
                data-testid="skill-workshop-content"
                className="border-border bg-vsc-background min-h-40 resize-y rounded border border-solid p-2 font-mono text-inherit"
                value={draft.content}
                onChange={(event) => {
                  setDraft({ ...draft, content: event.target.value });
                  setValidated(false);
                }}
                spellCheck={false}
              />
            </label>

            {(validated || workshopError) && (
              <div className="mt-3 space-y-1 text-xs" aria-live="polite">
                {workshopError && (
                  <div className="text-[color:var(--vscode-errorForeground)]">
                    {workshopError}
                  </div>
                )}
                {!workshopError && findings.length === 0 && (
                  <div className="flex items-center gap-1 text-emerald-400">
                    <CheckCircleIcon className="h-4 w-4" /> Sin hallazgos
                  </div>
                )}
                {findings.map((finding, index) => (
                  <div
                    key={`${finding.rule}:${index}`}
                    className={
                      finding.severity === "error"
                        ? "text-[color:var(--vscode-errorForeground)]"
                        : "text-amber-400"
                    }
                  >
                    {finding.severity === "error" ? "Error" : "Aviso"}:{" "}
                    {finding.message}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="border-border cursor-pointer rounded border border-solid bg-transparent px-3 py-1.5 text-xs text-inherit"
                onClick={() => void lintDraft()}
              >
                Validar
              </button>
              <button
                data-testid="skill-workshop-save"
                type="button"
                disabled={busy}
                className="flex cursor-pointer items-center gap-1 rounded border-0 bg-[color:var(--vscode-button-background)] px-3 py-1.5 text-xs text-[color:var(--vscode-button-foreground)] disabled:opacity-50"
                onClick={() => void saveDraft()}
              >
                <PlusIcon className="h-4 w-4" />
                {overwrite ? "Guardar revisión" : "Crear habilidad"}
              </button>
            </div>
          </Card>
        )}

        <Card>
          {skills.length > 0 ? (
            <div className="flex flex-col gap-2">
              {skills.map((skill) => (
                <SkillCard
                  key={`${skill.path}:${skill.name}`}
                  skill={skill}
                  onCurate={onCurate}
                  onEdit={editSkill}
                />
              ))}
              {configLoading && (
                <div className="px-2 py-1.5 text-xs opacity-65">
                  Reloading skills from your config...
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              message={
                loaded
                  ? "No skills yet. Lumina will save skills here as she learns, or add a SKILL.md under .continue/skills."
                  : "Loading skills..."
              }
            />
          )}
        </Card>

        <div className="pt-2">
          <h3 className="mb-1 text-sm font-semibold">Plugins locales</h3>
          <p className="mb-2 text-xs text-gray-400">
            Lumina descubre manifiestos <code>plugin.json</code> y carga sus
            habilidades cuando están activos. El catálogo no ejecuta JavaScript
            arbitrario; las integraciones ejecutables continúan usando el
            contrato MCP y sus permisos.
          </p>
          <Card data-testid="plugin-catalog">
            {plugins.length === 0 ? (
              <EmptyState message="No hay plugins locales. Añade uno bajo .continue/plugins para que aparezca aquí." />
            ) : (
              <div className="flex flex-col gap-2">
                {plugins.map((plugin) => (
                  <div
                    key={plugin.id}
                    className="border-border flex items-center justify-between gap-3 border-0 border-b border-solid py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {plugin.name}{" "}
                        <span className="text-xs text-gray-500">
                          v{plugin.version}
                        </span>
                      </div>
                      <div className="line-clamp-2 text-xs text-gray-400">
                        {plugin.description || "Plugin local de Lumina Code"}
                      </div>
                      <div className="mt-0.5 text-[10px] text-gray-500">
                        {plugin.skillFiles.length} habilidad
                        {plugin.skillFiles.length === 1 ? "" : "es"} ·{" "}
                        {plugin.source === "workspace" ? "proyecto" : "global"}
                      </div>
                    </div>
                    <button
                      data-testid={`plugin-toggle-${plugin.id}`}
                      type="button"
                      className="border-border cursor-pointer rounded border border-solid bg-transparent px-2 py-1 text-xs text-inherit"
                      onClick={() =>
                        void setPluginEnabled(plugin.id, !plugin.enabled)
                      }
                    >
                      {plugin.enabled ? "Desactivar" : "Activar"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
