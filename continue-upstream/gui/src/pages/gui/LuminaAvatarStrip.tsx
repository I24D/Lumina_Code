import { useEffect, useMemo, useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { getLuminaAssetUrl } from "../../util/luminaAssets";

const RESPONSE_LANGUAGES = [
  ["auto", "Auto"],
  ["es", "ES"],
  ["en", "EN"],
  ["pt", "PT"],
  ["fr", "FR"],
  ["de", "DE"],
];

const CODE_LANGUAGES = [
  ["project", "Code: project"],
  ["english", "Code: EN"],
  ["same-as-response", "Code: same"],
];

function initialPreference(key: string, fallback: string) {
  return (
    localStorage.getItem(`luminaCode.${key}`) ||
    window.luminaCodePreferences?.[key] ||
    fallback
  );
}

export function LuminaAvatarIcon({
  className = "h-8 w-8 object-contain p-0.5",
}: {
  className?: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarSrc = useMemo(
    () => window.luminaAvatarUrl || getLuminaAssetUrl("lumina-icon.png"),
    [],
  );

  if (avatarSrc && !avatarFailed) {
    return (
      <img
        src={avatarSrc}
        alt="Lumina"
        draggable={false}
        className={className}
        onError={() => setAvatarFailed(true)}
      />
    );
  }

  return (
    <div
      aria-label="Lumina"
      className="flex h-8 w-8 items-center justify-center rounded bg-red-600 text-sm font-bold text-white"
    >
      L
    </div>
  );
}

export function LuminaAvatarStrip() {
  const title = useAppSelector((state) => state.session.title);
  const mode = useAppSelector((state) => state.session.mode);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const [responseLanguage, setResponseLanguage] = useState(() =>
    initialPreference("responseLanguage", "auto"),
  );
  const [codeLanguage, setCodeLanguage] = useState(() =>
    initialPreference("codeLanguage", "project"),
  );
  useEffect(() => {
    localStorage.setItem("luminaCode.responseLanguage", responseLanguage);
    localStorage.setItem("luminaCode.codeLanguage", codeLanguage);
    window.luminaCodePreferences = {
      ...(window.luminaCodePreferences ?? {}),
      responseLanguage,
      codeLanguage,
    };
  }, [responseLanguage, codeLanguage]);

  return (
    <header className="lumina-chat-header">
      <div className="lumina-chat-header__identity">
        <LuminaAvatarIcon className="lumina-chat-header__avatar" />
        <div className="lumina-chat-header__copy">
          <span className="lumina-chat-header__eyebrow">Lumina Code</span>
          <strong title={title}>{title}</strong>
          <div className="lumina-chat-header__metadata">
            <span data-running={isStreaming || undefined}>
              {isStreaming ? "Trabajando" : "Lista"}
            </span>
            <span>{mode === "agent" ? "Agente" : "Chat"}</span>
            {selectedModel?.title && (
              <span title={selectedModel.title}>{selectedModel.title}</span>
            )}
          </div>
        </div>
      </div>

      <div className="lumina-chat-header__preferences">
        <label>
          <span>Respuesta</span>
          <select
            title="Response language"
            value={responseLanguage}
            onChange={(event) => setResponseLanguage(event.target.value)}
          >
            {RESPONSE_LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Código</span>
          <select
            title="Code language"
            value={codeLanguage}
            onChange={(event) => setCodeLanguage(event.target.value)}
          >
            {CODE_LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}
