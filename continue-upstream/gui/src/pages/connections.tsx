import {
  ArrowRightIcon,
  BoltIcon,
  CircleStackIcon,
  CpuChipIcon,
  LinkIcon,
  MicrophoneIcon,
  PuzzlePieceIcon,
} from "@heroicons/react/24/outline";
import type { LuminaRuntimeStatus } from "core/protocol/ideWebview";
import type { StartTalkConfigStatus } from "core/startTalk/env";
import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppSelector } from "../redux/hooks";
import { CONFIG_ROUTES } from "../util/navigation";

type ConnectionCard = {
  title: string;
  description: string;
  detail: string;
  state: "connected" | "attention" | "offline";
  icon: typeof LinkIcon;
  action: string;
  path: string;
};

export default function ConnectionsPage() {
  const navigate = useNavigate();
  const ideMessenger = useContext(IdeMessengerContext);
  const config = useAppSelector((state) => state.config.config);
  const [runtime, setRuntime] = useState<LuminaRuntimeStatus>();
  const [talk, setTalk] = useState<StartTalkConfigStatus>();

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      ideMessenger.request("lumina/runtimeStatus", undefined),
      ideMessenger.request("startTalk/getConfigStatus", undefined),
    ]).then(([runtimeResult, talkResult]) => {
      if (disposed) return;
      if (runtimeResult.status === "success") setRuntime(runtimeResult.content);
      if (talkResult.status === "success") setTalk(talkResult.content);
    });
    return () => {
      disposed = true;
    };
  }, [ideMessenger]);

  const cards = useMemo<ConnectionCard[]>(() => {
    const models = config.modelsByRole?.chat ?? [];
    const mcpServers = config.mcpServerStatuses ?? [];
    const connectedMcp = mcpServers.filter(
      (server) => server.status === "connected",
    ).length;
    const windowsBridge = runtime?.components.find(
      (component) => component.name === "windowsBridge",
    );
    const modelRouter = runtime?.components.find(
      (component) => component.name === "modelRouter",
    );

    return [
      {
        title: "Modelos de IA",
        description:
          "Proveedores para chat, edición, aplicación y autocompletado.",
        detail: `${models.length} modelo${models.length === 1 ? "" : "s"} de chat configurado${models.length === 1 ? "" : "s"}`,
        state: models.length ? "connected" : "attention",
        icon: CpuChipIcon,
        action: "Administrar modelos",
        path: CONFIG_ROUTES.MODELS,
      },
      {
        title: "Servidores MCP",
        description:
          "Herramientas, recursos y prompts aportados por integraciones MCP.",
        detail: `${connectedMcp} de ${mcpServers.length} conectados`,
        state: connectedMcp
          ? "connected"
          : mcpServers.length
            ? "attention"
            : "offline",
        icon: PuzzlePieceIcon,
        action: "Abrir herramientas",
        path: CONFIG_ROUTES.TOOLS,
      },
      {
        title: "Start Talk",
        description:
          "Conversación de voz nativa y delegación autorizada al agente.",
        detail: talk?.configured
          ? `Configurado · ${talk.voiceName || "voz predeterminada"}`
          : "Gemini API pendiente",
        state: talk?.configured ? "connected" : "attention",
        icon: MicrophoneIcon,
        action: "Configurar voz",
        path: CONFIG_ROUTES.TALK,
      },
      {
        title: "Windows Bridge",
        description: "Acciones de escritorio sujetas a políticas y aprobación.",
        detail: windowsBridge?.status ?? "Comprobando",
        state:
          windowsBridge?.status === "connected"
            ? "connected"
            : windowsBridge?.status === "starting"
              ? "attention"
              : "offline",
        icon: BoltIcon,
        action: "Ver diagnóstico",
        path: CONFIG_ROUTES.RUNTIME,
      },
      {
        title: "Router de modelos",
        description:
          "Enrutamiento del modelo activo y servicios auxiliares del agente.",
        detail: modelRouter?.status ?? "Comprobando",
        state:
          modelRouter?.status === "connected"
            ? "connected"
            : modelRouter?.status === "starting"
              ? "attention"
              : "offline",
        icon: CircleStackIcon,
        action: "Ver runtime",
        path: CONFIG_ROUTES.RUNTIME,
      },
    ];
  }, [config.mcpServerStatuses, config.modelsByRole, runtime, talk]);

  const connected = cards.filter((card) => card.state === "connected").length;

  return (
    <div className="lumina-overview-page thin-scrollbar">
      <header className="lumina-overview-page__hero">
        <div className="lumina-overview-page__hero-icon">
          <LinkIcon />
        </div>
        <div>
          <span>Ecosistema</span>
          <h1>Conexiones</h1>
          <p>
            Una vista única de los servicios que amplían Lumina Code. Cada
            tarjeta refleja configuración o estado real del host.
          </p>
        </div>
        <div className="lumina-overview-page__metric">
          <strong>
            {connected}/{cards.length}
          </strong>
          <span>operativas</span>
        </div>
      </header>

      <section
        className="lumina-overview-grid"
        aria-label="Conexiones de Lumina"
      >
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.title} data-state={card.state}>
              <div className="lumina-overview-card__topline">
                <span className="lumina-overview-card__icon">
                  <Icon />
                </span>
                <span className="lumina-overview-card__status">
                  {card.state === "connected"
                    ? "Operativa"
                    : card.state === "attention"
                      ? "Requiere atención"
                      : "No configurada"}
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
