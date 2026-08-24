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
import type { StartTalkThinkingLevel } from "core/startTalk/types";
import { useCallback, useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

const MODELS = [
  ["gemini-2.5-flash-native-audio-latest", "Native Audio 2.5"],
  ["gemini-3.1-flash-live-preview", "Gemini 3.1 Live"],
  ["gemini-3.5-live-translate-preview", "Gemini Live Translate"],
];

const VOICES = ["Leda", "Aoede", "Charon", "Fenrir", "Kore", "Puck"];

function sourceLabel(source?: StartTalkConfigStatus["source"]) {
  if (source === "workspace") return "Archivo .env del proyecto";
  if (source === "secureStorage") return "Almacén seguro de VS Code";
  return "Sin configurar";
}

export function StartTalkSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<StartTalkConfigStatus>();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(MODELS[0][0]);
  const [voiceName, setVoiceName] = useState("Leda");
  const [thinkingLevel, setThinkingLevel] =
    useState<StartTalkThinkingLevel>("medium");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const response = await ideMessenger.request(
      "startTalk/getConfigStatus",
      undefined,
    );
    if (response.status === "error") {
      setError(response.error);
      return;
    }
    setStatus(response.content);
    if (response.content.model) setModel(response.content.model);
    if (response.content.voiceName) setVoiceName(response.content.voiceName);
    if (response.content.thinkingLevel) {
      setThinkingLevel(response.content.thinkingLevel);
    }
    setError(undefined);
  }, [ideMessenger]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    const update: StartTalkConfigUpdate = {
      apiKey: apiKey.trim() || undefined,
      model,
      voiceName,
      thinkingLevel,
    };
    const response = await ideMessenger.request("startTalk/configure", update);
    if (response.status === "error") {
      setError(response.error);
    } else {
      setStatus(response.content);
      setApiKey("");
      setMessage("Configuración guardada de forma segura.");
    }
    setSaving(false);
  };

  return (
    <div className="lumina-config-section">
      <ConfigHeader
        title="Start Talk"
        subtext="Configura la conversación de voz Gemini Live sin guardar secretos en la GUI ni en el repositorio."
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
            {status?.configured ? "Listo para conversar" : "Falta la API key"}
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
        <label>
          <span>Gemini API key</span>
          <small>
            Déjala vacía para conservar la clave actual. Una clave nueva se
            guarda en Secret Storage.
          </small>
          <div className="lumina-secret-input">
            <input
              aria-label="Gemini API key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={status?.configured ? "••••••••••••••••" : "AIza…"}
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
              {MODELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
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
              {VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
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
            Si existe `GEMINI_API_KEY` en el `.env` del workspace, esa
            configuración tiene prioridad sobre Secret Storage.
          </p>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Guardando…" : "Guardar configuración"}
          </button>
        </div>
      </div>
    </div>
  );
}
