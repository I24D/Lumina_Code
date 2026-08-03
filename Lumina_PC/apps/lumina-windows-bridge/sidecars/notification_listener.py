"""Snapshot of live Windows toast notifications via WinRT UserNotificationListener.

Unlike notification_center.py (UI Automation, which opens the flyout with Win+N),
this reads the UserNotificationListener directly: no window is opened and nothing
steals focus, so Start Talk can poll it every couple of seconds to detect arrivals
without disrupting the user. AMSI-safe — pure Python WinRT, never PowerShell.

Output: one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any, Dict, List

MAX_TEXT = 1000


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(code)


def _clip(value: Any) -> str:
    return str(value or "").strip()[:MAX_TEXT]


async def _snapshot() -> Dict[str, Any]:
    try:
        from winsdk.windows.ui.notifications import NotificationKinds
        from winsdk.windows.ui.notifications.management import (
            UserNotificationListener,
            UserNotificationListenerAccessStatus,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"winsdk_missing: {exc!s}"}

    listener = UserNotificationListener.current
    access = await listener.request_access_async()
    if access != UserNotificationListenerAccessStatus.ALLOWED:
        return {"ok": False, "access": str(access), "error": "notification_access_denied"}

    notifications = await listener.get_notifications_async(NotificationKinds.TOAST)
    out: List[Dict[str, Any]] = []
    for item in notifications:
        app_id = ""
        app_name = ""
        # winsdk's AppInfo projection raises "Not implemented" on this build, so
        # app name/id are best-effort only; the toast text is the real payload.
        try:
            app_id = _clip(item.app_info.app_user_model_id)
            app_name = _clip(item.app_info.display_info.display_name)
        except Exception:
            pass

        texts: List[str] = []
        try:
            # The string template name is required here: KnownNotificationBindings
            # exposes no toast_generic member in this winsdk build.
            binding = item.notification.visual.get_binding("ToastGeneric")
            if binding is not None:
                texts = [_clip(el.text) for el in binding.get_text_elements()]
        except Exception:
            pass
        texts = [t for t in texts if t][:8]
        title = texts[0] if texts else ""
        body = " ".join(texts[1:]) if len(texts) > 1 else ""

        created_iso = ""
        try:
            created = item.creation_time
            created_iso = created.isoformat() if hasattr(created, "isoformat") else str(created)
        except Exception:
            pass
        try:
            nid = str(item.id)
        except Exception:
            nid = ""

        if not title and not body:
            continue  # silent/progress toasts with no readable text

        out.append(
            {
                "id": f"{nid}|{app_id}|{created_iso}",
                "notificationId": nid,
                "appName": app_name or "Notificación",
                "appUserModelId": app_id or None,
                "title": title,
                "body": body or None,
                "textElements": texts,
                "createdAt": created_iso,
            }
        )

    return {
        "ok": True,
        "source": "user-notification-listener",
        "count": len(out),
        "notifications": out,
        "readAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "notification_listener_only_runs_on_windows"}, 2)
    argparse.ArgumentParser(description="Snapshot live toast notifications (WinRT)").parse_args()
    try:
        result = asyncio.run(_snapshot())
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"listener_failed: {exc!s}"}, 1)
    emit(result, 0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
