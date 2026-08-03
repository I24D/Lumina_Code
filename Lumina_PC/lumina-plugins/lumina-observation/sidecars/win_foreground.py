"""
win_foreground.py — AMSI-safe foreground-window probe (pure ctypes).

Reports the active window's title + owning process. Kept separate from any
input-idle probe so this (benign) capability is never quarantined alongside
the input-monitoring API that Bitdefender flags.

Output: {"ok": true, "foreground": {"title": "...", "processName": "chrome", "processId": 1234}}
"""

import ctypes
import json
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

TITLE_CAP = 240
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]

kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def process_name(pid: int) -> str:
    if not pid:
        return ""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        base = buf.value.replace("\\", "/").split("/")[-1]
        if base.lower().endswith(".exe"):
            base = base[:-4]
        return base
    finally:
        kernel32.CloseHandle(handle)


def foreground():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    length = user32.GetWindowTextLengthW(hwnd)
    title = ""
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value[:TITLE_CAP]
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "title": title,
        "processName": process_name(pid.value),
        "processId": int(pid.value),
    }


def main() -> None:
    try:
        print(json.dumps({"ok": True, "foreground": foreground()}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
