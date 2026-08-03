"""
capture_analyze.py - one-shot screen/window vision sidecar for Lumina.

Returns screenshot + UIA structure + OCR for either:
- the foreground window/screen, or
- a target top-level window selected by hwnd, pid, title, or process name.
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import sys
import traceback
from ctypes import wintypes
from typing import Any, Dict, List, Optional


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _proc_name(pid: int) -> str:
    if not sys.platform.startswith("win") or not pid:
        return ""
    try:
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        h_proc = kernel32.OpenProcess(0x0410, False, pid)
        if not h_proc:
            return ""
        try:
            exe_buf = ctypes.create_unicode_buffer(260)
            if psapi.GetModuleBaseNameW(h_proc, None, exe_buf, 260):
                return (exe_buf.value or "").lower()
        finally:
            kernel32.CloseHandle(h_proc)
    except Exception:
        return ""
    return ""


def _window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _window_title(hwnd: int) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def _window_rect(hwnd: int) -> Optional[Dict[str, int]]:
    rect = wintypes.RECT()
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    width = int(rect.right - rect.left)
    height = int(rect.bottom - rect.top)
    if width <= 0 or height <= 0:
        return None
    return {"left": int(rect.left), "top": int(rect.top), "width": width, "height": height}


def enum_windows() -> List[Dict[str, Any]]:
    if not sys.platform.startswith("win"):
        return []
    user32 = ctypes.windll.user32
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    windows: List[Dict[str, Any]] = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            title = _window_title(int(hwnd))
            if title.strip():
                pid = _window_pid(int(hwnd))
                windows.append({
                    "handle": int(hwnd),
                    "title": title,
                    "pid": pid,
                    "process": _proc_name(pid),
                    "rect": _window_rect(int(hwnd)),
                })
        return True

    user32.EnumWindows(enum_proc(cb), 0)
    return windows


def find_target_window(
    hwnd: Optional[int],
    pid: Optional[int],
    title: Optional[str],
    process_name: Optional[str],
) -> Optional[Dict[str, Any]]:
    if hwnd:
        rect = _window_rect(hwnd)
        if not rect:
            return None
        found_pid = _window_pid(hwnd)
        return {
            "handle": hwnd,
            "title": _window_title(hwnd),
            "pid": found_pid,
            "process": _proc_name(found_pid),
            "rect": rect,
        }

    title_norm = (title or "").strip().lower()
    process_norm = (process_name or "").strip().lower()
    for window in enum_windows():
        if pid is not None and window.get("pid") == pid:
            return window
        if title_norm and title_norm in str(window.get("title", "")).lower():
            return window
        if process_norm and process_norm in str(window.get("process", "")).lower():
            return window
    return None


def capture_region(out_path: str, region: Optional[Dict[str, int]]) -> Optional[Dict[str, Any]]:
    try:
        import mss
        from PIL import Image
    except Exception as e:
        emit({"ok": False, "error": f"missing dep: {e!s}; pip install mss pillow"}, 2)
        return None

    with mss.mss() as sct:
        mon = region or (sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0])
        mon = {
            "left": int(mon.get("left", 0)),
            "top": int(mon.get("top", 0)),
            "width": max(1, int(mon.get("width", 1))),
            "height": max(1, int(mon.get("height", 1))),
        }
        raw = sct.grab(mon)
        img = Image.frombytes("RGB", raw.size, raw.rgb)
        img.save(out_path, "PNG", optimize=False)
    return {
        "path": out_path,
        "method": "mss_region" if region else "mss_primary",
        "left": mon["left"],
        "top": mon["top"],
        "width": mon["width"],
        "height": mon["height"],
    }


def capture_window_print(hwnd: int, out_path: str) -> Optional[Dict[str, Any]]:
    """Capture a top-level window by hwnd without depending on foreground focus."""
    try:
        import win32con
        import win32gui
        import win32ui
        from PIL import Image
    except Exception:
        return None

    rect = _window_rect(hwnd)
    if not rect:
        return None

    left = rect["left"]
    top = rect["top"]
    width = rect["width"]
    height = rect["height"]
    hwnd_dc = None
    mfc_dc = None
    save_dc = None
    bitmap = None
    try:
        hwnd_dc = win32gui.GetWindowDC(hwnd)
        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
        save_dc = mfc_dc.CreateCompatibleDC()
        bitmap = win32ui.CreateBitmap()
        bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
        save_dc.SelectObject(bitmap)
        rendered = ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), 0x00000002)
        if not rendered:
            return None
        bmpinfo = bitmap.GetInfo()
        bmpstr = bitmap.GetBitmapBits(True)
        img = Image.frombuffer(
            "RGB",
            (bmpinfo["bmWidth"], bmpinfo["bmHeight"]),
            bmpstr,
            "raw",
            "BGRX",
            0,
            1,
        )
        img.save(out_path, "PNG", optimize=False)
        return {
            "path": out_path,
            "method": "print_window",
            "left": left,
            "top": top,
            "width": width,
            "height": height,
        }
    except Exception:
        return None
    finally:
        try:
            if bitmap is not None:
                win32gui.DeleteObject(bitmap.GetHandle())
            if save_dc is not None:
                save_dc.DeleteDC()
            if mfc_dc is not None:
                mfc_dc.DeleteDC()
            if hwnd_dc is not None:
                win32gui.ReleaseDC(hwnd, hwnd_dc)
        except Exception:
            pass


def foreground_info() -> Optional[Dict[str, Any]]:
    if not sys.platform.startswith("win"):
        return None
    try:
        user32 = ctypes.windll.user32
        hwnd = int(user32.GetForegroundWindow())
        if not hwnd:
            return None
        pid = _window_pid(hwnd)
        return {
            "handle": hwnd,
            "process": _proc_name(pid),
            "title": _window_title(hwnd),
            "pid": pid,
            "rect": _window_rect(hwnd),
        }
    except Exception:
        return None


_INTERACTABLE = (
    "button", "hyperlink", "menuitem", "tabitem", "listitem", "treeitem",
    "checkbox", "radiobutton", "splitbutton", "combobox", "edit", "slider",
    "text", "document", "menu",
)


def get_uia_root(auto, target_window: Optional[Dict[str, Any]], pid: Optional[int]):
    if target_window and target_window.get("handle"):
        return auto.ControlFromHandle(int(target_window["handle"]))
    if pid is not None:
        for child in auto.GetRootControl().GetChildren():
            if _safe(lambda c=child: c.ProcessId) == pid:
                return child
        return None
    return auto.GetForegroundControl()


def extract_elements(
    target_window: Optional[Dict[str, Any]],
    pid: Optional[int],
    max_elements: int,
) -> Dict[str, Any]:
    try:
        import uiautomation as auto
    except Exception:
        return {"count": 0, "elements": [], "richUia": False, "error": "uiautomation_not_installed"}

    try:
        root = get_uia_root(auto, target_window, pid)
        if root is None:
            return {"count": 0, "elements": [], "richUia": False, "error": "no_target_window"}

        elements: List[Dict[str, Any]] = []
        stack = [(root, 0)]
        scanned = 0
        while stack and len(elements) < max_elements and scanned < 800:
            node, depth = stack.pop()
            scanned += 1
            name = (_safe(lambda: node.Name) or "").strip()
            ctype = _safe(lambda: node.ControlTypeName) or ""
            if name:
                ctl = ctype.lower().replace("control", "")
                if any(t in ctl for t in _INTERACTABLE):
                    enabled = _safe(lambda: bool(node.IsEnabled), True)
                    off = _safe(lambda: bool(node.IsOffscreen), False)
                    if enabled and not off:
                        r = _safe(lambda: node.BoundingRectangle)
                        bbox = None
                        center = None
                        if r is not None and getattr(r, "left", None) is not None:
                            left, top = int(r.left), int(r.top)
                            right, bottom = int(r.right), int(r.bottom)
                            bbox = {"x": left, "y": top, "w": right - left, "h": bottom - top}
                            center = {"x": (left + right) // 2, "y": (top + bottom) // 2}
                        elements.append({
                            "name": name[:120],
                            "controlType": ctype,
                            "automationId": _safe(lambda: node.AutomationId) or "",
                            "bbox": bbox,
                            "center": center,
                        })
            if depth < 10:
                for c in (_safe(lambda: node.GetChildren()) or []):
                    stack.append((c, depth + 1))
        return {
            "count": len(elements),
            "elements": elements,
            "nodesScanned": scanned,
            "richUia": len(elements) >= 3,
        }
    except Exception as e:
        return {"count": 0, "elements": [], "richUia": False, "error": str(e)}


async def _windows_ocr(png_path: str) -> Optional[Dict[str, Any]]:
    try:
        from winsdk.windows.graphics.imaging import BitmapDecoder
        from winsdk.windows.media.ocr import OcrEngine
        from winsdk.windows.storage import FileAccessMode, StorageFile
    except Exception:
        return None
    try:
        engine = OcrEngine.try_create_from_user_profile_languages()
        if engine is None:
            return None
        storage = await StorageFile.get_file_from_path_async(png_path)
        stream = await storage.open_async(FileAccessMode.READ)
        decoder = await BitmapDecoder.create_async(stream)
        bitmap = await decoder.get_software_bitmap_async()
        result = await engine.recognize_async(bitmap)
        blocks: List[Dict[str, Any]] = []
        for line in result.lines:
            words = list(line.words)
            if not words:
                continue
            left = min(w.bounding_rect.x for w in words)
            top = min(w.bounding_rect.y for w in words)
            right = max(w.bounding_rect.x + w.bounding_rect.width for w in words)
            bottom = max(w.bounding_rect.y + w.bounding_rect.height for w in words)
            blocks.append({
                "text": line.text,
                "bbox": {"x": int(left), "y": int(top), "w": int(right - left), "h": int(bottom - top)},
            })
        return {"engine": "windows.media.ocr", "blocks": blocks, "text": result.text}
    except Exception:
        return None


def _tesseract_ocr(png_path: str) -> Optional[Dict[str, Any]]:
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return None
    try:
        data = pytesseract.image_to_data(Image.open(png_path), output_type=pytesseract.Output.DICT)
    except Exception:
        return None
    blocks: List[Dict[str, Any]] = []
    n = len(data.get("text", []))
    for i in range(n):
        text = (data["text"][i] or "").strip()
        try:
            conf = float(data["conf"][i])
        except Exception:
            conf = -1.0
        if not text or conf < 40:
            continue
        blocks.append({
            "text": text,
            "bbox": {
                "x": int(data["left"][i]),
                "y": int(data["top"][i]),
                "w": int(data["width"][i]),
                "h": int(data["height"][i]),
            },
        })
    return {"engine": "pytesseract", "blocks": blocks, "text": " ".join(b["text"] for b in blocks)}


def run_ocr(png_path: str) -> Dict[str, Any]:
    try:
        win = asyncio.run(_windows_ocr(png_path))
    except Exception:
        win = None
    if win is not None:
        return {"available": True, **win}
    tess = _tesseract_ocr(png_path)
    if tess is not None:
        return {"available": True, **tess}
    return {
        "available": False,
        "engine": None,
        "blocks": [],
        "text": "",
        "reason": "no OCR backend (install winsdk or pytesseract+tesseract)",
    }


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "capture_analyze.py only runs on Windows"}, 2)
        return

    ap = argparse.ArgumentParser(description="Screenshot + UIA structure + OCR")
    ap.add_argument("--out", type=str, required=True, help="PNG output path.")
    ap.add_argument("--pid", type=int, default=None, help="Target window pid. Defaults to foreground.")
    ap.add_argument("--hwnd", type=int, default=None, help="Target window handle.")
    ap.add_argument("--title", type=str, default=None, help="Target window title substring.")
    ap.add_argument("--process-name", type=str, default=None, help="Target process name substring.")
    ap.add_argument("--max-elements", type=int, default=60)
    ap.add_argument("--no-ocr", action="store_true", help="Skip the OCR pass.")
    args = ap.parse_args()

    try:
        target_window = find_target_window(args.hwnd, args.pid, args.title, args.process_name)
        fg = foreground_info()
        selected_pid = args.pid if args.pid is not None else ((target_window or {}).get("pid") or (fg or {}).get("pid"))
        capture = None
        if target_window and target_window.get("handle"):
            capture = capture_window_print(int(target_window["handle"]), args.out)
        if capture is None:
            capture = capture_region(args.out, (target_window or {}).get("rect"))
        structure = extract_elements(target_window, selected_pid, max(5, min(300, args.max_elements)))
        ocr = (
            {"available": False, "engine": None, "blocks": [], "text": "", "reason": "skipped"}
            if args.no_ocr
            else run_ocr(args.out)
        )
        emit({
            "ok": True,
            "mode": "capture_analyze",
            "screenshot": capture,
            "foreground": fg,
            "targetWindow": target_window,
            "elements": structure.get("elements", []),
            "elementCount": structure.get("count", 0),
            "richUia": structure.get("richUia", False),
            "structureError": structure.get("error"),
            "ocr": ocr,
        })
    except SystemExit:
        raise
    except Exception as e:
        emit({"ok": False, "error": f"capture_analyze failed: {e!s}", "trace": traceback.format_exc()[:800]}, 3)


if __name__ == "__main__":
    main()
