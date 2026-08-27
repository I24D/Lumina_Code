import type { CSSProperties } from "react";
import styled, { css, keyframes } from "styled-components";
import type { StartTalkStatus } from "./types";

type LuminaEnergyCoreProps = {
  large: boolean;
  micLevel: number;
  roomy: boolean;
  status: StartTalkStatus;
};

const coreFloat = keyframes`
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.025); }
`;

const coreSpeak = keyframes`
  0%, 100% { transform: scale(1); filter: saturate(1.08); }
  32% { transform: scaleX(1.09) scaleY(0.94); filter: saturate(1.38); }
  68% { transform: scaleX(0.97) scaleY(1.07); filter: saturate(1.22); }
`;

const auraPulse = keyframes`
  0%, 100% { opacity: 0.28; transform: scale(0.9); }
  50% { opacity: 0.82; transform: scale(1.12); }
`;

const clawBreathe = keyframes`
  0%, 100% { transform: translateX(0); opacity: 0.82; }
  50% { transform: translateX(4px); opacity: 1; }
`;

const currentFlow = keyframes`
  to { stroke-dashoffset: -42; }
`;

const spark = keyframes`
  0%, 100% { opacity: 0.12; transform: scale(0.45); }
  45% { opacity: 1; transform: scale(1.35); }
  70% { opacity: 0.34; transform: scale(0.72); }
`;

const EnergyStage = styled.div<{
  $large: boolean;
  $roomy: boolean;
  $status: StartTalkStatus;
}>`
  position: relative;
  width: ${({ $large, $roomy }) =>
    $roomy ? "clamp(320px, 27vw, 420px)" : $large ? "330px" : "270px"};
  max-width: 100%;
  aspect-ratio: 360 / 260;
  flex: 0 0 auto;
  isolation: isolate;

  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .energy-core-level {
    transform: scale(var(--voice-scale));
    transform-box: view-box;
    transform-origin: 180px 132px;
    transition: transform 70ms linear;
  }

  .energy-core-shape {
    animation: ${coreFloat} 3.8s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  .energy-aura {
    animation: ${auraPulse} 2.6s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  .claw-motion {
    animation: ${clawBreathe} 3.4s ease-in-out infinite;
    transform-box: view-box;
    transform-origin: 180px 132px;
  }

  .energy-current {
    animation: ${currentFlow} 1.9s linear infinite;
    stroke-dasharray: 4 9;
  }

  .energy-spark {
    animation: ${spark} 2.7s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  .energy-spark:nth-of-type(3n + 1) {
    animation-delay: -0.7s;
  }

  .energy-spark:nth-of-type(3n + 2) {
    animation-delay: -1.5s;
  }

  ${({ $status }) =>
    $status === "listening" &&
    css`
      .energy-aura {
        animation-duration: 1.55s;
      }
      .claw-motion {
        animation-duration: 1.8s;
      }
      .energy-current {
        animation-duration: 1.05s;
      }
    `}

  ${({ $status }) =>
    $status === "speaking" &&
    css`
      .energy-core-shape {
        animation: ${coreSpeak} 620ms ease-in-out infinite;
      }
      .energy-aura {
        animation-duration: 760ms;
      }
      .claw-motion {
        animation-duration: 980ms;
      }
      .energy-current {
        animation-duration: 620ms;
      }
    `}

  ${({ $status }) =>
    $status === "error" &&
    css`
      filter: grayscale(0.42) saturate(0.62);
      .energy-core-shape,
      .energy-aura,
      .claw-motion,
      .energy-current,
      .energy-spark {
        animation: none;
      }
    `}

  @media (max-height: 560px) {
    width: 194px;
  }

  @media (prefers-reduced-motion: reduce) {
    .energy-core-level {
      transform: none;
    }
    .energy-core-shape,
    .energy-aura,
    .claw-motion,
    .energy-current,
    .energy-spark {
      animation: none;
    }
  }
`;

const clawPath =
  "M164 18 C121 22 83 43 59 78 C39 108 31 146 40 179 C47 204 65 224 91 238 L107 215 C84 198 74 176 76 149 C78 118 92 89 116 68 C131 55 147 47 165 42 Z";

const innerClawPath =
  "M155 52 C128 60 106 77 92 101 C79 123 75 151 82 176 C87 193 97 207 112 218 L125 199 C108 185 101 168 102 146 C103 122 114 100 132 84 C142 75 153 69 165 65 Z";

/**
 * Núcleo visual de Lumina Live. Es SVG/CSS para conservar nitidez y reaccionar
 * en tiempo real al nivel del micrófono sin incorporar una imagen pesada al
 * bundle. Las dos tenazas son espejos exactos y el orbe ocupa su centro común.
 */
export function LuminaEnergyCore({
  large,
  micLevel,
  roomy,
  status,
}: LuminaEnergyCoreProps) {
  const reactiveLevel =
    status === "listening"
      ? Math.min(1, Math.max(0, micLevel))
      : status === "speaking"
        ? 0.62
        : 0;
  const style = { "--voice-scale": 1 + reactiveLevel * 0.16 } as CSSProperties;

  return (
    <EnergyStage
      $large={large}
      $roomy={roomy}
      $status={status}
      data-status={status}
      data-testid="lumina-energy-core"
      style={style}
      aria-hidden="true"
    >
      <svg viewBox="0 0 360 260" focusable="false">
        <defs>
          <radialGradient id="lumina-core" cx="48%" cy="28%" r="78%">
            <stop offset="0" stopColor="#fffef0" />
            <stop offset="0.38" stopColor="#e9f7ff" />
            <stop offset="0.68" stopColor="#70c8ff" />
            <stop offset="1" stopColor="#2674ff" />
          </radialGradient>
          <linearGradient id="lumina-claw" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d9a849" stopOpacity="0.9" />
            <stop offset="0.45" stopColor="#367eb5" stopOpacity="0.78" />
            <stop offset="1" stopColor="#19c9f2" stopOpacity="0.94" />
          </linearGradient>
          <linearGradient id="lumina-claw-fill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#173148" stopOpacity="0.84" />
            <stop offset="1" stopColor="#07131e" stopOpacity="0.38" />
          </linearGradient>
          <filter
            id="lumina-soft-glow"
            x="-80%"
            y="-80%"
            width="260%"
            height="260%"
          >
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter
            id="lumina-core-glow"
            x="-80%"
            y="-80%"
            width="260%"
            height="260%"
          >
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <ellipse
          className="energy-aura"
          cx="180"
          cy="138"
          rx="112"
          ry="72"
          fill="#168ee8"
          opacity="0.22"
          filter="url(#lumina-soft-glow)"
        />
        <ellipse
          cx="180"
          cy="227"
          rx="112"
          ry="8"
          fill="#e2ae48"
          opacity="0.14"
          filter="url(#lumina-soft-glow)"
        />

        <g data-claw="left" className="claw-motion">
          <path
            d={clawPath}
            fill="url(#lumina-claw-fill)"
            stroke="url(#lumina-claw)"
            strokeWidth="1.5"
          />
          <path
            d={innerClawPath}
            fill="none"
            stroke="#4dcdf7"
            strokeOpacity="0.7"
            strokeWidth="1"
          />
          <path
            d="M151 31 L130 44 L119 61 M95 79 L76 105 L68 132 M66 157 L72 184 L91 207"
            fill="none"
            stroke="#e1aa49"
            strokeOpacity="0.58"
          />
          <path
            className="energy-current"
            d="M158 29 C105 43 63 91 58 151 C56 184 71 211 100 229"
            fill="none"
            stroke="#48ddff"
            strokeWidth="1.4"
          />
          <path
            d="M125 70 L142 79 L132 96 L111 92 Z M92 119 L108 128 L103 149 L82 145 Z M91 178 L112 178 L120 196 L103 207 Z"
            fill="#1f6a91"
            fillOpacity="0.34"
            stroke="#d7a84d"
            strokeOpacity="0.45"
          />
        </g>
        <g transform="translate(360 0) scale(-1 1)" data-claw="right">
          <g className="claw-motion">
            <path
              d={clawPath}
              fill="url(#lumina-claw-fill)"
              stroke="url(#lumina-claw)"
              strokeWidth="1.5"
            />
            <path
              d={innerClawPath}
              fill="none"
              stroke="#4dcdf7"
              strokeOpacity="0.7"
              strokeWidth="1"
            />
            <path
              d="M151 31 L130 44 L119 61 M95 79 L76 105 L68 132 M66 157 L72 184 L91 207"
              fill="none"
              stroke="#e1aa49"
              strokeOpacity="0.58"
            />
            <path
              className="energy-current"
              d="M158 29 C105 43 63 91 58 151 C56 184 71 211 100 229"
              fill="none"
              stroke="#48ddff"
              strokeWidth="1.4"
            />
            <path
              d="M125 70 L142 79 L132 96 L111 92 Z M92 119 L108 128 L103 149 L82 145 Z M91 178 L112 178 L120 196 L103 207 Z"
              fill="#1f6a91"
              fillOpacity="0.34"
              stroke="#d7a84d"
              strokeOpacity="0.45"
            />
          </g>
        </g>

        <g fill="none" strokeLinecap="round">
          <path
            className="energy-current"
            d="M18 184 C74 154 109 189 151 153"
            stroke="#27bfe8"
            strokeOpacity="0.52"
          />
          <path
            className="energy-current"
            d="M342 184 C286 154 251 189 209 153"
            stroke="#27bfe8"
            strokeOpacity="0.52"
          />
          <path
            d="M12 202 C75 174 114 215 157 168"
            stroke="#d39b42"
            strokeOpacity="0.28"
          />
          <path
            d="M348 202 C285 174 246 215 203 168"
            stroke="#d39b42"
            strokeOpacity="0.28"
          />
        </g>

        <g className="energy-core-level">
          <g className="energy-core-shape" filter="url(#lumina-core-glow)">
            <circle cx="180" cy="132" r="66" fill="#2f9fff" opacity="0.18" />
            <circle
              cx="180"
              cy="132"
              r="54"
              fill="url(#lumina-core)"
              stroke="#c9efff"
              strokeWidth="1.3"
            />
            <circle
              cx="180"
              cy="132"
              r="43"
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.55"
              strokeWidth="0.8"
            />
            <ellipse
              cx="180"
              cy="132"
              rx="53"
              ry="20"
              fill="none"
              stroke="#68d8ff"
              strokeOpacity="0.68"
            />
            <ellipse
              cx="180"
              cy="132"
              rx="20"
              ry="53"
              fill="none"
              stroke="#68d8ff"
              strokeOpacity="0.52"
            />
            <path
              d="M127 132 H233 M180 79 V185 M142 94 L218 170 M218 94 L142 170"
              stroke="#ffffff"
              strokeOpacity="0.34"
              strokeWidth="0.8"
            />
            <circle cx="180" cy="132" r="5" fill="#ffffff" />
          </g>
        </g>

        <g fill="#bfefff">
          {[
            [28, 162, 1.3],
            [51, 114, 1.1],
            [78, 57, 1.5],
            [113, 35, 1],
            [247, 35, 1],
            [282, 57, 1.5],
            [309, 114, 1.1],
            [332, 162, 1.3],
            [47, 213, 1],
            [313, 213, 1],
            [133, 207, 1.2],
            [227, 207, 1.2],
          ].map(([cx, cy, radius], index) => (
            <circle
              key={index}
              className="energy-spark"
              cx={cx}
              cy={cy}
              r={radius}
            />
          ))}
        </g>
      </svg>
    </EnergyStage>
  );
}
