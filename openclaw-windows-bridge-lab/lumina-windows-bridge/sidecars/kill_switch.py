"""
kill_switch.py — Global panic-hotkey listener for Lumina (§9).

Long-lived sidecar. Listens for a dedicated key chord anywhere in Windows
(even while another app is focused and an agent is mid-action) and emits a
single NDJSON `engage` event on stdout each time it fires. The TS side
(`kill-switch-process.ts`) reads that and trips the in-process kill switch,
which freezes the operator loop and blocks all further dispatch.

Default chord: Ctrl+Alt+K  (override with --keys "ctrl+alt+pause").
Uses pynput (already a Lumina sidecar dep) for a system-wide listener — no
PowerShell, consistent with the AMSI rule.

Protocol (one JSON per line on stdout):
  {"event": "ready", "chord": "ctrl+alt+k"}
  {"event": "engage", "atISO": "...", "chord": "ctrl+alt+k"}
  {"event": "error", "message": "..."}
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Set


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()))


def parse_chord(spec: str) -> Set[str]:
    tokens = {t.strip().lower() for t in spec.split("+") if t.strip()}
    return tokens or {"ctrl", "alt", "k"}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Lumina global kill-switch hotkey")
    ap.add_argument("--keys", type=str, default="ctrl+alt+k",
                    help='Chord, e.g. "ctrl+alt+k" or "ctrl+alt+pause".')
    ap.add_argument("--debounce-ms", type=int, default=1500)
    args = ap.parse_args()

    required = parse_chord(args.keys)
    chord_label = "+".join(sorted(required))

    try:
        from pynput import keyboard
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"pynput not installed: {e!s}; pip install pynput"})
        sys.exit(2)

    pressed: Set[str] = set()
    last_fire = 0.0
    debounce = max(0.2, args.debounce_ms / 1000.0)

    def normalize(key) -> str:
        Key = keyboard.Key
        mapping = {
            Key.ctrl_l: "ctrl", Key.ctrl_r: "ctrl",
            Key.alt_l: "alt", Key.alt_r: "alt", Key.alt_gr: "alt",
            Key.shift_l: "shift", Key.shift_r: "shift",
            Key.cmd: "cmd", Key.cmd_r: "cmd",
        }
        if key in mapping:
            return mapping[key]
        pause = getattr(Key, "pause", None)
        if pause is not None and key == pause:
            return "pause"
        char = getattr(key, "char", None)
        if char:
            return char.lower()
        return str(key).replace("Key.", "").lower()

    def on_press(key) -> None:
        nonlocal last_fire
        try:
            pressed.add(normalize(key))
        except Exception:
            return
        if required.issubset(pressed):
            now = time.time()
            if now - last_fire >= debounce:
                last_fire = now
                emit({"event": "engage", "atISO": now_iso(), "chord": chord_label})

    def on_release(key) -> None:
        try:
            pressed.discard(normalize(key))
        except Exception:
            pressed.clear()

    emit({"event": "ready", "chord": chord_label})
    try:
        with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
            listener.join()
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"listener failed: {e!s}"})
        sys.exit(3)


if __name__ == "__main__":
    main()
