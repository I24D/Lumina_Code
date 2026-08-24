import {
  BoltIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { ConversationStarterCards } from "../../components/ConversationStarters";
import { useMainEditor } from "../../components/mainInput/TipTapEditor";
import { OnboardingCard } from "../../components/OnboardingCard";

export interface EmptyChatBodyProps {
  showOnboardingCard?: boolean;
}

export function EmptyChatBody({ showOnboardingCard }: EmptyChatBodyProps) {
  const { mainEditor } = useMainEditor();

  if (showOnboardingCard) {
    return (
      <div className="mx-2 mt-6">
        <OnboardingCard />
      </div>
    );
  }

  const suggestions = [
    {
      label: "Construir una función",
      prompt: "Ayúdame a desarrollar una nueva función en este proyecto.",
      icon: CodeBracketIcon,
    },
    {
      label: "Investigar un error",
      prompt: "Analiza el proyecto y ayúdame a diagnosticar un error.",
      icon: MagnifyingGlassIcon,
    },
    {
      label: "Mejorar el código",
      prompt:
        "Revisa el código actual y propón mejoras seguras y verificables.",
      icon: BoltIcon,
    },
    {
      label: "Ejecutar una tarea",
      prompt:
        "Quiero que realices una tarea usando las herramientas disponibles.",
      icon: WrenchScrewdriverIcon,
    },
  ];

  return (
    <section className="lumina-empty-chat">
      <div className="lumina-empty-chat__hero">
        <span className="lumina-empty-chat__spark" aria-hidden="true">
          ✦
        </span>
        <h1>¿Qué vamos a construir?</h1>
        <p>
          Lumina entiende tu proyecto, modifica archivos, ejecuta herramientas y
          te acompaña desde la idea hasta una solución verificada.
        </p>
      </div>
      <div className="lumina-empty-chat__suggestions">
        {suggestions.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              type="button"
              key={suggestion.label}
              onClick={() => {
                mainEditor?.commands.setContent(suggestion.prompt);
                mainEditor?.commands.focus("end");
              }}
            >
              <Icon aria-hidden="true" />
              <span>{suggestion.label}</span>
            </button>
          );
        })}
      </div>
      <ConversationStarterCards />
    </section>
  );
}
