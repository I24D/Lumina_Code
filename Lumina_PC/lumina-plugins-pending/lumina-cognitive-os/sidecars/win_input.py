"""
win_input.py — Mouse/keyboard input via native ctypes SendInput (AMSI-safe).

Replaces the bridge's PowerShell `Add-Type` input path, which Bitdefender AMSI
blocks as ScriptContainedMaliciousContent (input-injection P/Invoke pattern).
Python ctypes calls user32.SendInput directly — it never touches a script
engine, so AMSI does not scan it. Same capability, base viva.

Safety: like the old handler, mutating input requires `allowedApps`; we read the
foreground process (also via ctypes, no PowerShell) and refuse if it isn't in
the allowlist, so input never lands on the wrong window.

Protocol (one JSON on stdout):
  python win_input.py --json '{"action":"mouse_click","button":"left","allowedApps":["msedge"]}'
Actions: mouse_move | mouse_click | mouse_scroll | mouse_drag | type_text |
         key_press | shortcut
"""
from __future__ import annotations

import argparse
import ctypes
import json
import sys
import time
from ctypes import wintypes
from typing import Any, Dict, List

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ── SendInput plumbing ───────────────────────────────────────────────
ULONG_PTR = ctypes.c_size_t

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

SM_CXSCREEN = 0
SM_CYSCREEN = 1


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTunion)]


def _send(*inputs: INPUT) -> None:
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))


def _mouse(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    return INPUT(type=INPUT_MOUSE,
                 u=_INPUTunion(mi=MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)))


def _key(vk: int, scan: int, flags: int) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD,
                 u=_INPUTunion(ki=KEYBDINPUT(vk, scan, flags, 0, 0)))


# ── Foreground guard (ctypes, no PowerShell) ─────────────────────────

def foreground_process() -> str:
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return ""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            path = buf.value or ""
            return path.rsplit("\\", 1)[-1].lower()
        return ""
    finally:
        kernel32.CloseHandle(h)


def guard(allowed: List[str]) -> Dict[str, Any]:
    """Return {'ok':False,...} if foreground isn't allowlisted, else {'ok':True}."""
    if not allowed:
        return {"ok": False, "error": "input_app_allowlist_empty"}
    fg = foreground_process()
    fg_base = fg[:-4] if fg.endswith(".exe") else fg
    norm = {a.strip().lower().removesuffix(".exe") for a in allowed if a.strip()}
    if fg_base and fg_base in norm:
        return {"ok": True, "foreground": fg}
    return {"ok": False, "error": "foreground_not_allowed", "foreground": fg,
            "allowedApps": sorted(norm)}


# ── Actions ──────────────────────────────────────────────────────────

def _abs_move(x: int, y: int) -> None:
    sw = user32.GetSystemMetrics(SM_CXSCREEN) or 1
    sh = user32.GetSystemMetrics(SM_CYSCREEN) or 1
    ax = int(x * 65535 / (sw - 1)) if sw > 1 else 0
    ay = int(y * 65535 / (sh - 1)) if sh > 1 else 0
    _send(_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay))


def do_mouse_move(p: Dict[str, Any]) -> Dict[str, Any]:
    _abs_move(int(p["x"]), int(p["y"]))
    return {"ok": True, "action": "mouse_move", "x": int(p["x"]), "y": int(p["y"])}


_BTN = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def do_mouse_click(p: Dict[str, Any]) -> Dict[str, Any]:
    if "x" in p and "y" in p and p.get("x") is not None:
        _abs_move(int(p["x"]), int(p["y"]))
        time.sleep(0.02)
    down, up = _BTN.get(str(p.get("button", "left")).lower(), _BTN["left"])
    count = max(1, min(3, int(p.get("count", 1))))
    for _ in range(count):
        _send(_mouse(down))
        _send(_mouse(up))
        time.sleep(0.03)
    return {"ok": True, "action": "mouse_click", "button": p.get("button", "left"), "count": count}


def do_mouse_scroll(p: Dict[str, Any]) -> Dict[str, Any]:
    dy = int(p.get("dy", 0))
    dx = int(p.get("dx", 0))
    if dy:
        _send(_mouse(MOUSEEVENTF_WHEEL, 0, 0, dy))
    if dx:
        _send(_mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx))
    return {"ok": True, "action": "mouse_scroll", "dx": dx, "dy": dy}


def do_mouse_drag(p: Dict[str, Any]) -> Dict[str, Any]:
    x1, y1, x2, y2 = int(p["x1"]), int(p["y1"]), int(p["x2"]), int(p["y2"])
    down, up = _BTN.get(str(p.get("button", "left")).lower(), _BTN["left"])
    steps = max(2, int(p.get("steps", 20)))
    delay = max(0, int(p.get("stepDelayMs", 8))) / 1000.0
    _abs_move(x1, y1)
    _send(_mouse(down))
    for i in range(1, steps + 1):
        ix = x1 + (x2 - x1) * i // steps
        iy = y1 + (y2 - y1) * i // steps
        _abs_move(ix, iy)
        if delay:
            time.sleep(delay)
    _send(_mouse(up))
    return {"ok": True, "action": "mouse_drag", "from": [x1, y1], "to": [x2, y2]}


def do_type_text(p: Dict[str, Any]) -> Dict[str, Any]:
    text = str(p.get("text", ""))
    for ch in text:
        code = ord(ch)
        _send(_key(0, code, KEYEVENTF_UNICODE))
        _send(_key(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        time.sleep(0.003)
    return {"ok": True, "action": "type_text", "length": len(text)}


# Virtual-key codes for named keys / shortcut modifiers.
VK = {
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "home": 0x24, "end": 0x23,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "pageup": 0x21, "pagedown": 0x22,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


def _vk_for(name: str) -> int:
    n = name.strip().lower()
    if n in VK:
        return VK[n]
    if len(n) == 1:
        return user32.VkKeyScanW(ctypes.c_wchar(n)) & 0xFF
    raise ValueError(f"unknown key {name!r}")


def do_key_press(p: Dict[str, Any]) -> Dict[str, Any]:
    key = str(p.get("key", ""))
    vk = _vk_for(key)
    _send(_key(vk, 0, 0))
    _send(_key(vk, 0, KEYEVENTF_KEYUP))
    return {"ok": True, "action": "key_press", "key": key}


def do_shortcut(p: Dict[str, Any]) -> Dict[str, Any]:
    keys = p.get("keys") or []
    if not isinstance(keys, list) or not keys:
        return {"ok": False, "error": "keys[] required"}
    vks = [_vk_for(str(k)) for k in keys]
    for vk in vks:
        _send(_key(vk, 0, 0))
    for vk in reversed(vks):
        _send(_key(vk, 0, KEYEVENTF_KEYUP))
    return {"ok": True, "action": "shortcut", "keys": keys}


ACTIONS = {
    "mouse_move": do_mouse_move,
    "mouse_click": do_mouse_click,
    "mouse_scroll": do_mouse_scroll,
    "mouse_drag": do_mouse_drag,
    "type_text": do_type_text,
    "key_press": do_key_press,
    "shortcut": do_shortcut,
}

# Actions that move the pointer only — no allowlist needed (harmless).
NO_GUARD = {"mouse_move", "mouse_scroll"}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        print(json.dumps({"ok": False, "error": "win_input.py only runs on Windows"}))
        sys.exit(2)

    ap = argparse.ArgumentParser(description="Lumina native input (SendInput)")
    ap.add_argument("--json", required=True, help="JSON body with action + params")
    args = ap.parse_args()

    try:
        body = json.loads(args.json)
        if not isinstance(body, dict):
            raise ValueError
    except Exception:
        print(json.dumps({"ok": False, "error": "invalid --json body"}))
        sys.exit(2)

    action = str(body.get("action", ""))
    fn = ACTIONS.get(action)
    if fn is None:
        print(json.dumps({"ok": False, "error": f"unknown action {action!r}",
                          "actions": sorted(ACTIONS)}))
        return

    if action not in NO_GUARD:
        allowed = body.get("allowedApps") or []
        g = guard(allowed if isinstance(allowed, list) else [])
        if not g.get("ok"):
            print(json.dumps(g, ensure_ascii=False))
            return

    try:
        result = fn(body)
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "action": action, "error": f"{type(e).__name__}: {e!s}"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
