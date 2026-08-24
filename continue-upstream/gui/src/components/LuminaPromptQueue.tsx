import { ClockIcon, XMarkIcon } from "@heroicons/react/24/outline";

export type QueuedPrompt = {
  id: string;
  preview: string;
};

export function LuminaPromptQueue({
  prompts,
  onRemove,
}: {
  prompts: QueuedPrompt[];
  onRemove: (id: string) => void;
}) {
  if (prompts.length === 0) return null;

  return (
    <section className="lumina-prompt-queue" aria-label="Mensajes en cola">
      <div className="lumina-prompt-queue__heading">
        <ClockIcon aria-hidden="true" />
        <strong>En cola</strong>
        <span>{prompts.length}</span>
      </div>
      <div className="lumina-prompt-queue__items thin-scrollbar">
        {prompts.map((prompt, index) => (
          <div key={prompt.id} className="lumina-prompt-queue__item">
            <span>{index + 1}</span>
            <p>{prompt.preview}</p>
            <button
              type="button"
              aria-label={`Quitar de la cola: ${prompt.preview}`}
              onClick={() => onRemove(prompt.id)}
            >
              <XMarkIcon />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
