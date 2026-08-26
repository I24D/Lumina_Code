import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  BellAlertIcon,
  LanguageIcon,
  MicrophoneIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import type {
  StartTalkNotificationAccess,
  StartTalkSoundCategory,
} from "core/startTalk";
import styled from "styled-components";
import type { MicrophoneDevice } from "./micCapture";

export interface StartTalkLanguage {
  code: string;
  label: string;
}

export interface StartTalkControlsProps {
  isActive: boolean;
  languages: StartTalkLanguage[];
  interpreterActive: boolean;
  onToggleInterpreter: (enabled: boolean) => void;
  source: string;
  target: string;
  bidirectional: boolean;
  onSourceChange: (code: string) => void;
  onTargetChange: (code: string) => void;
  onBidirectionalChange: (value: boolean) => void;
  voiceStyle: string;
  onVoiceStyleChange: (value: string) => void;
  devices: MicrophoneDevice[];
  selectedDevice: string;
  onDeviceChange: (device: string) => void;
  onRefreshDevices: () => void;
  onExportTranscript: () => void;
  exportState: "idle" | "done" | "empty";
  lastSoundEvent: StartTalkSoundCategory | null;
  announceNotifications: boolean;
  onAnnounceNotificationsChange: (value: boolean) => void;
  notificationAccess: StartTalkNotificationAccess;
  pendingNotificationCount: number;
  phoneAssistantBridge: boolean;
  onPhoneAssistantBridgeChange: (value: boolean) => void;
  phoneAssistantWakeWord: string;
  onPhoneAssistantWakeWordChange: (value: string) => void;
}

const VOICE_STYLE_PRESETS = [
  { label: "Cálida", value: "warm and calm" },
  { label: "Enérgica", value: "energetic and upbeat" },
  { label: "Suave", value: "soft and slow" },
  { label: "Concisa", value: "professional and concise" },
];

const SOUND_EVENT_LABELS: Record<StartTalkSoundCategory, string> = {
  speech: "voz",
  tonal: "tono o alarma",
  impulsive: "impacto",
  broadband: "ruido ambiental",
  silence: "silencio",
};

const Panel = styled.div`
  display: grid;
  gap: 14px;
  color: var(--live-text);
`;

const Section = styled.section`
  display: grid;
  gap: 9px;
`;

const SectionHeader = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--live-muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;

  svg {
    width: 16px;
    height: 16px;
    color: var(--live-accent);
  }
`;

const SectionTitle = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ToggleRow = styled.label`
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--live-border);
  border-radius: 8px;
  background: var(--live-control);
  padding: 7px 10px;
  color: var(--live-text);
  cursor: pointer;
`;

const ToggleCopy = styled.span`
  display: grid;
  min-width: 0;
  gap: 2px;
`;

const ToggleTitle = styled.span`
  font-size: 12px;
  font-weight: 650;
`;

const ToggleDescription = styled.span`
  color: var(--live-muted);
  font-size: 11px;
  line-height: 1.3;
`;

const Switch = styled.input`
  position: relative;
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  appearance: none;
  border: 1px solid var(--live-border-strong);
  border-radius: 999px;
  background: var(--live-control-strong);
  cursor: pointer;
  transition: background 140ms ease;

  &::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--live-text);
    content: "";
    transition: transform 140ms ease;
  }

  &:checked {
    border-color: var(--live-accent);
    background: var(--live-accent);
  }

  &:checked::after {
    background: #ffffff;
    transform: translateX(14px);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
`;

const TranslationGrid = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
  align-items: end;
  gap: 7px;
`;

const FieldGroup = styled.label`
  display: grid;
  min-width: 0;
  gap: 4px;
  color: var(--live-muted);
  font-size: 10px;
  font-weight: 650;
`;

const TranslationArrow = styled.div`
  display: flex;
  height: 34px;
  align-items: center;
  justify-content: center;
  color: var(--live-muted);

  svg {
    width: 15px;
    height: 15px;
  }
`;

const Field = styled.select`
  width: 100%;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--live-border);
  border-radius: 7px;
  background: var(--live-control);
  color: var(--live-text);
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 0 8px;

  &:focus {
    border-color: var(--live-accent);
    box-shadow: 0 0 0 2px var(--live-focus);
  }

  &:disabled {
    opacity: 0.62;
  }
`;

const TextField = styled.input`
  width: 100%;
  min-width: 0;
  height: 34px;
  box-sizing: border-box;
  border: 1px solid var(--live-border);
  border-radius: 7px;
  background: var(--live-control);
  color: var(--live-text);
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 0 10px;

  &::placeholder {
    color: var(--live-muted);
  }

  &:focus {
    border-color: var(--live-accent);
    box-shadow: 0 0 0 2px var(--live-focus);
  }
`;

const PresetGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;

  @media (max-width: 360px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
`;

const Chip = styled.button<{ $active?: boolean }>`
  min-width: 0;
  height: 30px;
  overflow: hidden;
  border: 1px solid
    ${({ $active }) => ($active ? "var(--live-accent)" : "var(--live-border)")};
  border-radius: 7px;
  background: ${({ $active }) =>
    $active ? "var(--live-accent-soft)" : "var(--live-control)"};
  color: ${({ $active }) =>
    $active ? "var(--live-accent-text)" : "var(--live-text)"};
  cursor: pointer;
  font-size: 11px;
  font-weight: 620;
  padding: 0 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const DeviceRow = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 34px;
  gap: 7px;
`;

const IconButton = styled.button`
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--live-border);
  border-radius: 7px;
  background: var(--live-control);
  color: var(--live-text);
  cursor: pointer;

  &:hover {
    border-color: var(--live-border-strong);
    background: var(--live-control-hover);
  }

  svg {
    width: 16px;
    height: 16px;
  }
`;

const ActionRow = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`;

const ActionButton = styled.button`
  display: inline-flex;
  min-width: 0;
  height: 34px;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--live-border);
  border-radius: 7px;
  background: var(--live-control);
  color: var(--live-text);
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
  padding: 0 10px;

  &:hover {
    border-color: var(--live-border-strong);
    background: var(--live-control-hover);
  }

  &:disabled {
    cursor: default;
    opacity: 0.42;
  }

  svg {
    width: 16px;
    height: 16px;
  }
`;

const Badge = styled.span`
  min-width: 0;
  overflow: hidden;
  border-radius: 999px;
  background: var(--live-success-soft);
  color: var(--live-success);
  font-size: 10px;
  font-weight: 650;
  padding: 4px 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export function StartTalkControls(props: StartTalkControlsProps) {
  const {
    isActive,
    languages,
    interpreterActive,
    onToggleInterpreter,
    source,
    target,
    bidirectional,
    onSourceChange,
    onTargetChange,
    onBidirectionalChange,
    voiceStyle,
    onVoiceStyleChange,
    devices,
    selectedDevice,
    onDeviceChange,
    onRefreshDevices,
    onExportTranscript,
    exportState,
    lastSoundEvent,
    announceNotifications,
    onAnnounceNotificationsChange,
    notificationAccess,
    pendingNotificationCount,
    phoneAssistantBridge,
    onPhoneAssistantBridgeChange,
    phoneAssistantWakeWord,
    onPhoneAssistantWakeWordChange,
  } = props;

  const notificationDescription = !announceNotifications
    ? "Desactivadas."
    : interpreterActive
      ? "Se pausarán mientras el modo intérprete esté activo."
      : pendingNotificationCount > 0
        ? `${pendingNotificationCount} esperando a que Lumina termine de hablar.`
        : notificationAccess === "allowed"
          ? "Windows conectado. Se anunciarán al terminar cada turno."
          : notificationAccess === "denied"
            ? "Windows no concedió acceso a las notificaciones."
            : notificationAccess === "error"
              ? "No se pudo iniciar el lector de notificaciones."
              : notificationAccess === "unsupported"
                ? "Disponible solamente en Windows."
                : "Comprobando acceso de Windows...";

  return (
    <Panel onPointerDown={(event) => event.stopPropagation()}>
      <Section>
        <SectionHeader>
          <LanguageIcon />
          <SectionTitle>Traducción en vivo</SectionTitle>
        </SectionHeader>
        <ToggleRow>
          <ToggleCopy>
            <ToggleTitle>Modo intérprete</ToggleTitle>
            <ToggleDescription>
              Traduce la conversación sin responder por su cuenta.
            </ToggleDescription>
          </ToggleCopy>
          <Switch
            type="checkbox"
            aria-label="Activar modo intérprete"
            checked={interpreterActive}
            onChange={(event) => onToggleInterpreter(event.target.checked)}
          />
        </ToggleRow>

        {interpreterActive ? (
          <>
            <TranslationGrid>
              <FieldGroup>
                Origen
                {bidirectional ? (
                  <Field
                    aria-label="Idioma de origen"
                    value={source}
                    onChange={(event) => onSourceChange(event.target.value)}
                  >
                    {languages.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </Field>
                ) : (
                  <Field aria-label="Idioma de origen" value="auto" disabled>
                    <option value="auto">Automático</option>
                  </Field>
                )}
              </FieldGroup>
              <TranslationArrow aria-hidden="true">
                <ArrowRightIcon />
              </TranslationArrow>
              <FieldGroup>
                Destino
                <Field
                  aria-label="Idioma de destino"
                  value={target}
                  onChange={(event) => onTargetChange(event.target.value)}
                >
                  {languages.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </Field>
              </FieldGroup>
            </TranslationGrid>
            <ToggleRow>
              <ToggleCopy>
                <ToggleTitle>Conversación bidireccional</ToggleTitle>
                <ToggleDescription>
                  Detecta quién habla y traduce en ambos sentidos.
                </ToggleDescription>
              </ToggleCopy>
              <Switch
                type="checkbox"
                aria-label="Activar traducción bidireccional"
                checked={bidirectional}
                onChange={(event) =>
                  onBidirectionalChange(event.target.checked)
                }
              />
            </ToggleRow>
          </>
        ) : null}
      </Section>

      {!interpreterActive ? (
        <Section>
          <SectionHeader>
            <SparklesIcon />
            <SectionTitle>Estilo de voz</SectionTitle>
          </SectionHeader>
          <TextField
            aria-label="Estilo de voz"
            placeholder="Describe cómo quieres que hable Lumina"
            value={voiceStyle}
            onChange={(event) => onVoiceStyleChange(event.target.value)}
          />
          <PresetGrid>
            {VOICE_STYLE_PRESETS.map((preset) => (
              <Chip
                key={preset.value}
                type="button"
                $active={voiceStyle === preset.value}
                onClick={() => onVoiceStyleChange(preset.value)}
              >
                {preset.label}
              </Chip>
            ))}
          </PresetGrid>
        </Section>
      ) : null}

      <Section>
        <SectionHeader>
          <BellAlertIcon />
          <SectionTitle>Notificaciones de Windows</SectionTitle>
        </SectionHeader>
        <ToggleRow>
          <ToggleCopy>
            <ToggleTitle>Leer notificaciones</ToggleTitle>
            <ToggleDescription>{notificationDescription}</ToggleDescription>
          </ToggleCopy>
          <Switch
            type="checkbox"
            aria-label="Leer notificaciones de Windows"
            checked={announceNotifications}
            disabled={interpreterActive}
            onChange={(event) =>
              onAnnounceNotificationsChange(event.target.checked)
            }
          />
        </ToggleRow>

        <ToggleRow>
          <ToggleCopy>
            <ToggleTitle>Puente con Google del teléfono</ToggleTitle>
            <ToggleDescription>
              Para mensajes individuales verificados de Enlace Móvil, Lumina
              activa a Gemini del teléfono, indica la app y el remitente, y
              escucha hasta confirmar la respuesta. Grupos y mensajes sensibles
              quedan bloqueados.
            </ToggleDescription>
          </ToggleCopy>
          <Switch
            type="checkbox"
            aria-label="Activar puente con el Google del teléfono"
            checked={phoneAssistantBridge}
            disabled={interpreterActive || !announceNotifications}
            onChange={(event) =>
              onPhoneAssistantBridgeChange(event.target.checked)
            }
          />
        </ToggleRow>

        {phoneAssistantBridge && !interpreterActive ? (
          <TextField
            aria-label="Palabra clave del asistente del teléfono"
            placeholder="OK Google"
            value={phoneAssistantWakeWord}
            onChange={(event) =>
              onPhoneAssistantWakeWordChange(event.target.value)
            }
          />
        ) : null}
      </Section>

      <Section>
        <SectionHeader>
          <MicrophoneIcon />
          <SectionTitle>Entrada de audio</SectionTitle>
        </SectionHeader>
        <DeviceRow>
          <Field
            aria-label="Dispositivo de micrófono"
            value={selectedDevice}
            onChange={(event) => onDeviceChange(event.target.value)}
            disabled={devices.length === 0}
          >
            {devices.length === 0 ? (
              <option value="">Micrófono predeterminado</option>
            ) : (
              devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))
            )}
          </Field>
          <IconButton
            type="button"
            title="Actualizar micrófonos"
            aria-label="Actualizar micrófonos"
            onClick={onRefreshDevices}
          >
            <ArrowPathIcon />
          </IconButton>
        </DeviceRow>
      </Section>

      <ActionRow>
        <ActionButton
          type="button"
          disabled={!isActive}
          onClick={onExportTranscript}
        >
          <ArrowDownTrayIcon />
          {exportState === "done"
            ? "Copiada"
            : exportState === "empty"
              ? "Sin conversación"
              : "Copiar conversación"}
        </ActionButton>
        {lastSoundEvent && lastSoundEvent !== "silence" ? (
          <Badge>Detectado: {SOUND_EVENT_LABELS[lastSoundEvent]}</Badge>
        ) : null}
      </ActionRow>
    </Panel>
  );
}
