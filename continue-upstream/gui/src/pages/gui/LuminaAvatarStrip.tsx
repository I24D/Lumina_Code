import { useEffect, useMemo, useState } from "react";
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
    <div className="mx-2 mb-2 mt-1 flex min-h-[46px] items-center justify-between gap-2 rounded border border-vsc-input-border bg-vsc-input-background px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <LuminaAvatarIcon className="h-8 w-8 flex-shrink-0 object-contain p-0.5" />
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-foreground">
            Lumina Code
          </div>
          <div className="truncate text-[10px] text-description-muted">
            Continue-native LLM routing
          </div>
        </div>
      </div>

      <div className="ml-auto hidden flex-shrink-0 items-center gap-1 min-[460px]:flex">
        <select
          className="rounded border border-vsc-input-border bg-vsc-input-background px-1 py-1 text-[10px] text-foreground"
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
        <select
          className="rounded border border-vsc-input-border bg-vsc-input-background px-1 py-1 text-[10px] text-foreground"
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
      </div>
    </div>
  );
}
