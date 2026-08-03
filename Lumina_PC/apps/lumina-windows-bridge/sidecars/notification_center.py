"""Read the current Windows Notification Center through UI Automation.

This is the immediate, unpackaged Windows path for OpenClaw. The official
UserNotificationListener API requires a packaged app manifest plus explicit
user consent. UI Automation can read the notification cards already retained
by the interactive Windows session without a second UI or a separate account.

Output: one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Tuple


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(code)


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def text(node, attr: str) -> str:
    return str(safe(lambda: getattr(node, attr), "") or "")


def normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", stripped).strip().lower()


def children(node) -> List[Any]:
    return list(safe(lambda: node.GetChildren(), []) or [])


def walk(root, max_depth: int = 16, max_nodes: int = 5000) -> List[Tuple[Any, int]]:
    pending: List[Tuple[Any, int]] = [(root, 0)]
    found: List[Tuple[Any, int]] = []
    while pending and len(found) < max_nodes:
        node, depth = pending.pop()
        found.append((node, depth))
        if depth >= max_depth:
            continue
        for child in reversed(children(node)):
            pending.append((child, depth + 1))
    return found


def find_by_id(root, automation_id: str) -> Optional[Any]:
    for node, _depth in walk(root):
        if text(node, "AutomationId") == automation_id:
            return node
    return None


def is_notification_center(root) -> bool:
    if root is None:
        return False
    name = normalize(text(root, "Name"))
    class_name = text(root, "ClassName")
    return (
        "notification center" in name
        or "centro de notificaciones" in name
        or (
            class_name == "Windows.UI.Core.CoreWindow"
            and find_by_id(root, "NotificationCenterGrid") is not None
        )
    )


def wait_for_notification_center(auto, timeout: float) -> Optional[Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        foreground = safe(lambda: auto.GetForegroundControl())
        if is_notification_center(foreground):
            return foreground
        time.sleep(0.1)
    return None


def wait_for_notification_center_closed(auto, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not is_notification_center(safe(lambda: auto.GetForegroundControl())):
            return
        time.sleep(0.1)


def invoke(node) -> bool:
    try:
        node.GetInvokePattern().Invoke()
        return True
    except Exception:
        try:
            node.Click()
            return True
        except Exception:
            return False


def first_descendant_text(root, automation_id: str) -> str:
    for node, _depth in walk(root, max_depth=8, max_nodes=300):
        if text(node, "AutomationId") == automation_id:
            value = text(node, "Name").strip()
            if value:
                return value
    return ""


def app_name_from_group(group) -> str:
    for child in children(group):
        if text(child, "AutomationId") == "Title":
            value = text(child, "Name").strip()
            if value:
                return value
    group_name = text(group, "Name").strip()
    for pattern in (
        r"^Notifications from\s+(.+)$",
        r"^Notificaciones (?:de|desde)\s+(.+)$",
    ):
        match = re.match(pattern, group_name, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return group_name


def notification_items(group) -> Iterable[Any]:
    direct = [
        node
        for node in children(group)
        if normalize(text(node, "ControlTypeName")).replace("control", "") == "listitem"
    ]
    if direct:
        return direct
    return [
        node
        for node, depth in walk(group, max_depth=6, max_nodes=1000)
        if depth > 0
        and normalize(text(node, "ControlTypeName")).replace("control", "") == "listitem"
    ]


def notification_groups(main_list) -> List[Any]:
    return [
        group
        for group in children(main_list)
        if normalize(text(group, "ControlTypeName")).replace("control", "") == "group"
        or text(group, "ClassName") == "ListViewHeaderItem"
    ]


def append_group_notifications(
    group,
    app: str,
    output: List[Dict[str, Any]],
    seen: set,
    limit: int,
) -> None:
    for item in notification_items(group):
        title = first_descendant_text(item, "Title")
        content = first_descendant_text(item, "Content")
        timestamp = first_descendant_text(item, "TimeStamp")
        raw_name = text(item, "Name").strip()
        if not title and not content and not raw_name:
            continue
        key = (normalize(app), normalize(title), normalize(content), normalize(timestamp), normalize(raw_name))
        if key in seen:
            continue
        seen.add(key)
        output.append(
            {
                "app": app or "Unknown",
                "title": title or None,
                "content": content or None,
                "timestamp": timestamp or None,
                "summary": raw_name or None,
                "offscreen": bool(safe(lambda: item.IsOffscreen, False)),
            }
        )
        if len(output) >= limit:
            return


def find_group(main_list, app: str) -> Optional[Any]:
    wanted = normalize(app)
    return next(
        (
            group
            for group in notification_groups(main_list)
            if normalize(app_name_from_group(group)) == wanted
        ),
        None,
    )


def find_more_button(group, collapsed_only: bool) -> Optional[Any]:
    return next(
        (
            node
            for node, _depth in walk(group)
            if text(node, "AutomationId") == "SeeMoreLessButton"
            and (not collapsed_only or re.match(r"^\s*\+\d+", text(node, "Name")))
        ),
        None,
    )


def scroll_pattern(main_list):
    return safe(lambda: main_list.GetScrollPattern()) if main_list is not None else None


def discover_group_names(main_list) -> List[str]:
    scroll = scroll_pattern(main_list)
    names: List[str] = []
    seen = set()

    def capture() -> None:
        for group in notification_groups(main_list):
            app = app_name_from_group(group)
            key = normalize(app)
            if key and key not in seen:
                seen.add(key)
                names.append(app)

    if scroll is None or not safe(lambda: scroll.VerticallyScrollable, False):
        capture()
        return names

    original_percent = float(safe(lambda: scroll.VerticalScrollPercent, 0.0) or 0.0)
    for percent in range(0, 101, 5):
        safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.04))
        capture()
    safe(lambda: scroll.SetScrollPercent(-1, original_percent, waitTime=0.08))
    return names


def scroll_to_group(main_list, app: str) -> Optional[Any]:
    scroll = scroll_pattern(main_list)
    if scroll is None or not safe(lambda: scroll.VerticallyScrollable, False):
        return find_group(main_list, app)

    for percent in range(0, 101, 5):
        safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.04))
        group = find_group(main_list, app)
        if group is not None:
            return group
    return find_group(main_list, app)


def collect_scrolled_group(
    main_list,
    app: str,
    output: List[Dict[str, Any]],
    seen: set,
    limit: int,
) -> None:
    scroll = scroll_pattern(main_list)
    if scroll is None or not safe(lambda: scroll.VerticallyScrollable, False):
        group = find_group(main_list, app)
        if group is not None:
            append_group_notifications(group, app, output, seen, limit)
        return

    original_percent = float(safe(lambda: scroll.VerticalScrollPercent, 0.0) or 0.0)
    for percent in range(0, 101, 4):
        safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.04))
        group = find_group(main_list, app)
        if group is not None:
            append_group_notifications(group, app, output, seen, limit)
        if len(output) >= limit:
            break
    safe(lambda: scroll.SetScrollPercent(-1, original_percent, waitTime=0.1))


def read_notifications(
    root,
    app_filter: str,
    limit: int,
    include_hidden: bool,
    restore_ui_state: bool,
) -> Tuple[List[Dict[str, Any]], int]:
    wanted = normalize(app_filter)
    output: List[Dict[str, Any]] = []
    seen: set = set()
    main_list = find_by_id(root, "MainListView")
    if main_list is None:
        return output, 0
    scroll = scroll_pattern(main_list)
    original_percent = float(safe(lambda: scroll.VerticalScrollPercent, 0.0) or 0.0) if scroll else 0.0
    percentages = range(0, 101, 10) if scroll else (0,)
    expanded_apps = set()
    expanded = 0

    if include_hidden:
        for _pass in range(2):
            changed = False
            for percent in percentages:
                if scroll:
                    safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.03))
                for group in notification_groups(main_list):
                    app = app_name_from_group(group)
                    if wanted and wanted not in normalize(app):
                        continue
                    more = find_more_button(group, collapsed_only=True)
                    if more is not None and invoke(more):
                        expanded_apps.add(normalize(app))
                        expanded += 1
                        changed = True
                        time.sleep(0.06)
            if not changed:
                break

    collect_percentages = range(0, 101, 3) if scroll and include_hidden else percentages
    for percent in collect_percentages:
        if scroll:
            safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.03))
        for group in notification_groups(main_list):
            app = app_name_from_group(group)
            if wanted and wanted not in normalize(app):
                continue
            append_group_notifications(group, app, output, seen, limit)
            if len(output) >= limit:
                break
        if len(output) >= limit:
            break

    if expanded_apps and restore_ui_state:
        remaining = set(expanded_apps)
        for _pass in range(2):
            for percent in percentages:
                if scroll:
                    safe(lambda percent=percent: scroll.SetScrollPercent(-1, percent, waitTime=0.03))
                for group in notification_groups(main_list):
                    app_key = normalize(app_name_from_group(group))
                    if app_key not in remaining:
                        continue
                    collapse = find_more_button(group, collapsed_only=False)
                    if collapse is not None and not re.match(r"^\s*\+\d+", text(collapse, "Name")):
                        if invoke(collapse):
                            remaining.discard(app_key)
                            time.sleep(0.05)
            if not remaining:
                break

    if scroll:
        safe(lambda: scroll.SetScrollPercent(-1, original_percent, waitTime=0.05))
    return output, expanded


# Names of the per-notification close/dismiss control across Windows locales.
# WhatsApp/Teams action buttons ("Responder", "Marcar como leido") never match
# these, so we only ever invoke the dismiss affordance, not an app action.
DISMISS_NAME_PATTERNS = (
    "descartar",
    "dismiss",
    "quitar notificacion",
    "remove this notification",
)
CLEAR_ALL_NAME_PATTERNS = (
    "clear all",
    "borrar todo",
    "borrar todas",
    "vaciar",
    "limpiar todo",
)


def is_button(node) -> bool:
    return normalize(text(node, "ControlTypeName")).replace("control", "") == "button"


def find_dismiss_button(item) -> Optional[Any]:
    fallback = None
    for node, _depth in walk(item, max_depth=8, max_nodes=400):
        if not is_button(node):
            continue
        name = normalize(text(node, "Name"))
        aid = normalize(text(node, "AutomationId"))
        if aid in ("dismissbutton", "closebutton"):
            return node
        if any(pattern in name for pattern in DISMISS_NAME_PATTERNS):
            return node
        if fallback is None and name in ("cerrar", "close"):
            fallback = node
    return fallback


def find_clear_all_button(root) -> Optional[Any]:
    for node, _depth in walk(root):
        if not is_button(node):
            continue
        name = normalize(text(node, "Name"))
        aid = normalize(text(node, "AutomationId"))
        if aid in ("clearall", "clearallbutton"):
            return node
        if any(pattern in name for pattern in CLEAR_ALL_NAME_PATTERNS):
            return node
    return None


def item_dismiss_match(item, app: str, wanted_app: str, match_norm: str) -> bool:
    if wanted_app and wanted_app not in normalize(app):
        return False
    if not match_norm:
        return True
    haystack = " ".join(
        normalize(value)
        for value in (
            first_descendant_text(item, "Title"),
            first_descendant_text(item, "Content"),
            text(item, "Name"),
        )
    )
    return match_norm in haystack


def item_label(item) -> str:
    title = first_descendant_text(item, "Title")
    content = first_descendant_text(item, "Content")
    raw = text(item, "Name").strip()
    return (title or raw or content or "").strip()


def dismiss_notifications(
    root,
    app_filter: str,
    match: str,
    dismiss_all: bool,
    max_dismiss: int,
) -> Dict[str, Any]:
    main_list = find_by_id(root, "MainListView")
    if main_list is None:
        return {"dismissed": [], "clearedAll": False, "remaining": 0}

    if dismiss_all and not app_filter and not match:
        clear = find_clear_all_button(root)
        if clear is not None and invoke(clear):
            time.sleep(0.35)
            remaining, _ = read_notifications(
                root, "", 200, include_hidden=False, restore_ui_state=False
            )
            return {"dismissed": [], "clearedAll": True, "remaining": len(remaining)}

    wanted_app = normalize(app_filter)
    match_norm = normalize(match)
    dismissed: List[Dict[str, Any]] = []
    # Each dismiss invalidates the UIA subtree, so re-scan from the top every pass
    # instead of caching stale item nodes.
    for _ in range(max(1, max_dismiss)):
        target = None
        target_app = ""
        target_label = ""
        for group in notification_groups(main_list):
            app = app_name_from_group(group)
            if wanted_app and wanted_app not in normalize(app):
                continue
            for item in notification_items(group):
                if not item_dismiss_match(item, app, wanted_app, match_norm):
                    continue
                button = find_dismiss_button(item)
                if button is not None:
                    target = button
                    target_app = app
                    target_label = item_label(item)
                    break
            if target is not None:
                break
        if target is None:
            break
        if not invoke(target):
            break
        dismissed.append({"app": target_app or "Unknown", "summary": target_label or None})
        time.sleep(0.2)
        if not dismiss_all:
            break

    remaining, _ = read_notifications(
        root, "", 200, include_hidden=False, restore_ui_state=False
    )
    return {"dismissed": dismissed, "clearedAll": False, "remaining": len(remaining)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read Windows Notification Center")
    parser.add_argument("--mode", choices=["read", "dismiss"], default="read")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--app", default="")
    parser.add_argument("--match", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--max-dismiss", type=int, default=25)
    parser.add_argument("--visible-only", action="store_true")
    parser.add_argument("--keep-open", action="store_true")
    return parser.parse_args()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "notification_center_only_runs_on_windows"}, 2)

    try:
        import uiautomation as auto  # type: ignore
    except ImportError:
        emit({"ok": False, "error": "uiautomation_not_installed"}, 2)

    args = parse_args()
    limit = max(1, min(200, args.limit))
    current = safe(lambda: auto.GetForegroundControl())
    already_open = is_notification_center(current)
    root = current if already_open else None

    try:
        if already_open:
            # A previous read may have just pressed Escape. Let the Windows
            # animation settle so a closing panel is never mistaken for a live
            # Notification Center and reported as an empty result.
            time.sleep(0.25)
            current = safe(lambda: auto.GetForegroundControl())
            already_open = is_notification_center(current)
            root = current if already_open else None
        if root is None:
            auto.SendKeys("{Win}n")
            root = wait_for_notification_center(auto, 4.0)
        if root is None:
            emit({"ok": False, "error": "notification_center_did_not_open"}, 2)

        if args.mode == "dismiss":
            result = dismiss_notifications(
                root,
                args.app,
                args.match,
                dismiss_all=args.all,
                max_dismiss=max(1, min(200, args.max_dismiss)),
            )
            emit(
                {
                    "ok": True,
                    "source": "windows-notification-center-uia",
                    "action": "dismiss",
                    "clearedAll": result["clearedAll"],
                    "dismissedCount": len(result["dismissed"]),
                    "dismissed": result["dismissed"],
                    "remaining": result["remaining"],
                    "filter": args.app or None,
                    "match": args.match or None,
                    "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                }
            )

        notifications, expanded = read_notifications(
            root,
            args.app,
            limit,
            include_hidden=not args.visible_only,
            restore_ui_state=already_open,
        )
        emit(
            {
                "ok": True,
                "source": "windows-notification-center-uia",
                "scope": "notifications_currently_retained_by_windows",
                "count": len(notifications),
                "expandedGroups": expanded,
                "filter": args.app or None,
                "notifications": notifications,
                "readAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }
        )
    finally:
        if not already_open and not args.keep_open:
            safe(lambda: auto.SendKeys("{Esc}"))
            wait_for_notification_center_closed(auto, 1.5)


if __name__ == "__main__":
    main()
