"""Control WhatsApp Desktop through Windows UI Automation.

The adapter intentionally uses semantic UIA controls instead of fixed screen
coordinates. It supports conversation discovery, contact resolution, recent
message reading, text/media sending, status discovery, and status publishing.
Every mutating action reports whether the resulting UI state was verified.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
import tempfile
import textwrap
import time
import unicodedata
from ctypes import wintypes
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


WINDOW_CANDIDATES: Tuple[Tuple[str, str], ...] = (
    ("whatsapp", "whatsapp.root.exe"),
    ("whatsapp_web", "msedge.exe"),
    ("whatsapp_web", "msedgewebview2.exe"),
    ("phone_link", "phoneexperiencehost.exe"),
)
HOST_ORDER = {"whatsapp": 0, "whatsapp_web": 1, "phone_link": 2}
MAIN_WINDOW_TITLE_HINTS = ("whatsapp", "phone link", "enlace movil")
COMPOSER_NAME_HINTS = (
    "type a message",
    "escribe un mensaje",
    "escribir un mensaje",
    "message to",
    "mensaje para",
)
SEARCH_NAME_HINTS = (
    "search or start a new chat",
    "buscar o iniciar un chat nuevo",
)
CHAT_LIST_NAMES = ("chat list", "lista de chats")
SEND_LABELS = ("send", "enviar")
STATUS_LABELS = ("status", "estados")
ADD_STATUS_LABELS = ("add status", "agregar estado")
CHATS_LABELS = ("chats",)
YOU_LABELS = ("you", "tu")
MAX_WALK_DEPTH = 44
MAX_WALK_NODES = 20_000
CONVERSATION_ROW_CLASS_HINT = "x10l6tqk"
CONVERSATION_HEADER_CLASS_HINT = "x6s0dn4"
TIME_PATTERN = re.compile(r"^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$", re.IGNORECASE)
DATE_PATTERN = re.compile(
    r"^(?:today|yesterday|hoy|ayer|monday|tuesday|wednesday|thursday|friday|"
    r"saturday|sunday|lunes|martes|miercoles|jueves|viernes|sabado|domingo|"
    r"\d{1,2}/\d{1,2}/\d{2,4})$",
    re.IGNORECASE,
)
UNREAD_PATTERN = re.compile(
    r"(?P<count>\d+)\s+(?:unread messages?|mensajes?\s+sin\s+leer)",
    re.IGNORECASE,
)
IMAGE_EXTENSIONS = {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".avi", ".mkv", ".mov", ".mp4", ".webm"}
AUDIO_EXTENSIONS = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"}
STATUS_MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
SUSPENDED_OVERLAY_WINDOWS: List[int] = []


def restore_suspended_overlays() -> None:
    user32 = ctypes.windll.user32
    while SUSPENDED_OVERLAY_WINDOWS:
        hwnd = SUSPENDED_OVERLAY_WINDOWS.pop()
        if user32.IsWindow(hwnd):
            user32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE


def emit(value: Dict[str, Any], code: int = 0) -> None:
    restore_suspended_overlays()
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
                      help="List conversations or search for a contact.")
    mode.add_argument("--messages", action="store_true",
                      help="Open a conversation and read recent messages.")
    mode.add_argument("--reply", action="store_true",
                      help="Send text or a media attachment to a contact.")
    mode.add_argument("--statuses", action="store_true",
                      help="List available status updates without viewing them.")
    mode.add_argument("--status", action="store_true",
                      help="Publish a media or rendered-text status.")
    parser.add_argument("--contact", default="")
    parser.add_argument("--message", default="")
    parser.add_argument("--media", default="")
    parser.add_argument("--text", default="")
    parser.add_argument("--caption", default="")
    parser.add_argument("--background", default="#075E54")
    parser.add_argument("--query", default="")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--unread-only", action="store_true")
    parser.add_argument("--no-previews", action="store_true")
    parser.add_argument("--window", default="",
                        help="whatsapp | whatsapp_web | phone_link; empty = auto.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Resolve and validate without sending or publishing.")
    parser.add_argument("--timeout", type=float, default=15.0)
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


def window_title(hwnd: int) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(max(1, length + 1))
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value or ""


def enum_visible_windows() -> List[Dict[str, Any]]:
    user32 = ctypes.windll.user32
    windows: List[Dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        title = window_title(int(hwnd))
        windows.append({
            "handle": int(hwnd),
            "pid": int(pid.value),
            "title": title,
            "process": process_name(int(pid.value)),
        })
        return True

    user32.EnumWindows(callback_type(callback), 0)
    return windows


def enum_target_windows() -> List[Dict[str, Any]]:
    windows: List[Dict[str, Any]] = []
    for candidate in enum_visible_windows():
        proc = candidate["process"]
        title_norm = normalize(candidate["title"])
        for host, exe in WINDOW_CANDIDATES:
            if proc != normalize(exe):
                continue
            if not any(hint in title_norm for hint in MAIN_WINDOW_TITLE_HINTS):
                continue
            windows.append({**candidate, "host": host})
            break
    return windows


def find_target_window(preferred: str) -> Optional[Dict[str, Any]]:
    windows = enum_target_windows()
    if preferred:
        preferred_windows = [window for window in windows if window["host"] == preferred]
        if preferred_windows:
            windows = preferred_windows
    if not windows:
        return None
    windows.sort(
        key=lambda window: (
            HOST_ORDER.get(window["host"], 99),
            0 if normalize(window["title"]) == "whatsapp" else 1,
        ),
    )
    return windows[0]


def restore_window(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    target_rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(target_rect))
    for window in enum_visible_windows():
        overlay_hwnd = window["handle"]
        if overlay_hwnd == hwnd or overlay_hwnd in SUSPENDED_OVERLAY_WINDOWS:
            continue
        if normalize(window["title"]) != "lumina live":
            continue
        if not (user32.GetWindowLongW(overlay_hwnd, -20) & 0x00000008):
            continue
        overlay_rect = wintypes.RECT()
        user32.GetWindowRect(overlay_hwnd, ctypes.byref(overlay_rect))
        overlaps = not (
            overlay_rect.right <= target_rect.left
            or overlay_rect.left >= target_rect.right
            or overlay_rect.bottom <= target_rect.top
            or overlay_rect.top >= target_rect.bottom
        )
        if overlaps:
            user32.ShowWindowAsync(overlay_hwnd, 6)  # SW_MINIMIZE
            SUSPENDED_OVERLAY_WINDOWS.append(overlay_hwnd)

    foreground = user32.GetForegroundWindow()
    foreground_pid = wintypes.DWORD()
    target_pid = wintypes.DWORD()
    foreground_thread = user32.GetWindowThreadProcessId(
        foreground, ctypes.byref(foreground_pid),
    )
    target_thread = user32.GetWindowThreadProcessId(
        hwnd, ctypes.byref(target_pid),
    )
    current_thread = kernel32.GetCurrentThreadId()
    attached_threads: List[int] = []
    for thread in {int(foreground_thread), int(target_thread)}:
        if (
            thread
            and thread != current_thread
            and user32.AttachThreadInput(current_thread, thread, True)
        ):
            attached_threads.append(thread)
    try:
        user32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetFocus(hwnd)
    finally:
        for thread in attached_threads:
            user32.AttachThreadInput(current_thread, thread, False)
    time.sleep(0.4)


def walk(root, max_depth: int = MAX_WALK_DEPTH,
         max_nodes: int = MAX_WALK_NODES) -> List[Any]:
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


def node_class(node) -> str:
    return str(safe(lambda: node.ClassName, "") or "")


def node_enabled(node) -> bool:
    return bool(safe(lambda: node.IsEnabled, False))


def node_rect(node) -> Optional[Tuple[int, int, int, int]]:
    rect = safe(lambda: node.BoundingRectangle)
    if rect is None:
        return None
    return (
        int(getattr(rect, "left", 0) or 0),
        int(getattr(rect, "top", 0) or 0),
        int(getattr(rect, "right", 0) or 0),
        int(getattr(rect, "bottom", 0) or 0),
    )


def node_is_visible(node) -> bool:
    rect = node_rect(node)
    if rect is None:
        return False
    left, top, right, bottom = rect
    return (
        right > left
        and bottom > top
        and left > -10_000
        and top > -10_000
        and not bool(safe(lambda: node.IsOffscreen, False))
    )


def describe(node) -> Dict[str, Any]:
    return {
        "name": node_name(node)[:200],
        "automationId": str(safe(lambda: node.AutomationId, "") or "")[:120],
        "controlType": str(safe(lambda: node.ControlTypeName, "") or "")[:80],
        "enabled": node_enabled(node),
    }


def invoke(node) -> None:
    try:
        node.GetInvokePattern().Invoke()
    except Exception:
        node.Click()


def read_value(node) -> str:
    return str(safe(lambda: node.GetValuePattern().Value, "") or "")


def set_value(node, value: str) -> None:
    try:
        node.GetValuePattern().SetValue(value)
    except Exception:
        safe(lambda: node.SetFocus())
        auto_module = sys.modules.get("uiautomation")
        if auto_module is None:
            raise
        auto_module.SendKeys("^a{Backspace}", waitTime=0.02)
        auto_module.SendKeys(value, waitTime=0.01)


def label_matches(value: str, labels: Sequence[str]) -> bool:
    value_norm = normalize(value)
    return any(value_norm == normalize(label) for label in labels)


def find_named_control(
    nodes: Iterable[Any],
    control_types: Sequence[str],
    labels: Sequence[str],
    *,
    contains: bool = False,
    visible_only: bool = True,
) -> Optional[Any]:
    normalized_labels = [normalize(label) for label in labels]
    for node in nodes:
        if node_type(node) not in control_types or not node_enabled(node):
            continue
        if visible_only and not node_is_visible(node):
            continue
        name_norm = normalize(node_name(node))
        matched = (
            any(label in name_norm for label in normalized_labels)
            if contains
            else name_norm in normalized_labels
        )
        if matched:
            return node
    return None


def find_chat_grid(nodes: Iterable[Any]) -> Optional[Any]:
    return find_named_control(
        nodes,
        ("datagrid", "list"),
        CHAT_LIST_NAMES,
        visible_only=False,
    )


def is_time_or_date(value: str) -> bool:
    normalized = normalize(value).replace(".", "")
    return bool(TIME_PATTERN.match(normalized) or DATE_PATTERN.match(normalized))


def score_contact(name_norm: str, query_norm: str,
                  query_tokens: List[str]) -> float:
    if not name_norm or not query_norm:
        return 0.0
    if name_norm == query_norm:
        return 1.0
    if name_norm.startswith(f"{query_norm} "):
        return 0.94
    if query_norm in name_norm:
        return max(0.82, 0.9 - (len(name_norm) - len(query_norm)) * 0.004)
    name_tokens = [token for token in name_norm.split() if len(token) >= 2]
    if not query_tokens or not name_tokens:
        return 0.0
    hits = sum(
        1
        for token in query_tokens
        if any(name_token.startswith(token) or token.startswith(name_token)
               for name_token in name_tokens)
    )
    if hits != len(query_tokens):
        return 0.0
    return 0.62 + 0.25 * (hits / max(len(name_tokens), len(query_tokens)))


def conversation_from_labels(
    row_name: str,
    header_labels: Sequence[str],
    all_labels: Sequence[str],
) -> Dict[str, Any]:
    clean_header = [
        label.strip()
        for label in header_labels
        if label.strip()
        and not is_time_or_date(label)
        and not label.strip().isdigit()
    ]
    title = clean_header[0] if clean_header else ""
    if not title:
        candidates = [
            label.strip()
            for label in all_labels
            if label.strip()
            and not is_time_or_date(label)
            and normalize(label) not in {"view status", "ver estado"}
            and not label.strip().isdigit()
        ]
        title = candidates[0] if candidates else row_name[:200]

    timestamp = next((label.strip() for label in all_labels if is_time_or_date(label)), "")
    preview_parts: List[str] = []
    started = not timestamp
    for label in all_labels:
        clean = label.strip()
        if not clean:
            continue
        if clean == timestamp:
            started = True
            continue
        if not started or clean == title or clean.isdigit():
            continue
        if normalize(clean) in {"view status", "ver estado"}:
            continue
        preview_parts.append(clean)
    preview = re.sub(r"\s+([:,.!?])", r"\1", " ".join(preview_parts)).strip()
    unread_match = UNREAD_PATTERN.search(row_name)
    return {
        "name": title[:200],
        "timestamp": timestamp[:80],
        "preview": preview[:1_000],
        "unreadCount": int(unread_match.group("count")) if unread_match else 0,
        "hasStatus": normalize(row_name).startswith(("view status ", "ver estado ")),
    }


def extract_conversation(row) -> Dict[str, Any]:
    descendants = walk(row, max_depth=12, max_nodes=800)
    header = next(
        (
            node
            for node in descendants
            if node_type(node) == "dataitem"
            and CONVERSATION_HEADER_CLASS_HINT in node_class(node)
        ),
        None,
    )
    header_labels = [
        node_name(node)
        for node in (walk(header, max_depth=8, max_nodes=200) if header else [])
        if node_type(node) == "text"
    ]
    ordered_text_nodes = [
        node
        for node in descendants
        if node_type(node) == "text" and node_name(node).strip()
    ]
    ordered_text_nodes.sort(
        key=lambda node: (
            (node_rect(node) or (0, 0, 0, 0))[1],
            (node_rect(node) or (0, 0, 0, 0))[0],
        ),
    )
    result = conversation_from_labels(
        node_name(row),
        header_labels,
        [node_name(node) for node in ordered_text_nodes],
    )
    result["_node"] = row
    return result


def list_conversations(nodes: List[Any]) -> List[Dict[str, Any]]:
    grid = find_chat_grid(nodes)
    search_root = grid if grid is not None else nodes[0] if nodes else None
    if search_root is None:
        return []
    descendants = walk(search_root, max_depth=14, max_nodes=8_000)
    rows = [
        node
        for node in descendants
        if node_type(node) == "dataitem"
        and node_name(node).strip()
        and CONVERSATION_ROW_CLASS_HINT in node_class(node)
    ]
    if not rows and grid is not None:
        grid_rect = node_rect(grid)
        grid_width = (grid_rect[2] - grid_rect[0]) if grid_rect else 0
        rows = [
            node
            for node in descendants
            if node_type(node) == "dataitem"
            and node_name(node).strip()
            and node_rect(node)
            and (node_rect(node)[2] - node_rect(node)[0]) >= grid_width * 0.75
        ]

    conversations: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        item = extract_conversation(row)
        key = normalize(item["name"])
        if not key or key in seen:
            continue
        seen.add(key)
        conversations.append(item)
    return conversations


def public_conversation(
    conversation: Dict[str, Any],
    include_preview: bool = True,
) -> Dict[str, Any]:
    value = {
        "name": conversation["name"],
        "timestamp": conversation["timestamp"],
        "unreadCount": conversation["unreadCount"],
        "hasStatus": conversation["hasStatus"],
    }
    if include_preview:
        value["preview"] = conversation["preview"]
    return value


def find_chat_search(nodes: Iterable[Any]) -> Optional[Any]:
    for node in nodes:
        if node_type(node) != "edit" or not node_enabled(node):
            continue
        name_norm = normalize(node_name(node))
        if any(hint in name_norm for hint in SEARCH_NAME_HINTS):
            return node
    return None


def read_app_nodes(auto, window: Dict[str, Any]) -> List[Any]:
    return walk(
        auto.ControlFromHandle(window["handle"]),
        max_depth=MAX_WALK_DEPTH,
        max_nodes=MAX_WALK_NODES,
    )


def search_conversations(
    auto,
    window: Dict[str, Any],
    query: str,
    timeout: float,
) -> Tuple[List[Dict[str, Any]], bool]:
    nodes = read_app_nodes(auto, window)
    search = find_chat_search(nodes)
    if search is None:
        return list_conversations(nodes), False
    set_value(search, query)
    deadline = time.monotonic() + max(0.8, min(timeout, 8.0))
    conversations: List[Dict[str, Any]] = []
    while time.monotonic() < deadline:
        time.sleep(0.25)
        conversations = list_conversations(read_app_nodes(auto, window))
        if conversations:
            break
    return conversations, True


def clear_chat_search(auto, window: Dict[str, Any]) -> None:
    search = find_chat_search(read_app_nodes(auto, window))
    if search is not None and read_value(search):
        safe(lambda: set_value(search, ""))
        time.sleep(0.2)


def rank_contacts(
    conversations: Sequence[Dict[str, Any]],
    contact: str,
) -> List[Tuple[float, Dict[str, Any]]]:
    query_norm = normalize(contact)
    query_tokens = [token for token in query_norm.split() if len(token) >= 2]
    ranked = [
        (
            score_contact(normalize(conversation["name"]), query_norm, query_tokens),
            conversation,
        )
        for conversation in conversations
    ]
    return sorted(
        [item for item in ranked if item[0] > 0.0],
        key=lambda item: item[0],
        reverse=True,
    )


def resolve_contact(
    auto,
    window: Dict[str, Any],
    contact: str,
    timeout: float,
    initial_nodes: Optional[List[Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], float, List[Dict[str, Any]], bool]:
    conversations = list_conversations(
        initial_nodes if initial_nodes is not None else read_app_nodes(auto, window),
    )
    ranked = rank_contacts(conversations, contact)
    used_search = False
    if not ranked or ranked[0][0] < 1.0:
        searched, used_search = search_conversations(auto, window, contact, timeout)
        searched_ranked = rank_contacts(searched, contact)
        if searched_ranked:
            ranked = searched_ranked

    candidates = [
        {**public_conversation(item), "score": round(score, 3)}
        for score, item in ranked[:5]
    ]
    if not ranked or ranked[0][0] < 0.62:
        return None, 0.0, candidates, used_search
    if (
        len(ranked) > 1
        and ranked[0][0] < 1.0
        and ranked[0][0] - ranked[1][0] < 0.04
    ):
        return None, ranked[0][0], candidates, used_search
    return ranked[0][1], ranked[0][0], candidates, used_search


def find_composer(nodes: List[Any]) -> Optional[Any]:
    editable = [
        node
        for node in nodes
        if node_type(node) in {"edit", "document"}
        and node_enabled(node)
        and node_is_visible(node)
    ]
    for node in editable:
        name_norm = normalize(node_name(node))
        if any(hint in name_norm for hint in COMPOSER_NAME_HINTS):
            return node
    return None


def wait_for_composer(
    auto,
    window: Dict[str, Any],
    timeout: float,
) -> Tuple[Optional[Any], List[Any]]:
    deadline = time.monotonic() + max(2.0, min(timeout, 20.0))
    nodes: List[Any] = []
    while time.monotonic() < deadline:
        nodes = read_app_nodes(auto, window)
        composer = find_composer(nodes)
        if composer is not None:
            return composer, nodes
        time.sleep(0.25)
    return None, nodes


def open_contact(
    auto,
    window: Dict[str, Any],
    contact: str,
    timeout: float,
    initial_nodes: Optional[List[Any]] = None,
) -> Tuple[
    Optional[Any],
    Optional[Dict[str, Any]],
    float,
    List[Dict[str, Any]],
    List[Any],
]:
    conversation, score, candidates, used_search = resolve_contact(
        auto, window, contact, timeout, initial_nodes,
    )
    if conversation is None:
        return None, None, score, candidates, []
    invoke(conversation["_node"])
    composer, nodes = wait_for_composer(auto, window, timeout)
    if used_search:
        clear_chat_search(auto, window)
        nodes = read_app_nodes(auto, window)
    return composer, conversation, score, candidates, nodes


def find_chat_divider_x(nodes: List[Any]) -> int:
    resize = find_named_control(
        nodes,
        ("button",),
        ("resize the chat list panel", "redimensionar el panel de lista de chats"),
        visible_only=False,
    )
    rect = node_rect(resize) if resize is not None else None
    if rect:
        return rect[2]
    grid = find_chat_grid(nodes)
    rect = node_rect(grid) if grid is not None else None
    return rect[2] if rect else 0


def delivery_state(nodes: Iterable[Any]) -> str:
    return delivery_state_from_labels(node_name(node) for node in nodes)


def delivery_state_from_labels(labels: Iterable[str]) -> str:
    labels = " ".join(normalize(label) for label in labels)
    if re.search(r"\b(read|leido)\b", labels):
        return "read"
    if re.search(r"\b(delivered|entregado)\b", labels):
        return "delivered"
    if re.search(r"\b(sent|enviado)\b", labels):
        return "sent"
    if re.search(r"\b(played|reproducido)\b", labels):
        return "played"
    return "unknown"


def extract_messages(nodes: List[Any]) -> List[Dict[str, Any]]:
    divider_x = find_chat_divider_x(nodes)
    messages: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str, str, Tuple[int, int, int, int]]] = set()
    snapshots = [
        (node_type(node), node_name(node), node_rect(node))
        for node in nodes
    ]
    for group_type, sender_label, rect in snapshots:
        if group_type != "group":
            continue
        sender_label = sender_label.strip()
        if not sender_label.endswith(":"):
            continue
        if rect is None or rect[0] < divider_x + 10:
            continue
        sender = sender_label[:-1].strip()
        # Chromium exposes the bubble label and its text/timestamp as sibling
        # UIA controls. Associate them by containment in the bubble rectangle.
        descendants: List[Tuple[str, str, Tuple[int, int, int, int]]] = []
        descendant_keys: set[Tuple[str, str, Tuple[int, int, int, int]]] = set()
        for candidate_type, candidate_name, candidate_rect in snapshots:
            if candidate_rect is None:
                continue
            if not (
                candidate_rect[0] >= rect[0]
                and candidate_rect[1] >= rect[1]
                and candidate_rect[2] <= rect[2] + 4
                and candidate_rect[3] <= rect[3] + 4
            ):
                continue
            key = (candidate_type, candidate_name, candidate_rect)
            if key in descendant_keys:
                continue
            descendant_keys.add(key)
            descendants.append(key)
        text_nodes = [
            item
            for item in descendants
            if item[0] == "text" and item[1].strip()
        ]
        text_nodes.sort(
            key=lambda item: (item[2][1], item[2][0]),
        )
        timestamp = next(
            (item[1].strip() for item in text_nodes if is_time_or_date(item[1])),
            "",
        )
        parts: List[str] = []
        part_keys: set[Tuple[str, Optional[Tuple[int, int, int, int]]]] = set()
        for _item_type, item_name, item_rect in text_nodes:
            value = item_name.strip()
            if not value or value == timestamp or normalize(value) == normalize(sender):
                continue
            key = (value, item_rect)
            if key in part_keys:
                continue
            part_keys.add(key)
            parts.append(value)
        message_text = "\n".join(parts).strip()
        if not message_text:
            media_labels = [
                item_name.strip()
                for item_type, item_name, _item_rect in descendants
                if item_type == "image"
                and item_name.strip()
                and not item_name.startswith("wds-ic-")
            ]
            if media_labels:
                message_text = f"[Media: {' '.join(dict.fromkeys(media_labels))}]"
        if not message_text:
            continue
        direction = "outgoing" if normalize(sender) in YOU_LABELS else "incoming"
        key = (direction, normalize(sender), normalize(message_text), rect)
        if key in seen:
            continue
        seen.add(key)
        messages.append({
            "direction": direction,
            "sender": sender[:200],
            "text": message_text[:8_000],
            "timestamp": timestamp[:80],
            "delivery": (
                delivery_state_from_labels(item[1] for item in descendants)
                if direction == "outgoing"
                else None
            ),
            "_top": rect[1],
        })
    messages.sort(key=lambda message: message["_top"])
    for message in messages:
        message.pop("_top", None)
    return messages


def count_matching_outgoing(messages: Sequence[Dict[str, Any]], text: str) -> int:
    text_norm = normalize(text)
    return sum(
        1
        for message in messages
        if message["direction"] == "outgoing"
        and normalize(message["text"]) == text_norm
    )


def find_send_button(nodes: List[Any]) -> Optional[Any]:
    return find_named_control(
        nodes,
        ("button",),
        SEND_LABELS,
        visible_only=True,
    )


def send_text_message(
    auto,
    window: Dict[str, Any],
    composer,
    message: str,
    timeout: float,
) -> Dict[str, Any]:
    before_messages = extract_messages(read_app_nodes(auto, window))
    before_count = count_matching_outgoing(before_messages, message)
    set_value(composer, message)
    current_nodes = read_app_nodes(auto, window)
    send_button = find_send_button(current_nodes)
    if send_button is not None:
        invoke(send_button)
        submit = "send_button"
    else:
        safe(lambda: composer.SetFocus())
        auto.SendKeys("{Enter}", waitTime=0.05)
        submit = "enter"

    verified_message: Optional[Dict[str, Any]] = None
    composer_empty = False
    deadline = time.monotonic() + max(2.0, min(timeout, 20.0))
    while time.monotonic() < deadline:
        time.sleep(0.25)
        nodes = read_app_nodes(auto, window)
        current_composer = find_composer(nodes)
        composer_empty = current_composer is not None and not normalize(read_value(current_composer))
        messages = extract_messages(nodes)
        if count_matching_outgoing(messages, message) > before_count:
            verified_message = next(
                (
                    item
                    for item in reversed(messages)
                    if item["direction"] == "outgoing"
                    and normalize(item["text"]) == normalize(message)
                ),
                None,
            )
        if composer_empty and verified_message is not None:
            break
    verified = composer_empty and verified_message is not None
    return {
        "ok": verified,
        "sent": True,
        "verified": verified,
        "submit": submit,
        "delivery": verified_message.get("delivery") if verified_message else "unknown",
        "error": None if verified else "send_not_verified",
    }


def wait_for_native_dialog(
    owner_pid: int,
    timeout: float,
) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + max(2.0, min(timeout, 15.0))
    while time.monotonic() < deadline:
        for window in enum_visible_windows():
            if window["pid"] != owner_pid:
                continue
            if normalize(window["title"]) in {"open", "abrir"}:
                return window
        time.sleep(0.2)
    return None


def choose_attachment_label(media_path: str) -> Tuple[str, ...]:
    extension = os.path.splitext(media_path)[1].lower()
    if extension in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
        return ("photos & videos", "fotos y videos")
    if extension in AUDIO_EXTENSIONS:
        return ("audio",)
    return ("document", "documento")


def select_file_in_dialog(
    auto,
    dialog_window: Dict[str, Any],
    filepath: str,
) -> bool:
    dialog = auto.ControlFromHandle(dialog_window["handle"])
    nodes = walk(dialog, max_depth=16, max_nodes=4_000)
    filename = find_named_control(
        nodes,
        ("edit",),
        ("file name:", "nombre de archivo:"),
        visible_only=True,
    )
    if filename is None:
        return False
    set_value(filename, filepath)
    open_button = find_named_control(
        nodes,
        ("button",),
        ("open", "abrir"),
        visible_only=True,
    )
    if open_button is not None:
        invoke(open_button)
    else:
        safe(lambda: filename.SetFocus())
        auto.SendKeys("{Enter}", waitTime=0.05)
    return True


def find_caption_editor(nodes: List[Any]) -> Optional[Any]:
    return find_named_control(
        nodes,
        ("edit", "document"),
        ("add a caption", "anadir un pie de foto", "agregar un pie de foto",
         "type a caption", "escribe un pie de foto"),
        contains=True,
        visible_only=True,
    )


def wait_for_media_preview(
    auto,
    window: Dict[str, Any],
    timeout: float,
) -> Tuple[Optional[Any], Optional[Any]]:
    deadline = time.monotonic() + max(2.0, min(timeout, 20.0))
    while time.monotonic() < deadline:
        nodes = read_app_nodes(auto, window)
        send_button = find_send_button(nodes)
        caption = find_caption_editor(nodes)
        if send_button is not None:
            return caption, send_button
        time.sleep(0.25)
    return None, None


def send_media_attachment(
    auto,
    window: Dict[str, Any],
    media_path: str,
    caption: str,
    timeout: float,
) -> Dict[str, Any]:
    before_messages = extract_messages(read_app_nodes(auto, window))
    nodes = read_app_nodes(auto, window)
    attach = find_named_control(
        nodes,
        ("button",),
        ("attach", "adjuntar"),
        visible_only=True,
    )
    if attach is None:
        return {"ok": False, "sent": False, "verified": False,
                "error": "attach_button_not_found"}
    invoke(attach)
    time.sleep(0.3)
    nodes = read_app_nodes(auto, window)
    attachment_item = find_named_control(
        nodes,
        ("menuitem",),
        choose_attachment_label(media_path),
        visible_only=True,
    )
    if attachment_item is None:
        return {"ok": False, "sent": False, "verified": False,
                "error": "attachment_type_not_found"}
    invoke(attachment_item)
    dialog = wait_for_native_dialog(window["pid"], timeout)
    if dialog is None:
        return {"ok": False, "sent": False, "verified": False,
                "error": "attachment_file_dialog_not_found"}
    if not select_file_in_dialog(auto, dialog, media_path):
        return {"ok": False, "sent": False, "verified": False,
                "error": "attachment_file_input_not_found"}
    caption_editor, send_button = wait_for_media_preview(auto, window, timeout)
    if send_button is None:
        return {"ok": False, "sent": False, "verified": False,
                "error": "attachment_preview_not_found"}
    if caption:
        if caption_editor is None:
            return {"ok": False, "sent": False, "verified": False,
                    "error": "attachment_caption_not_supported"}
        set_value(caption_editor, caption)
    invoke(send_button)

    verified = False
    deadline = time.monotonic() + max(3.0, min(timeout, 25.0))
    while time.monotonic() < deadline:
        time.sleep(0.3)
        nodes = read_app_nodes(auto, window)
        if find_composer(nodes) is None:
            continue
        messages = extract_messages(nodes)
        if caption:
            verified = (
                count_matching_outgoing(messages, caption)
                > count_matching_outgoing(before_messages, caption)
            )
        else:
            verified = len(messages) > len(before_messages)
        if verified:
            break
    return {
        "ok": verified,
        "sent": True,
        "verified": verified,
        "submit": "media_send_button",
        "media": os.path.basename(media_path),
        "error": None if verified else "media_send_not_verified",
    }


def navigate_to_section(
    auto,
    window: Dict[str, Any],
    labels: Sequence[str],
    timeout: float,
) -> Tuple[bool, List[Any]]:
    nodes = read_app_nodes(auto, window)
    status_drawer_visible = any(
        node_type(node) == "group"
        and normalize(node_name(node)) in {"status tab drawer", "panel de estados"}
        and node_is_visible(node)
        for node in nodes
    )
    if labels == STATUS_LABELS and status_drawer_visible:
        return True, nodes
    if (
        labels == CHATS_LABELS
        and find_chat_grid(nodes) is not None
        and not status_drawer_visible
    ):
        return True, nodes
    button = find_named_control(
        nodes,
        ("button",),
        labels,
        visible_only=True,
    )
    if button is None:
        return False, nodes
    invoke(button)
    deadline = time.monotonic() + max(1.0, min(timeout, 10.0))
    while time.monotonic() < deadline:
        time.sleep(0.2)
        nodes = read_app_nodes(auto, window)
        if labels == STATUS_LABELS:
            if any(normalize(node_name(node)) == "status tab drawer" for node in nodes):
                return True, nodes
        elif labels == CHATS_LABELS and find_chat_grid(nodes) is not None:
            return True, nodes
    return False, nodes


def return_to_chats(auto, window: Dict[str, Any], timeout: float) -> None:
    safe(lambda: navigate_to_section(auto, window, CHATS_LABELS, timeout))


def list_status_updates(nodes: List[Any]) -> List[Dict[str, str]]:
    drawer = next(
        (
            node for node in nodes
            if node_type(node) == "group"
            and normalize(node_name(node)) in {"status tab drawer", "panel de estados"}
        ),
        None,
    )
    if drawer is None:
        return []
    updates: List[Dict[str, str]] = []
    seen: set[str] = set()
    for button in walk(drawer, max_depth=14, max_nodes=5_000):
        if node_type(button) != "button" or not node_name(button).strip():
            continue
        button_norm = normalize(node_name(button))
        if button_norm in {
            "add status", "agregar estado", "status menu", "menu de estados",
        } or button_norm.startswith(("my status", "mi estado")):
            continue
        descendants = walk(button, max_depth=10, max_nodes=400)
        name = next(
            (
                node_name(node).strip()
                for node in descendants
                if node_type(node) == "dataitem" and node_name(node).strip()
            ),
            "",
        )
        timestamp = next(
            (
                node_name(node).strip()
                for node in descendants
                if node_type(node) == "text"
                and re.search(r"\b(?:today|yesterday|hoy|ayer|\d{1,2}:\d{2})\b",
                              normalize(node_name(node)))
            ),
            "",
        )
        key = normalize(name)
        if not key or key in seen:
            continue
        seen.add(key)
        updates.append({"contact": name[:200], "timestamp": timestamp[:100]})
    return updates


def validate_media_path(filepath: str, allowed: Optional[set[str]] = None) -> str:
    resolved = os.path.abspath(os.path.expandvars(os.path.expanduser(filepath)))
    if not os.path.isfile(resolved):
        raise ValueError("media_file_not_found")
    extension = os.path.splitext(resolved)[1].lower()
    if allowed is not None and extension not in allowed:
        raise ValueError("unsupported_media_type")
    return resolved


def render_text_status(text: str, background: str) -> str:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", background):
        raise ValueError("invalid_status_background")
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise ValueError("pillow_required_for_text_status") from error

    image = Image.new("RGB", (1080, 1920), background)
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("segoeuib.ttf", 72)
    except OSError:
        font = ImageFont.load_default()
    lines = textwrap.wrap(text, width=28, break_long_words=True) or [text]
    line_gap = 24
    boxes = [draw.textbbox((0, 0), line, font=font) for line in lines]
    heights = [box[3] - box[1] for box in boxes]
    total_height = sum(heights) + line_gap * max(0, len(lines) - 1)
    y = (1920 - total_height) // 2
    for line, box, height in zip(lines, boxes, heights):
        width = box[2] - box[0]
        draw.text(((1080 - width) // 2, y), line, fill="#FFFFFF", font=font)
        y += height + line_gap
    handle = tempfile.NamedTemporaryFile(
        prefix="lumina-whatsapp-status-",
        suffix=".png",
        delete=False,
    )
    handle.close()
    image.save(handle.name, "PNG")
    return handle.name


def publish_status(
    auto,
    window: Dict[str, Any],
    media_path: str,
    caption: str,
    timeout: float,
) -> Dict[str, Any]:
    navigated, nodes = navigate_to_section(auto, window, STATUS_LABELS, timeout)
    if not navigated:
        return {"ok": False, "published": False, "verified": False,
                "error": "status_section_not_found"}
    add_status = find_named_control(
        nodes,
        ("button",),
        ADD_STATUS_LABELS,
        visible_only=True,
    )
    if add_status is None:
        return {"ok": False, "published": False, "verified": False,
                "error": "add_status_button_not_found"}
    add_status.Click()
    dialog = wait_for_native_dialog(window["pid"], timeout)
    if dialog is None:
        return {"ok": False, "published": False, "verified": False,
                "error": "status_file_dialog_not_found"}
    if not select_file_in_dialog(auto, dialog, media_path):
        return {"ok": False, "published": False, "verified": False,
                "error": "status_file_input_not_found"}
    caption_editor, send_button = wait_for_media_preview(auto, window, timeout)
    if send_button is None:
        return {"ok": False, "published": False, "verified": False,
                "error": "status_preview_not_found"}
    if caption:
        if caption_editor is None:
            return {"ok": False, "published": False, "verified": False,
                    "error": "status_caption_not_supported"}
        set_value(caption_editor, caption)
    invoke(send_button)

    verified = False
    deadline = time.monotonic() + max(3.0, min(timeout, 30.0))
    while time.monotonic() < deadline:
        time.sleep(0.4)
        nodes = read_app_nodes(auto, window)
        add_status = find_named_control(
            nodes,
            ("button",),
            ADD_STATUS_LABELS,
            visible_only=True,
        )
        if add_status is not None and find_send_button(nodes) is None:
            verified = True
            break
    return {
        "ok": verified,
        "published": True,
        "verified": verified,
        "media": os.path.basename(media_path),
        "error": None if verified else "status_publish_not_verified",
    }


def run_contacts(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    restore_window(window["handle"])
    _navigated, nodes = navigate_to_section(
        auto, window, CHATS_LABELS, args.timeout,
    )
    used_search = False
    if args.query.strip():
        conversations, used_search = search_conversations(
            auto, window, args.query.strip(), args.timeout,
        )
    else:
        conversations = list_conversations(nodes)
    if args.unread_only:
        conversations = [
            conversation
            for conversation in conversations
            if conversation["unreadCount"] > 0
        ]
    limit = max(1, min(args.limit, 200))
    result = [
        public_conversation(item, include_preview=not args.no_previews)
        for item in conversations[:limit]
    ]
    if used_search:
        clear_chat_search(auto, window)
    emit({
        "ok": True,
        "host": window["host"],
        "title": window["title"],
        "query": args.query.strip() or None,
        "contacts": result,
        "count": len(result),
        "totalFound": len(conversations),
    })


def run_messages(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    contact = args.contact.strip()
    if not contact:
        emit({"ok": False, "error": "missing_contact"}, 2)
    restore_window(window["handle"])
    _navigated, nodes = navigate_to_section(
        auto, window, CHATS_LABELS, args.timeout,
    )
    composer, conversation, score, candidates, opened_nodes = open_contact(
        auto, window, contact, args.timeout, nodes,
    )
    if conversation is None:
        error = "contact_ambiguous" if len(candidates) > 1 else "contact_not_found"
        emit({"ok": False, "error": error, "contact": contact,
              "candidates": candidates}, 2)
    if composer is None:
        emit({"ok": False, "error": "conversation_not_opened",
              "contact": conversation["name"]}, 2)
    limit = max(1, min(args.limit, 100))
    messages = extract_messages(opened_nodes)[-limit:]
    emit({
        "ok": True,
        "host": window["host"],
        "contact": conversation["name"],
        "contactScore": round(score, 3),
        "messages": messages,
        "count": len(messages),
        "mayMarkRead": True,
    })


def run_reply(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    contact = args.contact.strip()
    message = args.message.strip()
    media_path = args.media.strip()
    if not contact or (not message and not media_path):
        emit({"ok": False, "error": "missing_contact_or_content"}, 2)
    if len(message) > 4_096:
        emit({"ok": False, "error": "message_too_long"}, 2)
    resolved_media = ""
    if media_path:
        try:
            resolved_media = validate_media_path(media_path)
        except ValueError as error:
            emit({"ok": False, "error": str(error)}, 2)

    restore_window(window["handle"])
    _navigated, nodes = navigate_to_section(
        auto, window, CHATS_LABELS, args.timeout,
    )
    composer, conversation, score, candidates, _opened_nodes = open_contact(
        auto, window, contact, args.timeout, nodes,
    )
    if conversation is None:
        error = "contact_ambiguous" if len(candidates) > 1 else "contact_not_found"
        emit({"ok": False, "error": error, "contact": contact,
              "candidates": candidates}, 2)
    if composer is None:
        emit({"ok": False, "error": "composer_not_found",
              "contact": conversation["name"]}, 2)
    if args.dry_run:
        emit({
            "ok": True,
            "dryRun": True,
            "host": window["host"],
            "contact": conversation["name"],
            "contactScore": round(score, 3),
            "composer": describe(composer),
            "media": os.path.basename(resolved_media) if resolved_media else None,
        })

    if resolved_media:
        result = send_media_attachment(
            auto, window, resolved_media, message, args.timeout,
        )
    else:
        result = send_text_message(
            auto, window, composer, message, args.timeout,
        )
    emit({
        **result,
        "host": window["host"],
        "contact": conversation["name"],
        "contactScore": round(score, 3),
    }, 0 if result["ok"] else 2)


def run_statuses(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    restore_window(window["handle"])
    navigated, nodes = navigate_to_section(
        auto, window, STATUS_LABELS, args.timeout,
    )
    if not navigated:
        emit({"ok": False, "error": "status_section_not_found"}, 2)
    updates = list_status_updates(nodes)
    limit = max(1, min(args.limit, 200))
    return_to_chats(auto, window, args.timeout)
    emit({
        "ok": True,
        "host": window["host"],
        "statuses": updates[:limit],
        "count": min(len(updates), limit),
        "totalFound": len(updates),
        "viewed": False,
    })


def run_status(auto, window: Dict[str, Any], args: argparse.Namespace) -> None:
    text = args.text.strip()
    caption = args.caption.strip()
    media_arg = args.media.strip()
    if not text and not media_arg:
        emit({"ok": False, "error": "status_requires_text_or_media"}, 2)
    if len(text) > 700 or len(caption) > 700:
        emit({"ok": False, "error": "status_text_too_long"}, 2)

    generated_media = ""
    try:
        if media_arg:
            media_path = validate_media_path(media_arg, STATUS_MEDIA_EXTENSIONS)
        else:
            media_path = render_text_status(text, args.background)
            generated_media = media_path
        restore_window(window["handle"])
        navigated, nodes = navigate_to_section(
            auto, window, STATUS_LABELS, args.timeout,
        )
        add_status = find_named_control(
            nodes,
            ("button",),
            ADD_STATUS_LABELS,
            visible_only=True,
        )
        if not navigated or add_status is None:
            emit({"ok": False, "error": "status_composer_unavailable"}, 2)
        if args.dry_run:
            return_to_chats(auto, window, args.timeout)
            emit({
                "ok": True,
                "dryRun": True,
                "host": window["host"],
                "ready": True,
                "media": os.path.basename(media_path),
                "generatedFromText": bool(generated_media),
            })
        result = publish_status(
            auto, window, media_path, caption, args.timeout,
        )
        return_to_chats(auto, window, args.timeout)
        emit({
            **result,
            "host": window["host"],
            "generatedFromText": bool(generated_media),
        }, 0 if result["ok"] else 2)
    except ValueError as error:
        emit({"ok": False, "error": str(error)}, 2)
    finally:
        if generated_media and os.path.exists(generated_media):
            safe(lambda: os.remove(generated_media))


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "windows_only"}, 2)
    try:
        import uiautomation as auto
    except ImportError:
        emit({"ok": False, "error": "uiautomation_not_installed"}, 2)

    try:
        args = parse_args()
        preferred = normalize(args.window).replace(" ", "_")
        allowed_hosts = {"whatsapp", "whatsapp_web", "phone_link"}
        window = find_target_window(preferred if preferred in allowed_hosts else "")
        if window is None:
            emit({"ok": False, "error": "no_whatsapp_window", "running": False}, 2)
        if args.contacts:
            run_contacts(auto, window, args)
        if args.messages:
            run_messages(auto, window, args)
        if args.reply:
            run_reply(auto, window, args)
        if args.statuses:
            run_statuses(auto, window, args)
        run_status(auto, window, args)
    finally:
        restore_suspended_overlays()


if __name__ == "__main__":
    main()
