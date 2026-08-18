#!/usr/bin/env python3
"""Codex CLI notify hook that relays a completed answer to Start Talk."""

import json
import os
import sys

from voice_bridge import post_response

MESSAGE_KEYS = (
    "last-assistant-message",
    "last_assistant_message",
    "last-agent-message",
    "last_agent_message",
    "assistant-message",
    "message",
)


def enabled() -> bool:
    flag = str(os.environ.get("START_TALK_READ_CODEX", "")).strip().lower()
    return flag not in ("false", "0", "off", "no")


def extract_message(data: dict) -> str:
    for key in MESSAGE_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def main() -> int:
    if not enabled() or len(sys.argv) < 2:
        return 0
    try:
        data = json.loads(sys.argv[1])
    except (ValueError, TypeError):
        return 0
    if not isinstance(data, dict):
        return 0

    event_type = data.get("type")
    if isinstance(event_type, str) and event_type not in (
        "agent-turn-complete",
        "agent_turn_complete",
    ):
        return 0

    text = extract_message(data)
    if not text:
        return 0
    turn_id = str(data.get("turn-id") or data.get("turn_id") or "turn")
    post_response(text, "codex:{}:{}".format(turn_id, len(text)), "codex")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
