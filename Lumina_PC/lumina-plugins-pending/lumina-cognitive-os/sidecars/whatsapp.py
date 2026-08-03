"""Reply to a WhatsApp contact through Windows UI Automation, no screen coordinates.

Unified flow for "answer <contact>: <message>":
  1. Find the target window (WhatsApp Desktop, else Phone Link mirror).
  2. Fuzzy-match the contact in the conversation list and open the chat.
  3. Type the message into the composer.
  4. Submit with Enter (the Send button is often not exposed in the UIA tree).
  5. Verify the message left the composer / appears as an outgoing bubble.

The exact AutomationIds differ between WhatsApp Desktop builds and the Phone
Link mirror, so selection is heuristic (name/type/geometry) and every response
reports what was observed, letting the caller tune without guessing coordinates.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import re
import sys
import time
import unicodedata
from ctypes import wintypes
from typing import Any, Dict, Iterable, List, Optional, Tuple


# Candidate host apps, in preference order. WhatsApp Desktop exposes a far
# richer UIA tree than the Phone Link app mirror, so it is tried first.
WINDOW_CANDIDATES: Tuple[Tuple[str, str], ...] = (
    ("whatsapp", "whatsapp.exe"),
    ("phone_link", "phoneexperiencehost.exe"),
)
COMPOSER_NAME_HINTS = ("type a message", "escribe un mensaje", "message", "mensaje")
SEND_LABELS = ("send", "enviar")
SEARCH_NAME_HINTS = ("search", "buscar")


def emit(value: Dict[str, Any], code: int = 0) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", stripped).strip().lower()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WhatsApp UI Automation adapter")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--contacts", action="store_true",
                      help="List visible conversations in the target window.")
    mode.add_argument("--reply", action="store_true",
                      help="Open a contact and send a message.")
    parser.add_argument("--contact", default="")
    parser.add_argument("--message", default="")
    parser.add_argument("--window", default="",
                        help="Force a host: whatsapp | phone_link. Empty = auto.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Resolve the contact and composer but do not send.")
    parser.add_argument("--timeout", type=float, default=12.0)
    return parser.parse_args()


def process_name(pid: int) -> str:
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    handle = kernel32.OpenProcess(0x0410, False, pid)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(260)
        if psapi.GetModuleBaseNameW(handle, None, buffer, 260):
            return normalize(buffer.value)
    finally:
        kernel32.CloseHandle(handle)
    return ""


def enum_target_windows() -> List[Dict[str, Any]]:
    user32 = ctypes.windll.user32
    windows: List[Dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc = process_name(int(pid.value))
        for host, exe in WINDOW_CANDIDATES:
            if proc == normalize(exe):
                length = user32.GetWindowTextLengthW(hwnd)
                title_buffer = ctypes.create_unicode_buffer(max(1, length + 1))
                user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
                windows.append({
                    "handle": int(hwnd),
                    "pid": int(pid.value),
                    "title": title_buffer.value,
                    "host": host,
                })
                break
        return True

    user32.EnumWindows(callback_type(callback), 0)
    return windows


def find_target_window(preferred: str) -> Optional[Dict[str, Any]]:
    windows = enum_target_windows()
    if not windows:
        return None
    if preferred:
        for window in windows:
            if window["host"] == preferred:
                return window
    order = {host: index for index, (host, _exe) in enumerate(WINDOW_CANDIDATES)}
    windows.sort(key=lambda w: order.get(w["host"], 99))
    return windows[0]


def restore_window(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)


def walk(root, max_depth: int = 18, max_nodes: int = 4000) -> List[Any]:
    output: List[Any] = []
    stack: List[Tuple[Any, int]] = [(root, 0)]
    while stack and len(output) < max_nodes:
        node, depth = stack.pop()
        output.append(node)
        if depth >= max_depth:
            continue
        for child in reversed(safe(lambda: node.GetChildren(), []) or []):
            stack.append((child, depth + 1))
    return output


def node_name(node) -> str:
    return str(safe(lambda: node.Name, "") or "")


def node_type(node) -> str:
    return normalize(str(safe(lambda: node.ControlTypeName, "") or "")).replace("control", "")


def node_enabled(node) -> bool:
    return bool(safe(lambda: node.IsEnabled, False))


def node_bottom(node) -> int:
    rect = safe(lambda: node.BoundingRectangle)
    return int(getattr(rect, "bottom", 0) or 0) if rect else 0


def describe(node) -> Dict[str, Any]:
    return {
        "name": node_name(node)[:200],
        "automationId": str(safe(lambda: node.AutomationId, "") or "")[:120],
        "controlType": str(safe(lambda: node.ControlTypeName, "") or "")[:80],
        "enabled": node_enabled(node),
    }


def score_contact(name_norm: str, query_norm: str, query_tokens: List[str]) -> float:
    if not name_norm:
        return 0.0
    if name_norm == query_norm:
        return 1.0
    if query_norm in name_norm:
        return 0.85 - (len(name_norm) - len(query_norm)) * 0.005
    if query_tokens:
        hits = sum(1 for token in query_tokens if token in name_norm)
        if hits:
            return 0.3 + 0.5 * (hits / len(query_tokens))
    return 0.0


def list_conversations(nodes: List[Any]) -> List[Any]:
    return [
        node for node in nodes
        if node_type(node) in {"listitem", "treeitem"} and node_name(node).strip()
    ]


def find_contact(nodes: List[Any], contact: str) -> Tuple[Optional[Any], float]:
    query_norm = normalize(contact)
    query_tokens = [token for token in query_norm.split() if len(token) >= 2]
    best: Optional[Any] = None
    best_score = 0.0
    for node in list_conversations(nodes):
        score = score_contact(normalize(node_name(node)), query_norm, query_tokens)
        if score > best_score:
            best, best_score = node, score
    return best, best_score


def find_composer(nodes: List[Any]) -> Optional[Any]:
    editable = [
        node for node in nodes
        if node_type(node) in {"edit", "document"} and node_enabled(node)
    ]
    if not editable:
        return None
    # Prefer an editor whose name looks like a message composer; otherwise the
    # lowest editable control on screen (WhatsApp's composer sits at the bottom).
    for node in editable:
        if any(hint in normalize(node_name(node)) for hint in COMPOSER_NAME_HINTS):
            return node
    return max(editable, key=node_bottom)


def find_send_button(nodes: List[Any]) -> Optional[Any]:
    for node in nodes:
        if node_type(node) in {"button", "hyperlink"} and node_enabled(node):
            if any(label in normalize(node_name(node)) for label in SEND_LABELS):
                return node
    return None


def invoke(node) -> None:
    try:
        node.GetInvokePattern().Invoke()
    except Exception:
        node.Click()


def run_contacts(auto, window: Dict[str, Any]) -> None:
    root = auto.ControlFromHandle(window["handle"])
    nodes = walk(root)
    conversations = list_conversations(nodes)
    emit({
        "ok": True,
        "host": window["host"],
        "title": window["title"],
        "contacts": [
            {"name": node_name(node)[:200], "enabled": node_enabled(node)}
            for node in conversations[:40]
        ],
        "count": len(conversations),
    })


def run_reply(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    if not args.contact.strip() or not args.message.strip():
        emit({"ok": False, "error": "missing_contact_or_message"}, 2)
    message = args.message.strip()
    if len(message) > 1000:
        emit({"ok": False, "error": "message_too_long"}, 2)

    restore_window(window["handle"])
    root = auto.ControlFromHandle(window["handle"])
    nodes = walk(root)

    contact_node, score = find_contact(nodes, args.contact)
    if contact_node is None or score <= 0.0:
        emit({
            "ok": False,
            "error": "contact_not_found",
            "host": window["host"],
            "contact": args.contact,
            "available": [node_name(n)[:80] for n in list_conversations(nodes)[:15]],
        }, 2)

    invoke(contact_node)

    # Wait for the conversation composer to appear after opening the chat.
    composer: Optional[Any] = None
    deadline = time.monotonic() + max(2.0, min(args.timeout, 15.0))
    while time.monotonic() < deadline:
        time.sleep(0.25)
        root = auto.ControlFromHandle(window["handle"])
        composer = find_composer(walk(root))
        if composer is not None:
            break
    if composer is None:
        emit({
            "ok": False,
            "error": "composer_not_found",
            "host": window["host"],
            "contact": node_name(contact_node)[:120],
            "contactScore": round(score, 3),
        }, 2)

    if args.dry_run:
        emit({
            "ok": True,
            "dryRun": True,
            "host": window["host"],
            "contact": node_name(contact_node)[:120],
            "contactScore": round(score, 3),
            "composer": describe(composer),
        })

    try:
        composer.GetValuePattern().SetValue(message)
    except Exception:
        # Some composers reject ValuePattern; fall back to focus + typed keys.
        safe(lambda: composer.SetFocus())
        auto.SendKeys(message, waitTime=0.02)

    # Prefer a real Send button; otherwise submit with Enter.
    send_button = find_send_button(walk(auto.ControlFromHandle(window["handle"])))
    if send_button is not None:
        invoke(send_button)
        submit = "send_button"
    else:
        safe(lambda: composer.SetFocus())
        auto.SendKeys("{Enter}", waitTime=0.05)
        submit = "enter"

    # Verify: the composer emptied and/or the message appears as a text node.
    verified = False
    message_norm = normalize(message)
    deadline = time.monotonic() + max(2.0, min(args.timeout, 15.0))
    while time.monotonic() < deadline:
        time.sleep(0.25)
        current_nodes = walk(auto.ControlFromHandle(window["handle"]))
        current_composer = find_composer(current_nodes)
        composer_value = normalize(
            str(safe(lambda: current_composer.GetValuePattern().Value, "") or "")
        ) if current_composer is not None else ""
        appears = any(message_norm in normalize(node_name(node)) for node in current_nodes)
        if appears and not composer_value:
            verified = True
            break

    emit({
        "ok": True,
        "sent": True,
        "verified": verified,
        "submit": submit,
        "host": window["host"],
        "contact": node_name(contact_node)[:120],
        "contactScore": round(score, 3),
    })


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "windows_only"}, 2)
    try:
        import uiautomation as auto  # type: ignore
    except ImportError:
        emit({"ok": False, "error": "uiautomation_not_installed"}, 2)

    args = parse_args()
    preferred = normalize(args.window).replace(" ", "_")
    window = find_target_window(preferred if preferred in {"whatsapp", "phone_link"} else "")
    if window is None:
        emit({"ok": False, "error": "no_whatsapp_window", "running": False}, 2)
    if args.contacts:
        run_contacts(auto, window)
    run_reply(auto, window, args)


if __name__ == "__main__":
    main()
