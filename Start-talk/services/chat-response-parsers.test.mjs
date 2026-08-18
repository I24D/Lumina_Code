import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaudeRecord,
  parseCodexRecord,
  parseOpenClawEvent,
} from "./chat-response-parsers.mjs";

test("reads only Codex final answers", () => {
  assert.equal(
    parseCodexRecord({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Respuesta Codex" }],
      },
    }),
    "Respuesta Codex",
  );
  assert.equal(
    parseCodexRecord({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: "commentary" },
    }),
    "",
  );
});

test("reads only completed Claude Code answers", () => {
  assert.equal(
    parseClaudeRecord({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Respuesta Claude" }],
      },
    }),
    "Respuesta Claude",
  );
});

test("reads only completed OpenClaw assistant messages", () => {
  assert.equal(
    parseOpenClawEvent({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Respuesta OpenClaw" }],
      },
    }),
    "Respuesta OpenClaw",
  );
});
