"""
vision_click.py — See-and-click by visible text, for UIA-blind apps (§9 vision).

Chromium/Electron/canvas apps hide their tree from UIA, so Lumina can't act on
them by identity. This closes the loop the human way: screenshot -> OCR (text +
bounding boxes) -> match the requested text -> click its center via SendInput
(ctypes, AMSI-safe). Now that input works natively, vision is the fallback that
makes the whole desktop reachable.

Reuses capture_analyze.run_ocr (Windows.Media.Ocr / pytesseract) and win_input
(SendInput + foreground allowlist guard) — one source of truth per capability.

Protocol (one JSON on stdout):
  python vision_click.py --action find  --text "Search"
  python vision_click.py --action click --text "Viva la vida" --json '{"allowedApps":["msedge"]}'
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture_analyze  # noqa: E402  (screenshot + OCR)
import win_input  # noqa: E402  (SendInput + guard)


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def _norm(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip().lower()


def rank_blocks(blocks: List[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    q = _norm(query)
    if not q:
        return []
    q_tokens = [t for t in q.split() if len(t) >= 2]
    scored: List[Dict[str, Any]] = []
    for b in blocks:
        t = _norm(b.get("text", ""))
        if not t:
            continue
        if t == q:
            score = 1.0
        elif q in t:
            score = 0.85 - min(0.3, (len(t) - len(q)) * 0.01)
        elif t in q:
            score = 0.6
        elif q_tokens:
            hits = sum(1 for tok in q_tokens if tok in t)
            score = 0.5 * (hits / len(q_tokens)) if hits else 0.0
        else:
            score = 0.0
        if score > 0.0:
            scored.append({**b, "score": round(score, 3)})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "vision_click.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina see-and-click by text")
    ap.add_argument("--action", default="find", choices=["find", "click"])
    ap.add_argument("--text", required=True, help="Visible text to locate/click")
    ap.add_argument("--json", default="{}", help="Extra params: allowedApps, occurrence, button")
    args = ap.parse_args()

    try:
        params = json.loads(args.json) if args.json else {}
        if not isinstance(params, dict):
            params = {}
    except Exception:
        emit({"ok": False, "error": "invalid --json params"}, 2)
        return

    # 1) Screenshot the primary monitor (records its origin for coord mapping).
    tmp = os.path.join(os.environ.get("TEMP", "."), f"lumina-vision-{int(time.time()*1000)}.png")
    cap = capture_analyze.capture_primary(tmp)
    off_x = int((cap or {}).get("left", 0))
    off_y = int((cap or {}).get("top", 0))

    # 2) OCR the frame.
    ocr = capture_analyze.run_ocr(tmp)
    if not ocr.get("available"):
        emit({"ok": False, "error": "ocr_unavailable", "detail": ocr.get("reason"),
              "hint": "install winsdk or pytesseract"})
        return

    # 3) Rank text matches and map to absolute screen coordinates.
    ranked = rank_blocks(ocr.get("blocks", []), args.text)
    targets: List[Dict[str, Any]] = []
    for b in ranked:
        bb = b.get("bbox") or {}
        cx = int(bb.get("x", 0) + bb.get("w", 0) / 2) + off_x
        cy = int(bb.get("y", 0) + bb.get("h", 0) / 2) + off_y
        targets.append({"text": b.get("text"), "score": b.get("score"),
                        "bbox": bb, "screen": {"x": cx, "y": cy}})

    if not targets:
        emit({"ok": False, "error": "text_not_found", "query": args.text,
              "ocrBlocks": len(ocr.get("blocks", []))})
        return

    occ = int(params.get("occurrence", 0))
    occ = max(0, min(occ, len(targets) - 1))
    chosen = targets[occ]

    if args.action == "find":
        emit({"ok": True, "action": "find", "query": args.text,
              "match": chosen, "matches": targets[:6]})
        return

    # 4) Click — same allowlist guard as native input (foreground must match).
    allowed = params.get("allowedApps") or []
    g = win_input.guard(allowed if isinstance(allowed, list) else [])
    if not g.get("ok"):
        emit({**g, "action": "click", "wouldClick": chosen})
        return

    button = str(params.get("button", "left"))
    win_input.do_mouse_click({"x": chosen["screen"]["x"], "y": chosen["screen"]["y"],
                              "button": button, "count": int(params.get("count", 1))})
    emit({"ok": True, "action": "click", "query": args.text, "clicked": chosen,
          "foreground": g.get("foreground")})


if __name__ == "__main__":
    main()
