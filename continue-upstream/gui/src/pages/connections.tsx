import {
  ArrowRightIcon,
  BoltIcon,
  CircleStackIcon,
  CpuChipIcon,
  LinkIcon,
  MicrophoneIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import type {
  LuminaChannelId,
  LuminaChannelPatch,
  LuminaChannelSnapshot,
} from "core/channels/ChannelService";
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
  const [channels, setChannels] = useState<LuminaChannelSnapshot>();
  const [trustedDrafts, setTrustedDrafts] = useState<
    Partial<Record<LuminaChannelId, string>>
  >({});

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      ideMessenger.request("lumina/runtimeStatus", undefined),
      ideMessenger.request("startTalk/getConfigStatus", undefined),
      ideMessenger.request("channels/get", undefined),
    ]).then(([runtimeResult, talkResult, channelResult]) => {
      if (disposed) return;
      if (runtimeResult.status === "success") setRuntime(runtimeResult.content);
      if (talkResult.status === "success") setTalk(talkResult.content);
      if (channelResult.status === "success") {
        setChannels(channelResult.content);
        setTrustedDrafts(
          Object.fromEntries(
            channelResult.content.channels.map((channel) => [
              channel.id,
              channel.trustedSenders.join(", "),
            ]),
          ),
        );
      }
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

  const updateChannel = (id: LuminaChannelId, patch: LuminaChannelPatch) => {
    void ideMessenger
      .request("channels/update", { id, patch })
      .then((result) => {
        if (result.status === "success") setChannels(result.content);
      });
  };

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

      <section className="mx-auto mt-6 w-full max-w-6xl px-4 pb-8">
        <div className="mb-3 flex items-start gap-2">
          <ShieldCheckIcon className="mt-0.5 h-5 w-5 text-emerald-400" />
          <div>
            <h2 className="m-0 text-base font-semibold">
              Contratos de canales
            </h2>
            <p className="text-description mb-0 mt-1 text-xs">
              Manual permite leer o enviar desde una herramienta aprobada.
              Sugerencias solo redacta borradores para contactos confiables;
              nunca los envía. Full Access no puede omitir la confirmación.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(channels?.channels ?? []).map((channel) => (
            <article
              key={channel.id}
              data-testid={`channel-${channel.id}`}
              className="bg-editor border-border rounded-lg border border-solid p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="m-0 text-sm font-semibold">{channel.label}</h3>
                  <div className="mt-0.5 text-[10px] text-emerald-400">
                    Confirmación explícita obligatoria
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    data-testid={`channel-enabled-${channel.id}`}
                    type="checkbox"
                    checked={channel.enabled}
                    onChange={(event) =>
                      updateChannel(channel.id, {
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {channel.enabled ? "Activo" : "Desactivado"}
                </label>
              </div>

              <label className="mt-3 flex flex-col gap-1 text-xs">
                Ingreso de notificaciones
                <select
                  data-testid={`channel-mode-${channel.id}`}
                  className="border-border bg-vsc-background rounded border border-solid px-2 py-1.5 text-inherit"
                  value={channel.mode}
                  disabled={!channel.enabled}
                  onChange={(event) =>
                    updateChannel(channel.id, {
                      mode: event.target.value as "manual" | "suggest",
                    })
                  }
                >
                  <option value="manual">Solo manual</option>
                  <option value="suggest">Sugerir borradores</option>
                </select>
              </label>

              <label className="mt-3 flex flex-col gap-1 text-xs">
                Contactos confiables (separados por coma)
                <div className="flex gap-2">
                  <input
                    data-testid={`channel-trusted-${channel.id}`}
                    className="border-border bg-vsc-background min-w-0 flex-1 rounded border border-solid px-2 py-1.5 text-inherit"
                    value={trustedDrafts[channel.id] ?? ""}
                    disabled={!channel.enabled}
                    onChange={(event) =>
                      setTrustedDrafts((current) => ({
                        ...current,
                        [channel.id]: event.target.value,
                      }))
                    }
                    placeholder="Ana, Equipo soporte"
                  />
                  <button
                    type="button"
                    className="cursor-pointer rounded border-0 bg-[color:var(--vscode-button-background)] px-3 text-xs text-[color:var(--vscode-button-foreground)] disabled:opacity-50"
                    disabled={!channel.enabled}
                    onClick={() =>
                      updateChannel(channel.id, {
                        trustedSenders: (trustedDrafts[channel.id] ?? "")
                          .split(",")
                          .map((sender) => sender.trim())
                          .filter(Boolean),
                      })
                    }
                  >
                    Guardar
                  </button>
                </div>
              </label>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
