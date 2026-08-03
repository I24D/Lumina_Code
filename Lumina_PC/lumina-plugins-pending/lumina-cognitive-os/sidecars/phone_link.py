"""Inspect and reply to Phone Link notification cards through Windows UI Automation.

The script never uses screen coordinates. A reply is sent only when one card
contains the expected sender and message and exposes an inline reply action.
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


PHONE_LINK_PROCESS = "phoneexperiencehost.exe"
REPLY_LABELS = ("reply", "respond", "responder", "respuesta")
SEND_LABELS = ("send", "enviar")


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
    parser = argparse.ArgumentParser(description="Phone Link UI Automation adapter")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--reply", action="store_true")
    parser.add_argument("--notification-id", default="")
    parser.add_argument("--mobile-app", default="")
    parser.add_argument("--sender", default="")
    parser.add_argument("--message", default="")
    parser.add_argument("--reply-text", default="")
    parser.add_argument("--dry-run", action="store_true")
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


def find_phone_link_window() -> Optional[Dict[str, Any]]:
    user32 = ctypes.windll.user32
    windows: List[Dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if process_name(int(pid.value)) != PHONE_LINK_PROCESS:
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        title_buffer = ctypes.create_unicode_buffer(max(1, length + 1))
        user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
        windows.append({"handle": int(hwnd), "pid": int(pid.value), "title": title_buffer.value})
        return True

    user32.EnumWindows(callback_type(callback), 0)
    return windows[0] if windows else None


def walk(root, max_depth: int = 16, max_nodes: int = 3500) -> List[Tuple[Any, int]]:
    output: List[Tuple[Any, int]] = []
    stack: List[Tuple[Any, int]] = [(root, 0)]
    while stack and len(output) < max_nodes:
        node, depth = stack.pop()
        output.append((node, depth))
        if depth >= max_depth:
            continue
        children = safe(lambda: node.GetChildren(), []) or []
        for child in reversed(children):
            stack.append((child, depth + 1))
    return output


def node_name(node) -> str:
    return str(safe(lambda: node.Name, "") or "")


def node_id(node) -> str:
    return str(safe(lambda: node.AutomationId, "") or "")


def node_type(node) -> str:
    return normalize(str(safe(lambda: node.ControlTypeName, "") or "")).replace("control", "")


def node_enabled(node) -> bool:
    return bool(safe(lambda: node.IsEnabled, False))


def describe(node) -> Dict[str, Any]:
    return {
        "name": node_name(node)[:200],
        "automationId": node_id(node)[:120],
        "controlType": str(safe(lambda: node.ControlTypeName, "") or "")[:80],
        "enabled": node_enabled(node),
        "offscreen": bool(safe(lambda: node.IsOffscreen, False)),
    }


def descendants(root, max_depth: int = 8, max_nodes: int = 500) -> List[Any]:
    return [node for node, _depth in walk(root, max_depth=max_depth, max_nodes=max_nodes)]


def named_descendants(root) -> List[Tuple[Any, str]]:
    return [(node, normalize(node_name(node))) for node in descendants(root) if node_name(node).strip()]


def find_by_automation_id(nodes: Iterable[Tuple[Any, int]], automation_id: str) -> Optional[Any]:
    for node, _depth in nodes:
        if node_id(node) == automation_id:
            return node
    return None


def contains_label(name: str, labels: Tuple[str, ...]) -> bool:
    normalized = normalize(name)
    return any(label in normalized for label in labels)


def find_action(root, labels: Tuple[str, ...]) -> Optional[Any]:
    for node, name in named_descendants(root):
        if node_type(node) in {"button", "hyperlink"} and node_enabled(node) and contains_label(name, labels):
            return node
    return None


def find_edit(root) -> Optional[Any]:
    for node in descendants(root):
        if node_type(node) in {"edit", "document"} and node_enabled(node):
            return node
    return None


def invoke(node) -> None:
    try:
        node.GetInvokePattern().Invoke()
    except Exception:
        node.Click()


def restore_window(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)


def ancestor_candidates(node, limit: int = 9) -> Iterable[Any]:
    current = node
    for _ in range(limit):
        current = safe(lambda: current.GetParentControl())
        if current is None:
            return
        yield current


def card_matches(card, sender: str, message: str) -> bool:
    names = " | ".join(name for _node, name in named_descendants(card))
    sender_norm = normalize(sender)
    message_norm = normalize(message)
    return sender_norm in names and (message_norm in names or all(token in names for token in message_norm.split()[:6]))


def find_notification_card(root, sender: str, message: str) -> Tuple[Optional[Any], Optional[Any]]:
    sender_norm = normalize(sender)
    sender_nodes = [
        node
        for node, _depth in walk(root)
        if sender_norm and sender_norm in normalize(node_name(node))
    ]
    fallback: Optional[Tuple[Any, Optional[Any]]] = None
    for sender_node in sender_nodes:
        for ancestor in ancestor_candidates(sender_node):
            if not card_matches(ancestor, sender, message):
                continue
            reply_action = find_action(ancestor, REPLY_LABELS)
            if reply_action is not None:
                return ancestor, reply_action
            if fallback is None:
                fallback = (ancestor, None)
    return fallback or (None, None)


def status(auto, window: Dict[str, Any]) -> None:
    root = auto.ControlFromHandle(window["handle"])
    nodes = walk(root)
    phone_node = find_by_automation_id(nodes, "PhoneNameTextBlock")
    connection_node = find_by_automation_id(nodes, "ConnectivityCardOpenButton")
    empty_notifications = any(
        normalize(node_name(node)) in {"no hay notificaciones nuevas", "no new notifications"}
        for node, _depth in nodes
    )
    emit({
        "ok": True,
        "service": "phone-link",
        "running": True,
        "pid": window["pid"],
        "title": window["title"],
        "phoneName": node_name(phone_node) if phone_node is not None else None,
        "connection": node_name(connection_node) if connection_node is not None else "unknown",
        "connected": normalize(node_name(connection_node)) in {"connected", "conectado"}
        if connection_node is not None else False,
        "notificationFeedReady": empty_notifications or any(
            node_id(node) == "PhoneNotificationsLabel" for node, _depth in nodes
        ),
        "hasVisibleNotifications": not empty_notifications,
    })


def reply(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    if not args.sender.strip() or not args.message.strip() or not args.reply_text.strip():
        emit({"ok": False, "error": "missing_reply_context"}, 2)
    if len(args.reply_text.strip()) > 280:
        emit({"ok": False, "error": "reply_text_too_long"}, 2)

    root = auto.ControlFromHandle(window["handle"])
    card, reply_action = find_notification_card(root, args.sender, args.message)
    if card is None:
        emit({
            "ok": False,
            "error": "notification_card_not_found",
            "notificationId": args.notification_id,
        }, 2)

    if args.dry_run:
        emit({
            "ok": True,
            "dryRun": True,
            "notificationId": args.notification_id,
            "cardMatched": True,
            "replyActionAvailable": reply_action is not None or find_edit(card) is not None,
            "replyAction": describe(reply_action) if reply_action is not None else None,
        })

    restore_window(window["handle"])
    root = auto.ControlFromHandle(window["handle"])
    card, reply_action = find_notification_card(root, args.sender, args.message)
    if card is None:
        emit({"ok": False, "error": "notification_card_disappeared"}, 2)

    edit = find_edit(card)
    if edit is None:
        if reply_action is None:
            emit({"ok": False, "error": "reply_action_not_available"}, 2)
        invoke(reply_action)
        deadline = time.monotonic() + max(2.0, min(args.timeout, 15.0))
        while time.monotonic() < deadline:
            time.sleep(0.2)
            root = auto.ControlFromHandle(window["handle"])
            card, _reply_action = find_notification_card(root, args.sender, args.message)
            if card is not None:
                edit = find_edit(card)
            if edit is not None:
                break
    if edit is None or card is None:
        emit({"ok": False, "error": "reply_editor_not_available"}, 2)

    try:
        edit.GetValuePattern().SetValue(args.reply_text.strip())
    except Exception as error:
        emit({"ok": False, "error": "reply_text_failed", "detail": str(error)[:300]}, 2)

    send_action = find_action(card, SEND_LABELS)
    if send_action is None:
        emit({"ok": False, "error": "send_action_not_available"}, 2)
    invoke(send_action)

    deadline = time.monotonic() + max(2.0, min(args.timeout, 15.0))
    verified = False
    while time.monotonic() < deadline:
        time.sleep(0.25)
        root = auto.ControlFromHandle(window["handle"])
        current_card, _ = find_notification_card(root, args.sender, args.message)
        if current_card is None:
            verified = True
            break
        current_edit = find_edit(current_card)
        if current_edit is None:
            verified = True
            break
        current_value = str(safe(lambda: current_edit.GetValuePattern().Value, "") or "")
        if not current_value.strip():
            verified = True
            break

    if not verified:
        emit({
            "ok": False,
            "error": "reply_verification_failed",
            "sent": True,
            "notificationId": args.notification_id,
        }, 2)
    emit({
        "ok": True,
        "sent": True,
        "verified": True,
        "notificationId": args.notification_id,
        "mobileApp": args.mobile_app,
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
    window = find_phone_link_window()
    if window is None:
        emit({"ok": False, "error": "phone_link_not_running", "running": False}, 2)
    if args.status:
        status(auto, window)
    reply(auto, window, args)


if __name__ == "__main__":
    main()
