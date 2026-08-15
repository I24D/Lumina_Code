import {
  AdjustmentsHorizontalIcon,
  ArrowUpTrayIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  CommandLineIcon,
  ExclamationCircleIcon,
  MicrophoneIcon,
  MinusIcon,
  MoonIcon,
  SpeakerWaveIcon,
  SunIcon,
  VideoCameraIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { StartTalkTranslationConfig } from "core/startTalk";
import {
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styled, { css, keyframes } from "styled-components";
import { StartTalkControls } from "./StartTalkControls";
import type {
  StartTalkModelOption,
  StartTalkStatus,
  StartTalkThinkingLevel,
  StartTalkToolActivity,
} from "./types";
import { useStartTalkAudio } from "./useStartTalkAudio";

const INTERPRETER_LANGUAGES: { code: string; label: string }[] = [
  { code: "en-US", label: "English" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português" },
  { code: "zh-CN", label: "中文" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
  { code: "ar-SA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ru-RU", label: "Русский" },
];

type PanelMode = "compact" | "expanded" | "minimized";
type OpenSettingMenu = "model" | "thinking" | null;
type StartTalkTheme = "light" | "dark";

type Position = {
  x: number;
  y: number;
};

type PanelSize = {
  width: number;
  height: number;
};

type TauriWindowHandle = {
  setFullscreen?: (value: boolean) => Promise<void> | void;
  setSize?: (size: unknown) => Promise<void> | void;
  startDragging?: () => Promise<void> | void;
};

type TauriGlobal = {
  core?: {
    invoke?: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  dpi?: {
    LogicalSize?: new (width: number, height: number) => unknown;
  };
  window?: {
    getCurrentWindow?: () => TauriWindowHandle;
  };
};

const compactSize: PanelSize = {
  width: 420,
  height: 620,
};

const expandedSize: PanelSize = {
  width: 680,
  height: 720,
};

const miniSize: PanelSize = {
  width: 88,
  height: 88,
};

const liveModelOptions: StartTalkModelOption[] = [
  {
    // `-latest` alias auto-tracks the newest 2.5 native-audio release, so the
    // voice stays current without re-pinning a dated preview. It is the only
    // Live tier that supports Google Search grounding (see modelSupportsSearch).
    description: "Voz natural + búsqueda web en vivo (siempre la más reciente)",
    label: "Native Audio (2.5)",
    model: "gemini-2.5-flash-native-audio-latest",
  },
  {
    description: "Voz avanzada de última generación (sin búsqueda web)",
    label: "Flash Live (3.1)",
    model: "gemini-3.1-flash-live-preview",
  },
];

const thinkingOptions: Array<{
  description: string;
  label: string;
  level: StartTalkThinkingLevel;
}> = [
  {
    description: "Ideal para la mayoría de las preguntas",
    label: "Estándar",
    level: "low",
  },
  {
    description: "Para problemas complejos",
    label: "Razonamiento extendido",
    level: "high",
  },
];

const breathe = keyframes`
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50% { transform: translate3d(0, -3px, 0) scale(1.035); }
`;

const listeningRing = keyframes`
  0%, 100% { transform: scale(0.9); opacity: 0.14; }
  50% { transform: scale(1.12); opacity: 0.34; }
`;

const speakingWarp = keyframes`
  0%, 100% { transform: scaleX(1) scaleY(1); filter: saturate(1.08); }
  34% { transform: scaleX(1.08) scaleY(0.93); filter: saturate(1.3); }
  67% { transform: scaleX(0.97) scaleY(1.05); filter: saturate(1.18); }
`;

const thoughtShift = keyframes`
  0% { background-position: 50% 18%, 50% 112%, 0% 50%; }
  50% { background-position: 48% 22%, 52% 104%, 100% 50%; }
  100% { background-position: 50% 18%, 50% 112%, 0% 50%; }
`;

const levelDance = keyframes`
  0%, 100% { transform: scaleY(0.45); }
  50% { transform: scaleY(1); }
`;

const OrbLayer = styled.div<{ $theme: StartTalkTheme }>`
  --live-surface: ${({ $theme }) =>
    $theme === "dark"
      ? "rgba(19, 20, 23, 0.985)"
      : "rgba(249, 251, 253, 0.985)"};
  --live-surface-elevated: ${({ $theme }) =>
    $theme === "dark" ? "#25272b" : "#ffffff"};
  --live-control: ${({ $theme }) =>
    $theme === "dark"
      ? "rgba(255, 255, 255, 0.055)"
      : "rgba(255, 255, 255, 0.88)"};
  --live-control-strong: ${({ $theme }) =>
    $theme === "dark" ? "rgba(255, 255, 255, 0.11)" : "#dce3ea"};
  --live-control-hover: ${({ $theme }) =>
    $theme === "dark" ? "rgba(255, 255, 255, 0.1)" : "#f0f5f9"};
  --live-text: ${({ $theme }) => ($theme === "dark" ? "#f4f6f8" : "#13171c")};
  --live-muted: ${({ $theme }) => ($theme === "dark" ? "#a8adb5" : "#66717e")};
  --live-border: ${({ $theme }) =>
    $theme === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(42, 55, 72, 0.14)"};
  --live-border-strong: ${({ $theme }) =>
    $theme === "dark" ? "rgba(255, 255, 255, 0.22)" : "rgba(42, 55, 72, 0.28)"};
  --live-accent: ${({ $theme }) => ($theme === "dark" ? "#64b5ff" : "#1375db")};
  --live-accent-text: ${({ $theme }) =>
    $theme === "dark" ? "#bfe1ff" : "#075cb3"};
  --live-accent-soft: ${({ $theme }) =>
    $theme === "dark" ? "rgba(60, 157, 255, 0.17)" : "rgba(19, 117, 219, 0.1)"};
  --live-focus: ${({ $theme }) =>
    $theme === "dark"
      ? "rgba(100, 181, 255, 0.16)"
      : "rgba(19, 117, 219, 0.12)"};
  --live-success: ${({ $theme }) =>
    $theme === "dark" ? "#62d6a5" : "#16794f"};
  --live-success-soft: ${({ $theme }) =>
    $theme === "dark" ? "rgba(98, 214, 165, 0.13)" : "rgba(22, 121, 79, 0.1)"};
  --live-danger: ${({ $theme }) => ($theme === "dark" ? "#ff8b92" : "#b42331")};

  position: fixed;
  inset: 0;
  z-index: 10000;
  color-scheme: ${({ $theme }) => $theme};
  pointer-events: none;
`;

const PanelShell = styled.div<{
  $fullscreen: boolean;
  $isOrb: boolean;
  $mode: PanelMode;
  $position: Position;
  $size: PanelSize;
}>`
  position: fixed;
  left: ${({ $isOrb, $position }) => ($isOrb ? 0 : $position.x)}px;
  top: ${({ $isOrb, $position }) => ($isOrb ? 0 : $position.y)}px;
  display: flex;
  width: ${({ $isOrb, $size }) => ($isOrb ? "100vw" : `${$size.width}px`)};
  height: ${({ $isOrb, $size }) => ($isOrb ? "100vh" : `${$size.height}px`)};
  max-width: ${({ $isOrb }) => ($isOrb ? "100vw" : "calc(100vw - 20px)")};
  max-height: ${({ $isOrb }) => ($isOrb ? "100vh" : "calc(100vh - 20px)")};
  box-sizing: border-box;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--live-border);
  border-radius: ${({ $mode }) => ($mode === "minimized" ? "50%" : "16px")};
  background: var(--live-surface);
  box-shadow: ${({ $mode }) =>
    $mode === "minimized"
      ? "0 10px 28px rgba(12, 20, 32, 0.32)"
      : "0 20px 60px rgba(10, 18, 30, 0.3)"};
  color: var(--live-text);
  pointer-events: auto;
  transition:
    border-radius 180ms ease,
    box-shadow 180ms ease;

  &::before {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      #ff6574,
      #ffc857 35%,
      #4fd3a5 66%,
      #4ca4ff
    );
    content: "";
    opacity: ${({ $mode }) => ($mode === "minimized" ? 0 : 0.9)};
    pointer-events: none;
  }

  ${({ $mode }) =>
    $mode === "minimized" &&
    css`
      align-items: center;
      justify-content: center;
      cursor: grab;
    `}

  ${({ $fullscreen }) =>
    $fullscreen &&
    css`
      border: 0;
      border-radius: 0;
      box-shadow: none;
    `}
`;

const Header = styled.header`
  display: flex;
  min-height: 52px;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--live-border);
  padding: 8px 10px;
  user-select: none;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
`;

const Brand = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
`;

const LuminaMark = styled.div<{ $small?: boolean }>`
  width: ${({ $small }) => ($small ? "18px" : "22px")};
  height: ${({ $small }) => ($small ? "18px" : "22px")};
  flex: 0 0 auto;
  background:
    radial-gradient(circle at 50% 50%, #ffffff 0 16%, transparent 17%),
    conic-gradient(from 8deg, #f05063, #ffcc4d, #28ad78, #3f8ff5, #f05063);
  clip-path: polygon(
    50% 0%,
    62% 36%,
    100% 50%,
    62% 64%,
    50% 100%,
    38% 64%,
    0% 50%,
    38% 36%
  );
  filter: drop-shadow(0 5px 10px rgba(35, 106, 191, 0.16));
`;

const BrandCopy = styled.div`
  display: grid;
  min-width: 0;
  gap: 1px;
`;

const Title = styled.div`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 720;
`;

const LiveState = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--live-muted);
  font-size: 10px;
`;

const StateDot = styled.span<{ $status: StartTalkStatus }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${({ $status }) => {
    if ($status === "error") return "var(--live-danger)";
    if ($status === "speaking") return "#ff6574";
    if ($status === "listening" || $status === "connected") return "#28ad78";
    return "#f0b429";
  }};
  box-shadow: 0 0 0 3px var(--live-control);
`;

const HeaderActions = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
`;

const IconButton = styled.button<{
  $active?: boolean;
  $danger?: boolean;
  $small?: boolean;
}>`
  display: inline-flex;
  width: ${({ $small }) => ($small ? "34px" : "44px")};
  height: ${({ $small }) => ($small ? "34px" : "44px")};
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid
    ${({ $active }) => ($active ? "var(--live-accent)" : "var(--live-border)")};
  border-radius: 50%;
  background: ${({ $active }) =>
    $active ? "var(--live-accent-soft)" : "var(--live-control)"};
  color: ${({ $danger }) =>
    $danger ? "var(--live-danger)" : "var(--live-text)"};
  cursor: pointer;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    transform 140ms ease;

  &:hover {
    border-color: var(--live-border-strong);
    background: var(--live-control-hover);
  }

  &:active {
    transform: scale(0.95);
  }

  &:disabled {
    cursor: default;
    opacity: 0.38;
    transform: none;
  }

  svg {
    width: ${({ $small }) => ($small ? "17px" : "20px")};
    height: ${({ $small }) => ($small ? "17px" : "20px")};
    stroke-width: 2;
  }
`;

const SessionStrip = styled.div`
  position: relative;
  z-index: 5;
  display: grid;
  width: min(100%, 760px);
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  align-self: center;
  gap: 8px;
  padding: 10px 14px 4px;
`;

const SettingField = styled.div`
  position: relative;
  display: grid;
  min-width: 0;
  gap: 4px;
`;

const SettingLabel = styled.span`
  color: var(--live-muted);
  font-size: 9px;
  font-weight: 720;
  text-transform: uppercase;
`;

const SettingMenuButton = styled.button`
  display: flex;
  width: 100%;
  min-width: 0;
  height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  border: 1px solid var(--live-border);
  border-radius: 8px;
  background: var(--live-control);
  color: var(--live-text);
  cursor: pointer;
  font-size: 11px;
  font-weight: 620;
  outline: none;
  padding: 0 9px;
  text-align: left;

  &:focus-visible {
    border-color: var(--live-accent);
    box-shadow: 0 0 0 2px var(--live-focus);
  }

  &:disabled {
    cursor: default;
    opacity: 0.64;
  }
`;

const SettingMenuValue = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SettingMenuChevron = styled(ChevronDownIcon)<{ $open: boolean }>`
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  transform: rotate(${({ $open }) => ($open ? "180deg" : "0deg")});
  transition: transform 140ms ease;
`;

const SettingMenuList = styled.div`
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  z-index: 12;
  overflow: hidden;
  border: 1px solid var(--live-border-strong);
  border-radius: 8px;
  background: var(--live-surface-elevated);
  box-shadow: 0 14px 34px rgba(8, 14, 22, 0.24);
`;

const SettingMenuItem = styled.button<{ $active: boolean }>`
  display: grid;
  width: 100%;
  gap: 2px;
  border: 0;
  background: ${({ $active }) =>
    $active ? "var(--live-accent-soft)" : "transparent"};
  color: ${({ $active }) =>
    $active ? "var(--live-accent-text)" : "var(--live-text)"};
  cursor: pointer;
  padding: 8px 10px;
  text-align: left;

  &:hover {
    background: var(--live-control-hover);
  }
`;

const MenuItemLabel = styled.span`
  font-size: 11px;
  font-weight: 650;
`;

const MenuItemDescription = styled.span`
  color: var(--live-muted);
  font-size: 9px;
  line-height: 1.3;
`;

const Stage = styled.main<{ $large: boolean }>`
  display: flex;
  width: min(100%, 760px);
  min-height: 0;
  box-sizing: border-box;
  flex: 1;
  align-self: center;
  align-items: center;
  flex-direction: column;
  gap: ${({ $large }) => ($large ? "12px" : "8px")};
  overflow: hidden;
  padding: ${({ $large }) => ($large ? "18px 28px 14px" : "10px 18px 8px")};
  text-align: center;

  @media (max-height: 560px) {
    gap: 5px;
    padding-top: 6px;
    padding-bottom: 4px;
  }
`;

const Prompt = styled.h1<{ $large: boolean }>`
  width: 100%;
  margin: 0;
  color: var(--live-text);
  font-size: ${({ $large }) => ($large ? "31px" : "23px")};
  font-weight: 470;
  letter-spacing: 0;
  line-height: 1.12;

  @media (max-height: 560px) {
    font-size: 20px;
  }
`;

const StatusLine = styled.div<{ $tone: StartTalkStatus }>`
  min-height: 18px;
  overflow: hidden;
  color: ${({ $tone }) =>
    $tone === "error" ? "var(--live-danger)" : "var(--live-muted)"};
  font-size: 11px;
  font-weight: 620;
  line-height: 1.35;
  text-overflow: ellipsis;
`;

const OrbWrap = styled.div<{ $large: boolean }>`
  position: relative;
  display: flex;
  width: ${({ $large }) => ($large ? "166px" : "128px")};
  height: ${({ $large }) => ($large ? "166px" : "128px")};
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;

  @media (max-height: 560px) {
    width: 102px;
    height: 102px;
  }
`;

const Ring = styled.div<{ $status: StartTalkStatus }>`
  position: absolute;
  inset: 7px;
  border-radius: 50%;
  background: ${({ $status }) =>
    $status === "speaking"
      ? "rgba(255, 91, 109, 0.3)"
      : "rgba(53, 151, 255, 0.32)"};
  filter: blur(14px);
  opacity: ${({ $status }) =>
    $status === "listening" || $status === "speaking" ? 1 : 0};
  animation: ${listeningRing} 1.7s ease-in-out infinite;
`;

const Orb = styled.div<{ $large: boolean; $status: StartTalkStatus }>`
  position: relative;
  width: ${({ $large }) => ($large ? "138px" : "108px")};
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(
      circle at 50% 18%,
      rgba(255, 255, 242, 0.98) 0 20%,
      rgba(255, 255, 255, 0.88) 32%,
      transparent 48%
    ),
    radial-gradient(
      circle at 50% 112%,
      rgba(37, 115, 255, 0.98) 0 22%,
      rgba(91, 182, 255, 0.72) 38%,
      transparent 55%
    ),
    linear-gradient(180deg, #fffbea 0%, #f9fbff 42%, #9fd8ff 73%, #367dff 100%);
  background-size:
    100% 100%,
    100% 100%,
    170% 170%;
  box-shadow:
    inset 0 2px 18px rgba(255, 255, 255, 0.84),
    inset 0 -14px 30px rgba(54, 127, 255, 0.3),
    0 18px 42px rgba(49, 139, 255, 0.24);
  animation:
    ${breathe} 3.9s ease-in-out infinite,
    ${thoughtShift} 6.5s ease-in-out infinite;
  will-change: transform, filter, background-position;

  ${({ $status }) =>
    $status === "listening" &&
    css`
      animation:
        ${breathe} 2.1s ease-in-out infinite,
        ${thoughtShift} 4.4s ease-in-out infinite;
    `}

  ${({ $status }) =>
    $status === "speaking" &&
    css`
      animation:
        ${speakingWarp} 640ms ease-in-out infinite,
        ${thoughtShift} 2.8s ease-in-out infinite;
    `}

  ${({ $status }) =>
    $status === "error" &&
    css`
      filter: grayscale(0.35) saturate(0.72);
      animation: none;
    `}

  @media (max-height: 560px) {
    width: 86px;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const AudioBars = styled.div<{ $active: boolean }>`
  display: flex;
  height: 12px;
  align-items: center;
  justify-content: center;
  gap: 3px;
  opacity: ${({ $active }) => ($active ? 0.9 : 0.35)};

  span {
    width: 2px;
    height: 100%;
    border-radius: 999px;
    background: ${({ $active }) => ($active ? "#36c994" : "var(--live-muted)")};
    animation: ${({ $active }) =>
      $active
        ? css`
            ${levelDance} 720ms ease-in-out infinite
          `
        : "none"};
  }

  span:nth-child(2),
  span:nth-child(6) {
    animation-delay: 90ms;
  }

  span:nth-child(3),
  span:nth-child(5) {
    animation-delay: 180ms;
  }

  span:nth-child(4) {
    animation-delay: 270ms;
  }

  @media (prefers-reduced-motion: reduce) {
    span {
      animation: none;
    }
  }
`;

const TranscriptPanel = styled.div<{ $large: boolean }>`
  display: grid;
  width: 100%;
  min-height: ${({ $large }) => ($large ? "92px" : "68px")};
  max-height: ${({ $large }) => ($large ? "160px" : "104px")};
  box-sizing: border-box;
  align-content: start;
  gap: 6px;
  overflow: auto;
  border-top: 1px solid var(--live-border);
  padding: 10px 4px 0;
  scrollbar-width: thin;

  @media (max-height: 560px) {
    min-height: 48px;
    max-height: 58px;
    padding-top: 6px;
  }
`;

const TranscriptLine = styled.div<{ $source: "assistant" | "user" }>`
  min-width: 0;
  color: ${({ $source }) =>
    $source === "user" ? "var(--live-text)" : "var(--live-muted)"};
  font-size: 12px;
  font-weight: ${({ $source }) => ($source === "user" ? 620 : 440)};
  line-height: 1.42;
  text-align: ${({ $source }) => ($source === "user" ? "right" : "left")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const EmptyTranscript = styled.div`
  color: var(--live-muted);
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
`;

const SpeakerLabel = styled.div`
  color: var(--live-success);
  font-size: 10px;
  font-weight: 700;
  text-align: right;
`;

const DelegationApprovalCard = styled.section`
  position: absolute;
  right: 14px;
  bottom: 86px;
  left: 14px;
  z-index: 20;
  display: grid;
  width: auto;
  max-width: 620px;
  margin: 0 auto;
  box-sizing: border-box;
  gap: 8px;
  border: 1px solid var(--live-border-strong);
  border-radius: 10px;
  background: var(--live-surface-elevated);
  box-shadow: 0 16px 42px rgba(8, 14, 22, 0.32);
  padding: 10px;
  text-align: left;
`;

const DelegationApprovalTitle = styled.div`
  color: var(--live-text);
  font-size: 11px;
  font-weight: 720;
`;

const DelegationApprovalTask = styled.div`
  max-height: 62px;
  overflow: auto;
  color: var(--live-muted);
  font-size: 10px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`;

const DelegationApprovalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 7px;
`;

const DelegationApprovalButton = styled.button<{ $primary?: boolean }>`
  border: 1px solid
    ${({ $primary }) =>
      $primary ? "var(--live-accent)" : "var(--live-border-strong)"};
  border-radius: 7px;
  background: ${({ $primary }) =>
    $primary ? "var(--live-accent)" : "var(--live-control)"};
  color: ${({ $primary }) => ($primary ? "#ffffff" : "var(--live-text)")};
  cursor: pointer;
  padding: 6px 10px;
  font-size: 10px;
  font-weight: 700;

  &:hover {
    filter: brightness(1.08);
  }
`;

const ToolActivityPanel = styled.div<{ $visible: boolean }>`
  display: ${({ $visible }) => ($visible ? "grid" : "none")};
  width: 100%;
  max-height: 74px;
  gap: 5px;
  overflow: auto;
`;

const ToolActivityRow = styled.div`
  display: grid;
  min-height: 27px;
  box-sizing: border-box;
  grid-template-columns: 17px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  border: 1px solid var(--live-border);
  border-radius: 7px;
  background: var(--live-control);
  padding: 4px 7px;
  color: var(--live-muted);
  font-size: 10px;
  text-align: left;
`;

const ToolActivityText = styled.div`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ToolActivityIcon = styled.div<{
  $status: StartTalkToolActivity["status"];
}>`
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${({ $status }) => {
    if ($status === "done") return "var(--live-success)";
    if ($status === "error") return "var(--live-danger)";
    if ($status === "waiting") return "#b5862d";
    return "var(--live-accent)";
  }};

  svg {
    width: 15px;
    height: 15px;
  }
`;

const AdvancedSheet = styled.aside`
  position: absolute;
  right: 12px;
  bottom: 74px;
  left: 12px;
  z-index: 20;
  display: flex;
  width: min(calc(100% - 24px), 540px);
  max-height: calc(100% - 138px);
  box-sizing: border-box;
  align-self: center;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--live-border-strong);
  border-radius: 8px;
  background: var(--live-surface-elevated);
  box-shadow: 0 18px 52px rgba(7, 12, 19, 0.34);
  margin: 0 auto;
`;

const AdvancedSheetHeader = styled.div`
  display: flex;
  min-height: 44px;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--live-border);
  padding: 5px 7px 5px 12px;
`;

const AdvancedSheetTitle = styled.div`
  display: grid;
  gap: 1px;
`;

const AdvancedTitle = styled.span`
  font-size: 12px;
  font-weight: 720;
`;

const AdvancedSubtitle = styled.span`
  color: var(--live-muted);
  font-size: 9px;
`;

const AdvancedSheetBody = styled.div`
  overflow: auto;
  padding: 12px;
  scrollbar-width: thin;
`;

const Dock = styled.footer`
  position: relative;
  z-index: 6;
  display: flex;
  min-height: 70px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  border-top: 1px solid var(--live-border);
  background: var(--live-surface);
  padding: 9px 14px 12px;
`;

const Controls = styled.div`
  display: grid;
  width: min(100%, 376px);
  grid-template-columns: repeat(2, 44px) 58px repeat(2, 44px);
  align-items: center;
  justify-content: space-between;
  gap: 9px;

  @media (max-width: 360px) {
    width: 100%;
    grid-template-columns: repeat(2, 40px) 52px repeat(2, 40px);
    gap: 6px;
  }
`;

const LiveButton = styled.button<{ $status: StartTalkStatus }>`
  position: relative;
  display: inline-flex;
  width: 58px;
  height: 58px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--live-surface-elevated);
  box-shadow:
    inset 0 0 0 1px var(--live-border),
    0 8px 24px rgba(28, 103, 183, 0.2);
  cursor: pointer;

  &::before {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 22%, #fffde8 0 24%, transparent 46%),
      linear-gradient(180deg, #ffffff 0%, #aee1ff 57%, #3e86ff 100%);
    box-shadow: 0 6px 15px rgba(55, 137, 236, 0.26);
    content: "";
    animation: ${({ $status }) =>
      $status === "speaking" || $status === "listening"
        ? css`
            ${listeningRing} 1.6s ease-in-out infinite
          `
        : "none"};
  }

  &:active:not(:disabled) {
    transform: scale(0.96);
  }

  &:disabled {
    cursor: default;
  }

  @media (max-width: 360px) {
    width: 52px;
    height: 52px;
  }
`;

const MiniButton = styled.button`
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: grab;
  padding: 0;

  &:active {
    cursor: grabbing;
  }
`;

const MiniOrb = styled.div<{ $status: StartTalkStatus }>`
  width: 62px;
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(
      circle at 50% 18%,
      rgba(255, 255, 242, 0.98) 0 20%,
      rgba(255, 255, 255, 0.88) 32%,
      transparent 48%
    ),
    radial-gradient(
      circle at 50% 112%,
      rgba(37, 115, 255, 0.98) 0 22%,
      rgba(91, 182, 255, 0.72) 38%,
      transparent 55%
    ),
    linear-gradient(180deg, #fffbea 0%, #f9fbff 42%, #9fd8ff 73%, #367dff 100%);
  box-shadow:
    inset 0 1px 10px rgba(255, 255, 255, 0.88),
    0 8px 22px rgba(49, 139, 255, 0.32);
  animation: ${({ $status }) =>
    $status === "speaking"
      ? css`
          ${speakingWarp} 640ms ease-in-out infinite
        `
      : css`
          ${breathe} 2.4s ease-in-out infinite
        `};

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const MiniState = styled.span<{ $status: StartTalkStatus }>`
  position: absolute;
  right: 9px;
  bottom: 9px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--live-surface);
  border-radius: 50%;
  background: ${({ $status }) => {
    if ($status === "error") return "var(--live-danger)";
    if ($status === "speaking") return "#ff6574";
    return "#28ad78";
  }};
`;

function getStatusText(status: StartTalkStatus, errorMessage?: string) {
  switch (status) {
    case "connecting":
      return "Conectando con Lumina Live...";
    case "connected":
      return "Preparando el micrófono...";
    case "listening":
      return "Escuchando...";
    case "speaking":
      return "Hablando...";
    case "unsupported":
      return "El audio no está disponible en esta ventana.";
    case "error":
      return errorMessage ?? "Start Talk encontró un error.";
    default:
      return "Lista para conversar.";
  }
}

function ToolActivityStatusIcon({
  activity,
}: {
  activity: StartTalkToolActivity;
}) {
  if (activity.status === "done") return <CheckCircleIcon />;
  if (activity.status === "error") return <ExclamationCircleIcon />;
  if (activity.status === "waiting") return <ClockIcon />;
  return <CommandLineIcon />;
}

function getSizeForMode(mode: PanelMode): PanelSize {
  if (mode === "expanded") {
    return {
      width: Math.min(expandedSize.width, window.innerWidth - 20),
      height: Math.min(expandedSize.height, window.innerHeight - 20),
    };
  }

  if (mode === "minimized") return miniSize;

  return {
    width: Math.min(compactSize.width, window.innerWidth - 20),
    height: Math.min(compactSize.height, window.innerHeight - 20),
  };
}

function clampPosition(position: Position, size: PanelSize): Position {
  return {
    x: Math.max(10, Math.min(position.x, window.innerWidth - size.width - 10)),
    y: Math.max(
      10,
      Math.min(position.y, window.innerHeight - size.height - 10),
    ),
  };
}

function getInitialPosition(size: PanelSize): Position {
  return clampPosition(
    {
      x: window.innerWidth - size.width - 18,
      y: 64,
    },
    size,
  );
}

function getTauriGlobal(): TauriGlobal | undefined {
  return (window as typeof window & { __TAURI__?: TauriGlobal }).__TAURI__;
}

function getTauriWindow(): TauriWindowHandle | undefined {
  return getTauriGlobal()?.window?.getCurrentWindow?.();
}

async function setNativeOrbSize(size: PanelSize) {
  const tauri = getTauriGlobal();
  if (tauri?.core?.invoke) {
    await tauri.core.invoke("set_orb_window_size", {
      width: size.width,
      height: size.height,
    });
    return;
  }

  const currentWindow = tauri?.window?.getCurrentWindow?.();
  const LogicalSize = tauri?.dpi?.LogicalSize;
  if (!currentWindow?.setSize || !LogicalSize) return;

  await currentWindow.setSize(new LogicalSize(size.width, size.height));
}

function readInitialTheme(): StartTalkTheme {
  try {
    return localStorage.getItem("lumina-start-talk-theme") === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function readInitialNotificationPreference(): boolean {
  try {
    return localStorage.getItem("lumina-start-talk-notifications") !== "false";
  } catch {
    return true;
  }
}

function readInitialPhoneBridgePreference(): boolean {
  try {
    // The phone-assistant "OK Google" bridge is opt-in and OFF by default.
    // Notifications are answered directly by the Lumina Code chat (it opens
    // Phone Link and replies), not by the phone's Google Assistant. This v3
    // migration clears the old force-enabled state so existing installs stop
    // routing notifications to "OK Google".
    const migrationKey = "lumina-start-talk-phone-bridge-config-v3";
    if (localStorage.getItem(migrationKey) !== "ready") {
      localStorage.setItem(migrationKey, "ready");
      localStorage.setItem("lumina-start-talk-phone-bridge", "false");
      return false;
    }
    return localStorage.getItem("lumina-start-talk-phone-bridge") === "true";
  } catch {
    return false;
  }
}

function readInitialWakeWord(): string {
  try {
    return localStorage.getItem("lumina-start-talk-wake-word") || "OK Google";
  } catch {
    return "OK Google";
  }
}

export function LiveConversationOverlay({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const autoStartRef = useRef(false);
  const previousConfigKeyRef = useRef<string | undefined>();
  const settingsRef = useRef<HTMLDivElement>(null);
  const [liveModel, setLiveModel] = useState<StartTalkModelOption>(
    liveModelOptions[0],
  );
  const [mode, setMode] = useState<PanelMode>("compact");
  const [openSettingMenu, setOpenSettingMenu] = useState<OpenSettingMenu>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [theme, setTheme] = useState<StartTalkTheme>(readInitialTheme);
  const isOrb =
    typeof window !== "undefined" &&
    Boolean((window as { luminaOrbAutostart?: boolean }).luminaOrbAutostart);
  const [orbFullscreen, setOrbFullscreen] = useState(false);
  const [position, setPosition] = useState<Position>(() =>
    getInitialPosition(compactSize),
  );
  const [thinkingLevel, setThinkingLevel] =
    useState<StartTalkThinkingLevel>("low");
  const [translation, setTranslation] =
    useState<StartTalkTranslationConfig | null>(null);
  const [interpreterOn, setInterpreterOn] = useState(false);
  const [interpreterTarget, setInterpreterTarget] = useState("en-US");
  const [interpreterSource, setInterpreterSource] = useState("es-ES");
  const [bidirectional, setBidirectional] = useState(false);
  const [voiceStyle, setVoiceStyle] = useState("");
  const [announceNotifications, setAnnounceNotifications] = useState(
    readInitialNotificationPreference,
  );
  const [phoneAssistantBridge, setPhoneAssistantBridge] = useState(
    readInitialPhoneBridgePreference,
  );
  const [phoneAssistantWakeWord, setPhoneAssistantWakeWord] =
    useState(readInitialWakeWord);
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [exportState, setExportState] = useState<"idle" | "done" | "empty">(
    "idle",
  );
  const {
    approveDelegation,
    assistantTranscript,
    errorMessage,
    isActive,
    restartListening,
    startListening,
    status,
    stopSpeaking,
    toolActivities,
    userTranscript,
    videoSource,
    startScreenShare,
    startCamera,
    stopVideo,
    micLevel,
    speaker,
    isMuted,
    toggleMute,
    lastSoundEvent,
    listAudioDevices,
    switchAudioDevice,
    exportTranscript,
    notificationAccess,
    pendingNotificationCount,
    pendingDelegationApproval,
    rejectDelegation,
  } = useStartTalkAudio({
    isOpen,
    model: liveModel,
    thinkingLevel,
    translation,
    voiceStyle,
    announceNotifications,
    phoneAssistantBridge,
    phoneAssistantWakeWord,
  });

  const size = useMemo(() => getSizeForMode(mode), [mode]);
  const visualMode: PanelMode = orbFullscreen ? "expanded" : mode;
  const isLarge = visualMode === "expanded";

  useEffect(() => {
    if (pendingDelegationApproval && mode === "minimized") {
      setMode("compact");
    }
  }, [mode, pendingDelegationApproval]);

  useEffect(() => {
    try {
      localStorage.setItem("lumina-start-talk-theme", theme);
    } catch {
      // Theme persistence is best-effort in restricted WebViews.
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "lumina-start-talk-notifications",
        String(announceNotifications),
      );
    } catch {
      // Preference persistence is best-effort in restricted WebViews.
    }
  }, [announceNotifications]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "lumina-start-talk-phone-bridge",
        String(phoneAssistantBridge),
      );
    } catch {
      // Preference persistence is best-effort in restricted WebViews.
    }
  }, [phoneAssistantBridge]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "lumina-start-talk-wake-word",
        phoneAssistantWakeWord,
      );
    } catch {
      // Preference persistence is best-effort in restricted WebViews.
    }
  }, [phoneAssistantWakeWord]);

  useEffect(() => {
    setTranslation(
      interpreterOn
        ? {
            source: bidirectional ? interpreterSource : "auto",
            target: interpreterTarget,
            bidirectional,
          }
        : null,
    );
  }, [interpreterOn, bidirectional, interpreterSource, interpreterTarget]);

  useEffect(() => {
    if (!isOrb || !isOpen) return;

    document.documentElement.dataset.luminaOrbMode = mode;
    document.body.dataset.luminaOrbMode = mode;

    if (!orbFullscreen) {
      void setNativeOrbSize(
        mode === "minimized" ? miniSize : compactSize,
      ).catch(() => undefined);
    }
  }, [isOpen, isOrb, mode, orbFullscreen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void listAudioDevices().then((devices) => {
      if (!cancelled) setAudioDevices(devices);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, listAudioDevices]);

  const handleDeviceChange = useCallback(
    (device: string) => {
      setSelectedDevice(device);
      void switchAudioDevice(device);
    },
    [switchAudioDevice],
  );

  const handleRefreshDevices = useCallback(() => {
    void listAudioDevices().then(setAudioDevices);
  }, [listAudioDevices]);

  const handleExportTranscript = useCallback(async () => {
    const entries = await exportTranscript();
    if (!entries.length) {
      setExportState("empty");
      window.setTimeout(() => setExportState("idle"), 1500);
      return;
    }
    const text = entries
      .map(
        (entry) =>
          `${entry.role === "assistant" ? "Lumina" : "Tú"}: ${entry.text}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The UI still confirms the prepared export in restricted WebViews.
    }
    setExportState("done");
    window.setTimeout(() => setExportState("idle"), 1500);
  }, [exportTranscript]);

  useEffect(() => {
    if (!isOpen) {
      autoStartRef.current = false;
      setMode("compact");
      setOpenSettingMenu(null);
      setAdvancedOpen(false);
      return;
    }

    if (!isOrb) {
      setPosition((current) => clampPosition(current, size));
    }

    if (!autoStartRef.current) {
      autoStartRef.current = true;
      void startListening();
    }
  }, [isOpen, isOrb, size, startListening]);

  useEffect(() => {
    if (!isOpen || !openSettingMenu) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && settingsRef.current?.contains(target))
        return;
      setOpenSettingMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, openSettingMenu]);

  useEffect(() => {
    const translationKey = translation
      ? `${translation.source ?? "auto"}>${translation.target}${
          translation.bidirectional ? ":bi" : ""
        }`
      : "assistant";
    const configKey = `${liveModel.model}:${thinkingLevel}:${translationKey}:${voiceStyle}`;
    if (!isOpen || !isActive || status === "connecting") {
      previousConfigKeyRef.current = configKey;
      return;
    }

    if (!previousConfigKeyRef.current) {
      previousConfigKeyRef.current = configKey;
      return;
    }

    if (previousConfigKeyRef.current !== configKey) {
      previousConfigKeyRef.current = configKey;
      void restartListening();
    }
  }, [
    isOpen,
    isActive,
    liveModel,
    restartListening,
    status,
    thinkingLevel,
    translation,
    voiceStyle,
  ]);

  const minimizeOverlay = useCallback(() => {
    setAdvancedOpen(false);
    setOpenSettingMenu(null);
    if (isOrb && orbFullscreen) {
      void Promise.resolve(getTauriWindow()?.setFullscreen?.(false)).catch(
        () => undefined,
      );
      setOrbFullscreen(false);
    }
    setMode("minimized");
  }, [isOrb, orbFullscreen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleResize = () => {
      if (!isOrb) {
        setPosition((current) => clampPosition(current, getSizeForMode(mode)));
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") minimizeOverlay();
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isOrb, minimizeOverlay, mode]);

  const toggleOrbFullscreen = useCallback(() => {
    const next = !orbFullscreen;
    setAdvancedOpen(false);
    setOpenSettingMenu(null);
    const currentWindow = getTauriWindow();
    void Promise.resolve(currentWindow?.setFullscreen?.(next))
      .then(() => {
        if (!next) return setNativeOrbSize(compactSize);
        return undefined;
      })
      .catch(() => undefined);
    setOrbFullscreen(next);
    setMode("compact");
  }, [orbFullscreen]);

  const statusText = useMemo(
    () => getStatusText(status, errorMessage),
    [errorMessage, status],
  );
  const selectedThinkingOption =
    thinkingOptions.find((option) => option.level === thinkingLevel) ??
    thinkingOptions[0];

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;

      if (isOrb) {
        void Promise.resolve(getTauriWindow()?.startDragging?.()).catch(
          () => undefined,
        );
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = position;

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        setPosition(
          clampPosition(
            {
              x: origin.x + moveEvent.clientX - startX,
              y: origin.y + moveEvent.clientY - startY,
            },
            size,
          ),
        );
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [isOrb, position, size],
  );

  const handleMiniPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = position;
      let didDrag = false;

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;

        if (!didDrag && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
          didDrag = true;
          if (isOrb) {
            void Promise.resolve(getTauriWindow()?.startDragging?.()).catch(
              () => undefined,
            );
          }
        }

        if (didDrag && !isOrb) {
          setPosition(
            clampPosition(
              { x: origin.x + deltaX, y: origin.y + deltaY },
              miniSize,
            ),
          );
        }
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", cleanup);
      };

      const handlePointerUp = () => {
        cleanup();
        if (!didDrag) setMode("compact");
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", cleanup);
    },
    [isOrb, position],
  );

  if (!isOpen) return null;

  const isConnecting = status === "connecting";
  const canStart = !isActive && !isConnecting;
  const hasTranscript = Boolean(userTranscript || assistantTranscript);

  if (mode === "minimized") {
    return (
      <OrbLayer $theme={theme}>
        <PanelShell
          $fullscreen={false}
          $isOrb={isOrb}
          $mode={mode}
          $position={position}
          $size={size}
          role="dialog"
          aria-label="Start Talk minimizado"
        >
          <MiniButton
            type="button"
            title="Restaurar Start Talk"
            aria-label="Restaurar Start Talk"
            onPointerDown={handleMiniPointerDown}
          >
            <MiniOrb $status={status} />
            <MiniState $status={status} />
          </MiniButton>
        </PanelShell>
      </OrbLayer>
    );
  }

  return (
    <OrbLayer $theme={theme}>
      <PanelShell
        $fullscreen={isOrb && orbFullscreen}
        $isOrb={isOrb}
        $mode={visualMode}
        $position={position}
        $size={size}
        role="dialog"
        aria-label="Start Talk"
      >
        <Header onPointerDown={handleDragStart}>
          <Brand>
            <LuminaMark $small aria-hidden="true" />
            <BrandCopy>
              <Title>Lumina Live</Title>
              <LiveState>
                <StateDot $status={status} />
                {statusText}
              </LiveState>
            </BrandCopy>
          </Brand>

          <HeaderActions onPointerDown={(event) => event.stopPropagation()}>
            <IconButton
              type="button"
              $small
              $active={advancedOpen}
              title="Ajustes de Start Talk"
              aria-label="Ajustes de Start Talk"
              aria-expanded={advancedOpen}
              onClick={() => {
                setOpenSettingMenu(null);
                setAdvancedOpen((current) => !current);
              }}
            >
              <AdjustmentsHorizontalIcon />
            </IconButton>
            <IconButton
              type="button"
              $small
              title={theme === "dark" ? "Usar tema claro" : "Usar tema oscuro"}
              aria-label={
                theme === "dark" ? "Usar tema claro" : "Usar tema oscuro"
              }
              onClick={() =>
                setTheme((current) => (current === "dark" ? "light" : "dark"))
              }
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </IconButton>
            <IconButton
              type="button"
              $small
              title="Minimizar a orbe"
              aria-label="Minimizar a orbe"
              onClick={minimizeOverlay}
            >
              <MinusIcon />
            </IconButton>
            <IconButton
              type="button"
              $small
              title={
                (isOrb ? orbFullscreen : mode === "expanded")
                  ? "Volver a tamaño compacto"
                  : "Usar pantalla completa"
              }
              aria-label={
                (isOrb ? orbFullscreen : mode === "expanded")
                  ? "Volver a tamaño compacto"
                  : "Usar pantalla completa"
              }
              onClick={() => {
                if (isOrb) {
                  toggleOrbFullscreen();
                } else {
                  setMode((current) =>
                    current === "expanded" ? "compact" : "expanded",
                  );
                }
              }}
            >
              {(isOrb ? orbFullscreen : mode === "expanded") ? (
                <ArrowsPointingInIcon />
              ) : (
                <ArrowsPointingOutIcon />
              )}
            </IconButton>
            <IconButton
              type="button"
              $small
              $danger
              title="Cerrar Start Talk"
              aria-label="Cerrar Start Talk"
              onClick={onClose}
            >
              <XMarkIcon />
            </IconButton>
          </HeaderActions>
        </Header>

        <SessionStrip
          ref={settingsRef}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <SettingField>
            <SettingLabel>Modelo de voz</SettingLabel>
            <SettingMenuButton
              type="button"
              aria-label="Modelo de Start Talk"
              aria-expanded={openSettingMenu === "model"}
              onClick={() =>
                setOpenSettingMenu((current) =>
                  current === "model" ? null : "model",
                )
              }
            >
              <SettingMenuValue>{liveModel.label}</SettingMenuValue>
              <SettingMenuChevron $open={openSettingMenu === "model"} />
            </SettingMenuButton>
            {openSettingMenu === "model" ? (
              <SettingMenuList role="listbox">
                {liveModelOptions.map((option) => (
                  <SettingMenuItem
                    key={option.model}
                    type="button"
                    role="option"
                    $active={option.model === liveModel.model}
                    aria-selected={option.model === liveModel.model}
                    onClick={() => {
                      setLiveModel(option);
                      setOpenSettingMenu(null);
                    }}
                  >
                    <MenuItemLabel>{option.label}</MenuItemLabel>
                    <MenuItemDescription>
                      {option.description}
                    </MenuItemDescription>
                  </SettingMenuItem>
                ))}
              </SettingMenuList>
            ) : null}
          </SettingField>

          <SettingField>
            <SettingLabel>Pensamiento</SettingLabel>
            <SettingMenuButton
              type="button"
              aria-label="Nivel de pensamiento"
              disabled={status === "connecting"}
              aria-expanded={openSettingMenu === "thinking"}
              onClick={() =>
                setOpenSettingMenu((current) =>
                  current === "thinking" ? null : "thinking",
                )
              }
            >
              <SettingMenuValue>
                {selectedThinkingOption.label}
              </SettingMenuValue>
              <SettingMenuChevron $open={openSettingMenu === "thinking"} />
            </SettingMenuButton>
            {openSettingMenu === "thinking" ? (
              <SettingMenuList role="listbox">
                {thinkingOptions.map((option) => (
                  <SettingMenuItem
                    key={option.level}
                    type="button"
                    role="option"
                    $active={option.level === thinkingLevel}
                    aria-selected={option.level === thinkingLevel}
                    onClick={() => {
                      setThinkingLevel(option.level);
                      setOpenSettingMenu(null);
                    }}
                  >
                    <MenuItemLabel>{option.label}</MenuItemLabel>
                    <MenuItemDescription>
                      {option.description}
                    </MenuItemDescription>
                  </SettingMenuItem>
                ))}
              </SettingMenuList>
            ) : null}
          </SettingField>
        </SessionStrip>

        <Stage $large={isLarge}>
          <Prompt $large={isLarge}>¿En qué deberíamos enfocarnos?</Prompt>
          <StatusLine $tone={status}>{statusText}</StatusLine>
          <OrbWrap $large={isLarge}>
            <Ring $status={status} />
            <Orb
              $large={isLarge}
              $status={status}
              aria-hidden="true"
              style={{
                transform:
                  status === "listening"
                    ? `scale(${1 + micLevel * 0.18})`
                    : undefined,
              }}
            />
          </OrbWrap>
          <AudioBars
            $active={status === "listening" || status === "speaking"}
            aria-hidden="true"
          >
            {Array.from({ length: 7 }).map((_, index) => (
              <span key={index} />
            ))}
          </AudioBars>

          <TranscriptPanel $large={isLarge} aria-live="polite">
            {speaker?.name ? <SpeakerLabel>{speaker.name}</SpeakerLabel> : null}
            {userTranscript ? (
              <TranscriptLine $source="user">{userTranscript}</TranscriptLine>
            ) : null}
            {assistantTranscript ? (
              <TranscriptLine $source="assistant">
                {assistantTranscript}
              </TranscriptLine>
            ) : null}
            {!hasTranscript ? (
              <EmptyTranscript>
                La conversación aparecerá aquí mientras hablas con Lumina.
              </EmptyTranscript>
            ) : null}
          </TranscriptPanel>

          <ToolActivityPanel $visible={toolActivities.length > 0}>
            {toolActivities.slice(-3).map((activity) => (
              <ToolActivityRow key={activity.id}>
                <ToolActivityIcon $status={activity.status}>
                  <ToolActivityStatusIcon activity={activity} />
                </ToolActivityIcon>
                <ToolActivityText>
                  {activity.detail
                    ? `${activity.label}: ${activity.detail}`
                    : activity.label}
                </ToolActivityText>
              </ToolActivityRow>
            ))}
          </ToolActivityPanel>
        </Stage>

        {pendingDelegationApproval ? (
          <DelegationApprovalCard
            aria-label="Autorizacion de tarea de Start Talk"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DelegationApprovalTitle>
              Start Talk propone enviar esta tarea a Lumina Code
            </DelegationApprovalTitle>
            <DelegationApprovalTask>
              {pendingDelegationApproval.task}
            </DelegationApprovalTask>
            <DelegationApprovalActions>
              <DelegationApprovalButton
                type="button"
                onClick={rejectDelegation}
              >
                Rechazar
              </DelegationApprovalButton>
              <DelegationApprovalButton
                type="button"
                $primary
                onClick={approveDelegation}
              >
                Autorizar una vez
              </DelegationApprovalButton>
            </DelegationApprovalActions>
          </DelegationApprovalCard>
        ) : null}

        {advancedOpen ? (
          <AdvancedSheet aria-label="Ajustes avanzados de Start Talk">
            <AdvancedSheetHeader>
              <AdvancedSheetTitle>
                <AdvancedTitle>Ajustes de conversación</AdvancedTitle>
                <AdvancedSubtitle>
                  Voz, notificaciones, micrófono y exportación
                </AdvancedSubtitle>
              </AdvancedSheetTitle>
              <IconButton
                type="button"
                $small
                title="Cerrar ajustes"
                aria-label="Cerrar ajustes"
                onClick={() => setAdvancedOpen(false)}
              >
                <XMarkIcon />
              </IconButton>
            </AdvancedSheetHeader>
            <AdvancedSheetBody>
              <StartTalkControls
                isActive={isActive}
                languages={INTERPRETER_LANGUAGES}
                interpreterActive={interpreterOn}
                onToggleInterpreter={setInterpreterOn}
                source={interpreterSource}
                target={interpreterTarget}
                bidirectional={bidirectional}
                onSourceChange={setInterpreterSource}
                onTargetChange={setInterpreterTarget}
                onBidirectionalChange={setBidirectional}
                voiceStyle={voiceStyle}
                onVoiceStyleChange={setVoiceStyle}
                devices={audioDevices}
                selectedDevice={selectedDevice}
                onDeviceChange={handleDeviceChange}
                onRefreshDevices={handleRefreshDevices}
                onExportTranscript={() => void handleExportTranscript()}
                exportState={exportState}
                lastSoundEvent={lastSoundEvent}
                announceNotifications={announceNotifications}
                onAnnounceNotificationsChange={setAnnounceNotifications}
                notificationAccess={notificationAccess}
                pendingNotificationCount={pendingNotificationCount}
                phoneAssistantBridge={phoneAssistantBridge}
                onPhoneAssistantBridgeChange={setPhoneAssistantBridge}
                phoneAssistantWakeWord={phoneAssistantWakeWord}
                onPhoneAssistantWakeWordChange={setPhoneAssistantWakeWord}
              />
            </AdvancedSheetBody>
          </AdvancedSheet>
        ) : null}

        <Dock>
          <Controls>
            <IconButton
              type="button"
              title={
                videoSource === "camera" ? "Apagar cámara" : "Encender cámara"
              }
              aria-label={
                videoSource === "camera" ? "Apagar cámara" : "Encender cámara"
              }
              $active={videoSource === "camera"}
              disabled={!isActive}
              onClick={() =>
                videoSource === "camera" ? void stopVideo() : void startCamera()
              }
            >
              <VideoCameraIcon />
            </IconButton>
            <IconButton
              type="button"
              title={
                videoSource === "screen"
                  ? "Dejar de compartir pantalla"
                  : "Compartir pantalla"
              }
              aria-label={
                videoSource === "screen"
                  ? "Dejar de compartir pantalla"
                  : "Compartir pantalla"
              }
              $active={videoSource === "screen"}
              disabled={!isActive}
              onClick={() =>
                videoSource === "screen"
                  ? void stopVideo()
                  : void startScreenShare()
              }
            >
              <ArrowUpTrayIcon />
            </IconButton>
            <LiveButton
              type="button"
              title={canStart ? "Iniciar Start Talk" : statusText}
              aria-label={canStart ? "Iniciar Start Talk" : statusText}
              disabled={!canStart}
              onClick={startListening}
              $status={status}
            />
            <IconButton
              type="button"
              title={
                canStart
                  ? "Iniciar micrófono"
                  : isMuted
                    ? "Activar micrófono"
                    : "Silenciar micrófono"
              }
              aria-label={
                canStart
                  ? "Iniciar micrófono"
                  : isMuted
                    ? "Activar micrófono"
                    : "Silenciar micrófono"
              }
              $active={isMuted}
              onClick={() =>
                canStart ? void startListening() : void toggleMute()
              }
            >
              <MicrophoneIcon style={{ opacity: isMuted ? 0.45 : 1 }} />
            </IconButton>
            <IconButton
              type="button"
              title="Detener la voz de Lumina"
              aria-label="Detener la voz de Lumina"
              disabled={!isActive}
              onClick={stopSpeaking}
            >
              <SpeakerWaveIcon />
            </IconButton>
          </Controls>
        </Dock>
      </PanelShell>
    </OrbLayer>
  );
}
