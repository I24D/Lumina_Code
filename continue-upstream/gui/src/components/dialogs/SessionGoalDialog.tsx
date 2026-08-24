import { FormEvent, useLayoutEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { Input, SecondaryButton } from "..";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";

interface SessionGoalDialogProps {
  onSubmit: (goal: string) => Promise<void>;
}

export function SessionGoalDialog({ onSubmit }: SessionGoalDialogProps) {
  const dispatch = useDispatch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  useLayoutEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const closeDialog = () => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const text = goal.trim();
    if (!text) {
      setError("Describe el resultado que Lumina debe conseguir.");
      return;
    }

    setError(undefined);
    setIsSubmitting(true);
    try {
      await onSubmit(text);
      closeDialog();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo guardar la meta de la sesión.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="px-2 pt-4 sm:px-4">
      <h1 className="mb-0">Meta de la sesión</h1>
      <p className="m-0 mt-2 p-0 text-stone-500">
        Lumina continuará trabajando hasta cumplir este resultado o necesitar tu
        intervención.
      </p>
      <form className="mt-3 flex flex-col gap-2" onSubmit={handleSubmit}>
        <label className="flex w-full flex-col gap-1">
          <span>¿Qué debe conseguir Lumina antes de parar?</span>
          <Input
            ref={inputRef}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Ej.: Corrige los tests de autenticación y verifica el build"
            disabled={isSubmitting}
          />
        </label>
        {error && <p className="m-0 text-xs text-red-500">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <SecondaryButton type="button" onClick={closeDialog}>
            Cancelar
          </SecondaryButton>
          <SecondaryButton type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Guardando…" : "Iniciar meta"}
          </SecondaryButton>
        </div>
      </form>
    </div>
  );
}
