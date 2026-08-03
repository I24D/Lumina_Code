# Lumina Cognitive OS

OpenClaw extension that implements **Niveles 1-12** of the Codex roadmap.

Every capability is exposed as an agent tool. The user invokes them by
voice via **Start Talk** — there is no separate CLI surface.

## Tools (registered with the agent)

| Nivel | Tool | Purpose |
|------:|------|---------|
| 1 | `lumina_awareness_snapshot` | Unified env snapshot (CPU/RAM/GPU/battery/disks/devices/monitors/network). |
| 1 | `lumina_awareness_subscribe` | Recent environment-change events. |
| 2 | `lumina_working_memory_get` / `_set` | "What is the user doing right now?" |
| 2 | `lumina_episodic_remember` / `_recall` | Time-stamped log of actions. |
| 3 | `lumina_vision_ui_tree` | UIA tree of the foreground window. |
| 3 | `lumina_vision_multimonitor` | Captures every attached display. |
| 4 | `lumina_browser_drive` | Persistent Chromium via Playwright. |
| 4 | `lumina_action_plan` | Multi-step plan registration. |
| 5 | `lumina_director_route` | Picks one of 12 named agents for an intent. |
| 8 | `lumina_transparency_publish` / `_recent` | Real-time activity log. |
| 9 | `lumina_intent_run` | Matches an utterance to a pre-built recipe. |
| 10 | `lumina_risk_evaluate` / `_recent` | 4-tier risk classifier. |
| 11 | `lumina_gmail` / `_calendar` / `_drive` | Google integration. |
| 12 | `lumina_boot_greeting` | Morning briefing phrase. |
| 12 | `lumina_wake_word` | Wake-word detector daemon. |

## Configuration

Plugin config (per `openclaw.plugin.json`):

```json
{
  "enabled": true,
  "envPath": "c:/I24D_WhatsApp/.env",
  "awarenessIntervalMs": 15000,
  "wakeWordEnabled": false,
  "wakeWordModel": "hey_jarvis_v0.1",
  "bootGreetingEnabled": true,
  "browserDriverEnabled": false
}
```

`browserDriverEnabled` and `wakeWordEnabled` default to **off** because
they require Python deps. Enable after running `pip install -r
sidecars/requirements.txt`.

## Environment variables

Read from `c:/I24D_WhatsApp/.env` only:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` —
  Required for `lumina_gmail`, `lumina_calendar`, `lumina_drive`.
- `LUMINA_PYTHON` — Optional override for the Python interpreter used by
  sidecars.

## Files

```
extensions/lumina-cognitive-os/
├── index.ts                    plugin entry — registers everything
├── openclaw.plugin.json
├── package.json
├── README.md                   this file
├── sidecars/
│   ├── README.md
│   ├── requirements.txt
│   ├── uia_tree.py
│   ├── browser_drive.py
│   └── wake_word.py
└── src/
    ├── env.ts                  reads c:/I24D_WhatsApp/.env
    ├── shared/                 powershell/python/tool-result helpers
    ├── risk/                   Nivel 10
    ├── awareness/              Nivel 1
    ├── memory/                 Nivel 2
    ├── vision/                 Nivel 3
    ├── action/                 Nivel 4
    ├── agents/                 Nivel 5 — 12 named specialists + Director
    ├── automation/             Nivel 9 — intent router + 9 templates
    ├── mcp/                    Nivel 11 — Gmail/Calendar/Drive
    ├── presence/               Nivel 12 — boot greeting + wake-word
    └── transparency/           Nivel 8 — activity log
```

UI additions live alongside the existing chat code:

- `ui/src/ui/chat/realtime-talk-shared.ts` — Nivel 6 expanded states
  + `REALTIME_TALK_STATE_VISUALS` table.
- `ui/src/ui/chat/mascot-lifelike-controller.ts` — Nivel 7 expressions.
- `ui/src/styles/chat/voice-overlay.css` — appended Nivel 6/7 CSS rules.
- `ui/src/ui/chat/transparency-panel.ts` + `ui/src/styles/chat/transparency-panel.css`
  — Nivel 8 panel.

## Voice flow

1. The user speaks. Start Talk transcribes.
2. Agent calls `lumina_intent_run` — if a template matches, follow the
   recipe; otherwise call `lumina_director_route` to pick a specialist.
3. Agent calls `lumina_transparency_publish` before each side-effect.
4. Agent calls `lumina_risk_evaluate` for any action with side-effects;
   on `HIGH_RISK`/`CRITICAL`, ask the user out loud.
5. After execution, agent calls `lumina_episodic_remember` so the user
   can later ask "qué hice X".
