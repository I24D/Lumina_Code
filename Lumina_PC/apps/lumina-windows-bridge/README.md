# Lumina Windows Bridge Dev

Local Windows-first bridge for Lumina development. It runs as a normal
foreground process and exposes a localhost-only HTTP API for native Windows
actions.

Start it from the repo root:

```powershell
npm run bridge:dev
```

Default port comes from the canonical `I24D_WhatsApp/.env` (one level above this repo):

```text
LUMINA_BRIDGE_PORT=8765
```

Endpoints:

- `GET /health`
- `GET /processes`
- `GET /camera_devices`
- `GET /logs`
- `POST /open_application`
- `POST /open_settings`
- `POST /execute_powershell_safe`
- `POST /screenshot`
- `POST /clipboard`
- `POST /notify_toast`
- `POST /window_control`
- `POST /input_control`
- `POST /alarms`
- `POST /input`
- `GET /phone_link/status`
- `POST /phone_link/reply`

`POST /window_control` supports:

- `list`: list visible desktop windows.
- `focus`: focus a visible window by partial title.
- `launch`: launch an app by alias or fuzzy Start Menu match.
- `close`: close by `pid`, partial `title`, or `processName`.
- `discover`: list installed Start Menu applications.

`POST /input_control` is the preferred mouse/keyboard endpoint. It supports
`mouse_move`, `mouse_click`, `mouse_scroll`, `mouse_drag`, `type_text`,
`key_press`, and `shortcut`. It requires `allowedApps` so input only runs when
the foreground process is expected.

`POST /alarms` supports:

- `create`: registers a Windows Scheduled Task under `\Lumina\` with wake enabled, toast alarm UI, speech, and repeated sound.
- `list`: lists Lumina alarms currently registered in Windows.
- `cancel`: unregisters an alarm by id.
- `test`: runs a short local alarm test without leaving a scheduled task.

`GET /phone_link/status` inspects the public Windows UI Automation surface of
Phone Link and reports whether the paired phone and notification feed are
available. `POST /phone_link/reply` replies to one exact visible direct-message
notification. It uses sender and message text as the UI identity and never uses
screen coordinates.

Phone Link replies are deny-by-default: group and aggregate notifications,
ambiguous context, sensitive content, links, money, purchases, appointments,
addresses, and context mismatches are rejected before UI Automation runs. Raw
message and reply text are omitted from the Bridge audit log.

The bridge blocks destructive PowerShell by default, validates every pipeline
segment in `execute_powershell_safe`, honors `timeout_ms`, and writes JSONL
audit logs under `logs/lumina-windows-bridge-audit.jsonl`.
