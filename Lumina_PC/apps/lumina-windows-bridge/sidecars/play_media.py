"""
play_media.py — Resolve a song/query and start it playing on YouTube (§5).

The AMSI-safe "play music" path: it never drives the UI (Bitdefender blocks the
bridge's SendInput/EnumWindows P/Invoke, and Chromium is opaque to UIA anyway).
Instead it resolves the request to an exact video and deep-links the browser
straight to it, then leaves verification to now_playing.py.

Steps:
  1. Resolve the query to the first YouTube videoId (HTML scrape, no API key).
  2. Open https://www.youtube.com/watch?v=<id> in the default browser via
     os.startfile (ShellExecute — not PowerShell, so AMSI doesn't block it).

Protocol (one JSON on stdout):
  python play_media.py --query "coldplay viva la vida" [--provider youtube] [--no-open]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def resolve_youtube(query: str) -> Tuple[Optional[str], Optional[str]]:
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "en-US,en;q=0.9",
    })
    html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
    vid = re.search(r'"videoId":"([\w-]{11})"', html)
    title = re.search(
        r'"videoId":"[\w-]{11}","thumbnail".*?"text":"([^"]+)"', html)
    if not title:
        title = re.search(r'"title":\{"runs":\[\{"text":"([^"]+)"\}', html)
    return (vid.group(1) if vid else None,
            title.group(1) if title else None)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "play_media.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina media resolver/opener")
    ap.add_argument("--query", required=True, help="Song / video to play")
    ap.add_argument("--provider", default="youtube", choices=["youtube"])
    ap.add_argument("--no-open", action="store_true", help="Resolve only, don't open")
    args = ap.parse_args()

    try:
        vid, title = resolve_youtube(args.query)
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"resolve_failed: {e!s}", "query": args.query}, 1)
        return

    if not vid:
        emit({"ok": False, "error": "no_result", "query": args.query})
        return

    watch = f"https://www.youtube.com/watch?v={vid}"
    opened = False
    if not args.no_open:
        try:
            os.startfile(watch)  # ShellExecute -> default browser (AMSI-safe)
            opened = True
        except Exception as e:  # noqa: BLE001
            emit({"ok": False, "error": f"open_failed: {e!s}",
                  "videoId": vid, "url": watch, "resolvedTitle": title})
            return

    emit({
        "ok": True,
        "provider": args.provider,
        "query": args.query,
        "videoId": vid,
        "resolvedTitle": title,
        "url": watch,
        "opened": opened,
        "note": "Verify real playback with /now_playing (audio peak + media session).",
    })


if __name__ == "__main__":
    main()
