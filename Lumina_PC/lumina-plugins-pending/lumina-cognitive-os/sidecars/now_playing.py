"""
now_playing.py — Lumina's "ears": is audio ACTUALLY playing right now? (§7)

Verification, not assumption. To honestly say "the music is playing" Lumina
must observe the real OS audio state, not trust that a click worked. This
sidecar reports two independent signals:

  1. Audio meter (pycaw / Core Audio) — the real output peak of the default
     render device, plus per-app session peaks. peak > 0 means sound is
     genuinely leaving the speakers. This is the strongest proof.
  2. Media session (winsdk / SMTC) — the title/artist/playback-status the OS
     exposes for the current transport (what YouTube/Spotify report). Tells us
     WHAT is playing and whether the app says it's PLAYING. Optional; degrades.

`audible` = default-device peak over threshold AND not muted → sound is out.
Both signals are best-effort and each degrades independently.

Protocol (one JSON on stdout):
  python now_playing.py [--settle-ms 700] [--threshold 0.0008]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any, Dict, List, Optional


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")
    sys.exit(code)


# ── Audio meter (pycaw) ──────────────────────────────────────────────

def read_audio(threshold: float, settle_ms: int) -> Dict[str, Any]:
    try:
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioMeterInformation
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"pycaw missing: {e!s}"}

    try:
        speakers = AudioUtilities.GetSpeakers()  # AudioDevice wrapper (pycaw ≥2025)
        # Endpoint peak meter — total output level of the default device. The
        # raw IMMDevice (._dev) is what exposes Activate() for the meter iface.
        meter_if = speakers._dev.Activate(IAudioMeterInformation._iid_, CLSCTX_ALL, None)
        meter = cast(meter_if, POINTER(IAudioMeterInformation))
        vol = speakers.EndpointVolume  # already an IAudioEndpointVolume

        # Sample the peak a few times over the settle window — audio is bursty,
        # so we take the max to avoid catching a momentary silence between beats.
        peak = 0.0
        deadline = time.monotonic() + max(0.05, settle_ms / 1000.0)
        while time.monotonic() < deadline:
            peak = max(peak, float(meter.GetPeakValue()))
            time.sleep(0.05)

        muted = bool(vol.GetMute())
        volume = round(float(vol.GetMasterVolumeLevelScalar()) * 100)

        # Per-app session peaks: which process is actually making sound.
        sessions: List[Dict[str, Any]] = []
        try:
            for s in AudioUtilities.GetAllSessions():
                proc = s.Process.name() if s.Process else "system"
                spk = 0.0
                try:
                    sm = s._ctl.QueryInterface(IAudioMeterInformation)
                    spk = float(sm.GetPeakValue())
                except Exception:
                    spk = 0.0
                if proc and (spk > 0.0 or (s.Process is not None)):
                    sessions.append({"process": proc, "peak": round(spk, 4)})
        except Exception:
            pass
        sessions.sort(key=lambda x: x["peak"], reverse=True)

        audible = (peak >= threshold) and not muted
        loudest = sessions[0] if sessions else None
        return {
            "available": True,
            "peak": round(peak, 4),
            "threshold": threshold,
            "muted": muted,
            "volume": volume,
            "audible": audible,
            "loudestApp": loudest,
            "sessions": sessions[:8],
        }
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"audio_read_failed: {e!s}"}


# ── Media session (winsdk / SMTC) ────────────────────────────────────

async def _read_smtc() -> Optional[Dict[str, Any]]:
    try:
        from winsdk.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as Manager,
        )
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"winsdk missing: {e!s}"}
    try:
        mgr = await Manager.request_async()
        current = mgr.get_current_session()
        if current is None:
            return {"available": True, "hasSession": False}
        props = await current.try_get_media_properties_async()
        info = current.get_playback_info()
        status_map = {0: "closed", 1: "opened", 2: "changing",
                      3: "stopped", 4: "playing", 5: "paused"}
        status_val = int(info.playback_status)
        return {
            "available": True,
            "hasSession": True,
            "title": props.title or "",
            "artist": props.artist or "",
            "albumTitle": getattr(props, "album_title", "") or "",
            "status": status_map.get(status_val, str(status_val)),
            "isPlaying": status_val == 4,
            "sourceApp": current.source_app_user_model_id or "",
        }
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"smtc_failed: {e!s}"}


def read_media_session() -> Dict[str, Any]:
    try:
        return asyncio.run(_read_smtc()) or {"available": False}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"smtc_error: {e!s}"}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "now_playing.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina now-playing verifier")
    ap.add_argument("--threshold", type=float, default=0.0008)
    ap.add_argument("--settle-ms", type=int, default=700)
    args = ap.parse_args()

    audio = read_audio(args.threshold, args.settle_ms)
    media = read_media_session()

    # The honest verdict: sound is out (audio.audible) OR the media session
    # explicitly reports PLAYING. Prefer the audio meter — it's ground truth.
    playing = bool(audio.get("audible")) or bool(media.get("isPlaying"))
    emit({
        "ok": True,
        "playing": playing,
        "audible": audio.get("audible", False),
        "audio": audio,
        "mediaSession": media,
    })


if __name__ == "__main__":
    main()
