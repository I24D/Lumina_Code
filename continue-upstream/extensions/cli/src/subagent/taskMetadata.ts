export interface SubagentTaskMetadata {
  output: string;
  status?: string;
  sessionId?: string;
  parentSessionId?: string;
  error?: string;
}

export function parseSubagentTaskMetadata(
  content: string,
): SubagentTaskMetadata {
  const match = content.match(
    /<task_metadata>\s*([\s\S]*?)\s*<\/task_metadata>/,
  );
  if (!match) return { output: content.trim() };

  const fields = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([^:]+):\s*(.*)$/))
      .filter((item): item is RegExpMatchArray => item !== null)
      .map((item) => [item[1].trim(), item[2].trim()]),
  );
  return {
    output: content.slice(0, match.index).trim(),
    status: fields.status,
    sessionId: fields.session_id,
    parentSessionId: fields.parent_session_id,
    error: fields.error,
  };
}
