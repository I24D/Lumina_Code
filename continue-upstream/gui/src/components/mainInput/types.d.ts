import { ContextProviderDescription, SlashCommandSource } from "core";

export type ComboBoxItemType =
  | "contextProvider"
  | "slashCommand"
  | "file"
  | "query"
  | "folder"
  | "action";

export interface ComboBoxSubAction {
  label: string;
  icon: string;
  action: (item: ComboBoxItem) => void;
}

export interface ComboBoxItem {
  title: string;
  description: string;
  id?: string;
  content?: string;
  type: ComboBoxItemType;
  contextProvider?: ContextProviderDescription;
  query?: string;
  label?: string;
  icon?: string;
  action?: () => void;
  subActions?: ComboBoxSubAction[];
  slashCommandSource?: SlashCommandSource;
  /** Encabezado bajo el que se agrupa en el desplegable (SESIÓN, MODELO, …). */
  category?: string;
  /** Argumentos que acepta, mostrados tenues tras el nombre: `[nivel]`. */
  argsHint?: string;
  /** Etiqueta corta a la derecha: "instantáneo", "4 opciones". */
  badge?: string;
}
