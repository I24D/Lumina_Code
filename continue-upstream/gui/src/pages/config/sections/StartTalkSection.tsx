import {
  CheckBadgeIcon,
  EyeIcon,
  EyeSlashIcon,
  MicrophoneIcon,
  PlayIcon,
} from "@heroicons/react/24/outline";
import type {
  StartTalkConfigStatus,
  StartTalkConfigUpdate,
} from "core/startTalk/env";
import type {
  StartTalkProvider,
  StartTalkThinkingLevel,
} from "core/startTalk/types";
import {
  defaultModelForProvider,
  defaultVoiceForProvider,
  modelsForProvider,
  resolveModelForProvider,
  voicesForProvider,
} from "core/startTalk/voices";
import { useCallback, useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

const PROVIDERS: Array<{
  id: StartTalkProvider;
  label: string;
  hint: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyHelp: string;
}> = [
  {
    id: "openai-realtime",
    label: "OpenAI Realtime",
    hint: "El modelo de voz más reciente de OpenAI, con voz de mujer joven",
    keyLabel: "OpenAI API key",
    keyPlaceholder: "sk-…",
    keyHelp:
      "Se usa solo para la voz en tiempo real. Se guarda en Secret Storage.",
  },
  {
    id: "gemini-live",
    label: "Gemini Live",
    hint: "Audio nativo de Google con grounding de Búsqueda",
    keyLabel: "Gemini API key",
    keyPlaceholder: "AIza…",
    keyHelp:
      "Se usa solo para la voz en tiempo real. Se guarda en Secret Storage.",
  },
];

function providerInfo(provider: StartTalkProvider) {
  return PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0];
}

function sourceLabel(source?: StartTalkConfigStatus["source"]) {
  if (source === "workspace") return "Archivo .env del proyecto";
  if (source === "secureStorage") return "Almacén seguro de VS Code";
  return "Sin configurar";
}

export function StartTalkSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<StartTalkConfigStatus>();
  const [provider, setProvider] =
    useState<StartTalkProvider>("openai-realtime");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(
    defaultModelForProvider("openai-realtime"),
  );
  const [voiceName, setVoiceName] = useState(
    defaultVoiceForProvider("openai-realtime"),
  );
  const [thinkingLevel, setThinkingLevel] =
    useState<StartTalkThinkingLevel>("medium");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const applyStatus = useCallback((next: StartTalkConfigStatus) => {
    setStatus(next);
    setProvider(next.provider);
    // El modelo guardado puede ser del otro proveedor (se comparte un solo
    // campo); en ese caso vale el del proveedor activo, no una combinación
    // imposible que la API rechazaría al conectar.
    setModel(resolveModelForProvider(next.provider, next.model));
    setVoiceName(
      (next.provider === "openai-realtime"
        ? next.openAiVoiceName
        : next.voiceName) ?? defaultVoiceForProvider(next.provider),
    );
    if (next.thinkingLevel) {
      setThinkingLevel(next.thinkingLevel);
    }
  }, []);

  const refresh = useCallback(async () => {
    const response = await ideMessenger.request(
      "startTalk/getConfigStatus",
      undefined,
    );
    if (response.status === "error") {
      setError(response.error);
      return;
    }
    applyStatus(response.content);
    setError(undefined);
  }, [applyStatus, ideMessenger]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Cambiar de proveedor arrastra modelo y voz: no son intercambiables. */
  const selectProvider = (next: StartTalkProvider) => {
    if (next === provider) {
      return;
    }
    setProvider(next);
    setModel(defaultModelForProvider(next));
    setVoiceName(
      (next === "openai-realtime"
        ? status?.openAiVoiceName
        : status?.voiceName) ?? defaultVoiceForProvider(next),
    );
    setApiKey("");
    setMessage(undefined);
    setError(undefined);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    const secret = apiKey.trim() || undefined;
    const update: StartTalkConfigUpdate = {
      provider,
      model,
      thinkingLevel,
      ...(provider === "openai-realtime"
        ? { openAiApiKey: secret, openAiVoiceName: voiceName }
        : { apiKey: secret, voiceName }),
    };
    const response = await ideMessenger.request("startTalk/configure", update);
    if (response.status === "error") {
      setError(response.error);
    } else {
      applyStatus(response.content);
      setApiKey("");
      setMessage("Configuración guardada de forma segura.");
    }
    setSaving(false);
  };

  const active = providerInfo(provider);
  const voices = voicesForProvider(provider);
  const femaleVoices = voices.filter((voice) => voice.youngFemale);
  const otherVoices = voices.filter((voice) => !voice.youngFemale);

  return (
    <div className="lumina-config-section">
      <ConfigHeader
        title="Start Talk"
        subtext="Elige el proveedor de voz en tiempo real y su voz, sin guardar secretos en la GUI ni en el repositorio."
      />

      <div className="lumina-settings-summary">
        <div
          className="lumina-settings-summary__icon"
          data-state={status?.configured ? "connected" : "offline"}
        >
          {status?.configured ? <CheckBadgeIcon /> : <MicrophoneIcon />}
        </div>
        <div>
          <strong>
            {status?.configured
              ? `Listo para conversar · ${providerInfo(status.provider).label}`
              : `Falta la ${providerInfo(status?.provider ?? provider).keyLabel}`}
          </strong>
          <span>{sourceLabel(status?.source)}</span>
        </div>
        <button
          type="button"
          onClick={() => ideMessenger.post("startTalk/launchOrb", undefined)}
          disabled={!status?.configured}
        >
          <PlayIcon />
          Abrir Start Talk
        </button>
      </div>

      <div className="lumina-settings-form">
        <div>
          <span className="lumina-settings-form__legend">Proveedor de voz</span>
          <div
            className="lumina-settings-form__providers"
            role="radiogroup"
            aria-label="Proveedor de voz"
          >
            {PROVIDERS.map((entry) => {
              const ready =
                entry.id === "openai-realtime"
                  ? status?.openAiConfigured
                  : status?.geminiConfigured;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={entry.id === provider}
                  data-active={entry.id === provider}
                  onClick={() => selectProvider(entry.id)}
                >
                  <strong>{entry.label}</strong>
                  <small>{entry.hint}</small>
                  <em>{ready ? "Clave guardada" : "Sin clave"}</em>
                </button>
              );
            })}
          </div>
        </div>

        <label>
          <span>{active.keyLabel}</span>
          <small>
            Déjala vacía para conservar la clave actual. {active.keyHelp}
          </small>
          <div className="lumina-secret-input">
            <input
              aria-label={active.keyLabel}
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                (
                  provider === "openai-realtime"
                    ? status?.openAiConfigured
                    : status?.geminiConfigured
                )
                  ? "••••••••••••••••"
                  : active.keyPlaceholder
              }
              autoComplete="off"
            />
            <button
              type="button"
              aria-label={showKey ? "Ocultar clave" : "Mostrar clave"}
              onClick={() => setShowKey((visible) => !visible)}
            >
              {showKey ? <EyeSlashIcon /> : <EyeIcon />}
            </button>
          </div>
        </label>

        <div className="lumina-settings-form__row">
          <label>
            <span>Modelo de voz</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {modelsForProvider(provider).map((option) => (
                <option key={option.model} value={option.model}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Voz</span>
            <select
              value={voiceName}
              onChange={(event) => setVoiceName(event.target.value)}
            >
              <optgroup label="Mujer joven">
                {femaleVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label} · {voice.description}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Otras voces">
                {otherVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label} · {voice.description}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            <span>Pensamiento</span>
            <select
              value={thinkingLevel}
              onChange={(event) =>
                setThinkingLevel(event.target.value as StartTalkThinkingLevel)
              }
            >
              <option value="minimal">Mínimo</option>
              <option value="low">Bajo</option>
              <option value="medium">Estándar</option>
              <option value="high">Alto</option>
            </select>
          </label>
        </div>

        {error && <div className="lumina-settings-error">{error}</div>}
        {message && <div className="lumina-settings-success">{message}</div>}

        <div className="lumina-settings-form__submit">
          <p>
            Si el `.env` del workspace trae `OPENAI_API_KEY` o `GEMINI_API_KEY`,
            esa configuración tiene prioridad sobre Secret Storage. Puedes dejar
            las dos claves guardadas y cambiar de proveedor cuando quieras.
          </p>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Guardando…" : "Guardar configuración"}
          </button>
        </div>
      </div>
    </div>
  );
}
