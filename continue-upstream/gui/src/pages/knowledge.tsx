import {
  AcademicCapIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  CircleStackIcon,
  DocumentTextIcon,
  LightBulbIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { MemoryOverview } from "core/protocol/core";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppSelector } from "../redux/hooks";
import { CONFIG_ROUTES } from "../util/navigation";

export default function KnowledgePage() {
  const navigate = useNavigate();
  const ideMessenger = useContext(IdeMessengerContext);
  const config = useAppSelector((state) => state.config.config);
  const statuses = useAppSelector((state) => state.indexing.indexing.statuses);
  const indexing = useMemo(() => Object.values(statuses), [statuses]);
  const running = indexing.filter(
    (status) => status.status === "indexing",
  ).length;
  const rules = config.rules ?? [];
  const skills = config.skills ?? [];
  const [memory, setMemory] = useState<MemoryOverview>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [clearArmed, setClearArmed] = useState(false);

  const loadMemory = useCallback(
    async (search?: string) => {
      setBusy(true);
      try {
        const result = await ideMessenger.request("memory/get", {
          query: search?.trim() || undefined,
          limit: 50,
        });
        if (result.status === "error") throw new Error(result.error);
        setMemory(result.content);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [ideMessenger],
  );

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  const deleteMemory = async (id: string) => {
    setBusy(true);
    try {
      const result = await ideMessenger.request("memory/delete", { id });
      if (result.status === "error") throw new Error(result.error);
      setMemory(result.content);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const syncMemory = async () => {
    setBusy(true);
    try {
      const result = await ideMessenger.request("memory/sync", undefined);
      if (result.status === "error") throw new Error(result.error);
      setMemory(result.content);
      setError(result.content.sync.lastError);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const clearMemory = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setBusy(true);
    try {
      const result = await ideMessenger.request("memory/clear", undefined);
      if (result.status === "error") throw new Error(result.error);
      setMemory(result.content);
      setClearArmed(false);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cards = [
    {
      title: "Contexto del proyecto",
      description:
        "Índice de código y documentación que Lumina consulta para comprender el workspace.",
      detail: config.disableIndexing
        ? "Indexación desactivada"
        : running
          ? `${running} proceso${running === 1 ? "" : "s"} indexando`
          : `${indexing.length} fuente${indexing.length === 1 ? "" : "s"} registradas`,
      icon: CircleStackIcon,
      path: CONFIG_ROUTES.INDEXING,
      action: "Administrar contexto",
    },
    {
      title: "Reglas",
      description:
        "Instrucciones persistentes que definen cómo debe trabajar Lumina en el proyecto.",
      detail: `${rules.length} regla${rules.length === 1 ? "" : "s"} disponible${rules.length === 1 ? "" : "s"}`,
      icon: DocumentTextIcon,
      path: CONFIG_ROUTES.RULES,
      action: "Revisar reglas",
    },
    {
      title: "Habilidades",
      description:
        "Procedimientos reutilizables que amplían el comportamiento del agente sin duplicar el core.",
      detail: `${skills.length} habilidad${skills.length === 1 ? "" : "es"} disponible${skills.length === 1 ? "" : "s"}`,
      icon: AcademicCapIcon,
      path: CONFIG_ROUTES.SKILLS,
      action: "Explorar habilidades",
    },
    {
      title: "Configuraciones",
      description:
        "Perfiles y bloques que organizan modelos, prompts, contexto y herramientas.",
      detail: "Configuración activa del workspace",
      icon: LightBulbIcon,
      path: CONFIG_ROUTES.CONFIGS,
      action: "Abrir configuraciones",
    },
  ];

  return (
    <div className="lumina-overview-page thin-scrollbar">
      <header className="lumina-overview-page__hero">
        <div className="lumina-overview-page__hero-icon">
          <CircleStackIcon />
        </div>
        <div>
          <span>Memoria de trabajo</span>
          <h1>Conocimiento</h1>
          <p>
            Controla las fuentes que dan contexto al agente. Lumina no presenta
            memoria oculta: aquí se muestran los mecanismos configurables que
            realmente existen en el proyecto.
          </p>
        </div>
      </header>

      <section className="mb-4 rounded-xl border border-solid border-[color:var(--vscode-panel-border)] bg-[color:var(--vscode-sideBar-background)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm">Memoria persistente del agente</h2>
            <p className="m-0 mt-1 text-xs opacity-60">
              Experiencias, reflexiones y candidatos de habilidades conservados
              entre reinicios.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent px-2 py-1.5 text-xs disabled:opacity-50"
              onClick={() => void loadMemory(query)}
            >
              <ArrowPathIcon
                className={`h-4 w-4 ${busy ? "animate-spin" : ""}`}
              />
              Actualizar
            </button>
            <button
              type="button"
              disabled={busy || !memory?.sync.configured}
              className="flex cursor-pointer items-center gap-1 rounded border border-solid border-[color:var(--vscode-button-border)] bg-transparent px-2 py-1.5 text-xs disabled:cursor-default disabled:opacity-40"
              title={
                memory?.sync.configured
                  ? "Sincronizar ahora"
                  : "Configura Supabase para habilitar la sincronización"
              }
              onClick={() => void syncMemory()}
            >
              <CircleStackIcon className="h-4 w-4" /> Sincronizar
            </button>
            <button
              type="button"
              disabled={busy || !memory?.snapshot.experiences.length}
              className={`flex cursor-pointer items-center gap-1 rounded border border-solid px-2 py-1.5 text-xs disabled:cursor-default disabled:opacity-40 ${
                clearArmed
                  ? "border-red-500/60 bg-red-500/10 text-red-300"
                  : "border-[color:var(--vscode-button-border)] bg-transparent"
              }`}
              onBlur={() => setClearArmed(false)}
              onClick={() => void clearMemory()}
            >
              <TrashIcon className="h-4 w-4" />
              {clearArmed ? "Confirmar borrado" : "Borrar memoria"}
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Experiencias", memory?.snapshot.experiences.length ?? 0],
            ["Reflexiones", memory?.snapshot.insights.length ?? 0],
            ["Skills sugeridas", memory?.snapshot.skillCandidates.length ?? 0],
            [
              "Réplica",
              memory?.sync.provider === "supabase"
                ? memory.sync.state
                : "Solo local",
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded bg-white/5 p-2">
              <div className="text-[10px] uppercase opacity-55">{label}</div>
              <div className="mt-1 truncate text-sm font-semibold">{value}</div>
            </div>
          ))}
        </div>

        {memory?.sync.provider === "local" && (
          <p className="m-0 mt-2 text-[11px] opacity-55">
            Supabase es opcional. Sin credenciales, toda la memoria continúa
            funcionando y guardándose localmente.
          </p>
        )}
        {memory?.sync.lastSyncAt && (
          <p className="m-0 mt-2 text-[11px] opacity-55">
            Última sincronización:{" "}
            {new Date(memory.sync.lastSyncAt).toLocaleString()}
          </p>
        )}
        {error && (
          <div className="mt-2 rounded border border-solid border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <form
          className="mt-3 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void loadMemory(query);
          }}
        >
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded border border-solid border-[color:var(--vscode-input-border)] bg-[color:var(--vscode-input-background)] px-2">
            <MagnifyingGlassIcon className="h-4 w-4 flex-none opacity-50" />
            <input
              aria-label="Buscar memoria"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-[color:var(--vscode-input-foreground)] outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar una experiencia, error o herramienta…"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="cursor-pointer rounded border-0 bg-[color:var(--vscode-button-background)] px-3 text-xs text-[color:var(--vscode-button-foreground)] disabled:opacity-50"
          >
            Buscar
          </button>
        </form>

        {(query.trim() ? memory?.matches : memory?.snapshot.experiences)
          ?.length ? (
          <div className="thin-scrollbar mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {(query.trim()
              ? memory?.matches.map((match) => match.item)
              : [...(memory?.snapshot.experiences ?? [])].reverse().slice(0, 30)
            )?.map((experience) => (
              <article
                key={experience.id}
                className="flex items-start gap-2 rounded border border-solid border-[color:var(--vscode-panel-border)] p-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="text-xs">{experience.goal}</strong>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase opacity-60">
                      {experience.outcome}
                    </span>
                  </div>
                  <p className="m-0 mt-1 text-xs leading-5 opacity-65">
                    {experience.summary}
                  </p>
                  <small className="opacity-45">
                    {new Date(experience.createdAt).toLocaleString()}
                    {experience.toolNames.length
                      ? ` · ${experience.toolNames.join(", ")}`
                      : ""}
                  </small>
                </div>
                <button
                  type="button"
                  aria-label={`Olvidar ${experience.goal}`}
                  disabled={busy}
                  className="cursor-pointer border-0 bg-transparent p-1 opacity-50 hover:text-red-300 hover:opacity-100"
                  onClick={() => void deleteMemory(experience.id)}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="m-0 mt-3 rounded bg-white/5 p-3 text-xs opacity-55">
            {query.trim()
              ? "No hay recuerdos que coincidan."
              : "La memoria se llenará con resultados verificables de herramientas."}
          </p>
        )}
      </section>

      <section
        className="lumina-overview-grid"
        aria-label="Fuentes de conocimiento"
      >
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.title} data-state="connected">
              <div className="lumina-overview-card__topline">
                <span className="lumina-overview-card__icon">
                  <Icon />
                </span>
              </div>
              <h2>{card.title}</h2>
              <p>{card.description}</p>
              <code>{card.detail}</code>
              <button type="button" onClick={() => navigate(card.path)}>
                {card.action}
                <ArrowRightIcon />
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}
