import { FormEvent, useLayoutEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { Input, SecondaryButton } from "..";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";

interface GitHubSessionDialogProps {
  onSubmit: (reference: string) => Promise<void>;
}

export function GitHubSessionDialog({ onSubmit }: GitHubSessionDialogProps) {
  const dispatch = useDispatch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

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
    const value = reference.trim();
    if (!value) {
      setError("Pega el enlace de un issue o pull request.");
      return;
    }
    setError(undefined);
    setIsLoading(true);
    try {
      await onSubmit(value);
      closeDialog();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo cargar la referencia de GitHub.",
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="px-2 pt-4 sm:px-4">
      <h1 className="mb-0">Sesión desde GitHub</h1>
      <p className="m-0 mt-2 p-0 text-stone-500">
        Carga la descripción, comentarios y cambios del PR en una sesión nueva.
        Lumina no ejecutará nada hasta que revises y envíes el prompt.
      </p>
      <form className="mt-3 flex flex-col gap-2" onSubmit={handleSubmit}>
        <label className="flex w-full flex-col gap-1">
          <span>Issue o pull request</span>
          <Input
            ref={inputRef}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="https://github.com/owner/repo/issues/123"
            disabled={isLoading}
          />
        </label>
        <span className="text-xs text-stone-500">
          También admite owner/repo#123. El token permanece en el backend.
        </span>
        {error && <p className="m-0 text-xs text-red-500">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <SecondaryButton type="button" onClick={closeDialog}>
            Cancelar
          </SecondaryButton>
          <SecondaryButton type="submit" disabled={isLoading}>
            {isLoading ? "Cargando…" : "Preparar sesión"}
          </SecondaryButton>
        </div>
      </form>
    </div>
  );
}
