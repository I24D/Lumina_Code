"""
uia_tree.py — Windows UI Automation tree extractor + element resolver.

Two modes:
  1. Walk mode (default) — returns the JSON tree of interactable elements
     of the foreground window (or a given --pid). Used by
     `lumina_vision_ui_tree`.

  2. Find mode (--find "Save") — fuzzy-matches a natural-language query
     against the same tree and returns the top-N candidates ranked by
     score, each with bbox + center coordinates ready for SetCursorPos /
     mouse_click. Used by `lumina_vision_ui_resolve` so Lumina can go
     from "haz click en el botón Guardar" directly to (x,y) without OCR.

Requirements: pip install uiautomation
If `uiautomation` is missing or the platform is not Windows, the script
exits 2 with a structured error so the TS caller can degrade gracefully.

Invocation:
  python uia_tree.py [--pid <PID>] [--max-depth N] [--max-nodes N]
  python uia_tree.py --find "Guardar" [--control-type Button] [--max-matches 5]

Output: JSON to stdout.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import re
import sys
import time
import traceback
import unicodedata
from ctypes import wintypes
from typing import Any, Dict, List, Optional, Tuple


def fail(reason: str, code: int = 2) -> None:
    json.dump({"ok": False, "error": reason}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="UIA tree extractor + resolver")
    p.add_argument("--pid", type=int, default=None,
                   help="Process id whose top-level window to walk. Defaults to foreground.")
    p.add_argument("--hwnd", type=int, default=None,
                   help="Top-level window handle to walk.")
    p.add_argument("--title", type=str, default=None,
                   help="Top-level window title substring to walk.")
    p.add_argument("--process-name", type=str, default=None,
                   help="Top-level process name substring to walk.")
    p.add_argument("--max-depth", type=int, default=6)
    p.add_argument("--max-nodes", type=int, default=400)
    p.add_argument("--find", type=str, default=None,
                   help="Natural-language query to resolve to UI element(s).")
    p.add_argument("--control-type", type=str, default=None,
                   help="Optional ControlType filter (Button, Edit, Hyperlink, ...).")
    p.add_argument("--max-matches", type=int, default=5,
                   help="Max candidates to return in --find mode.")
    # Invoke mode — act on an element by identity via native UIA patterns
    # (Invoke/Value/Toggle/SelectionItem), which works even when the element
    # is off-screen or its window is not foreground, unlike coordinate clicks.
    p.add_argument("--invoke", action="store_true",
                   help="Act on an element via UIA patterns instead of returning it.")
    p.add_argument("--automation-id", type=str, default=None,
                   help="Match target by AutomationId (preferred, exact).")
    p.add_argument("--name", type=str, default=None,
                   help="Match target by Name when no automationId.")
    p.add_argument("--action", type=str, default="invoke",
                   help="invoke | click | set_value | toggle | select | focus")
    p.add_argument("--value", type=str, default=None,
                   help="Text for --action set_value.")
    p.add_argument("--name-match", type=str, default="contains",
                   help="contains | exact (how --name is matched)")
    p.add_argument("--fuzzy", action="store_true",
                   help="In --invoke: if no contains/exact match, fall back to "
                        "token-scored fuzzy resolution of --name (e.g. 'Sandra' "
                        "matches 'Sandra Patricia').")
    p.add_argument("--then-press", type=str, default=None,
                   help="In --invoke: after acting, focus the element and send a "
                        "key. One of enter | tab | escape. Used to submit a "
                        "message when the Send button is not in the UIA tree.")
    p.add_argument("--pre-wait", type=float, default=0.0,
                   help="In --invoke: poll up to N seconds for the target element "
                        "to appear before acting (avoids load races).")
    # Wait mode — poll the foreground (or --pid) tree until a target element
    # appears (or times out). Lets Lumina wait for a slow-loading button before
    # acting, instead of firing blind and failing. Reuses --find / --name /
    # --automation-id / --control-type as the selector.
    p.add_argument("--wait", action="store_true",
                   help="Poll until the selector matches an element or timeout.")
    p.add_argument("--timeout", type=float, default=8.0,
                   help="Max seconds to wait in --wait mode.")
    p.add_argument("--interval", type=float, default=0.4,
                   help="Seconds between polls in --wait mode.")
    return p.parse_args()


def safe(attr_call) -> Any:
    try:
        return attr_call()
    except Exception:
        return None


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
        return {
            "handle": hwnd,
            "title": _window_title(hwnd),
            "pid": _window_pid(hwnd),
            "process": _proc_name(_window_pid(hwnd)),
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


def walk(node, depth: int, args, collected: List[Dict[str, Any]]) -> None:
    if len(collected) >= args.max_nodes:
        return
    name = safe(lambda: node.Name) or ""
    automation_id = safe(lambda: node.AutomationId) or ""
    control_type = safe(lambda: node.ControlTypeName) or ""
    class_name = safe(lambda: node.ClassName) or ""
    rect = safe(lambda: node.BoundingRectangle)
    bbox: Optional[Dict[str, int]] = None
    center: Optional[Dict[str, int]] = None
    if rect and getattr(rect, "left", None) is not None:
        left, top, right, bottom = int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
        bbox = {"x": left, "y": top, "w": right - left, "h": bottom - top}
        center = {"x": (left + right) // 2, "y": (top + bottom) // 2}
    is_enabled = safe(lambda: bool(node.IsEnabled))
    is_offscreen = safe(lambda: bool(node.IsOffscreen))
    value = safe(lambda: node.CurrentValue) if hasattr(node, "CurrentValue") else None

    entry: Dict[str, Any] = {
        "depth": depth,
        "name": str(name)[:160],
        "automationId": str(automation_id)[:80],
        "controlType": str(control_type)[:60],
        "className": str(class_name)[:80],
        "bbox": bbox,
        "center": center,
        "enabled": is_enabled if is_enabled is not None else True,
        "offscreen": is_offscreen if is_offscreen is not None else False,
    }
    if value is not None:
        entry["value"] = str(value)[:240]
    collected.append(entry)

    if depth >= args.max_depth:
        return
    children = safe(lambda: node.GetChildren()) or []
    for c in children:
        walk(c, depth + 1, args, collected)


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip().lower()


CLICKABLE_TYPES = {
    "button", "hyperlink", "menuitem", "tabitem", "listitem",
    "treeitem", "checkbox", "radiobutton", "splitbutton", "image",
}
EDITABLE_TYPES = {"edit", "document", "combobox"}


def score_node(node: Dict[str, Any], query_norm: str, want_type: Optional[str]) -> float:
    """0..1 score for how well node matches the natural-language query."""
    if not node.get("enabled", True) or node.get("offscreen", False):
        return 0.0
    if not node.get("bbox") or not node.get("center"):
        return 0.0
    name = normalize(node.get("name", ""))
    aid = normalize(node.get("automationId", ""))
    klass = normalize(node.get("className", ""))
    ctype_raw = (node.get("controlType") or "").lower().replace("controltype", "")
    ctype = re.sub(r"[^a-z]", "", ctype_raw)

    if want_type and want_type not in ctype:
        return 0.0

    s = 0.0
    if name and name == query_norm:
        s = 1.0
    elif name and query_norm in name:
        s = 0.85 - (len(name) - len(query_norm)) * 0.005
    elif aid and query_norm in aid:
        s = 0.7
    elif klass and query_norm in klass:
        s = 0.5
    else:
        tokens = [t for t in query_norm.split() if len(t) >= 2]
        if tokens and name:
            hits = sum(1 for t in tokens if t in name)
            if hits:
                s = 0.3 + 0.4 * (hits / len(tokens))

    if s > 0 and ctype in CLICKABLE_TYPES:
        s += 0.05
    if s > 0 and ctype in EDITABLE_TYPES:
        s += 0.03
    return max(0.0, min(1.0, s))


def resolve(collected: List[Dict[str, Any]], query: str,
            want_type: Optional[str], limit: int) -> List[Dict[str, Any]]:
    qn = normalize(query)
    if not qn:
        return []
    want = normalize(want_type) if want_type else None
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for node in collected:
        s = score_node(node, qn, want)
        if s > 0.0:
            scored.append((s, node))
    scored.sort(key=lambda t: t[0], reverse=True)
    out: List[Dict[str, Any]] = []
    for s, node in scored[:max(1, limit)]:
        out.append({**node, "score": round(s, 3)})
    return out


INTERACTABLE_INVOKE_TYPES = {
    "button", "hyperlink", "menuitem", "tabitem", "listitem", "treeitem",
    "checkbox", "radiobutton", "splitbutton", "combobox", "edit", "menu",
    "slider", "text", "document",
}


def describe_node(node) -> Dict[str, Any]:
    rect = safe(lambda: node.BoundingRectangle)
    bbox: Optional[Dict[str, int]] = None
    center: Optional[Dict[str, int]] = None
    if rect and getattr(rect, "left", None) is not None:
        left, top, right, bottom = int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
        bbox = {"x": left, "y": top, "w": right - left, "h": bottom - top}
        center = {"x": (left + right) // 2, "y": (top + bottom) // 2}
    return {
        "name": str(safe(lambda: node.Name) or "")[:160],
        "automationId": str(safe(lambda: node.AutomationId) or "")[:80],
        "controlType": str(safe(lambda: node.ControlTypeName) or "")[:60],
        "bbox": bbox,
        "center": center,
    }


def find_controls(root, automation_id: Optional[str], name: Optional[str],
                  control_type: Optional[str], name_match: str,
                  max_depth: int = 14, max_nodes: int = 2000) -> List[Any]:
    """Walk the live tree returning uiautomation nodes matching the selector."""
    want_type = normalize(control_type) if control_type else None
    q = normalize(name) if name else None
    stack: List[Tuple[Any, int]] = [(root, 0)]
    seen = 0
    matches: List[Any] = []
    while stack and seen < max_nodes and len(matches) < 25:
        node, depth = stack.pop()
        seen += 1
        aid = safe(lambda: node.AutomationId) or ""
        nm = safe(lambda: node.Name) or ""
        ctype_raw = (safe(lambda: node.ControlTypeName) or "").lower().replace("controltype", "")
        ctype = re.sub(r"[^a-z]", "", ctype_raw)
        if automation_id:
            hit = aid == automation_id
        elif q:
            n = normalize(nm)
            hit = (n == q) if name_match == "exact" else (q in n)
        else:
            hit = False
        if hit and want_type and want_type not in ctype:
            hit = False
        if hit:
            matches.append(node)
        if depth < max_depth:
            for c in safe(lambda: node.GetChildren()) or []:
                stack.append((c, depth + 1))
    return matches


def find_controls_fuzzy(root, name: str, control_type: Optional[str],
                        max_depth: int = 14, max_nodes: int = 2000) -> List[Any]:
    """Rank live nodes by token overlap of their Name against `name`.

    Used when exact/contains matching fails, so a partial or reordered query
    (e.g. "Sandra") still resolves the intended element ("Sandra Patricia").
    Returns live uiautomation nodes sorted best-first (score > 0 only).
    """
    q = normalize(name)
    if not q:
        return []
    tokens = [t for t in q.split() if len(t) >= 2]
    want_type = normalize(control_type) if control_type else None
    stack: List[Tuple[Any, int]] = [(root, 0)]
    seen = 0
    scored: List[Tuple[float, Any]] = []
    while stack and seen < max_nodes:
        node, depth = stack.pop()
        seen += 1
        nm = normalize(safe(lambda: node.Name) or "")
        if nm:
            ctype_raw = (safe(lambda: node.ControlTypeName) or "").lower().replace("controltype", "")
            ctype = re.sub(r"[^a-z]", "", ctype_raw)
            type_ok = (not want_type) or (want_type in ctype)
            if type_ok:
                if nm == q:
                    score = 1.0
                elif q in nm:
                    score = 0.85 - (len(nm) - len(q)) * 0.005
                elif tokens:
                    hits = sum(1 for t in tokens if t in nm)
                    score = 0.3 + 0.5 * (hits / len(tokens)) if hits else 0.0
                else:
                    score = 0.0
                if score > 0.0:
                    scored.append((score, node))
        if depth < max_depth:
            for c in safe(lambda: node.GetChildren()) or []:
                stack.append((c, depth + 1))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [node for _score, node in scored]


THEN_PRESS_KEYS = {"enter": "{Enter}", "tab": "{Tab}", "escape": "{Esc}"}


def send_then_press(auto, node, then_press: str) -> Optional[str]:
    """Focus the node and send a submit key (Enter/Tab/Escape). Returns the key
    sent, or None if unsupported. Solves apps whose Send button is not exposed
    in the UIA tree (Chromium/embedded), where Enter submits the text box."""
    key = THEN_PRESS_KEYS.get((then_press or "").strip().lower())
    if not key:
        return None
    safe(lambda: node.SetFocus())
    auto.SendKeys(key, waitTime=0.05)
    return then_press.strip().lower()


def act_on_node(node, action: str, value: Optional[str]) -> str:
    """Perform a native UIA action on a node. Returns the action actually done."""
    if action == "set_value":
        node.GetValuePattern().SetValue(value or "")
        return "set_value"
    if action == "toggle":
        node.GetTogglePattern().Toggle()
        return "toggle"
    if action == "select":
        node.GetSelectionItemPattern().Select()
        return "select"
    if action == "focus":
        node.SetFocus()
        return "focus"
    if action == "click":
        node.Click()
        return "click"
    # default: invoke, fall back to a real click when no InvokePattern
    try:
        node.GetInvokePattern().Invoke()
        return "invoke"
    except Exception:
        node.Click()
        return "click_fallback"


def resolve_root(
    auto,
    pid: Optional[int],
    hwnd: Optional[int] = None,
    title: Optional[str] = None,
    process_name: Optional[str] = None,
):
    target_window = find_target_window(hwnd, pid, title, process_name)
    if target_window and target_window.get("handle"):
        return auto.ControlFromHandle(int(target_window["handle"]))

    if pid is not None:
        root = auto.GetRootControl()
        for child in root.GetChildren():
            if safe(lambda c=child: c.ProcessId) == pid:
                return child
        return None
    return auto.GetForegroundControl()


def run_invoke(auto, args) -> None:
    if not (args.automation_id or args.name):
        fail("--invoke requires --automation-id or --name")
        return
    root = resolve_root(auto, args.pid, args.hwnd, args.title, args.process_name)
    if root is None:
        fail("no target window (foreground empty or pid not found)")
        return

    # Optionally poll for the element to appear before acting (load races).
    matches: List[Any] = []
    pre_wait = max(0.0, float(getattr(args, "pre_wait", 0.0) or 0.0))
    deadline = time.monotonic() + pre_wait
    while True:
        matches = find_controls(root, args.automation_id, args.name,
                                args.control_type, args.name_match)
        if not matches and args.fuzzy and args.name:
            matches = find_controls_fuzzy(root, args.name, args.control_type)
        if matches or time.monotonic() >= deadline:
            break
        time.sleep(0.3)
        root = resolve_root(auto, args.pid, args.hwnd, args.title, args.process_name)
        if root is None:
            break

    if not matches:
        json.dump({
            "ok": False, "error": "element_not_found",
            "selector": {"automationId": args.automation_id, "name": args.name,
                         "controlType": args.control_type, "fuzzy": bool(args.fuzzy)},
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    # Prefer an enabled, on-screen match; fall back to the first.
    chosen = None
    for node in matches:
        if safe(lambda n=node: bool(n.IsEnabled)) and not safe(lambda n=node: bool(n.IsOffscreen)):
            chosen = node
            break
    if chosen is None:
        chosen = matches[0]
    info = describe_node(chosen)
    try:
        performed = act_on_node(chosen, (args.action or "invoke").lower(), args.value)
    except Exception as e:  # noqa: BLE001
        json.dump({
            "ok": False, "error": "action_failed", "action": args.action,
            "detail": str(e), "matched": info, "matchCount": len(matches),
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    pressed: Optional[str] = None
    if args.then_press:
        try:
            pressed = send_then_press(auto, chosen, args.then_press)
        except Exception:  # noqa: BLE001 — key send is best-effort
            pressed = None
    json.dump({
        "ok": True, "mode": "invoke", "action": performed,
        "thenPressed": pressed,
        "matched": info, "matchCount": len(matches),
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _match_once(auto, args) -> Optional[Dict[str, Any]]:
    """One polling pass: return the best matching element for the selector, or None."""
    root = resolve_root(auto, args.pid, args.hwnd, args.title, args.process_name)
    if root is None:
        return None
    if args.find:
        collected: List[Dict[str, Any]] = []
        walk(root, 0, args, collected)
        results = resolve(collected, args.find, args.control_type, 1)
        return results[0] if results else None
    # Identity selector (name / automationId) via the live tree.
    matches = find_controls(root, args.automation_id, args.name,
                            args.control_type, args.name_match)
    if not matches:
        return None
    for node in matches:
        if safe(lambda n=node: bool(n.IsEnabled)) and not safe(lambda n=node: bool(n.IsOffscreen)):
            return describe_node(node)
    return describe_node(matches[0])


def run_wait(auto, args) -> None:
    if not (args.find or args.name or args.automation_id):
        fail("--wait requires --find, --name, or --automation-id")
        return
    timeout = max(0.2, float(args.timeout))
    interval = max(0.05, float(args.interval))
    started = time.monotonic()
    deadline = started + timeout
    attempts = 0
    while True:
        attempts += 1
        match = None
        try:
            match = _match_once(auto, args)
        except Exception:  # noqa: BLE001 — transient COM/tree errors: keep polling
            match = None
        if match is not None:
            json.dump({
                "ok": True, "mode": "wait", "appeared": True,
                "attempts": attempts,
                "waitedMs": int((time.monotonic() - started) * 1000),
                "selector": {"query": args.find, "name": args.name,
                             "automationId": args.automation_id,
                             "controlType": args.control_type},
                "match": match,
            }, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
            return
        if time.monotonic() >= deadline:
            json.dump({
                "ok": True, "mode": "wait", "appeared": False,
                "attempts": attempts,
                "waitedMs": int((time.monotonic() - started) * 1000),
                "selector": {"query": args.find, "name": args.name,
                             "automationId": args.automation_id,
                             "controlType": args.control_type},
                "match": None,
            }, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
            return
        time.sleep(interval)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # valid JSON regardless of caller locale
    except Exception:
        pass
    if sys.platform != "win32":
        fail("uia_tree.py only runs on Windows")
        return

    try:
        import uiautomation as auto  # type: ignore
    except ImportError:
        fail("uiautomation package not installed. pip install uiautomation")
        return

    args = parse_args()

    if args.invoke:
        try:
            run_invoke(auto, args)
        except Exception as e:  # noqa: BLE001
            fail(f"uia invoke failed: {e!s}\n{traceback.format_exc()}")
        return

    if args.wait:
        try:
            run_wait(auto, args)
        except Exception as e:  # noqa: BLE001
            fail(f"uia wait failed: {e!s}\n{traceback.format_exc()}")
        return

    try:
        target = resolve_root(auto, args.pid, args.hwnd, args.title, args.process_name)
        if target is None:
            fail("no target window")
            return

        collected: List[Dict[str, Any]] = []
        walk(target, 0, args, collected)

        process_info = {
            "pid": safe(lambda: target.ProcessId),
            "name": safe(lambda: target.Name) or "",
            "className": safe(lambda: target.ClassName) or "",
        }

        if args.find:
            matches = resolve(collected, args.find, args.control_type, args.max_matches)
            json.dump(
                {
                    "ok": True,
                    "mode": "find",
                    "query": args.find,
                    "controlTypeFilter": args.control_type,
                    "process": process_info,
                    "matches": matches,
                    "matchCount": len(matches),
                    "nodesScanned": len(collected),
                },
                sys.stdout,
                ensure_ascii=False,
            )
            sys.stdout.write("\n")
            return

        json.dump(
            {
                "ok": True,
                "mode": "tree",
                "process": process_info,
                "nodes": collected,
                "nodeCount": len(collected),
                "maxNodes": args.max_nodes,
                "maxDepth": args.max_depth,
            },
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
    except Exception as e:  # noqa: BLE001
        fail(f"uia walk failed: {e!s}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
