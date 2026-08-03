"""
audio_manager.py — System audio adapter for Lumina (§5).

Get/set master volume, mute, and list playback devices — the structural audio
path so "sube el volumen a 30%" is a deterministic API call, not a guessed drag
on a slider. Uses pycaw (Core Audio via comtypes); reading/controlling system
audio → Python, per the AMSI rule. Degrades with a structured hint if pycaw is
missing.

Protocol (one JSON per stdout):
  python audio_manager.py --action <action> --json '<params>'
Actions:
  status                     → master volume (0..100), muted, default device
  set_volume  {level}        → set master volume 0..100
  mute        {muted?}       → mute/unmute (toggle if muted omitted)
  list_devices               → active playback devices
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def _endpoint_volume():
    """Return an IAudioEndpointVolume for the default playback device, or None.

    pycaw ≥2025 wraps GetSpeakers() as an AudioDevice; its `.EndpointVolume`
    property is the ready-cast IAudioEndpointVolume (the old `.Activate()` path
    no longer exists on the wrapper)."""
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"pycaw not installed: {e!s}",
              "hint": "pip install pycaw comtypes"}, 2)
        return None
    return AudioUtilities.GetSpeakers().EndpointVolume


def action_status(_: Dict[str, Any]) -> Dict[str, Any]:
    vol = _endpoint_volume()
    if vol is None:
        return {"ok": False, "error": "no_audio_endpoint"}
    scalar = vol.GetMasterVolumeLevelScalar()
    muted = bool(vol.GetMute())
    device = ""
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore
        device = str(AudioUtilities.GetSpeakers().FriendlyName)
    except Exception:
        device = ""
    return {"ok": True, "level": round(scalar * 100), "muted": muted, "device": device}


def action_set_volume(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        level = float(params.get("level"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "level_required (0..100)"}
    level = max(0.0, min(100.0, level))
    vol = _endpoint_volume()
    if vol is None:
        return {"ok": False, "error": "no_audio_endpoint"}
    vol.SetMasterVolumeLevelScalar(level / 100.0, None)
    return {"ok": True, "level": round(level)}


def action_mute(params: Dict[str, Any]) -> Dict[str, Any]:
    vol = _endpoint_volume()
    if vol is None:
        return {"ok": False, "error": "no_audio_endpoint"}
    if "muted" in params:
        target = bool(params.get("muted"))
    else:
        target = not bool(vol.GetMute())
    vol.SetMute(1 if target else 0, None)
    return {"ok": True, "muted": target}


def action_list_devices(_: Dict[str, Any]) -> Dict[str, Any]:
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"pycaw not installed: {e!s}"}
    devices: List[Dict[str, Any]] = []
    try:
        for dev in AudioUtilities.GetAllDevices():
            state = getattr(dev, "state", None)
            devices.append({
                "id": str(getattr(dev, "id", "")),
                "name": str(getattr(dev, "FriendlyName", "")),
                "state": str(state) if state is not None else "",
            })
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"enumerate_failed: {e!s}"}
    return {"ok": True, "count": len(devices), "devices": devices}


ACTIONS = {
    "status": action_status,
    "set_volume": action_set_volume,
    "mute": action_mute,
    "list_devices": action_list_devices,
}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "audio_manager.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina Audio adapter")
    ap.add_argument("--action", required=True, choices=sorted(ACTIONS.keys()))
    ap.add_argument("--json", type=str, default="{}")
    args = ap.parse_args()

    try:
        params = json.loads(args.json) if args.json else {}
        if not isinstance(params, dict):
            params = {}
    except Exception:
        emit({"ok": False, "error": "invalid --json params"}, 2)
        return

    try:
        import comtypes  # type: ignore  # noqa: F401
        try:
            import comtypes.client  # noqa: F401
        except Exception:
            pass
    except Exception:
        pass

    try:
        emit(ACTIONS[args.action](params))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"audio {args.action} failed: {e!s}"}, 1)


if __name__ == "__main__":
    main()
