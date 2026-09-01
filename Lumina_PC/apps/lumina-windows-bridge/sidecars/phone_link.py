"""Inspect and reply to Phone Link notification cards through Windows UI Automation.

The script never uses screen coordinates. A reply is sent only when one card
contains the expected sender and message and exposes an inline reply action.

`--list` reads the notification feed the Phone Link app itself renders. That
feed is the phone's own list, so it holds notifications the Windows toast
pipeline never saw: apps not mirrored to the Action Center, toasts already
dismissed, and anything that arrived while Start Talk was closed.
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
PHONE_LINK_LAUNCH_URI = "ms-phone:"
REPLY_LABELS = ("reply", "respond", "responder", "respuesta")
SEND_LABELS = ("send", "enviar")

# Automation ids of the notification feed, read off the live tree of Phone Link
# (Enlace Móvil) on Windows 11. Names are localized; ids are not, so everything
# structural keys off ids and only the "empty feed" check looks at text.
NOTIFICATIONS_LIST_ID = "NotificationsList"
PINNED_NOTIFICATIONS_LIST_ID = "PinnedNotificationsList"
APP_NAME_ID = "AppNameTextBlock"
RECEIVED_AT_ID = "HoverDateReceivedTextBlock"
CARD_TITLE_ID = "CompactModeTitleTextBlock"
CARD_DESCRIPTION_ID = "NotificationDescriptionText"
CARD_MESSAGES_ID = "NotificationMessagesList"
CARD_ACTIONS_ID = "InlineActionList"
HIDDEN_NOTICE_ID = "NotificationsTitleFontIcon"
REFRESH_BUTTON_ID = "RefreshButton"
CONNECTIVITY_TEXT_ID = "ConnectivityStatusTextBlock"
EMPTY_FEED_LABELS = {"no hay notificaciones nuevas", "no new notifications"}

MAX_FIELD_CHARS = 600
MAX_LIST_ITEMS = 25
# Bidi marks litter Phone Link's timestamps ("\u200e10\u200e:\u200e43").
BIDI_CONTROLS = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
URL_PATTERN = re.compile(r"https?://|www\.", re.IGNORECASE)


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
    mode.add_argument("--list", action="store_true", dest="list_notifications")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument(
        "--launch",
        action="store_true",
        help="Start Phone Link and wait for its window when it is not open yet.",
    )
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
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        windows.append(
            {
                "handle": int(hwnd),
                "pid": int(pid.value),
                "title": title_buffer.value,
                "area": max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top),
            }
        )
        return True

    user32.EnumWindows(callback_type(callback), 0)
    if not windows:
        return None
    # While Phone Link boots it owns a "SplashScreen loading" window whose UIA
    # tree is a single empty pane. Binding to it made every mode report an empty
    # app, so the real window — the biggest non-splash one — always wins.
    real = [window for window in windows if "splash" not in normalize(window["title"])]
    return max(real or windows, key=lambda window: window["area"])


def launch_phone_link() -> None:
    ctypes.windll.shell32.ShellExecuteW(None, "open", PHONE_LINK_LAUNCH_URI, None, None, 1)


def ensure_phone_link_window(launch: bool, timeout: float) -> Optional[Dict[str, Any]]:
    """The app window, starting Phone Link first when it only lives in the tray."""
    window = find_phone_link_window()
    if window is not None or not launch:
        return window

    launch_phone_link()
    # A cold start shows a splash window first and can take ~20 s to settle.
    deadline = time.monotonic() + max(25.0, timeout)
    while time.monotonic() < deadline:
        time.sleep(0.5)
        window = find_phone_link_window()
        if window is not None:
            return window
    return None


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


def clean_text(value: Any, limit: int = MAX_FIELD_CHARS) -> str:
    text = str(value or "")
    for control in BIDI_CONTROLS:
        text = text.replace(control, "")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def child_text(by_id: Dict[str, Any], automation_id: str) -> str:
    node = by_id.get(automation_id)
    return clean_text(node_name(node)) if node is not None else ""


def card_body(card, by_id: Dict[str, Any]) -> str:
    """The message text of one card, without the URLs its links expose as names."""
    messages_root = by_id.get(CARD_MESSAGES_ID)
    if messages_root is not None:
        parts: List[str] = []
        for node in descendants(messages_root, max_depth=4, max_nodes=120):
            if node_type(node) != "text":
                continue
            text = clean_text(node_name(node))
            # Nested blocks repeat their parent's text; keep the outermost only.
            if text and not any(text in part for part in parts):
                parts.append(text)
        if parts:
            return clean_text(" · ".join(parts))

    description = child_text(by_id, CARD_DESCRIPTION_ID)
    if description:
        return description

    # Last resort: the flattened accessible name of the card minus the fields we
    # already read separately, so the body is not announced twice.
    text = clean_text(node_name(card))
    for known in (
        child_text(by_id, APP_NAME_ID),
        child_text(by_id, CARD_TITLE_ID),
        child_text(by_id, RECEIVED_AT_ID),
    ):
        if known:
            text = text.replace(known, " ")
    return clean_text(text)


def collect_card(card, pinned: bool) -> Optional[Dict[str, Any]]:
    nodes = descendants(card, max_depth=7, max_nodes=250)
    by_id: Dict[str, Any] = {}
    for node in nodes:
        automation_id = node_id(node)
        if automation_id and automation_id not in by_id:
            by_id[automation_id] = node

    application = child_text(by_id, APP_NAME_ID)
    title = child_text(by_id, CARD_TITLE_ID)
    body = card_body(card, by_id)
    if not application and not title and not body:
        return None

    actions_root = by_id.get(CARD_ACTIONS_ID)
    actions = (
        [
            clean_text(node_name(node), 60)
            for node in descendants(actions_root, max_depth=4, max_nodes=60)
            if node_type(node) == "button" and clean_text(node_name(node))
        ]
        if actions_root is not None
        else []
    )

    has_link = any(node_type(node) == "hyperlink" for node in nodes) or bool(
        URL_PATTERN.search(body)
    )

    return {
        "application": application,
        "sender": title,
        "message": body,
        "receivedAt": child_text(by_id, RECEIVED_AT_ID),
        "pinned": pinned,
        # The URLs themselves are deliberately omitted: the voice must say that
        # there is a link, never read one out.
        "hasLink": has_link,
        "actions": actions[:4],
    }


def collect_list(root, automation_id: str, pinned: bool) -> List[Dict[str, Any]]:
    container = find_by_automation_id(walk(root), automation_id)
    if container is None:
        return []
    cards: List[Dict[str, Any]] = []
    for node, _depth in walk(container, max_depth=3, max_nodes=400):
        if node_type(node) != "listitem":
            continue
        card = collect_card(node, pinned)
        if card is not None:
            cards.append(card)
    return cards


def last_updated_label(refresh_node) -> Optional[str]:
    """Just the freshness part of the refresh button's name, without its shortcut."""
    if refresh_node is None:
        return None
    text = clean_text(node_name(refresh_node), 200)
    return text.split(", ", 1)[1] if ", " in text else text or None


def feed_is_empty(nodes: List[Tuple[Any, int]]) -> bool:
    return any(normalize(node_name(node)) in EMPTY_FEED_LABELS for node, _depth in nodes)


def control_from_window(auto, window: Dict[str, Any]) -> Tuple[Any, Dict[str, Any]]:
    """
    UIA root for the app window, re-resolving the handle when it goes stale.

    A cold start destroys its first window when the real one takes over, and
    `ElementFromHandle` on the dead handle raises a COMError instead of
    returning nothing. Looking the window up again turns that into a retry.
    """
    root = safe(lambda: auto.ControlFromHandle(window["handle"]))
    if root is not None:
        return root, window
    current = find_phone_link_window()
    if current is None:
        return None, window
    return safe(lambda: auto.ControlFromHandle(current["handle"])), current


def feed_is_ready(root) -> bool:
    nodes = walk(root)
    if feed_is_empty(nodes):
        return True
    container = find_by_automation_id(nodes, NOTIFICATIONS_LIST_ID)
    return container is not None and any(
        node_type(node) == "listitem"
        for node, _depth in walk(container, max_depth=3, max_nodes=200)
    )


def wait_for_feed(
    auto, window: Dict[str, Any], timeout: float
) -> Tuple[Any, Dict[str, Any]]:
    """Phone Link renders its shell before the feed; poll until one is there."""
    deadline = time.monotonic() + max(2.0, timeout)
    root, window = control_from_window(auto, window)
    while True:
        if root is not None and feed_is_ready(root):
            return root, window
        if time.monotonic() >= deadline:
            if root is None:
                emit({"ok": False, "error": "phone_link_window_not_readable"}, 2)
            return root, window
        time.sleep(0.5)
        root, window = control_from_window(auto, window)


def list_notifications(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    limit = max(1, min(MAX_LIST_ITEMS, args.limit or 12))
    # A cold start needs noticeably longer than the reply timeout to paint the
    # feed, and the callers allow for it (bridge 90 s, Start Talk 120 s).
    root, window = wait_for_feed(auto, window, max(args.timeout, 30.0))
    nodes = walk(root)

    notifications = collect_list(root, PINNED_NOTIFICATIONS_LIST_ID, True)
    notifications.extend(collect_list(root, NOTIFICATIONS_LIST_ID, False))

    hidden_node = find_by_automation_id(nodes, HIDDEN_NOTICE_ID)
    refresh_node = find_by_automation_id(nodes, REFRESH_BUTTON_ID)
    phone_node = find_by_automation_id(nodes, "PhoneNameTextBlock")
    connection_node = find_by_automation_id(nodes, CONNECTIVITY_TEXT_ID)

    emit(
        {
            "ok": True,
            "source": "phone-link-ui",
            "phoneName": clean_text(node_name(phone_node)) if phone_node is not None else None,
            "connection": clean_text(node_name(connection_node)) if connection_node is not None else None,
            "connected": normalize(node_name(connection_node)) in {"connected", "conectado"}
            if connection_node is not None
            else False,
            # Phone Link's own "last refreshed" label: a feed can be minutes old.
            "lastUpdated": last_updated_label(refresh_node),
            "someHidden": clean_text(node_name(hidden_node), 160) if hidden_node is not None else None,
            "empty": len(notifications) == 0 and feed_is_empty(nodes),
            "truncated": len(notifications) > limit,
            "count": min(len(notifications), limit),
            "notifications": notifications[:limit],
        }
    )


def status(auto, window: Dict[str, Any]) -> None:
    root, window = control_from_window(auto, window)
    if root is None:
        emit({"ok": False, "error": "phone_link_window_not_readable", "running": True}, 2)
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
    window = ensure_phone_link_window(args.launch, args.timeout)
    if window is None:
        emit(
            {
                "ok": False,
                "error": "phone_link_window_not_available"
                if args.launch
                else "phone_link_not_running",
                "running": False,
            },
            2,
        )
    if args.list_notifications:
        list_notifications(auto, window, args)
    if args.status:
        status(auto, window)
    reply(auto, window, args)


if __name__ == "__main__":
    main()
