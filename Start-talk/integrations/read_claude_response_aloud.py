#!/usr/bin/env python3
"""Claude Code Stop hook that relays its latest answer to Start Talk."""

import json
import os
import sys

from voice_bridge import post_response


def enabled() -> bool:
    flag = str(os.environ.get("START_TALK_READ_CLAUDE_CODE", "")).strip().lower()
    return flag not in ("false", "0", "off", "no")


def last_assistant_text(transcript_path: str) -> str:
    result = ""
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(record, dict) or record.get("type") != "assistant":
                    continue
                message = record.get("message")
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                parts = []
                if isinstance(content, str):
                    parts.append(content)
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text")
                            if isinstance(text, str):
                                parts.append(text)
                joined = "".join(parts).strip()
                if joined:
                    result = joined
    except OSError:
        return ""
    return result


def main() -> int:
    if not enabled():
        return 0
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except (ValueError, TypeError):
        return 0
    if not isinstance(data, dict):
        return 0
    transcript_path = data.get("transcript_path")
    if not isinstance(transcript_path, str) or not transcript_path:
        return 0
    text = last_assistant_text(transcript_path)
    if not text:
        return 0
    session_id = str(data.get("session_id") or "unknown")
    post_response(text, "claude:{}:{}".format(session_id, len(text)), "claude-code")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
