import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import { AssistantSettingsState } from "./types";

type Props = {
  settings: AssistantSettingsState;
  onChange?: (settings: AssistantSettingsState) => void;
};

export function AgentSettings({ settings, onChange }: Props) {
  const update = (key: keyof AssistantSettingsState) => {
    onChange?.({ ...settings, [key]: !settings[key] });
  };

  return (
    <section className="p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[color:var(--vscode-descriptionForeground)]">
        <Cog6ToothIcon className="h-4 w-4" />
        Settings
      </div>
      <div className="flex flex-col gap-2">
        {([
          ["fullAccess", "Full access"],
          ["requireVerification", "Require verification"],
          ["continuousVision", "Continuous vision"],
        ] as const).map(([key, label]) => (
          <label
            key={key}
            className="flex cursor-pointer items-center justify-between gap-3 text-sm"
          >
            <span>{label}</span>
            <input
              checked={settings[key]}
              disabled={key !== "fullAccess"}
              onChange={() => update(key)}
              type="checkbox"
            />
          </label>
        ))}
      </div>
    </section>
  );
}
