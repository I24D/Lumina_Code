#!/usr/bin/env python
"""Continuous monitor vision stream for Lumina Windows Bridge.

This sidecar is intentionally different from ui_capture/capture_analyze.py.
It keeps a DXGI Desktop Duplication camera alive and continuously reads the
latest monitor frame. The bridge exposes its heartbeat through /vision_stream.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import numpy as np
    from PIL import Image
except Exception as exc:  # pragma: no cover - startup diagnostic
    np = None  # type: ignore[assignment]
    Image = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(event: str, payload: dict[str, Any] | None = None) -> None:
    data = {"event": event, "ts": utc_now(), **(payload or {})}
    print(json.dumps(data, ensure_ascii=False), flush=True)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def foreground_window() -> dict[str, Any]:
    if sys.platform != "win32":
        return {"hwnd": None, "title": "", "pid": None, "processName": ""}

    user32 = ctypes.windll.user32
    hwnd = int(user32.GetForegroundWindow())
    title_buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, title_buf, 512)

    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    process_name = ""
    try:
        import psutil  # type: ignore

        process_name = psutil.Process(int(pid.value)).name()
    except Exception:
        process_name = ""

    return {
        "hwnd": hwnd,
        "title": title_buf.value,
        "pid": int(pid.value) if pid.value else None,
        "processName": process_name,
    }


def stdin_reader(commands: "queue.Queue[dict[str, Any]]") -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                commands.put(parsed)
        except Exception as exc:
            emit("stdin_error", {"error": str(exc)})


def downsample_gray(frame: Any) -> Any:
    if np is None:
        return None
    sample = frame[::24, ::24, :3].astype(np.float32)
    return (sample[:, :, 0] * 0.299 + sample[:, :, 1] * 0.587 + sample[:, :, 2] * 0.114).astype(np.uint8)


def changed_ratio(previous: Any, current: Any) -> float:
    if np is None or previous is None or current is None or previous.shape != current.shape:
        return 0.0
    return float(np.mean(np.abs(current.astype(np.int16) - previous.astype(np.int16)) > 8))


def save_latest_frame(frame: Any, path: Path) -> None:
    if Image is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    image = Image.fromarray(frame)
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        image.save(tmp, format="JPEG", quality=82, optimize=True)
    else:
        image.save(tmp)
    os.replace(tmp, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lumina continuous DXGI monitor vision stream")
    parser.add_argument("--fps", type=float, default=float(os.environ.get("LUMINA_VISION_STREAM_FPS", "8")))
    parser.add_argument(
        "--latest-state",
        default=os.environ.get("LUMINA_VISION_STREAM_LATEST_STATE", "runtime/vision-stream/latest-state.json"),
    )
    parser.add_argument(
        "--latest-frame",
        default=os.environ.get("LUMINA_VISION_STREAM_LATEST_FRAME", "runtime/vision-stream/latest-frame.jpg"),
    )
    parser.add_argument("--heartbeat-sec", type=float, default=2.0)
    parser.add_argument("--save-frame-every-ms", type=int, default=1000)
    parser.add_argument("--health", action="store_true")
    return parser.parse_args()


def error_state(state_path: Path, frame_path: Path, message: str, detail: str | None = None) -> None:
    payload = {
        "ok": False,
        "mode": "dxgi_desktop_duplication",
        "streaming": False,
        "error": message,
        "detail": detail or "",
        "latestFramePath": str(frame_path),
        "updatedAt": utc_now(),
    }
    atomic_write_json(state_path, payload)
    emit("error", payload)


def run() -> int:
    args = parse_args()
    fps = min(max(float(args.fps), 1.0), 30.0)
    state_path = Path(args.latest_state).resolve()
    frame_path = Path(args.latest_frame).resolve()

    if args.health:
        print(json.dumps({"ok": True, "sidecar": "vision_stream", "platform": sys.platform}), flush=True)
        return 0

    if sys.platform != "win32":
        error_state(state_path, frame_path, "vision_stream_requires_windows", sys.platform)
        return 2

    if _IMPORT_ERROR is not None:
        error_state(state_path, frame_path, "vision_stream_python_dependency_missing", str(_IMPORT_ERROR))
        return 2

    try:
        import dxcam  # type: ignore
    except Exception as exc:
        error_state(
            state_path,
            frame_path,
            "dxcam_missing",
            f"{exc}; install dxcam in the Lumina Python environment",
        )
        return 2

    commands: "queue.Queue[dict[str, Any]]" = queue.Queue()
    threading.Thread(target=stdin_reader, args=(commands,), daemon=True).start()

    camera = None
    started_at = utc_now()
    frames_seen = 0
    last_frame_at = ""
    last_state_at = 0.0
    last_saved_at = 0.0
    last_emitted_at = 0.0
    previous_sample = None
    last_foreground: dict[str, Any] | None = None
    running = True

    try:
        camera = dxcam.create(output_idx=0, output_color="RGB")
        if camera is None:
            error_state(state_path, frame_path, "dxcam_create_failed")
            return 2

        camera.start(target_fps=int(round(fps)), video_mode=True)
        emit("started", {"mode": "dxgi_desktop_duplication", "fps": fps, "statePath": str(state_path)})

        while running:
            try:
                while True:
                    command = commands.get_nowait()
                    cmd = str(command.get("cmd", "")).strip().lower()
                    if cmd in {"shutdown", "stop", "exit"}:
                        running = False
                    elif cmd == "ping":
                        emit("pong", {"framesSeen": frames_seen, "lastFrameAt": last_frame_at})
            except queue.Empty:
                pass

            if not running:
                break

            frame = camera.get_latest_frame()
            now = time.monotonic()
            if frame is None:
                time.sleep(0.02)
                continue

            frames_seen += 1
            last_frame_at = utc_now()
            sample = downsample_gray(frame)
            diff = changed_ratio(previous_sample, sample)
            previous_sample = sample
            fg = foreground_window()
            foreground_changed = last_foreground is None or fg.get("hwnd") != last_foreground.get("hwnd")
            last_foreground = fg

            height, width = int(frame.shape[0]), int(frame.shape[1])
            if args.save_frame_every_ms > 0 and (now - last_saved_at) * 1000 >= args.save_frame_every_ms:
                save_latest_frame(frame, frame_path)
                last_saved_at = now

            should_write_state = (now - last_state_at) >= 0.25 or foreground_changed
            if should_write_state:
                state = {
                    "ok": True,
                    "mode": "dxgi_desktop_duplication",
                    "streaming": True,
                    "startedAt": started_at,
                    "updatedAt": utc_now(),
                    "fpsTarget": fps,
                    "framesSeen": frames_seen,
                    "lastFrameAt": last_frame_at,
                    "frame": {"width": width, "height": height, "channels": int(frame.shape[2])},
                    "latestFramePath": str(frame_path),
                    "foreground": fg,
                    "change": {"downsampledPixelRatio": round(diff, 6)},
                }
                atomic_write_json(state_path, state)
                last_state_at = now

            if foreground_changed or (now - last_emitted_at) >= args.heartbeat_sec:
                emit(
                    "heartbeat",
                    {
                        "framesSeen": frames_seen,
                        "lastFrameAt": last_frame_at,
                        "foreground": fg,
                        "latestFramePath": str(frame_path),
                    },
                )
                last_emitted_at = now

            time.sleep(max(0.001, min(0.05, 1.0 / fps / 2.0)))

    except KeyboardInterrupt:
        emit("shutdown", {"reason": "keyboard_interrupt"})
    except Exception as exc:
        detail = traceback.format_exc()
        error_state(state_path, frame_path, str(exc), detail)
        return 1
    finally:
        try:
            if camera is not None:
                camera.stop()
        except Exception:
            pass
        emit("stopped", {"framesSeen": frames_seen, "lastFrameAt": last_frame_at})

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
