function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object")
    .filter((block) => block.type === "text" || block.type === "output_text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

export function parseCodexRecord(record) {
  if (record?.type !== "response_item") return "";
  const payload = record.payload;
  if (
    payload?.type !== "message" ||
    payload.role !== "assistant" ||
    payload.phase !== "final_answer"
  ) {
    return "";
  }
  return textFromContent(payload.content);
}

export function parseClaudeRecord(record) {
  if (record?.type !== "assistant" || record.message?.role !== "assistant") return "";
  const stopReason = record.stop_reason ?? record.message.stop_reason;
  if (stopReason !== "end_turn") return "";
  return textFromContent(record.message.content);
}

export function parseOpenClawEvent(eventJson) {
  let event;
  try {
    event = typeof eventJson === "string" ? JSON.parse(eventJson) : eventJson;
  } catch {
    return "";
  }
  const message = event?.type === "message" ? event.message : undefined;
  if (message?.role !== "assistant") return "";
  const stopReason = message.stopReason ?? message.stop_reason;
  if (stopReason !== "stop" && stopReason !== "end_turn") return "";
  return textFromContent(message.content);
}
