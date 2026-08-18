#!/usr/bin/env python3
"""Shared best-effort client for Start Talk's local voice response relay."""

import json
import os
import urllib.request

BRIDGE_URL = os.environ.get(
    "LUMINA_VOICE_BRIDGE_URL", "http://127.0.0.1:8765/voice/claude-response"
)
MAX_CHARS = 6000
POST_TIMEOUT_S = 3.0


def post_response(text: str, request_id: str, source: str) -> None:
    payload = json.dumps(
        {
            "text": text[:MAX_CHARS],
            "requestId": request_id,
            "source": source,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        BRIDGE_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=POST_TIMEOUT_S).close()
    except Exception:
        # Hooks must never delay or break the tool that invoked them.
        pass
