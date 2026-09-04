"""
agent_bridge.py — Lo que Lumina escucha cuando no es el micrófono.

Dos fuentes, una sola cola:

  1. Las respuestas ya terminadas de Claude Code, Codex y Lumina Code.
  2. Las notificaciones de Windows, incluidas las del teléfono a través de
     Enlace Móvil.

Ambas se leen del **Lumina Windows Bridge**, el servicio Node que ya corre en
`127.0.0.1:8765` desde `Lumina_PC`. No montamos servidor propio: ese puerto ya
tiene dueño y ese dueño ya hace el trabajo difícil.

  · `POST /voice/claude-response`         ← lo llena el hook `on-response.ps1`
  · `POST /voice/claude-response/pending` → lo vaciamos aquí (TTL de 2 min en el
                                            bridge, así que nunca se lee una
                                            respuesta rancia tras una reconexión)
  · `POST /notifications/live`            → instantánea vía WinRT; no abre
                                            ventana ni roba el foco, por eso se
                                            puede consultar cada pocos segundos

Nada de esto habla por su cuenta: deja elementos en una cola y es `main.py`
quien decide cuándo interrumpir. Si el bridge no está levantado, este módulo se
calla y lo dice una vez; jamás puede tumbar la sesión de voz.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

# El bridge escucha aquí por defecto; LUMINA_BRIDGE_URL/PORT lo mueven, igual
# que en el hook de Claude Code.
def _bridge_base() -> str:
    base = (os.environ.get("LUMINA_BRIDGE_URL") or "").strip()
    if base:
        return base.rstrip("/")
    port = (os.environ.get("LUMINA_BRIDGE_PORT") or "").strip() or "8765"
    return f"http://127.0.0.1:{port}"


# Una respuesta de agente puede ser larguísima. Se recorta antes de mandarla al
# modelo porque el objetivo es que Lumina la RESUMA, no que la recite entera.
_MAX_AGENT_CHARS = 1500
_MAX_NOTIF_CHARS = 400

_POLL_SECONDS = 2.5

# Enlace Móvil se identifica por el prefijo de su AppUserModelId.
_PHONE_LINK_PREFIX = "microsoft.yourphone_"

# Ruido que nunca merece interrumpir: la propia Lumina, terminales y consolas.
_IGNORED_APPS = {
    "python", "pythonw", "lumina", "jarvis",
    "windows powershell", "powershell", "terminal", "windows terminal",
    "cmd.exe", "símbolo del sistema",
}

# Tope de notificaciones habladas por minuto. Una ráfaga de un grupo de WhatsApp
# no puede convertirse en veinte interrupciones seguidas.
_MAX_PER_MINUTE = 4


@dataclass
class BridgeItem:
    """Algo que merece que Lumina abra la boca."""
    kind: str          # "agent" | "notification"
    source: str        # "Claude Code", "Codex", "WhatsApp (móvil)"...
    text: str

    def as_prompt(self) -> str:
        """Texto para el modelo, con la etiqueta que el prompt sabe leer."""
        if self.kind == "agent":
            return (
                f"[AGENT_RESPONSE] {self.source} ha terminado de responder. "
                f"Resume lo esencial en una o dos frases, en el idioma del usuario. "
                f"No leas el texto entero ni cites código:\n\n{self.text}"
            )
        return f"[NOTIFICATION] {self.source}: {self.text}"


class AgentBridge:
    """Cliente del Lumina Windows Bridge. Entrega trabajo por `poll()`."""

    def __init__(self, base: Optional[str] = None, log=None) -> None:
        self._base = (base or _bridge_base()).rstrip("/")
        self._log = log or (lambda msg: None)
        self._queue: "queue.Queue[BridgeItem]" = queue.Queue(maxsize=100)
        self._stopped = threading.Event()
        self._recent: dict[str, float] = {}     # dedupe por contenido
        self._spoken_times: list[float] = []    # ventana del límite por minuto
        self._seen_notifs: set[str] = set()     # /notifications/live es una foto,
                                                # no una cola: hay que recordar
        self._baseline_done = False
        self._warned_offline = False

    # ── Ciclo de vida ────────────────────────────────────────────────────────

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self) -> None:
        self._stopped.set()

    # ── HTTP ─────────────────────────────────────────────────────────────────

    def _post(self, path: str, payload: dict | None = None) -> Optional[dict]:
        req = urllib.request.Request(
            f"{self._base}{path}",
            data=json.dumps(payload or {}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read() or b"{}")
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return None

    # ── Bucle de sondeo ──────────────────────────────────────────────────────

    def _loop(self) -> None:
        while not self._stopped.is_set():
            alive = self._drain_agent_responses()
            self._drain_notifications()

            if alive:
                self._warned_offline = False
            elif not self._warned_offline:
                # Decirlo UNA vez: si el bridge no está, esto no funciona y el
                # usuario merece saberlo, pero no cada 2,5 segundos.
                self._warned_offline = True
                self._log(f"BRIDGE: sin respuesta en {self._base} — "
                          "notificaciones y respuestas de agentes inactivas.")

            self._stopped.wait(_POLL_SECONDS)

    def _drain_agent_responses(self) -> bool:
        data = self._post("/voice/claude-response/pending")
        if data is None:
            return False
        for item in (data.get("responses") or []):
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            self._offer(BridgeItem(
                kind="agent",
                source=str(item.get("source") or "Claude Code"),
                text=text[:_MAX_AGENT_CHARS],
            ))
        return True

    def _drain_notifications(self) -> None:
        data = self._post("/notifications/live")
        if data is None:
            return
        items = data.get("notifications")
        if not isinstance(items, list):
            return

        first_pass = not self._baseline_done
        self._baseline_done = True

        for n in items:
            if not isinstance(n, dict):
                continue
            app = str(n.get("appName") or "Windows").strip()
            title = str(n.get("title") or "").strip()
            body = str(n.get("body") or "").strip()

            key = str(n.get("id") or f"{app}|{title}|{body}")
            if key in self._seen_notifs:
                continue
            self._seen_notifs.add(key)
            if len(self._seen_notifs) > 500:
                self._seen_notifs = set(list(self._seen_notifs)[-250:])

            # La primera vuelta solo sirve para aprender qué había ya en el
            # Centro de actividades. Leerlo entero al arrancar sería insufrible.
            if first_pass:
                continue

            if app.lower() in _IGNORED_APPS or (not title and not body):
                continue

            # Enlace Móvil se anuncia con su propio nombre: lo que importa es que
            # viene del móvil, no qué app de Windows lo pinta.
            if str(n.get("appUserModelId") or "").lower().startswith(_PHONE_LINK_PREFIX):
                app = f"{app} (móvil)"

            text = f"{title}. {body}".strip(". ") if body else title
            self._offer(BridgeItem(
                kind="notification",
                source=app,
                text=text[:_MAX_NOTIF_CHARS],
            ))

    # ── Cola, deduplicación y límite ─────────────────────────────────────────

    def _offer(self, item: BridgeItem) -> None:
        now = time.monotonic()

        # Mismo texto dos veces en 30 s: casi siempre es la misma notificación
        # repintada, o el hook disparando dos veces por el mismo turno.
        key = f"{item.source}|{item.text[:120]}"
        if now - self._recent.get(key, 0.0) < 30:
            return
        self._recent[key] = now
        if len(self._recent) > 200:
            self._recent = {k: v for k, v in self._recent.items() if now - v < 300}

        try:
            self._queue.put_nowait(item)
        except queue.Full:
            # Preferimos perder lo viejo: una notificación de hace un minuto ya
            # no interesa, la de ahora sí.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(item)
            except Exception:
                pass

    def poll(self) -> Optional[BridgeItem]:
        """Siguiente elemento que toca hablar, o None.

        El límite por minuto se aplica aquí y no en `_offer` para que lo que se
        descarte sea lo que no llegó a decirse, no lo que acaba de entrar.
        """
        try:
            item = self._queue.get_nowait()
        except queue.Empty:
            return None

        now = time.monotonic()
        self._spoken_times = [t for t in self._spoken_times if now - t < 60]
        if item.kind == "notification" and len(self._spoken_times) >= _MAX_PER_MINUTE:
            return None
        self._spoken_times.append(now)
        return item
