"""
win_window.py — Window control via native ctypes (AMSI-safe).

Replaces the bridge's PowerShell `Add-Type` EnumWindows path, which Bitdefender
AMSI blocks. Pure ctypes (EnumWindows / SetForegroundWindow / PostMessage) never
touches a script engine, so AMSI doesn't scan it.

Actions:
  list                        → visible top-level windows {handle,title,pid,process}
  focus  {title?|pid?}        → bring a window to the foreground
  close  {pid?|title?|processName?} → WM_CLOSE matching windows
  launch {target}             → open a URL/path/known app (os.startfile / alias)

Protocol (one JSON on stdout):
  python win_window.py --action list
  python win_window.py --action focus --json '{"title":"YouTube"}'
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from typing import Any, Dict, List, Optional

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
WM_CLOSE = 0x0010
SW_MINIMIZE = 6
SW_RESTORE = 9
SW_SHOW = 5
VK_MENU = 0x12
KEYEVENTF_KEYUP = 0x0002
SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
SPIF_SENDCHANGE = 0x02


# ── Robust foreground activation ─────────────────────────────────────
# Windows blocks a background process (like this bridge, launched from VS Code)
# from stealing the foreground. Defeating it reliably needs several tricks at
# once — no single one is enough on Windows 11: (1) zero the foreground lock
# timeout, (2) a synthetic ALT tap so the OS counts us as "the user pressed a
# key", (3) attach to the current foreground thread's input queue, (4) a
# minimize→restore bounce as a last resort, all retried a few times.

def _get_fg_lock_timeout() -> int:
    val = wintypes.DWORD(0)
    try:
        user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(val), 0)
    except Exception:
        return 0
    return val.value


def _set_fg_lock_timeout(value: int) -> None:
    # For SPI_SETFOREGROUNDLOCKTIMEOUT the new value is passed AS pvParam (cast
    # to a pointer), not via a pointer — one of the SPI exceptions.
    try:
        user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0,
                                     ctypes.c_void_p(value), SPIF_SENDCHANGE)
    except Exception:
        pass


def force_foreground(hwnd, attempts: int = 4) -> bool:
    """Best-effort: make hwnd the foreground window. Returns observed success."""
    saved = _get_fg_lock_timeout()
    _set_fg_lock_timeout(0)
    this_tid = kernel32.GetCurrentThreadId()
    try:
        for i in range(max(1, attempts)):
            if int(user32.GetForegroundWindow()) == int(hwnd):
                break
            user32.keybd_event(VK_MENU, 0, 0, 0)
            user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
            fg = user32.GetForegroundWindow()
            fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
            attached = False
            if fg_tid and fg_tid != this_tid:
                attached = bool(user32.AttachThreadInput(fg_tid, this_tid, True))
            try:
                if user32.IsIconic(hwnd):
                    user32.ShowWindow(hwnd, SW_RESTORE)
                else:
                    user32.ShowWindow(hwnd, SW_SHOW)
                user32.BringWindowToTop(hwnd)
                user32.SetForegroundWindow(hwnd)
                user32.SetActiveWindow(hwnd)
                user32.SetFocus(hwnd)
            finally:
                if attached:
                    user32.AttachThreadInput(fg_tid, this_tid, False)
            if int(user32.GetForegroundWindow()) != int(hwnd) and i >= 1:
                # Bounce: minimize then restore forces activation.
                user32.ShowWindow(hwnd, SW_MINIMIZE)
                user32.ShowWindow(hwnd, SW_RESTORE)
            time.sleep(0.12)
    finally:
        _set_fg_lock_timeout(saved)
    return int(user32.GetForegroundWindow()) == int(hwnd)


def _proc_name(pid: int) -> str:
    if not pid:
        return ""
    h = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return (buf.value or "").rsplit("\\", 1)[-1]
        return ""
    finally:
        kernel32.CloseHandle(h)


def _window_pid(hwnd) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _title(hwnd) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def enum_windows() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            title = _title(hwnd)
            if title.strip():
                pid = _window_pid(hwnd)
                out.append({
                    "handle": int(hwnd),
                    "title": title,
                    "pid": pid,
                    "process": _proc_name(pid),
                })
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def _find(windows: List[Dict[str, Any]], title: Optional[str], pid: Optional[int],
          process: Optional[str]) -> List[Dict[str, Any]]:
    t = (title or "").strip().lower()
    p = (process or "").strip().lower()
    matches = []
    for w in windows:
        if pid is not None and w["pid"] == pid:
            matches.append(w); continue
        if t and t in w["title"].lower():
            matches.append(w); continue
        if p and p in (w["process"] or "").lower():
            matches.append(w)
    return matches


def action_list(_: Dict[str, Any]) -> Dict[str, Any]:
    wins = enum_windows()
    return {"ok": True, "count": len(wins), "windows": wins}


def action_focus(p: Dict[str, Any]) -> Dict[str, Any]:
    # A window just launched (esp. UWP under ApplicationFrameHost) may not be
    # enumerated for a moment — poll briefly instead of failing "no_match".
    wait_ms = int(p.get("waitMs", 2500))
    deadline = time.monotonic() + max(0.0, wait_ms / 1000.0)
    matches: List[Dict[str, Any]] = []
    while True:
        matches = _find(enum_windows(), p.get("title"), p.get("pid"), p.get("processName"))
        if matches or time.monotonic() >= deadline:
            break
        time.sleep(0.25)
    if not matches:
        return {"ok": False, "error": "no_match", "title": p.get("title"),
                "pid": p.get("pid"), "processName": p.get("processName")}
    hwnd = matches[0]["handle"]
    focused = force_foreground(hwnd)
    return {"ok": focused, "action": "focus", "focused": focused,
            "matched": matches[0], "matchCount": len(matches)}


def action_close(p: Dict[str, Any]) -> Dict[str, Any]:
    wins = enum_windows()
    matches = _find(wins, p.get("title"), p.get("pid"), p.get("processName"))
    if not matches:
        return {"ok": False, "error": "no_match"}
    closed = []
    for w in matches:
        user32.PostMessageW(w["handle"], WM_CLOSE, 0, 0)
        closed.append({"handle": w["handle"], "title": w["title"], "pid": w["pid"]})
    return {"ok": True, "action": "close", "closed": closed}


# ── Installed-app enumeration (Start Menu / AppsFolder via COM) ───────
# The AMSI-safe replacement for Get-StartApps. Shell.Application enumerates the
# AppsFolder namespace (UWP + Win32 + PWAs) with Name + AppID. Needs pywin32;
# degrades to {ok:False} when absent.

def list_apps() -> List[Dict[str, str]]:
    import pythoncom  # type: ignore
    import win32com.client  # type: ignore
    pythoncom.CoInitialize()
    shell = win32com.client.Dispatch("Shell.Application")
    folder = shell.NameSpace("shell:AppsFolder")
    apps: List[Dict[str, str]] = []
    for item in folder.Items():
        name = item.Name or ""
        if name:
            apps.append({"name": name, "appId": item.Path or ""})
    return apps


def _rank(apps: List[Dict[str, str]], query: str) -> List[Dict[str, Any]]:
    q = query.strip().lower()
    scored: List[Dict[str, Any]] = []
    for a in apps:
        n = a["name"].lower()
        if n == q:
            s = 0
        elif n.startswith(q):
            s = 1
        elif q in n:
            s = 2
        elif q in a["appId"].lower():
            s = 3
        else:
            continue
        scored.append({**a, "score": s})
    scored.sort(key=lambda x: (x["score"], len(x["name"])))
    return scored


def action_discover(p: Dict[str, Any]) -> Dict[str, Any]:
    query = ""
    for key in ("query", "filter", "target", "application", "appName", "name"):
        v = p.get(key)
        if isinstance(v, str) and v.strip():
            query = v.strip()
            break
    try:
        apps = list_apps()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"appsfolder_unavailable: {e!s}",
                "hint": "pip install pywin32"}
    ranked = _rank(apps, query) if query else [
        {**a, "score": 0} for a in sorted(apps, key=lambda x: x["name"].lower())]
    return {"ok": True, "action": "discover", "query": query or None,
            "count": len(ranked), "apps": ranked[:25]}


# Small alias map for common apps — extend as needed. Values are what
# os.startfile / the shell can resolve (exe on PATH, URL, or shell: target).
LAUNCH_ALIASES = {
    "youtube": "https://www.youtube.com",
    "youtube music": "https://music.youtube.com",
    "spotify": "spotify:",
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "explorer": "explorer.exe",
    "settings": "ms-settings:",
    "edge": "microsoft-edge:",
    "chrome": "chrome.exe",
}


def _wait_new_window(before: set, hint: str, timeout: float) -> Optional[Dict[str, Any]]:
    """Poll for a NEW titled top-level window after a launch. Prefers one whose
    title matches `hint` (the app name); falls back to the first new window
    (handles localized titles, e.g. Calculator→'Calculadora')."""
    h = (hint or "").strip().lower()
    deadline = time.monotonic() + max(0.5, timeout)
    best: Optional[Dict[str, Any]] = None
    while time.monotonic() < deadline:
        for w in enum_windows():
            if w["handle"] in before or not w["title"].strip():
                continue
            if h and h in w["title"].lower():
                return w
            if best is None:
                best = w
        if best is not None and not h:
            return best
        time.sleep(0.3)
    return best


def action_launch(p: Dict[str, Any]) -> Dict[str, Any]:
    target = ""
    for key in ("target", "application", "appName", "app", "name", "url"):
        v = p.get(key)
        if isinstance(v, str) and v.strip():
            target = v.strip()
            break
    if not target:
        return {"ok": False, "error": "target_required"}
    via = "alias_or_literal"
    resolved = LAUNCH_ALIASES.get(target.lower())
    if resolved is None:
        # No alias — if it's not obviously a URL/scheme/path, try to resolve it
        # to an installed app and launch by AppID (shell:AppsFolder\<AppID>).
        looks_direct = ("://" in target or target.lower().endswith(".exe")
                        or ":\\" in target or target.endswith(":"))
        if not looks_direct:
            try:
                ranked = _rank(list_apps(), target)
                if ranked:
                    resolved = "shell:AppsFolder\\" + ranked[0]["appId"]
                    via = f"appsfolder:{ranked[0]['name']}"
            except Exception:
                resolved = None
        if resolved is None:
            resolved = target
    # Snapshot windows so we can detect the NEW one the launch creates and
    # bring it to the foreground — otherwise a UWP app opens behind VS Code and
    # every downstream inspect/input acts on the wrong (still-foreground) window.
    wait = p.get("waitForWindow", True)
    before = {w["handle"] for w in enum_windows()} if wait else set()
    try:
        os.startfile(resolved)  # ShellExecute — AMSI-safe, no PowerShell
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"launch_failed: {e!s}", "target": target, "resolved": resolved}

    result: Dict[str, Any] = {"ok": True, "action": "launch", "target": target,
                              "resolved": resolved, "via": via}
    if wait:
        timeout = float(p.get("timeoutMs", 8000)) / 1000.0
        is_url = "://" in resolved or resolved.endswith(":")
        hint = p.get("expectTitle") or ("" if is_url else target)
        win = _wait_new_window(before, hint, timeout)
        if win:
            result["window"] = win
            result["focused"] = force_foreground(win["handle"])
        else:
            result["window"] = None
            result["focused"] = None
            result["note"] = "no new top-level window detected (may have reused one)"
    return result


ACTIONS = {
    "list": action_list,
    "focus": action_focus,
    "close": action_close,
    "launch": action_launch,
    "discover": action_discover,
}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        print(json.dumps({"ok": False, "error": "win_window.py only runs on Windows"}))
        sys.exit(2)

    ap = argparse.ArgumentParser(description="Lumina native window control")
    ap.add_argument("--action", required=True, choices=sorted(ACTIONS.keys()))
    ap.add_argument("--json", default="{}")
    args = ap.parse_args()

    try:
        params = json.loads(args.json) if args.json else {}
        if not isinstance(params, dict):
            params = {}
    except Exception:
        print(json.dumps({"ok": False, "error": "invalid --json params"}))
        sys.exit(2)

    try:
        print(json.dumps(ACTIONS[args.action](params), ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "action": args.action, "error": f"{type(e).__name__}: {e!s}"}))


if __name__ == "__main__":
    main()
