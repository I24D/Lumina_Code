import {
  AcademicCapIcon,
  ArrowRightIcon,
  CircleStackIcon,
  DocumentTextIcon,
  LightBulbIcon,
} from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSelector } from "../redux/hooks";
import { CONFIG_ROUTES } from "../util/navigation";

export default function KnowledgePage() {
  const navigate = useNavigate();
  const config = useAppSelector((state) => state.config.config);
  const statuses = useAppSelector((state) => state.indexing.indexing.statuses);
  const indexing = useMemo(() => Object.values(statuses), [statuses]);
  const running = indexing.filter(
    (status) => status.status === "indexing",
  ).length;
  const rules = config.rules ?? [];
  const skills = config.skills ?? [];

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
