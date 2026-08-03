"""
office_com.py — Office COM Automation adapter for Lumina (§5).

Drives Word / Excel / Outlook / PowerPoint through their COM Automation
interfaces (win32com) — the structural, no-pixels path the App Adapter
Registry prefers before falling back to generic UIA or vision. COM speaks to
the running Office instance directly, so it reads/writes documents reliably
regardless of window focus or z-order.

Uses pywin32 (win32com.client). Reading/controlling another app's content →
Python, per the AMSI rule. If pywin32 is missing the sidecar exits 2 with a
structured hint so the TS layer can surface install instructions.

Protocol (one JSON per stdout):
  python office_com.py --action <action> [--json '<params>']
Actions:
  status                          → which Office apps are currently running
  word_get_text                   → active Word document text (truncated)
  word_insert_text  {text}        → insert text at the Word selection
  word_save                       → save the active Word document
  excel_get_cell    {cell,sheet?} → value of a cell (e.g. "B2")
  excel_set_cell    {cell,value,sheet?} → set a cell value
  outlook_unread                  → unread count of the default Inbox
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def _com():
    try:
        import win32com.client  # type: ignore
        return win32com.client
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"pywin32 not installed: {e!s}",
              "hint": "pip install pywin32"}, 2)


def get_active(progid: str):
    """Attach to a RUNNING Office app only (never launch one)."""
    com = _com()
    try:
        return com.GetActiveObject(progid)
    except Exception:
        return None


# ── Actions ──────────────────────────────────────────────────────────

def action_status(_: Dict[str, Any]) -> Dict[str, Any]:
    running = {}
    for label, progid in (
        ("word", "Word.Application"),
        ("excel", "Excel.Application"),
        ("outlook", "Outlook.Application"),
        ("powerpoint", "PowerPoint.Application"),
    ):
        running[label] = get_active(progid) is not None
    return {"ok": True, "running": running}


def action_word_get_text(_: Dict[str, Any]) -> Dict[str, Any]:
    app = get_active("Word.Application")
    if app is None:
        return {"ok": False, "error": "word_not_running"}
    try:
        doc = app.ActiveDocument
    except Exception:
        return {"ok": False, "error": "no_active_document"}
    text = str(doc.Content.Text or "")
    return {"ok": True, "name": str(doc.Name), "length": len(text), "text": text[:8000]}


def action_word_insert_text(params: Dict[str, Any]) -> Dict[str, Any]:
    text = str(params.get("text", ""))
    if not text:
        return {"ok": False, "error": "text_required"}
    app = get_active("Word.Application")
    if app is None:
        return {"ok": False, "error": "word_not_running"}
    app.Selection.TypeText(Text=text)
    return {"ok": True, "inserted": len(text)}


def action_word_save(_: Dict[str, Any]) -> Dict[str, Any]:
    app = get_active("Word.Application")
    if app is None:
        return {"ok": False, "error": "word_not_running"}
    try:
        app.ActiveDocument.Save()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"save_failed: {e!s}"}
    return {"ok": True, "saved": str(app.ActiveDocument.Name)}


def _excel_sheet(app, sheet: str):
    if sheet:
        return app.ActiveWorkbook.Worksheets(sheet)
    return app.ActiveSheet


def action_excel_get_cell(params: Dict[str, Any]) -> Dict[str, Any]:
    cell = str(params.get("cell", "")).strip()
    if not cell:
        return {"ok": False, "error": "cell_required"}
    app = get_active("Excel.Application")
    if app is None:
        return {"ok": False, "error": "excel_not_running"}
    try:
        ws = _excel_sheet(app, str(params.get("sheet", "")))
        value = ws.Range(cell).Value
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"read_failed: {e!s}"}
    return {"ok": True, "cell": cell, "value": value}


def action_excel_set_cell(params: Dict[str, Any]) -> Dict[str, Any]:
    cell = str(params.get("cell", "")).strip()
    if not cell:
        return {"ok": False, "error": "cell_required"}
    if "value" not in params:
        return {"ok": False, "error": "value_required"}
    app = get_active("Excel.Application")
    if app is None:
        return {"ok": False, "error": "excel_not_running"}
    try:
        ws = _excel_sheet(app, str(params.get("sheet", "")))
        ws.Range(cell).Value = params["value"]
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"write_failed: {e!s}"}
    return {"ok": True, "cell": cell, "value": params["value"]}


def action_outlook_unread(_: Dict[str, Any]) -> Dict[str, Any]:
    app = get_active("Outlook.Application")
    if app is None:
        return {"ok": False, "error": "outlook_not_running"}
    try:
        ns = app.GetNamespace("MAPI")
        inbox = ns.GetDefaultFolder(6)  # olFolderInbox
        return {"ok": True, "unread": int(inbox.UnReadItemCount), "folder": str(inbox.Name)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"outlook_failed: {e!s}"}


ACTIONS = {
    "status": action_status,
    "word_get_text": action_word_get_text,
    "word_insert_text": action_word_insert_text,
    "word_save": action_word_save,
    "excel_get_cell": action_excel_get_cell,
    "excel_set_cell": action_excel_set_cell,
    "outlook_unread": action_outlook_unread,
}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "office_com.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina Office COM adapter")
    ap.add_argument("--action", required=True, choices=sorted(ACTIONS.keys()))
    ap.add_argument("--json", type=str, default="{}", help="JSON params object")
    args = ap.parse_args()

    try:
        params = json.loads(args.json) if args.json else {}
        if not isinstance(params, dict):
            params = {}
    except Exception:
        emit({"ok": False, "error": "invalid --json params"}, 2)
        return

    # win32com needs COM initialized on this thread.
    try:
        import pythoncom  # type: ignore
        pythoncom.CoInitialize()
    except Exception:
        pass

    try:
        result = ACTIONS[args.action](params)
        emit(result)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"office_com {args.action} failed: {e!s}"}, 1)


if __name__ == "__main__":
    main()
