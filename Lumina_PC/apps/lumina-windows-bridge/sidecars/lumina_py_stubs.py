"""
lumina_py_stubs.py — Python facade over a SAFE SUBSET of Lumina tools.

When the agent runs in "CodeAct" mode (LLM-writes-Python-instead-of-
JSON-tool-calls), it `import lumina_py_stubs as lumina` and calls
functions like `lumina.screen_capture()` or `lumina.clipboard_get()`.
Each function makes an HTTP request to the Lumina Windows Bridge
(http://127.0.0.1:8765 by default) and returns the JSON response.

Only a READ-MOSTLY / observation subset is exposed here, NOT:
   - input_control (synthetic keyboard/mouse) — needs Risk approval
   - shell exec, code_execute, alarms_create, file_ops — also gated
   - skills_run / workflow_run — orchestration belongs to the host agent

This deliberate restriction is what makes CodeAct safe to enable: even
if the LLM goes off-rails, it can READ but not push side-effects beyond
displaying toasts and reading the clipboard.

Env vars (read at import time):
   LUMINA_BRIDGE_URL          default http://127.0.0.1:8765
   LUMINA_PY_STUBS_TIMEOUT_S  default 8
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

BRIDGE_URL = os.environ.get("LUMINA_BRIDGE_URL", "http://127.0.0.1:8765").rstrip("/")
DEFAULT_TIMEOUT = float(os.environ.get("LUMINA_PY_STUBS_TIMEOUT_S", "8"))


class LuminaError(RuntimeError):
    pass


def _request(method: str, path: str, payload: Optional[Dict[str, Any]] = None,
             timeout: Optional[float] = None) -> Dict[str, Any]:
    url = f"{BRIDGE_URL}{path}"
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout or DEFAULT_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise LuminaError(f"HTTP {e.code} on {url}: {body[:200]}") from None
    except urllib.error.URLError as e:
        raise LuminaError(f"Bridge unreachable at {url}: {e.reason}") from None
    if not body.strip():
        return {"ok": True, "raw": ""}
    try:
        return json.loads(body)
    except Exception as e:
        return {"ok": False, "raw": body[:400], "parseError": str(e)}


# ── Health / inspection ──────────────────────────────────────────────

def health() -> Dict[str, Any]:
    """Returns the Bridge health JSON. Always cheap."""
    return _request("GET", "/health")


def processes() -> Dict[str, Any]:
    """List Windows processes (Name, Pid, CPU, WorkingSet)."""
    return _request("GET", "/processes", timeout=20)


def logs() -> Dict[str, Any]:
    """Tail the Bridge audit log."""
    return _request("GET", "/logs")


def camera_devices() -> Dict[str, Any]:
    """List camera/imaging PnP devices and their status."""
    return _request("GET", "/camera_devices", timeout=20)


# ── Clipboard ────────────────────────────────────────────────────────

def clipboard_get() -> str:
    """Return current Windows clipboard text (empty string if not text)."""
    r = _request("POST", "/clipboard", {"action": "get"})
    return r.get("text", "") if isinstance(r, dict) else ""


def clipboard_set(text: str) -> Dict[str, Any]:
    """Set Windows clipboard text."""
    return _request("POST", "/clipboard", {"action": "set", "text": text})


# ── Window observation ──────────────────────────────────────────────

def window_list() -> Dict[str, Any]:
    """List visible top-level Windows with title + pid + process name."""
    return _request("POST", "/window_control", {"action": "list"}, timeout=20)


def window_focus(title: str) -> Dict[str, Any]:
    """Bring a window matching `title` to the foreground."""
    return _request("POST", "/window_control", {"action": "focus", "title": title})


def window_launch(application: str) -> Dict[str, Any]:
    """Launch one of the Bridge's predefined applications (browser, chrome,
    spotify, vscode, notepad, calculator, explorer, settings, terminal,
    powershell, cmd)."""
    return _request("POST", "/window_control", {"action": "launch", "application": application})


# ── Screen capture (returns a path to a PNG on disk) ───────────────

def screen_capture() -> Dict[str, Any]:
    """Capture the full virtual screen to a PNG and return the file path.
    The agent can then read the file with a Python `open(...)` for
    base64-encoding, OCR, etc."""
    return _request("POST", "/screenshot", timeout=30)


# ── Notifications ────────────────────────────────────────────────────

def notify_toast(title: str, message: str) -> Dict[str, Any]:
    """Display a Windows toast notification. Side-effect but harmless."""
    return _request("POST", "/notify_toast", {"title": title, "message": message})


# ── Helpers: structured "FINAL" emitter and observation summary ───

def final(value: Any) -> None:
    """Print a sentinel that the CodeAct loop will detect to stop and
    use `value` as the final answer to the user."""
    print("CODEACT_FINAL:" + json.dumps(value, ensure_ascii=False))


def observation(value: Any) -> None:
    """Print a structured observation block visible to the next LLM turn."""
    print("CODEACT_OBSERVATION:" + json.dumps(value, ensure_ascii=False))


# When the LLM does `import lumina_py_stubs` as the first line, this header
# is printed once so the human reader of the transcript can confirm which
# Bridge the stubs are talking to.
def _banner() -> None:
    if os.environ.get("LUMINA_PY_STUBS_BANNER") != "0":
        print(f"# lumina_py_stubs ready (bridge={BRIDGE_URL})", file=sys.stderr)


_banner()
