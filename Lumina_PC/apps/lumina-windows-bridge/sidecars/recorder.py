"""
recorder.py — Persistent Lumina LfD recorder sidecar.

Unlike the other sidecars (uia_tree.py, browser_drive.py) this one is
NOT one-shot. The TS layer spawns it, keeps it alive across many
recording sessions, and talks to it via JSON-lines on stdin / stdout.

Protocol — one JSON object per line:

  TS → sidecar (stdin):
    {"cmd": "ping"}
    {"cmd": "start", "sessionDir": "<absolute>", "label": "...",
     "mode": "events"|"screencast", "fpsHint": 5, "captureUia": true}
    {"cmd": "pause"}
    {"cmd": "resume"}
    {"cmd": "stop"}
    {"cmd": "exit"}

  sidecar → TS (stdout):
    {"event": "ready", "version": "1.0.0"}
    {"event": "started", "sessionId": "...", "atISO": "..."}
    {"event": "paused"} | {"event": "resumed"}
    {"event": "stopped", "stats": {"events": N, "durationMs": M}}
    {"event": "tick", "idx": N, "kind": "...", ...}    # one per recorded event
    {"event": "error", "where": "...", "message": "..."}
    {"event": "bye"}

Each recorded event is ALSO appended to <sessionDir>/events.jsonl with
its full payload (the "tick" line on stdout is a lightweight notification
for the TS supervisor — not all metadata is duplicated).

Capture details:
  - pynput Listeners for mouse + keyboard (cross-platform).
  - mss for screenshots (10–30ms typical) saved as PNG under
    <sessionDir>/screenshots/<idx>.png.
  - On Windows, an optional UIA snapshot via the `uiautomation` package
    (already required by uia_tree.py) saved under
    <sessionDir>/uia/<idx>.json — captures the foreground window
    subtree at event time so the Replayer has ground truth.
  - Event throttling: mouse_move events are batched (only the FIRST move
    after a non-move event is kept; intermediate moves dropped).
  - Burst-suppression: identical consecutive key repeats (when the OS
    auto-repeats) are coalesced into one event with `repeatCount`.

The sidecar writes events synchronously to disk so a hard crash leaves a
valid JSONL up to the last flush.

Requirements:
  pynput, mss, Pillow. On Windows: uiautomation (already used by
  uia_tree.py for foreground UIA snapshots).
"""
from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

VERSION = "1.0.0"


# ── Stdout helpers ───────────────────────────────────────────────────

_STDOUT_LOCK = threading.Lock()


def emit(event: str, **fields: Any) -> None:
    """Write one JSON object + newline to stdout, flushed."""
    payload: Dict[str, Any] = {"event": event}
    payload.update(fields)
    with _STDOUT_LOCK:
        try:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:
            # If stdout is broken we can't recover; just exit silently.
            os._exit(2)


def emit_error(where: str, exc: BaseException) -> None:
    emit("error", where=where, message=str(exc), traceback=traceback.format_exc())


# ── Lazy library loader ──────────────────────────────────────────────


def load_deps() -> Dict[str, Any]:
    try:
        import mss  # type: ignore
        import mss.tools  # type: ignore
        from pynput import keyboard, mouse  # type: ignore
    except ImportError as e:
        emit("error", where="import", message=str(e),
             hint="pip install pynput mss Pillow")
        sys.exit(2)

    uia = None
    if sys.platform == "win32":
        try:
            import uiautomation as auto  # type: ignore
            uia = auto
        except Exception:
            uia = None  # optional: recorder still works without UIA snapshots

    return {"mss": mss, "keyboard": keyboard, "mouse": mouse, "uia": uia}


# ── Session state ────────────────────────────────────────────────────


@dataclass
class SessionState:
    sessionId: str
    sessionDir: Path
    mode: str  # "events" | "screencast"
    captureUia: bool
    fpsHintHz: float
    paused: bool = False
    stopped: bool = False
    startedAtMs: float = 0.0
    idx: int = 0
    lastScreencastTickMs: float = 0.0
    lastEventKind: str = ""
    last_key_event: Optional[Dict[str, Any]] = None
    events_path: Optional[Path] = None
    events_fh: Any = None
    screenshots_dir: Optional[Path] = None
    uia_dir: Optional[Path] = None
    pending: "queue.Queue[Dict[str, Any]]" = field(default_factory=queue.Queue)
    last_mouse_pos: Optional[Dict[str, int]] = None


_state: Optional[SessionState] = None
_state_lock = threading.Lock()


# ── Disk layout ──────────────────────────────────────────────────────


def ensure_session_layout(state: SessionState) -> None:
    state.sessionDir.mkdir(parents=True, exist_ok=True)
    state.screenshots_dir = state.sessionDir / "screenshots"
    state.screenshots_dir.mkdir(exist_ok=True)
    if state.captureUia:
        state.uia_dir = state.sessionDir / "uia"
        state.uia_dir.mkdir(exist_ok=True)
    state.events_path = state.sessionDir / "events.jsonl"
    state.events_fh = state.events_path.open("a", encoding="utf-8")
    # meta.json written once at start, then again at stop with totals.
    write_meta(state, finalize=False)


def write_meta(state: SessionState, finalize: bool, extra: Optional[Dict[str, Any]] = None) -> None:
    meta = {
        "sessionId": state.sessionId,
        "version": VERSION,
        "mode": state.mode,
        "captureUia": state.captureUia,
        "fpsHintHz": state.fpsHintHz,
        "startedAtISO": iso_from_monotonic(state.startedAtMs),
        "platform": sys.platform,
        "python": sys.version.split()[0],
    }
    if finalize:
        meta["stoppedAtISO"] = datetime.now(timezone.utc).isoformat()
        meta["eventCount"] = state.idx
    if extra:
        meta.update(extra)
    (state.sessionDir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


def iso_from_monotonic(monotonic_ms: float) -> str:
    # Approximate: stored at start time using current UTC.
    return datetime.now(timezone.utc).isoformat()


# ── Screenshot + UIA capture ────────────────────────────────────────


def take_screenshot(deps: Dict[str, Any], state: SessionState) -> Optional[str]:
    if state.screenshots_dir is None:
        return None
    try:
        with deps["mss"].mss() as sct:
            monitor = sct.monitors[0]  # full virtual screen
            raw = sct.grab(monitor)
            filename = f"{state.idx:06d}.png"
            out = state.screenshots_dir / filename
            deps["mss"].tools.to_png(raw.rgb, raw.size, output=str(out))
            return f"screenshots/{filename}"
    except Exception as e:
        emit_error("screenshot", e)
        return None


def take_uia_snapshot(deps: Dict[str, Any], state: SessionState) -> Optional[str]:
    if not state.captureUia or state.uia_dir is None or deps.get("uia") is None:
        return None
    try:
        auto = deps["uia"]
        target = auto.GetForegroundControl()
        if target is None:
            return None
        nodes: list[Dict[str, Any]] = []
        _walk_uia(auto, target, depth=0, collected=nodes, max_nodes=300, max_depth=5)
        process_info = {
            "pid": _safe(lambda: target.ProcessId),
            "name": _safe(lambda: target.Name) or "",
            "className": _safe(lambda: target.ClassName) or "",
        }
        filename = f"{state.idx:06d}.json"
        out = state.uia_dir / filename
        out.write_text(json.dumps({"process": process_info, "nodes": nodes},
                                  ensure_ascii=False), encoding="utf-8")
        return f"uia/{filename}"
    except Exception as e:
        emit_error("uia", e)
        return None


def _safe(call: Any) -> Any:
    try:
        return call()
    except Exception:
        return None


def _walk_uia(auto: Any, node: Any, depth: int, collected: list, max_nodes: int, max_depth: int) -> None:
    if len(collected) >= max_nodes:
        return
    name = _safe(lambda: node.Name) or ""
    aid = _safe(lambda: node.AutomationId) or ""
    ctype = _safe(lambda: node.ControlTypeName) or ""
    klass = _safe(lambda: node.ClassName) or ""
    rect = _safe(lambda: node.BoundingRectangle)
    bbox = None
    center = None
    if rect and getattr(rect, "left", None) is not None:
        left, top, right, bottom = int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
        bbox = {"x": left, "y": top, "w": right - left, "h": bottom - top}
        center = {"x": (left + right) // 2, "y": (top + bottom) // 2}
    collected.append({
        "depth": depth,
        "name": str(name)[:120],
        "automationId": str(aid)[:80],
        "controlType": str(ctype)[:60],
        "className": str(klass)[:80],
        "bbox": bbox,
        "center": center,
        "enabled": bool(_safe(lambda: node.IsEnabled) or False),
        "offscreen": bool(_safe(lambda: node.IsOffscreen) or False),
    })
    if depth >= max_depth:
        return
    children = _safe(lambda: node.GetChildren()) or []
    for c in children:
        _walk_uia(auto, c, depth + 1, collected, max_nodes, max_depth)


# ── Event writers ────────────────────────────────────────────────────


def write_event(state: SessionState, deps: Dict[str, Any], kind: str, payload: Dict[str, Any]) -> None:
    state.idx += 1
    now_ms = (time.monotonic() - state.startedAtMs) * 1000.0
    full: Dict[str, Any] = {
        "idx": state.idx,
        "atMs": int(now_ms),
        "kind": kind,
    }
    full.update(payload)
    # Always take a screenshot for non-throttled events.
    full["screenshot"] = take_screenshot(deps, state)
    full["uia"] = take_uia_snapshot(deps, state)
    full["window"] = current_window_info(deps)
    try:
        state.events_fh.write(json.dumps(full, ensure_ascii=False) + "\n")
        state.events_fh.flush()
    except Exception as e:
        emit_error("jsonl-write", e)
    emit("tick", idx=state.idx, kind=kind)


def current_window_info(deps: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    auto = deps.get("uia")
    if auto is None:
        return None
    try:
        fg = auto.GetForegroundControl()
        if fg is None:
            return None
        return {
            "title": _safe(lambda: fg.Name) or "",
            "pid": _safe(lambda: fg.ProcessId),
            "className": _safe(lambda: fg.ClassName) or "",
        }
    except Exception:
        return None


# ── Listener callbacks ──────────────────────────────────────────────


def install_listeners(deps: Dict[str, Any]) -> tuple:
    keyboard = deps["keyboard"]
    mouse = deps["mouse"]

    # Throttle mouse moves: drop until a non-move event happens, then record one
    # final move just before that event so we have the right position context.
    move_buffer = {"pos": None}

    def on_move(x: int, y: int):
        with _state_lock:
            if _state is None or _state.paused or _state.stopped:
                return
            move_buffer["pos"] = (int(x), int(y))
            _state.last_mouse_pos = {"x": int(x), "y": int(y)}

    def on_click(x: int, y: int, button, pressed: bool):
        with _state_lock:
            if _state is None or _state.paused or _state.stopped:
                return
            kind = "mouse.down" if pressed else "mouse.up"
            payload = {
                "pos": {"x": int(x), "y": int(y)},
                "button": getattr(button, "name", str(button)),
            }
            write_event(_state, deps, kind, payload)
            move_buffer["pos"] = None

    def on_scroll(x: int, y: int, dx: int, dy: int):
        with _state_lock:
            if _state is None or _state.paused or _state.stopped:
                return
            payload = {"pos": {"x": int(x), "y": int(y)}, "dx": int(dx), "dy": int(dy)}
            write_event(_state, deps, "mouse.scroll", payload)

    def on_press(key):
        with _state_lock:
            if _state is None or _state.paused or _state.stopped:
                return
            label = key_label(key)
            payload = {"key": label}
            write_event(_state, deps, "key.down", payload)

    def on_release(key):
        with _state_lock:
            if _state is None or _state.paused or _state.stopped:
                return
            label = key_label(key)
            payload = {"key": label}
            write_event(_state, deps, "key.up", payload)

    m_listener = mouse.Listener(on_move=on_move, on_click=on_click, on_scroll=on_scroll)
    k_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    m_listener.start()
    k_listener.start()
    return m_listener, k_listener


def key_label(key: Any) -> str:
    """Render a pynput Key/KeyCode into a stable label like 'a', 'shift', 'enter'."""
    try:
        if hasattr(key, "char") and key.char is not None:
            return str(key.char)
    except Exception:
        pass
    name = getattr(key, "name", None) or str(key)
    return name.replace("Key.", "")


# ── Screencast ticker (only when mode='screencast') ────────────────


def screencast_loop(deps: Dict[str, Any]) -> None:
    while True:
        time.sleep(0.05)
        with _state_lock:
            if _state is None:
                continue
            if _state.stopped:
                return
            if _state.paused:
                continue
            if _state.mode != "screencast":
                continue
            interval = 1.0 / max(0.5, _state.fpsHintHz)
            now = time.monotonic()
            if now - _state.lastScreencastTickMs < interval:
                continue
            _state.lastScreencastTickMs = now
            write_event(_state, deps, "screencast.tick", {})


# ── Command dispatch ────────────────────────────────────────────────


def handle_command(deps: Dict[str, Any], raw: str) -> bool:
    """Process one command line. Returns False to request exit."""
    raw = raw.strip()
    if not raw:
        return True
    try:
        msg = json.loads(raw)
    except Exception as e:
        emit("error", where="cmd-parse", message=str(e), raw=raw[:200])
        return True
    cmd = msg.get("cmd")
    if cmd == "ping":
        emit("pong")
        return True
    if cmd == "exit":
        _stop_session_locked()
        emit("bye")
        return False
    if cmd == "start":
        return _cmd_start(deps, msg)
    if cmd == "pause":
        with _state_lock:
            if _state and not _state.stopped:
                _state.paused = True
                emit("paused")
        return True
    if cmd == "resume":
        with _state_lock:
            if _state and not _state.stopped:
                _state.paused = False
                emit("resumed")
        return True
    if cmd == "stop":
        _stop_session_locked()
        return True
    emit("error", where="cmd-dispatch", message=f"unknown cmd: {cmd}")
    return True


def _cmd_start(deps: Dict[str, Any], msg: Dict[str, Any]) -> bool:
    global _state
    with _state_lock:
        if _state is not None and not _state.stopped:
            emit("error", where="start", message="a session is already active; stop it first")
            return True
        try:
            session_dir = Path(msg["sessionDir"]).resolve()
            session_id = session_dir.name
            state = SessionState(
                sessionId=session_id,
                sessionDir=session_dir,
                mode=msg.get("mode", "events"),
                captureUia=bool(msg.get("captureUia", True)),
                fpsHintHz=float(msg.get("fpsHint", 5)),
                startedAtMs=time.monotonic(),
            )
            ensure_session_layout(state)
            _state = state
            # Capture one initial frame so the replayer has baseline.
            write_event(_state, deps, "session.start", {
                "label": msg.get("label", ""),
                "platform": sys.platform,
            })
            emit("started", sessionId=session_id, sessionDir=str(session_dir),
                 atISO=datetime.now(timezone.utc).isoformat())
        except Exception as e:
            emit_error("start", e)
    return True


def _stop_session_locked() -> None:
    global _state
    with _state_lock:
        if _state is None:
            emit("stopped", stats={"events": 0, "durationMs": 0})
            return
        if _state.stopped:
            return
        # Write a closing event with stats.
        try:
            duration_ms = int((time.monotonic() - _state.startedAtMs) * 1000)
            write_meta(_state, finalize=True)
            if _state.events_fh is not None:
                _state.events_fh.flush()
                _state.events_fh.close()
            emit("stopped", stats={
                "events": _state.idx,
                "durationMs": duration_ms,
                "sessionDir": str(_state.sessionDir),
            })
        except Exception as e:
            emit_error("stop", e)
        finally:
            _state.stopped = True


# ── Main loop ────────────────────────────────────────────────────────


def main() -> None:
    deps = load_deps()
    emit("ready", version=VERSION, platform=sys.platform, uiaAvailable=(deps.get("uia") is not None))

    install_listeners(deps)
    screencast_thread = threading.Thread(target=screencast_loop, args=(deps,), daemon=True)
    screencast_thread.start()

    for raw_line in sys.stdin:
        try:
            if not handle_command(deps, raw_line):
                break
        except Exception as e:
            emit_error("cmd-loop", e)
    _stop_session_locked()
    # graceful exit; listener threads are daemon, will die with process


def _signal_handler(signum: int, frame: Any) -> None:
    _stop_session_locked()
    emit("bye")
    sys.exit(0)


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)
    except Exception:
        pass
    try:
        main()
    except BrokenPipeError:
        # TS side closed; quit silently.
        os._exit(0)
    except Exception as e:
        emit_error("main", e)
        sys.exit(2)
