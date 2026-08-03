# Lumina Cognitive OS — Python sidecars

These scripts back the tools that need libraries Node.js doesn't offer
natively on Windows.

## One-time setup

```powershell
# From this folder
python -m pip install -r requirements.txt
playwright install chromium
```

Optionally point Lumina at a specific interpreter via `c:/I24D_WhatsApp/.env`:

```
LUMINA_PYTHON=C:\\Python312\\python.exe
```

## Sidecars

| Script           | Tool                          | Notes |
|------------------|-------------------------------|-------|
| `uia_tree.py`    | `lumina_vision_ui_tree`       | Walks the Windows UI Automation tree of the foreground window. |
| `browser_drive.py` | `lumina_browser_drive`       | Persistent Chromium profile via Playwright. |
| `wake_word.py`   | `lumina_wake_word`            | Continuous wake-word detection (default model `hey_jarvis_v0.1`). |

All sidecars print one JSON object to stdout and exit. The TS callers
parse stdout and surface any error in the tool result so Start Talk can
read the explanation aloud.
