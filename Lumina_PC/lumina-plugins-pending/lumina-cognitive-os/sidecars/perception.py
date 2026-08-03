"""
perception.py — Continuous screen perception sidecar for Lumina.

Runs as a long-lived subprocess. Captures the primary monitor at a tunable
rate (default 2 Hz), computes a perceptual hash, and emits one NDJSON
event per *meaningful* change to stdout. Quiet otherwise — no event when
the screen hasn't moved.

Also maintains a latest-state JSON cache so the rest of Lumina can consume
fresh foreground/frame data even without subscribing to the live event bus.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional


def emit(payload: Dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def now_iso() -> str:
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def write_latest(path: Optional[Path], payload: Dict[str, Any]) -> None:
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def check_health() -> None:
    try:
        import mss  # noqa: F401
        import PIL  # noqa: F401
    except ImportError as e:
        emit({"ok": False, "ready": False, "error": f"missing dep: {e!s}"})
        sys.exit(0)
    emit({"ok": True, "ready": True})


def get_foreground_window() -> Optional[Dict[str, Any]]:
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value or ""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h_proc = kernel32.OpenProcess(0x0410, False, pid.value)
        process = ""
        if h_proc:
            try:
                exe_buf = ctypes.create_unicode_buffer(260)
                if psapi.GetModuleBaseNameW(h_proc, None, exe_buf, 260):
                    process = exe_buf.value or ""
            finally:
                kernel32.CloseHandle(h_proc)
        return {"process": process.lower(), "title": title, "pid": pid.value}
    except Exception:
        return None


def downsample_pixels(rgb_bytes: bytes, width: int, height: int, target_w: int = 64, target_h: int = 36) -> bytes:
    if width <= 0 or height <= 0:
        return b""
    out = bytearray(target_w * target_h)
    for y in range(target_h):
        sy = (y * height) // target_h
        for x in range(target_w):
            sx = (x * width) // target_w
            i = (sy * width + sx) * 3
            if i + 2 < len(rgb_bytes):
                out[y * target_w + x] = (rgb_bytes[i] + rgb_bytes[i + 1] + rgb_bytes[i + 2]) // 3
    return bytes(out)


def diff_ratio(a: bytes, b: bytes, threshold: int = 16) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 1.0
    changed = 0
    for i in range(n):
        if abs(a[i] - b[i]) > threshold:
            changed += 1
    return changed / n


# ── Semantic vision ─────────────────────────────────────────────────────────
# The raw loop above only sees *motion* + which app is in front. To let Lumina
# actually SEE — know the buttons/fields she can act on — we resolve the
# foreground window's UI Automation tree (via the existing uia_tree.py sidecar,
# a fresh process = clean STA COM) whenever the app or screen changes, and keep
# the actionable elements in latest-state so any command acts on current sight.
import subprocess

_SIDECAR_DIR = Path(__file__).resolve().parent
_UIA_SIDECAR = _SIDECAR_DIR / "uia_tree.py"
_INTERACTABLE = (
    "button", "hyperlink", "menuitem", "tabitem", "listitem", "treeitem",
    "checkbox", "radiobutton", "splitbutton", "combobox", "edit", "slider",
    "text", "document", "menu",
)


def _safe_attr(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def extract_foreground_semantics(pid: Optional[int], max_elements: int = 40) -> Optional[Dict[str, Any]]:
    """Return the actionable UIA elements of the foreground window (or None).

    Done IN-PROCESS via `uiautomation` (not a nested subprocess) — the daemon is
    a Windows python spawned by the WSL gateway, and re-spawning a child Windows
    python from there breaks on path/env translation. GetForegroundControl()
    resolves the *actual* focused tree, including UWP apps hosted under
    ApplicationFrameHost. Native apps give a rich tree; Chromium/UWP web apps
    give little (richUia=False) → those fall back to the visual/OmniParser lane.
    """
    try:
        import uiautomation as auto
    except Exception:
        return None
    try:
        root = auto.GetForegroundControl()
        if root is None:
            return None
        elements: list = []
        stack = [(root, 0)]
        scanned = 0
        while stack and len(elements) < max_elements and scanned < 400:
            node, depth = stack.pop()
            scanned += 1
            name = (_safe_attr(lambda: node.Name) or "").strip()
            ct = _safe_attr(lambda: node.ControlTypeName) or ""
            if name:
                ctl = ct.lower().replace("control", "")
                if any(t in ctl for t in _INTERACTABLE):
                    enabled = _safe_attr(lambda: bool(node.IsEnabled), True)
                    off = _safe_attr(lambda: bool(node.IsOffscreen), False)
                    if enabled and not off:
                        r = _safe_attr(lambda: node.BoundingRectangle)
                        center = None
                        if r is not None and getattr(r, "left", None) is not None:
                            center = {"x": (int(r.left) + int(r.right)) // 2,
                                      "y": (int(r.top) + int(r.bottom)) // 2}
                        elements.append({
                            "name": name[:80],
                            "controlType": ct,
                            "automationId": _safe_attr(lambda: node.AutomationId) or "",
                            "center": center,
                        })
            if depth < 8:
                for c in (_safe_attr(lambda: node.GetChildren()) or []):
                    stack.append((c, depth + 1))
        return {
            "count": len(elements),
            "elements": elements,
            "nodesScanned": scanned,
            "richUia": len(elements) >= 3,
        }
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Lumina perception sidecar")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--threshold", type=float, default=0.01)
    ap.add_argument("--out-dir", type=str, default="")
    ap.add_argument("--save-frames", action="store_true")
    ap.add_argument("--heartbeat-sec", type=float, default=30.0)
    ap.add_argument("--latest-state", type=str, default=os.environ.get("LUMINA_PERCEPTION_LATEST_STATE", ""))
    ap.add_argument("--health", action="store_true")
    args = ap.parse_args()

    if args.health:
        check_health()
        return

    try:
        import mss
        from PIL import Image
    except ImportError as e:
        emit({"kind": "error", "atISO": now_iso(), "message": f"missing dep {e!s}; install: pip install mss pillow"})
        sys.exit(2)

    out_dir = Path(args.out_dir or (os.environ.get("TEMP", "/tmp") + "/lumina-perception"))
    latest_state_path = Path(args.latest_state) if args.latest_state else (out_dir / "latest-state.json")
    if args.save_frames:
        out_dir.mkdir(parents=True, exist_ok=True)
    else:
        latest_state_path.parent.mkdir(parents=True, exist_ok=True)

    state = {
        "fps": max(0.5, min(10.0, args.fps)),
        "threshold": max(0.001, min(0.5, args.threshold)),
        "paused": False,
        "shutdown": False,
        "heartbeat_sec": max(5.0, args.heartbeat_sec),
    }

    latest_payload: Dict[str, Any] = {
        "ok": True,
        "atISO": now_iso(),
        "seq": 0,
        "changedRatio": 0.0,
        "framePath": "",
        "size": None,
        "foreground": None,
        "fps": state["fps"],
        "threshold": state["threshold"],
        "paused": False,
    }
    write_latest(latest_state_path, latest_payload)

    def stdin_listener() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            cmd = msg.get("cmd")
            if cmd == "set_fps":
                state["fps"] = max(0.5, min(10.0, float(msg.get("fps", state["fps"]))))
            elif cmd == "set_threshold":
                state["threshold"] = max(0.001, min(0.5, float(msg.get("r", state["threshold"]))))
            elif cmd == "pause":
                state["paused"] = True
            elif cmd == "resume":
                state["paused"] = False
            elif cmd == "shutdown":
                state["shutdown"] = True
                return

    threading.Thread(target=stdin_listener, daemon=True).start()

    emit({"kind": "start", "atISO": now_iso(), "fps": state["fps"], "monitor": 1, "threshold": state["threshold"]})

    prev_thumb: bytes = b""
    last_event_ts = time.time()
    last_foreground: Optional[str] = None
    seq = 0
    # Semantic model of the current app (refreshed on change, throttled).
    last_semantics: Optional[Dict[str, Any]] = None
    last_semantics_ts = 0.0
    last_semantics_iso = ""
    SEM_MIN_INTERVAL = 1.0

    try:
        with mss.mss() as sct:
            mon = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            while not state["shutdown"]:
                if state["paused"]:
                    latest_payload["paused"] = True
                    latest_payload["atISO"] = now_iso()
                    write_latest(latest_state_path, latest_payload)
                    time.sleep(0.2)
                    continue
                t0 = time.time()
                try:
                    raw = sct.grab(mon)
                except Exception as e:
                    emit({"kind": "error", "atISO": now_iso(), "message": f"capture: {e!s}"})
                    time.sleep(1.0)
                    continue
                rgb = bytearray(raw.width * raw.height * 3)
                bgra = raw.bgra
                for px in range(raw.width * raw.height):
                    b = bgra[px * 4]
                    g = bgra[px * 4 + 1]
                    r = bgra[px * 4 + 2]
                    rgb[px * 3] = r
                    rgb[px * 3 + 1] = g
                    rgb[px * 3 + 2] = b
                thumb = downsample_pixels(bytes(rgb), raw.width, raw.height)

                ratio = diff_ratio(thumb, prev_thumb) if prev_thumb else 1.0
                frame_path = latest_payload.get("framePath", "") or ""
                emitted_frame = False
                if ratio >= state["threshold"]:
                    seq += 1
                    path = ""
                    if args.save_frames:
                        try:
                            img = Image.frombytes("RGB", (raw.width, raw.height), bytes(rgb))
                            path = str(out_dir / f"frame-{seq:06d}.png")
                            img.save(path, "PNG", optimize=False)
                        except Exception:
                            path = ""
                    frame_path = path
                    emit({
                        "kind": "frame",
                        "atISO": now_iso(),
                        "seq": seq,
                        "changedRatio": round(ratio, 4),
                        "path": path,
                        "size": [raw.width, raw.height],
                    })
                    emitted_frame = True
                    last_event_ts = time.time()
                prev_thumb = thumb

                fg = get_foreground_window()
                fg_changed = False
                if fg is not None:
                    fg_key = f"{fg.get('process','')}::{fg.get('title','')[:80]}"
                    if fg_key != last_foreground:
                        fg_changed = True
                        emit({
                            "kind": "foreground",
                            "atISO": now_iso(),
                            "process": fg.get("process", ""),
                            "title": fg.get("title", ""),
                            "pid": fg.get("pid", 0),
                        })
                        last_foreground = fg_key
                        last_event_ts = time.time()

                # Refresh the actionable UIA model when the app or screen changed
                # (throttled), so latest-state always carries current sight.
                if fg is not None and (fg_changed or emitted_frame):
                    if (time.time() - last_semantics_ts) >= SEM_MIN_INTERVAL:
                        sem = extract_foreground_semantics(fg.get("pid"))
                        if sem is not None:
                            last_semantics = sem
                            last_semantics_ts = time.time()
                            last_semantics_iso = now_iso()
                            if fg_changed or sem.get("count"):
                                emit({
                                    "kind": "semantics",
                                    "atISO": last_semantics_iso,
                                    "process": fg.get("process", ""),
                                    "elementCount": sem.get("count", 0),
                                    "richUia": sem.get("richUia", False),
                                })

                latest_payload = {
                    "ok": True,
                    "atISO": now_iso(),
                    "seq": seq,
                    "changedRatio": round(ratio, 4),
                    "framePath": frame_path,
                    "size": [raw.width, raw.height],
                    "foreground": fg,
                    "elements": last_semantics.get("elements") if last_semantics else None,
                    "elementCount": last_semantics.get("count", 0) if last_semantics else 0,
                    "richUia": last_semantics.get("richUia", False) if last_semantics else False,
                    "elementsAtISO": last_semantics_iso,
                    "fps": state["fps"],
                    "threshold": state["threshold"],
                    "paused": False,
                }
                write_latest(latest_state_path, latest_payload)

                if not emitted_frame:
                    quiet = time.time() - last_event_ts
                    if quiet >= state["heartbeat_sec"]:
                        emit({"kind": "heartbeat", "atISO": now_iso(), "quietForSec": int(quiet)})
                        last_event_ts = time.time()

                elapsed = time.time() - t0
                wait = max(0.0, (1.0 / max(0.5, state["fps"])) - elapsed)
                if wait > 0:
                    time.sleep(wait)
    except Exception as e:
        emit({"kind": "error", "atISO": now_iso(), "message": f"loop: {e!s}", "trace": traceback.format_exc()[:500]})
        sys.exit(3)
    finally:
        latest_payload["atISO"] = now_iso()
        latest_payload["paused"] = True
        write_latest(latest_state_path, latest_payload)
        emit({"kind": "shutdown", "atISO": now_iso()})


if __name__ == "__main__":
    main()
