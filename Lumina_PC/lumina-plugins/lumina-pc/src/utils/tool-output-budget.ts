export const TOOL_RESULT_MODEL_CHAR_LIMIT = 5 * 1024;
export const TOOL_RESULT_STORAGE_CHAR_LIMIT = 20 * 1024;
export const TERMINAL_CAPTURE_CHAR_LIMIT = 20 * 1024;
export const AGENT_TOOL_ITERATION_LIMIT = 20;
export const AGENT_TOOL_ITERATION_LIMIT_MESSAGE = "l\u00edmite alcanzado, dime c\u00f3mo continuar";

type BudgetOptions = {
  toolName?: string;
  maxChars?: number;
};

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactText(text: string, opts: BudgetOptions): string {
  const maxChars = Math.max(200, opts.maxChars ?? TOOL_RESULT_MODEL_CHAR_LIMIT);
  if (text.length <= maxChars) return text;

  const noticeBudget = 220;
  const bodyBudget = Math.max(80, maxChars - noticeBudget);
  const headChars = Math.ceil(bodyBudget * 0.6);
  const tailChars = Math.max(40, bodyBudget - headChars);
  const omitted = Math.max(0, text.length - headChars - tailChars);
  const label = opts.toolName ? ` for ${opts.toolName}` : "";

  return [
    text.slice(0, headChars).trimEnd(),
    "",
    `[Lumina output guard${label}: compacted output for model; omitted ${omitted} chars from the middle.]`,
    "",
    text.slice(-tailChars).trimStart(),
  ].join("\n");
}

export function compactToolResultForModel(text: unknown, opts: BudgetOptions = {}): string {
  return compactText(toText(text), {
    ...opts,
    maxChars: opts.maxChars ?? TOOL_RESULT_MODEL_CHAR_LIMIT,
  });
}

export function compactContextItemsForStorage<T>(items: T, opts: BudgetOptions = {}): T | string {
  const text = toText(items);
  if (text.length <= (opts.maxChars ?? TOOL_RESULT_STORAGE_CHAR_LIMIT)) {
    return items;
  }
  return compactText(text, {
    ...opts,
    maxChars: opts.maxChars ?? TOOL_RESULT_STORAGE_CHAR_LIMIT,
  });
}

export function appendCappedTerminalOutput(
  current: string,
  chunk: string,
  maxChars = TERMINAL_CAPTURE_CHAR_LIMIT,
): string {
  const next = `${current ?? ""}${chunk ?? ""}`;
  if (next.length <= maxChars) return next;

  const omitted = next.length - maxChars;
  const notice = `[Lumina output guard: kept last ${maxChars} chars; omitted ${omitted} earlier chars]\n`;
  const keptBudget = Math.max(0, maxChars - notice.length);
  return notice + next.slice(-keptBudget);
}

export function capTerminalText(text: unknown, maxChars = TERMINAL_CAPTURE_CHAR_LIMIT): string {
  return appendCappedTerminalOutput("", toText(text), maxChars);
}
