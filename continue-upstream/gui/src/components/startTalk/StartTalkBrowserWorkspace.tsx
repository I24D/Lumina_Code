import {
  ArrowTopRightOnSquareIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  ClockIcon,
  CommandLineIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  SpeakerWaveIcon,
} from "@heroicons/react/24/outline";
import type { CSSProperties, ComponentType, SVGProps } from "react";
import { useMemo, useState } from "react";
import styled, { css, keyframes } from "styled-components";

import { LuminaEnergyCore } from "./LuminaEnergyCore";
import { safeSearchSourceUrl } from "./WebSearchActivityCard";
import type { VoiceRuntimeState } from "core/startTalk";
import type {
  StartTalkStatus,
  StartTalkToolActivity,
  StartTalkTranscriptItem,
} from "./types";

type WorkspaceProps = {
  assistantTranscript: string;
  micLevel: number;
  onOpenUrl: (url: string) => void;
  status: StartTalkStatus;
  runtimeState?: VoiceRuntimeState;
  toolActivities: StartTalkToolActivity[];
  transcriptEntries: StartTalkTranscriptItem[];
  userTranscript: string;
};

type DisplayTurn = StartTalkTranscriptItem & { live?: boolean };

const waveform = [
  0.26, 0.44, 0.72, 0.38, 0.56, 0.88, 0.47, 0.7, 0.36, 0.6, 0.94, 0.52, 0.78,
  0.4, 0.64, 0.3, 0.74, 0.48, 0.9, 0.58, 0.35, 0.68, 0.46, 0.82, 0.4, 0.7, 0.52,
  0.92, 0.58, 0.38, 0.76, 0.46, 0.86, 0.54, 0.32, 0.66, 0.42, 0.78, 0.48, 0.64,
  0.34, 0.56, 0.3, 0.48, 0.25, 0.4, 0.2,
];

const previewNow = Date.now();
const previewTranscripts: StartTalkTranscriptItem[] = [
  {
    id: "preview-user-1",
    role: "user",
    text: "¿Puedes buscar información sobre las últimas noticias de inteligencia artificial hoy?",
    createdAt: previewNow - 180_000,
  },
  {
    id: "preview-assistant-1",
    role: "assistant",
    text: "He encontrado varias noticias recientes sobre inteligencia artificial. Aquí tienes un resumen de los puntos más importantes:\n• OpenAI presenta nuevos avances en GPT-5\n• Google amplía las capacidades multimodales de Gemini\n• Microsoft integra IA avanzada en todas sus aplicaciones\n• Nuevas regulaciones globales sobre el uso ético de la IA",
    createdAt: previewNow - 60_000,
  },
  {
    id: "preview-user-2",
    role: "user",
    text: "También necesito que me ayudes a crear un resumen con los puntos más importantes.",
    createdAt: previewNow - 120_000,
  },
  {
    id: "preview-assistant-2",
    role: "assistant",
    text: "He programado una tarea para enviarte un informe completo mañana a las 9:00 a. m. Incluirá análisis detallado, fuentes adicionales y recomendaciones personalizadas.",
    createdAt: previewNow,
  },
  {
    id: "preview-user-3",
    role: "user",
    text: "Además, ¿puedes delegar una tarea para que me avises mañana con un informe completo?",
    createdAt: previewNow - 60_000,
  },
];

const previewActivities: StartTalkToolActivity[] = [
  {
    id: "preview-search",
    label: "Buscando en Internet",
    detail: "Consultando las últimas noticias sobre inteligencia artificial…",
    status: "done",
    webSearch: {
      query: "últimas noticias de inteligencia artificial",
      provider: "web",
      answer: "Resumen contrastado con cuatro fuentes.",
      visibility: "payload",
      sources: [
        {
          title: "OpenAI Blog · GPT-5 Announcements",
          url: "https://openai.com/index/gpt-5/",
        },
        {
          title: "Google DeepMind · Gemini",
          url: "https://deepmind.google/technologies/gemini/",
        },
        {
          title: "Microsoft AI Blog",
          url: "https://blogs.microsoft.com/ai/",
        },
        {
          title: "Reuters · AI Global Regulations",
          url: "https://www.reuters.com/technology/artificial-intelligence/",
        },
      ],
    },
  },
  {
    id: "preview-analysis",
    label: "Analizando información",
    detail: "Extrayendo y analizando los puntos más importantes…",
    status: "done",
  },
  {
    id: "preview-summary",
    label: "Generando resumen",
    detail: "Creando un resumen claro y conciso con la información encontrada…",
    status: "done",
  },
  {
    id: "preview-delegation",
    label: "Delegando tarea",
    detail: "Programando informe completo para mañana a las 9:00 a. m.",
    status: "waiting",
  },
];

const waveMove = keyframes`
  0%, 100% { transform: scaleY(0.46); opacity: 0.52; }
  45% { transform: scaleY(1); opacity: 1; }
`;

const Workspace = styled.main`
  display: grid;
  width: min(calc(100% - 20px), 1540px);
  min-height: 0;
  box-sizing: border-box;
  flex: 1;
  grid-template-columns:
    minmax(250px, 1fr)
    minmax(285px, 0.88fr)
    minmax(292px, 1.1fr);
  align-self: center;
  gap: 10px;
  overflow: hidden;
  margin-inline: auto;
  padding: 8px 0 10px;

  @media (max-width: 1000px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: auto minmax(520px, 1fr);
    align-content: start;
    overflow-x: hidden;
    overflow-y: auto;
    padding-bottom: 16px;

    > section:nth-child(2) {
      display: grid;
      grid-column: 1 / -1;
      grid-row: 1;
      min-height: 320px;
      grid-template-columns: minmax(250px, 0.82fr) minmax(330px, 1.18fr);
      gap: 10px;
    }

    > section:not(:nth-child(2)) {
      min-height: 520px;
    }
  }

  @media (max-width: 680px) {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 10px;
    margin-inline: 0;
    padding: 8px 10px 16px;

    > section {
      width: 100%;
      min-height: min(560px, calc(100vh - 132px));
      flex: 0 0 auto;
    }

    > section:nth-child(2) {
      display: flex;
      min-height: 560px;
      grid-template-columns: none;
      order: -1;
    }
  }

  @media (max-width: 420px) {
    padding-inline: 7px;

    > section {
      min-height: 520px;
    }

    > section:nth-child(2) {
      min-height: 540px;
    }
  }
`;

const VoiceColumn = styled.section<{ $side: "assistant" | "user" }>`
  --column-accent: ${({ $side }) => ($side === "user" ? "#10c9ed" : "#f19a20")};
  --column-accent-soft: ${({ $side }) =>
    $side === "user" ? "rgba(16, 201, 237, 0.12)" : "rgba(241, 154, 32, 0.11)"};

  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--column-accent) 58%, transparent);
  border-radius: 18px;
  background:
    radial-gradient(
      circle at 50% 0,
      color-mix(in srgb, var(--column-accent) 7%, transparent),
      transparent 36%
    ),
    linear-gradient(180deg, rgba(10, 18, 25, 0.96), rgba(7, 14, 19, 0.98));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.025),
    0 16px 48px rgba(0, 0, 0, 0.18);
`;

const VoiceHeading = styled.div`
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 18px 16px 8px;
`;

const VoiceIcon = styled.div`
  display: grid;
  width: 36px;
  height: 36px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--column-accent) 58%, transparent);
  border-radius: 50%;
  background: var(--column-accent-soft);
  color: var(--column-accent);
  place-items: center;

  svg {
    width: 20px;
    height: 20px;
    stroke-width: 1.8;
  }
`;

const VoiceHeadingCopy = styled.div`
  display: grid;
  min-width: 0;
  gap: 4px;
`;

const VoiceTitle = styled.h2`
  margin: 0;
  color: #eef3f7;
  font-size: 13px;
  font-weight: 760;
  letter-spacing: 0.025em;
  line-height: 1.2;
`;

const VoiceSubtitle = styled.div`
  color: #8f9aa4;
  font-size: 11px;
  line-height: 1.3;
`;

const Wave = styled.div<{ $active: boolean }>`
  display: flex;
  height: 64px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 1px;
  margin: 3px 14px 9px;
  overflow: hidden;
  opacity: ${({ $active }) => ($active ? 0.98 : 0.56)};

  span {
    width: 2px;
    min-width: 2px;
    height: calc(58px * var(--bar-height));
    flex: 0 0 2px;
    border-radius: 999px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--column-accent) 62%, #23f29d),
      var(--column-accent)
    );
    transform-origin: center;
    ${({ $active }) =>
      $active &&
      css`
        animation: ${waveMove} 820ms ease-in-out infinite;
      `}
  }

  @media (prefers-reduced-motion: reduce) {
    span {
      animation: none;
    }
  }
`;

const Messages = styled.div<{ $role: "assistant" | "user" }>`
  display: flex;
  min-height: 0;
  flex: ${({ $role }) => ($role === "user" ? "1" : "0 1 auto")};
  flex-direction: column;
  gap: ${({ $role }) => ($role === "user" ? "16px" : "10px")};
  overflow: auto;
  padding: ${({ $role }) =>
    $role === "user" ? "8px 14px 14px" : "1px 14px 8px"};
  scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
  scrollbar-width: thin;

  ${({ $role }) =>
    $role === "assistant" &&
    css`
      > article:first-child:not(:last-child) {
        min-height: 265px;
      }
    `}
`;

const MessageCard = styled.article<{ $side: "assistant" | "user" }>`
  position: relative;
  display: grid;
  min-height: ${({ $side }) => ($side === "user" ? "143px" : "auto")};
  box-sizing: border-box;
  gap: 8px;
  border: 1px solid
    color-mix(in srgb, var(--column-accent) 27%, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  background: linear-gradient(
    145deg,
    rgba(18, 29, 37, 0.95),
    rgba(13, 22, 29, 0.92)
  );
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
  padding: ${({ $side }) =>
    $side === "user" ? "14px 15px 10px" : "14px 15px 4px"};
`;

const MessageRole = styled.div`
  color: var(--column-accent);
  font-size: 11px;
  font-weight: 760;
`;

const MessageText = styled.div`
  color: #dce3e8;
  font-size: clamp(13px, 1.22vw, 15px);
  line-height: 1.43;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`;

const MessageTime = styled.time`
  position: absolute;
  right: 14px;
  bottom: 10px;
  color: #73808a;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
`;

const EmptyState = styled.div`
  display: grid;
  min-height: 180px;
  flex: 1;
  align-content: center;
  justify-items: center;
  color: #687580;
  font-size: 11px;
  line-height: 1.5;
  padding: 20px;
  text-align: center;
`;

const CenterColumn = styled.section`
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 9px;
  overflow: hidden;
`;

const CoreStage = styled.div`
  display: grid;
  min-height: 235px;
  flex: 0 0 235px;
  place-items: center;
  overflow: hidden;
  border-radius: 18px;
  background:
    radial-gradient(
      circle at 50% 50%,
      rgba(0, 162, 255, 0.12),
      transparent 42%
    ),
    linear-gradient(180deg, rgba(7, 15, 21, 0.3), transparent);

  > div {
    width: min(100%, 290px);
  }
`;

const ActionPanel = styled.div`
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(108, 150, 178, 0.23);
  border-radius: 17px;
  background: linear-gradient(
    180deg,
    rgba(14, 23, 30, 0.95),
    rgba(9, 17, 23, 0.98)
  );
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
  padding: 11px;
`;

const ActionTitle = styled.div`
  flex: 0 0 auto;
  color: #d9e1e6;
  font-size: 11px;
  font-weight: 760;
  letter-spacing: 0.025em;
  padding: 2px 2px 10px;
`;

const ActionList = styled.div`
  display: grid;
  min-height: 0;
  gap: 7px;
  overflow: auto;
  scrollbar-width: thin;
`;

const ActionRow = styled.div`
  display: grid;
  min-height: 55px;
  box-sizing: border-box;
  grid-template-columns: 35px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  border: 1px solid rgba(111, 149, 174, 0.17);
  border-radius: 10px;
  background: rgba(20, 31, 39, 0.82);
  padding: 8px 9px;

  @media (max-width: 480px) {
    grid-template-columns: 35px minmax(0, 1fr) 12px;
    gap: 6px;
    padding-right: 7px;
    padding-left: 7px;
  }
`;

const ActionIcon = styled.div<{ $tone: "blue" | "purple" }>`
  display: grid;
  width: 33px;
  height: 33px;
  box-sizing: border-box;
  border: 1px solid
    ${({ $tone }) => ($tone === "purple" ? "#8057c8" : "#087eaa")};
  border-radius: 50%;
  background: ${({ $tone }) =>
    $tone === "purple" ? "rgba(102, 55, 172, 0.2)" : "rgba(0, 137, 193, 0.19)"};
  color: ${({ $tone }) => ($tone === "purple" ? "#b78cff" : "#27c9f4")};
  place-items: center;

  svg {
    width: 18px;
    height: 18px;
  }
`;

const ActionCopy = styled.div`
  display: grid;
  min-width: 0;
  gap: 2px;
`;

const ActionLabel = styled.div`
  overflow: hidden;
  color: #e3e9ed;
  font-size: 10.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ActionDetail = styled.div`
  display: -webkit-box;
  overflow: hidden;
  color: #8f9aa4;
  font-size: 9.5px;
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
`;

const ActionState = styled.div<{ $status: StartTalkToolActivity["status"] }>`
  display: flex;
  align-items: center;
  gap: 3px;
  color: ${({ $status }) => {
    if ($status === "error") return "#ff777e";
    if ($status === "waiting") return "#b88cff";
    if ($status === "done") return "#47e6a4";
    return "#3bcaf3";
  }};
  font-size: 8px;
  white-space: nowrap;

  svg {
    width: 12px;
    height: 12px;
  }

  @media (max-width: 480px) {
    span {
      display: none;
    }
  }
`;

const ActionFooter = styled.button`
  display: flex;
  width: 100%;
  min-height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
  border: 1px solid rgba(111, 149, 174, 0.18);
  border-radius: 9px;
  background: transparent;
  color: #c5ced4;
  cursor: pointer;
  font-size: 9px;
  font-weight: 680;

  &:hover,
  &:focus-visible {
    border-color: rgba(39, 201, 244, 0.45);
    background: rgba(39, 201, 244, 0.05);
  }
`;

const SourcesCard = styled.div`
  display: grid;
  flex: 0 0 auto;
  gap: 6px;
  border: 1px solid rgba(241, 154, 32, 0.3);
  border-radius: 12px;
  background: rgba(14, 23, 30, 0.94);
  margin: 0 14px 10px;
  padding: 10px;
`;

const SourcesTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  color: #ee9a21;
  font-size: 9px;
  font-weight: 760;
  letter-spacing: 0.035em;
`;

const SourcesList = styled.ol`
  display: grid;
  gap: 5px;
  margin: 0;
  color: #d1d8dd;
  font-size: 8.5px;
  padding-left: 18px;
`;

const SourceButton = styled.button`
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) minmax(65px, 0.7fr) 12px;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-align: left;

  &:hover strong,
  &:focus-visible strong {
    color: #ffffff;
  }

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-weight: 520;
  }

  span {
    color: #5fa5c9;
    font-size: 8px;
    text-align: right;
  }

  svg {
    width: 10px;
    height: 10px;
    color: #87939c;
  }
`;

function formatTime(value: number) {
  const date = new Date(value);
  const hour = date.getHours();
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(date.getMinutes()).padStart(2, "0")} ${
    hour < 12 ? "a. m." : "p. m."
  }`;
}

function turnsForRole(
  entries: StartTalkTranscriptItem[],
  role: StartTalkTranscriptItem["role"],
  liveText: string,
): DisplayTurn[] {
  const turns: DisplayTurn[] = entries
    .filter((entry) => entry.role === role)
    .slice(-12);
  const cleanLive = liveText.replace(/\s+/gu, " ").trim();
  const latest = turns.at(-1);
  if (
    cleanLive &&
    latest?.text !== cleanLive &&
    !latest?.text.startsWith(cleanLive)
  ) {
    return turns.concat({
      id: `${role}-live`,
      role,
      text: cleanLive,
      createdAt: Date.now(),
      live: true,
    });
  }
  return turns;
}

function VoiceWave({ active, level }: { active: boolean; level: number }) {
  return (
    <Wave $active={active} aria-hidden="true">
      {waveform.map((height, index) => (
        <span
          key={index}
          style={
            {
              "--bar-height": Math.min(
                1,
                height * (active ? 0.82 + level * 0.55 : 0.55),
              ),
              animationDelay: `${(index % 9) * -73}ms`,
            } as CSSProperties
          }
        />
      ))}
    </Wave>
  );
}

function MessageList({
  empty,
  role,
  turns,
}: {
  empty: string;
  role: StartTalkTranscriptItem["role"];
  turns: DisplayTurn[];
}) {
  if (!turns.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <Messages $role={role} aria-live="polite">
      {turns.map((turn) => (
        <MessageCard
          key={turn.id}
          $side={role === "user" ? "user" : "assistant"}
        >
          <MessageRole>{role === "user" ? "Tú" : "Start Talk"}</MessageRole>
          <MessageText>{turn.text}</MessageText>
          <MessageTime dateTime={new Date(turn.createdAt).toISOString()}>
            {turn.live ? "ahora" : formatTime(turn.createdAt)}
          </MessageTime>
        </MessageCard>
      ))}
    </Messages>
  );
}

type OutlineIcon = ComponentType<SVGProps<SVGSVGElement>>;

function activityIcon(activity: StartTalkToolActivity): {
  Icon: OutlineIcon;
  tone: "blue" | "purple";
} {
  const label = `${activity.label} ${activity.detail ?? ""}`.toLowerCase();
  if (activity.webSearch) return { Icon: GlobeAltIcon, tone: "blue" };
  if (label.includes("analiz"))
    return { Icon: MagnifyingGlassIcon, tone: "blue" };
  if (label.includes("resumen") || label.includes("informe"))
    return { Icon: DocumentTextIcon, tone: "blue" };
  if (label.includes("program") || label.includes("deleg"))
    return { Icon: CalendarDaysIcon, tone: "purple" };
  return { Icon: CommandLineIcon, tone: "blue" };
}

function stateLabel(status: StartTalkToolActivity["status"]) {
  if (status === "done") return "Completado";
  if (status === "waiting") return "Programado";
  if (status === "error") return "Error";
  return "En curso";
}

function StateIcon({ status }: { status: StartTalkToolActivity["status"] }) {
  if (status === "done") return <CheckCircleIcon />;
  if (status === "error") return <ExclamationCircleIcon />;
  return <ClockIcon />;
}

function ActivityRow({ activity }: { activity: StartTalkToolActivity }) {
  const { Icon, tone } = activityIcon(activity);
  return (
    <ActionRow>
      <ActionIcon $tone={tone}>
        <Icon />
      </ActionIcon>
      <ActionCopy>
        <ActionLabel>{activity.label}</ActionLabel>
        <ActionDetail>
          {activity.detail ||
            activity.webSearch?.query ||
            "Lumina está procesando esta acción."}
        </ActionDetail>
      </ActionCopy>
      <ActionState $status={activity.status}>
        <span>{stateLabel(activity.status)}</span>
        <StateIcon status={activity.status} />
      </ActionState>
    </ActionRow>
  );
}

function fallbackActivity(
  status: StartTalkStatus,
  runtimeState?: VoiceRuntimeState,
): StartTalkToolActivity {
  const listening = status === "listening" || status === "connected";
  const speaking = status === "speaking";
  const phase = runtimeState ?? (speaking ? "ASSISTANT_SPEAKING" : undefined);
  const labels: Partial<Record<VoiceRuntimeState, [string, string]>> = {
    USER_SPEAKING: ["Entendiendo solicitud", "Transcripción parcial en curso."],
    THINKING: ["Preparando respuesta", "El modelo está razonando en tiempo real."],
    TOOL_EXECUTION: [
      "Ejecutando herramientas",
      "Consultando las fuentes y servicios necesarios.",
    ],
    RECONNECTING: [
      "Recuperando la sesión",
      "Reconectando sin perder el estado válido de la conversación.",
    ],
    INTERRUPTED: [
      "Interrupción detectada",
      "Se canceló la respuesta anterior y se abrió un turno nuevo.",
    ],
  };
  const phaseCopy = phase ? labels[phase] : undefined;
  return {
    id: "voice-session-state",
    label: phaseCopy?.[0] ?? (speaking
      ? "Generando respuesta"
      : listening
        ? "Escuchando tu conversación"
        : "Preparando Lumina Live"),
    detail: phaseCopy?.[1] ?? (speaking
      ? "Start Talk está generando texto y audio en tiempo real."
      : listening
        ? "Lista para comprender, investigar y responder."
        : "Conectando voz, micrófono y herramientas."),
    status:
      status === "error"
        ? "error"
        : listening
          ? "done"
          : speaking
            ? "running"
            : "waiting",
  };
}

export function StartTalkBrowserWorkspace({
  assistantTranscript,
  micLevel,
  onOpenUrl,
  status,
  runtimeState,
  toolActivities,
  transcriptEntries,
  userTranscript,
}: WorkspaceProps) {
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const designPreview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("luminaOrbPreview") ===
      "demo";
  const visibleTranscripts = designPreview
    ? previewTranscripts
    : transcriptEntries;
  const activities = designPreview ? previewActivities : toolActivities;
  const userTurns = turnsForRole(
    visibleTranscripts,
    "user",
    designPreview ? "" : userTranscript,
  );
  const assistantTurns = turnsForRole(
    visibleTranscripts,
    "assistant",
    designPreview ? "" : assistantTranscript,
  );
  const visibleActivities = activities.length
    ? activities.slice(-7)
    : [fallbackActivity(status, runtimeState)];
  const displayedActivities = actionsExpanded
    ? visibleActivities
    : visibleActivities.slice(-4);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    return activities
      .flatMap((activity) => activity.webSearch?.sources ?? [])
      .flatMap((source) => {
        const url = safeSearchSourceUrl(source.url);
        if (!url || seen.has(url)) return [];
        seen.add(url);
        return [{ ...source, url }];
      })
      .slice(-6);
  }, [activities]);

  return (
    <Workspace data-testid="start-talk-browser-workspace">
      <VoiceColumn $side="user">
        <VoiceHeading>
          <VoiceIcon>
            <MicrophoneIcon />
          </VoiceIcon>
          <VoiceHeadingCopy>
            <VoiceTitle>TÚ HABLAS</VoiceTitle>
            <VoiceSubtitle>Start Talk lo traduce en texto</VoiceSubtitle>
          </VoiceHeadingCopy>
        </VoiceHeading>
        <VoiceWave
          active={status === "listening"}
          level={Math.max(0.18, micLevel)}
        />
        <MessageList
          empty="Tu conversación aparecerá aquí mientras hablas."
          role="user"
          turns={userTurns}
        />
      </VoiceColumn>

      <CenterColumn>
        <CoreStage>
          <LuminaEnergyCore large micLevel={micLevel} roomy status={status} />
        </CoreStage>
        <ActionPanel>
          <ActionTitle>ACCIONES EN CURSO</ActionTitle>
          <ActionList>
            {displayedActivities.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </ActionList>
          <ActionFooter
            type="button"
            aria-expanded={actionsExpanded}
            onClick={() => setActionsExpanded((current) => !current)}
          >
            {actionsExpanded
              ? "OCULTAR DETALLES DE ACCIONES"
              : "VER DETALLES DE ACCIONES"}
            <span aria-hidden="true">{actionsExpanded ? "⌃" : "⌄"}</span>
          </ActionFooter>
        </ActionPanel>
      </CenterColumn>

      <VoiceColumn $side="assistant">
        <VoiceHeading>
          <VoiceIcon>
            <SpeakerWaveIcon />
          </VoiceIcon>
          <VoiceHeadingCopy>
            <VoiceTitle>START TALK RESPONDE</VoiceTitle>
            <VoiceSubtitle>Start Talk genera texto y habla</VoiceSubtitle>
          </VoiceHeadingCopy>
        </VoiceHeading>
        <VoiceWave active={status === "speaking"} level={0.7} />
        <MessageList
          empty="Las respuestas de Start Talk aparecerán aquí."
          role="assistant"
          turns={assistantTurns}
        />
        {sources.length ? (
          <SourcesCard>
            <SourcesTitle>
              <DocumentTextIcon width={12} height={12} />
              FUENTES CONSULTADAS
            </SourcesTitle>
            <SourcesList>
              {sources.map((source) => (
                <li key={source.url}>
                  <SourceButton
                    type="button"
                    onClick={() => onOpenUrl(source.url)}
                  >
                    <strong>
                      {source.title || new URL(source.url).hostname}
                    </strong>
                    <span>{new URL(source.url).hostname}</span>
                    <ArrowTopRightOnSquareIcon />
                  </SourceButton>
                </li>
              ))}
            </SourcesList>
          </SourcesCard>
        ) : null}
      </VoiceColumn>
    </Workspace>
  );
}
