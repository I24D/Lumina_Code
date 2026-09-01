"""Read the MSN Weather app ("El Tiempo") through Windows UI Automation.

The app is a WinUI shell around a web view, so its UIA tree exposes the page's
accessibility tree with stable element ids (`WeatherOverviewCurrentSection`,
`WeatherDetailsSection`, `weatherDailyForecastSection`). Everything is read from
those containers by id, which keeps the ad slots that sit between them out of
the result and survives the app being localized.

Read-only: it opens the app and reads it, and never clicks, searches or changes
a setting.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import re
import subprocess
import sys
import time
import unicodedata
from ctypes import wintypes
from typing import Any, Dict, List, Optional, Tuple

WEATHER_PROCESS = "microsoft.msn.weather.exe"
WEATHER_AUMID = "Microsoft.BingWeather_8wekyb3d8bbwe!App"
# Classic UWP: the visible frame belongs to ApplicationFrameHost and the app
# itself only owns the CoreWindow child inside it.
FRAME_HOST_PROCESS = "applicationframehost.exe"
CORE_WINDOW_CLASS = "Windows.UI.Core.CoreWindow"

ROOT_WEB_AREA_ID = "RootWebArea"
OVERVIEW_ID = "WeatherOverviewCurrentSection"
OVERVIEW_ROOT_ID = "WeatherOverviewV2"
LOCATION_ID = "WeatherOverviewLocationName"
TEMPERATURE_ID = "OverviewCurrentTemperature"
DETAILS_ID = "WeatherDetailsSection"
FORECAST_ID = "weatherDailyForecastSection"
MINI_MAP_ID = "weatherMiniMapContainer"
REFRESH_COMMAND_ID = "RefreshCommand"
APP_VERSION_ID_PREFIX = "ApplicationVersion"

MAX_FIELD_CHARS = 400
MAX_DETAILS = 16
# Cuántas fichas de detalle publica la página cuando termina de pintar.
EXPECTED_DETAIL_CARDS = 12
MAX_FORECAST_DAYS = 10
BIDI_CONTROLS = "‎‏‪‫‬‭‮⁦⁧⁨⁩"

TIME_PATTERN = re.compile(r"^\d{1,2}:\d{2}\s*(?:[AP]\.?\s?M\.?)?$", re.IGNORECASE)
MERIDIEM_PATTERN = re.compile(r"^[AP]\.?\s?M\.?$", re.IGNORECASE)
# Below this a card has no written narrative and is a readings-only card. Every
# real narrative on the page runs past 40 characters, while the longest string
# in a value card ("Siguiente luna llena") stops at 20.
MIN_NARRATIVE_CHARS = 30
# Labels for the day already gone; asking for the forecast should not read it.
PAST_DAY_LABELS = {"ayer", "yesterday"}
TODAY_LABELS = {"hoy", "today"}
TEMPERATURE_PATTERN = re.compile(r"-?\d+\s*°")
# "29 Hoy 31° 20°" / "30 domingo 31° 20°"
FORECAST_PATTERN = re.compile(r"^(\d{1,2})\s+(.+?)\s+(-?\d+)°\s+(-?\d+)°$")
PRECIPITATION_PATTERN = re.compile(r"precipitac|precipitation", re.IGNORECASE)
ALERT_ID_PATTERN = re.compile(r"alert|severe|warning", re.IGNORECASE)


def emit(value: Dict[str, Any], code: int = 0) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def clean(value: Any, limit: int = MAX_FIELD_CHARS) -> str:
    text = str(value or "")
    for control in BIDI_CONTROLS:
        text = text.replace(control, "")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", stripped).strip().lower()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MSN Weather UI Automation reader")
    parser.add_argument("--read", action="store_true", required=True)
    parser.add_argument("--days", type=int, default=5)
    parser.add_argument(
        "--launch",
        action="store_true",
        help="Start the app and wait for its window when it is not open yet.",
    )
    parser.add_argument(
        "--no-refresh",
        action="store_true",
        help="Read whatever the app already has instead of refreshing it first.",
    )
    # La página tarda ~11 s en pintar tras arrancar; 30 deja margen sin agotar
    # el presupuesto de 90 s del endpoint aunque haya que reciclar la app.
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def process_name(pid: int) -> str:
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    handle = kernel32.OpenProcess(0x0410, False, pid)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(260)
        if psapi.GetModuleBaseNameW(handle, None, buffer, 260):
            return buffer.value.strip().lower()
    finally:
        kernel32.CloseHandle(handle)
    return ""


def hosted_process_name(hwnd: int) -> str:
    """Process behind the CoreWindow a UWP frame hosts, or '' when there is none."""
    user32 = ctypes.windll.user32
    found: List[int] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(child, _lparam):
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child, class_name, 256)
        if class_name.value == CORE_WINDOW_CLASS:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(child, ctypes.byref(pid))
            found.append(int(pid.value))
            return False
        return True

    user32.EnumChildWindows(hwnd, callback_type(callback), 0)
    return process_name(found[0]) if found else ""


def find_weather_window() -> Optional[Dict[str, Any]]:
    user32 = ctypes.windll.user32
    windows: List[Dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        owner = process_name(int(pid.value))
        if owner != WEATHER_PROCESS:
            if owner != FRAME_HOST_PROCESS:
                return True
            if hosted_process_name(hwnd) != WEATHER_PROCESS:
                return True
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(max(1, length + 1))
        user32.GetWindowTextW(hwnd, title, len(title))
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, 256)
        windows.append(
            {
                "handle": int(hwnd),
                "title": title.value,
                "className": class_name.value,
                # El marco de ApplicationFrameHost es el único que expone el
                # árbol. Un CoreWindow suelto —la app arrancó sin marco o se
                # quedó huérfana— se ve, pero no tiene nada dentro.
                "framed": class_name.value == "ApplicationFrameWindow",
                "area": max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top),
            }
        )
        return True

    user32.EnumWindows(callback_type(callback), 0)
    if not windows:
        return None
    real = [window for window in windows if "splash" not in normalize(window["title"])]
    pool = real or windows
    return max(pool, key=lambda window: (window["framed"], window["area"]))


def recycle_weather_app() -> None:
    """
    Cierra la app del todo y la vuelve a abrir.

    Es el único remedio cuando queda una ventana huérfana: un `CoreWindow` sin
    su marco no tiene árbol de accesibilidad y no hay espera que lo arregle.
    Solo se intenta una vez por invocación, y solo sobre esta app.
    """
    subprocess.run(
        ["taskkill", "/F", "/IM", "Microsoft.Msn.Weather.exe"],
        capture_output=True,
        check=False,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    time.sleep(1.5)
    ctypes.windll.shell32.ShellExecuteW(
        None, "open", f"shell:AppsFolder\\{WEATHER_AUMID}", None, None, 1
    )


def ensure_window_shown(hwnd: int) -> None:
    """
    Saca la ventana de minimizada.

    Windows SUSPENDE una app UWP minimizada, y una app suspendida no realiza su
    WebView: el árbol de accesibilidad se queda en un único nodo vacío y toda la
    lectura falla con `weather_page_not_loaded`. Restaurarla es la única forma
    de que exista algo que leer.
    """
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(1.2)


def ensure_weather_window(launch: bool, timeout: float) -> Optional[Dict[str, Any]]:
    window = find_weather_window()
    if window is not None or not launch:
        return window

    ctypes.windll.shell32.ShellExecuteW(
        None, "open", f"shell:AppsFolder\\{WEATHER_AUMID}", None, None, 1
    )
    deadline = time.monotonic() + max(30.0, timeout)
    while time.monotonic() < deadline:
        time.sleep(0.5)
        window = find_weather_window()
        if window is not None:
            return window
    return None


def walk(root, max_depth: int = 34, max_nodes: int = 6000) -> List[Any]:
    """Depth-first, in document order, so the first hit of an id is the live one."""
    output: List[Any] = []
    stack: List[Tuple[Any, int]] = [(root, 0)]
    while stack and len(output) < max_nodes:
        node, depth = stack.pop()
        output.append(node)
        if depth >= max_depth:
            continue
        for child in reversed(safe(lambda: node.GetChildren(), []) or []):
            stack.append((child, depth + 1))
    return output


def node_name(node) -> str:
    return str(safe(lambda: node.Name, "") or "")


def node_id(node) -> str:
    return str(safe(lambda: node.AutomationId, "") or "")


def node_type(node) -> str:
    return str(safe(lambda: node.ControlTypeName, "") or "").replace("Control", "").lower()


def first_by_id(nodes: List[Any], automation_id: str) -> Optional[Any]:
    # The page renders a second, hidden copy of every section for narrow layouts.
    # Document order puts the live one first, so never scan backwards.
    for node in nodes:
        if node_id(node) == automation_id:
            return node
    return None


def control_from_window(auto, window: Dict[str, Any]) -> Tuple[Any, Dict[str, Any]]:
    """UIA root, re-resolving the handle when a cold start swaps windows."""
    root = safe(lambda: auto.ControlFromHandle(window["handle"]))
    if root is not None:
        return root, window
    current = find_weather_window()
    if current is None:
        return None, window
    return safe(lambda: auto.ControlFromHandle(current["handle"])), current


def refresh_page(auto, window: Dict[str, Any]) -> bool:
    """
    Press the app's own Refresh command.

    Without this the app serves whatever it fetched when it first started: the
    process stays resident after its window closes, so reopening it does NOT
    re-read the forecast and the observation time can be hours old.

    Only the invoke pattern is used, never a synthesized click: a click would
    move the real cursor and take input away from whatever the user is doing.
    """
    root, _window = control_from_window(auto, window)
    if root is None:
        return False
    button = first_by_id(walk(root, max_depth=14, max_nodes=2000), REFRESH_COMMAND_ID)
    if button is None:
        return False
    if safe(lambda: button.GetInvokePattern().Invoke(), "failed") == "failed":
        return False
    time.sleep(1.5)
    return True


def wait_for_page(
    auto, window: Dict[str, Any], timeout: float
) -> Tuple[List[Any], Dict[str, Any], str]:
    """
    The shell paints before the forecast does; poll until the overview exists.

    Devuelve el motivo del fallo en vez de abortar, para que quien llama decida
    si vale la pena reciclar la app y volver a intentarlo.
    """
    deadline = time.monotonic() + max(3.0, timeout)
    restored = False
    while True:
        root, window = control_from_window(auto, window)
        nodes = walk(root) if root is not None else []
        if first_by_id(nodes, OVERVIEW_ID) is not None:
            return nodes, window, ""
        # Un árbol de uno o dos nodos es la firma de una ventana sin marco o de
        # una UWP suspendida, no de una página cargando: esperar no la despierta.
        empty = len(nodes) <= 2
        if empty and not restored:
            restored = True
            ensure_window_shown(window["handle"])
        if time.monotonic() >= deadline:
            return (
                nodes,
                window,
                "weather_window_not_readable" if empty else "weather_page_not_loaded",
            )
        time.sleep(0.6)


def texts_under(node, max_depth: int = 8) -> List[str]:
    return [
        clean(node_name(child))
        for child in walk(node, max_depth=max_depth, max_nodes=400)
        if node_type(child) == "text" and clean(node_name(child))
    ]


def read_location_text(nodes: List[Any], section) -> str:
    holder = (
        first_by_id(walk(section, max_depth=6, max_nodes=200), LOCATION_ID)
        if section is not None
        else None
    )
    if holder is not None:
        # Two nested blocks carry the place: the outer one appends the "set as
        # primary location" affordance, the inner one is the bare name.
        names = [name for name in texts_under(holder, max_depth=6) if name]
        if names:
            return min(names, key=len)

    # Fallback: "Pronóstico meteorológico de <place> | MSN El Tiempo".
    page = first_by_id(nodes, ROOT_WEB_AREA_ID)
    title = clean(node_name(page), 200) if page is not None else ""
    if "|" in title:
        title = title.split("|", 1)[0].strip()
    return re.sub(r"^[^:]*?\bde\s+", "", title, count=1).strip() if title else ""


def read_temperature(section) -> Tuple[str, str]:
    """(temperature, condition) from the big current-conditions block."""
    holder = first_by_id(walk(section, max_depth=6, max_nodes=200), TEMPERATURE_ID)
    if holder is None:
        return "", ""
    temperature = ""
    condition = ""
    for node in walk(holder, max_depth=6, max_nodes=200):
        name = clean(node_name(node), 60)
        if not name:
            continue
        kind = node_type(node)
        if not temperature and kind == "hyperlink" and TEMPERATURE_PATTERN.search(name):
            temperature = name
        elif not condition and kind == "image":
            condition = name
    if not condition:
        for name in texts_under(holder):
            if not TEMPERATURE_PATTERN.search(name) and not name.strip("°").isdigit():
                condition = name
                break
    return temperature, condition


def read_metrics(section, temperature: str) -> List[str]:
    """The one-line readings under the temperature: wind, humidity, UV, ..."""
    metrics: List[str] = []
    seen = set()
    for node in walk(section, max_depth=6, max_nodes=400):
        if node_type(node) != "hyperlink":
            continue
        name = clean(node_name(node), 80)
        key = normalize(name)
        if not name or key in seen or name == temperature:
            continue
        # A bare "28 °C" is the temperature link, already reported on its own.
        if TEMPERATURE_PATTERN.fullmatch(name.replace(" ", "")):
            continue
        seen.add(key)
        metrics.append(name)
    return metrics[:12]


def read_observed_at(section) -> str:
    for name in texts_under(section, max_depth=6):
        if TIME_PATTERN.match(name):
            return name
    return ""


def join_readings(names) -> str:
    """
    Value cards arrive as loose tokens ("7:00", "AM", "Amanecer"). Re-joining a
    meridiem onto its time keeps the result speakable instead of a list of
    fragments.
    """
    parts: List[str] = []
    for name in names:
        if parts and MERIDIEM_PATTERN.fullmatch(name) and TIME_PATTERN.match(parts[-1]):
            parts[-1] = f"{parts[-1]} {name}"
            continue
        if name not in parts:
            parts.append(name)
    return clean(" · ".join(parts))


def read_details(nodes: List[Any]) -> List[Dict[str, str]]:
    """
    The "Detalles del tiempo" cards. Each one already carries a written summary
    ("Subirá hasta llegar a un pico de 31° a la(s) 16:00."), which is what makes
    this worth reading aloud instead of reciting numbers.
    """
    section = first_by_id(nodes, DETAILS_ID)
    if section is None:
        return []
    details: List[Dict[str, str]] = []
    seen = set()
    for card in walk(section, max_depth=6, max_nodes=1200):
        if node_type(card) != "listitem":
            continue
        names = texts_under(card, max_depth=8)
        if not names:
            continue
        label = names[0]
        key = normalize(label)
        if not label or key in seen:
            continue
        # Most cards carry a written narrative, which is always the longest
        # string in them. Sun, moon and moon-phase are value cards instead —
        # sunrise and sunset are worth reading, so they fall back to their
        # readings rather than being dropped for having no sentence.
        summary = max(names, key=len)
        if len(summary) < MIN_NARRATIVE_CHARS or summary == label:
            summary = join_readings(name for name in names[1:] if name != label)
        if not summary:
            continue
        seen.add(key)
        details.append({"label": label, "summary": summary})
        if len(details) >= MAX_DETAILS:
            break
    return details


def read_forecast(nodes: List[Any], days: int) -> List[Dict[str, Any]]:
    section = first_by_id(nodes, FORECAST_ID)
    if section is None:
        return []
    forecast: List[Dict[str, Any]] = []
    seen = set()
    for node in walk(section, max_depth=8, max_nodes=1200):
        if node_type(node) != "tabitem":
            continue
        match = FORECAST_PATTERN.match(clean(node_name(node), 80))
        if not match:
            continue
        day, label, high, low = match.groups()
        key = f"{day}|{normalize(label)}"
        if key in seen:
            continue
        seen.add(key)
        forecast.append(
            {
                "day": int(day),
                "label": clean(label, 40),
                "high": int(high),
                "low": int(low),
            }
        )
        if len(forecast) > MAX_FORECAST_DAYS:
            break

    # The strip opens on yesterday so the user can compare; a spoken forecast
    # must not start by reading a day that has already happened.
    today = next(
        (
            index
            for index, entry in enumerate(forecast)
            if normalize(entry["label"]) in TODAY_LABELS
        ),
        None,
    )
    if today is not None:
        forecast = forecast[today:]
    else:
        forecast = [
            entry for entry in forecast if normalize(entry["label"]) not in PAST_DAY_LABELS
        ]
    return forecast[: max(1, min(MAX_FORECAST_DAYS, days))]


def read_precipitation_outlook(nodes: List[Any]) -> str:
    section = first_by_id(nodes, MINI_MAP_ID)
    if section is None:
        return ""
    for name in texts_under(section, max_depth=8):
        if PRECIPITATION_PATTERN.search(name) and len(name) > 15:
            return name
    return ""


def read_alerts(nodes: List[Any]) -> List[str]:
    """
    Best effort: MSN only renders a severe-weather banner when one is active, so
    this is keyed off the element id rather than translated text. Matching by id
    also keeps the ad slots, which sit between the sections, out of the result.
    """
    alerts: List[str] = []
    seen = set()
    for node in nodes:
        if not ALERT_ID_PATTERN.search(node_id(node)):
            continue
        name = clean(node_name(node))
        key = normalize(name)
        if len(name) < 12 or key in seen:
            continue
        seen.add(key)
        alerts.append(name)
    return alerts[:4]


def read_app_version(nodes: List[Any]) -> str:
    for node in nodes:
        if node_name(node) == APP_VERSION_ID_PREFIX:
            return clean(node_id(node), 40)
    return ""


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "windows_only"}, 2)
    try:
        import uiautomation as auto  # type: ignore
    except ImportError:
        emit({"ok": False, "error": "uiautomation_not_installed"}, 2)

    args = parse_args()
    window = ensure_weather_window(args.launch, args.timeout)
    if window is None:
        emit(
            {
                "ok": False,
                "error": "weather_app_not_available"
                if args.launch
                else "weather_app_not_running",
            },
            2,
        )

    ensure_window_shown(window["handle"])
    # Cargar PRIMERO y refrescar después: pulsar Actualizar sobre una página que
    # todavía no existe renavega el WebView y deja la lectura sin nada que leer.
    nodes, window, failure = wait_for_page(auto, window, args.timeout)

    if failure and args.launch:
        # Dos estados distintos, mismo remedio y misma imposibilidad de salir
        # esperando: la ventana huérfana sin árbol, y el WebView encallado en
        # `about:blank`. Se recicla la app UNA vez y se reintenta.
        recycle_weather_app()
        recycled = ensure_weather_window(True, args.timeout)
        if recycled is None:
            emit({"ok": False, "error": "weather_app_not_available"}, 2)
        window = recycled
        ensure_window_shown(window["handle"])
        nodes, window, failure = wait_for_page(auto, window, args.timeout)

    if failure:
        emit({"ok": False, "error": failure}, 2)

    refreshed = False
    if not args.no_refresh and refresh_page(auto, window):
        refreshed = True
        refreshed_nodes, window, refresh_failure = wait_for_page(
            auto, window, min(args.timeout, 15.0)
        )
        # Si el refresco dejó la página peor, se lee lo que ya se tenía.
        if not refresh_failure:
            nodes = refreshed_nodes
    # Las fichas de "Detalles" se pintan por debajo del pliegue y llegan tarde:
    # justo tras un refresco se leen 8 de 13 y la narrativa sale coja. Se
    # reintenta un par de veces y se conserva la lectura más completa.
    details = read_details(nodes)
    for _attempt in range(3):
        if len(details) >= EXPECTED_DETAIL_CARDS:
            break
        time.sleep(1.2)
        root, window = control_from_window(auto, window)
        if root is None:
            break
        retried_nodes = walk(root)
        retried = read_details(retried_nodes)
        if len(retried) > len(details):
            details = retried
            nodes = retried_nodes

    overview = first_by_id(nodes, OVERVIEW_ID)
    temperature, condition = read_temperature(overview)
    page = first_by_id(nodes, ROOT_WEB_AREA_ID)

    emit(
        {
            "ok": True,
            "source": "msn-weather-app",
            "refreshed": refreshed,
            "appVersion": read_app_version(nodes),
            "location": read_location_text(nodes, overview),
            "observedAt": read_observed_at(overview),
            "temperature": temperature,
            "condition": condition,
            "metrics": read_metrics(overview, temperature),
            "precipitationOutlook": read_precipitation_outlook(nodes),
            "alerts": read_alerts(nodes),
            "forecast": read_forecast(nodes, args.days),
            "details": read_details(nodes),
            "pageTitle": clean(node_name(page), 200) if page is not None else "",
        }
    )


if __name__ == "__main__":
    main()
