# Lumina Cognitive OS — Niveles 1-12 entregados

Resumen de lo construido el 2026-06-23. Todo es **TypeScript** y **Python**, ningún `.js` ni `.mjs` nuevo. Todas las capacidades nuevas son **tools del agente** invocables por voz desde **Start Talk**.

## Estructura nueva

```
Lumina_PC/Open_PC/extensions/lumina-cognitive-os/    ← extensión nueva
├── README.md
├── index.ts                      ← registra TODAS las tools
├── openclaw.plugin.json
├── package.json
├── sidecars/                     ← Python (UI Automation, Playwright, openwakeword)
│   ├── README.md
│   ├── requirements.txt
│   ├── uia_tree.py
│   ├── browser_drive.py
│   └── wake_word.py
└── src/
    ├── env.ts                    ← lee c:/I24D_WhatsApp/.env (regla del usuario)
    ├── shared/{powershell,python,tool-result}.ts
    ├── risk/                     ← Nivel 10
    ├── awareness/                ← Nivel 1
    ├── memory/                   ← Nivel 2
    ├── vision/                   ← Nivel 3
    ├── action/                   ← Nivel 4
    ├── agents/                   ← Nivel 5 (catalog de 12 + Director)
    ├── automation/               ← Nivel 9 (9 plantillas)
    ├── mcp/                      ← Nivel 11 (google-auth + gmail/calendar/drive)
    ├── presence/                 ← Nivel 12 (boot greeting + wake-word)
    └── transparency/             ← Nivel 8 (activity log + tools)
```

Cambios incrementales en la UI (no destructivos):

- `ui/src/ui/chat/realtime-talk-shared.ts` — type `RealtimeTalkStatus` extendido a 13 estados + tabla `REALTIME_TALK_STATE_VISUALS`.
- `ui/src/ui/chat/mascot-lifelike-controller.ts` — `MascotControllerState` extendido a 10 estados; loop publica `--lumina-eye-narrow`, `--lumina-halo-amp`, `--lumina-iris-pulse`, `--lumina-body-shake` y `data-mascot-state`.
- `ui/src/styles/chat/voice-overlay.css` — bloque appended con reglas por estado.
- `ui/src/ui/chat/voice-overlay.ts` — usa la tabla de visuales para etiquetas / sonidos / estado del mascot.
- `ui/src/ui/chat/transparency-panel.ts` (nuevo) + `ui/src/styles/chat/transparency-panel.css` (nuevo) — Nivel 8.

## Tools nuevas (todas voz-first)

| Nivel | Tool | Qué hace |
|------:|------|---------|
| 1 | `lumina_awareness_snapshot` | Snapshot unificado CPU/RAM/GPU/batería/discos/dispositivos/monitores/red |
| 1 | `lumina_awareness_subscribe` | Eventos recientes del entorno (batería baja, red caída, monitor enchufado) |
| 2 | `lumina_working_memory_get` / `_set` | Qué está haciendo el usuario ahora (proyecto/ventana/archivo/intent/5 pinned) |
| 2 | `lumina_episodic_remember` / `_recall` | Bitácora episódica por tiempo / tag / kind / substring |
| 3 | `lumina_vision_ui_tree` | Árbol UI Automation de la ventana foreground (Python: `uiautomation`) |
| 3 | `lumina_vision_multimonitor` | Captura **todos** los monitores |
| 4 | `lumina_browser_drive` | Chromium persistente vía Playwright (goto/click/type/screenshot/read) |
| 4 | `lumina_action_plan` | Registrar plan multi-paso validado |
| 5 | `lumina_director_route` | Enruta intent a 1 de 12 agentes nombrados (Atlas/Mira/Postino/Horus/Nimbus/Vidrio/Soren/Bit/Vault/Iris/Vox/Forge) |
| 8 | `lumina_transparency_publish` / `_recent` | Bitácora visible para el panel "qué está haciendo Lumina ahora" |
| 9 | `lumina_intent_run` | Matchea utterance contra 9 plantillas (organiza mi día, revisa correos, agenda reunión, etc) |
| 10 | `lumina_risk_evaluate` / `_recent` | Clasificador 4-tier SAFE/WARNING/HIGH_RISK/CRITICAL antes de cada acción |
| 11 | `lumina_gmail` | list/read/send/draft/label vía Gmail v1 |
| 11 | `lumina_calendar` | list/create/update/delete/freeBusy vía Calendar v3 |
| 11 | `lumina_drive` | search/read/upload/share vía Drive v3 |
| 12 | `lumina_boot_greeting` | Frase de saludo con correos + agenda + sistema |
| 12 | `lumina_wake_word` | status/probe/start/stop del daemon Python (openwakeword) |

## Variables de entorno (en `c:/I24D_WhatsApp/.env`)

Agregar si faltan:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
LUMINA_PYTHON=C:\\Python312\\python.exe   # opcional, si quieres forzar versión
```

Los tools de Google fallan con error claro si faltan — no rompen el plugin.

## Para activar lo que necesita Python

```powershell
cd c:\I24D_WhatsApp\Lumina_PC\Open_PC\extensions\lumina-cognitive-os\sidecars
python -m pip install -r requirements.txt
playwright install chromium
```

Luego en la config del plugin (UI de OpenClaw) activar:

```json
{
  "browserDriverEnabled": true,
  "wakeWordEnabled": true
}
```

## Tests

`vitest` corre desde la raíz del workspace. Los nuevos tests:

- `src/risk/policies.test.ts` — Risk engine 4-tier
- `src/awareness/snapshot.test.ts` — Diff de snapshots
- `src/memory/working-memory.test.ts` — Persistencia working memory
- `src/agents/director.test.ts` — Routing de intents a agentes
- `src/automation/templates.test.ts` — Match de plantillas
- `src/action/planner.test.ts` — Validación de planes

## Flujo voz-first típico

1. Usuario dice (Start Talk): "Lumina, organiza mi día"
2. Agente → `lumina_intent_run({ utterance })` → match `organiza-mi-dia` → recipe de 4 pasos
3. Agente → `lumina_transparency_publish({ category:"intent", summary:"Voy a organizar tu día" })`
4. Agente → `lumina_calendar({ action:"list" })`, `lumina_gmail({ action:"list", query:"is:unread newer_than:1d" })`, `lumina_episodic_recall(...)`
5. Para cualquier acción con side-effect: `lumina_risk_evaluate(...)`; si HIGH_RISK/CRITICAL → pregunta al usuario en voz alta
6. Antes de cada paso real: `lumina_transparency_publish(...)` para que la UI muestre la intención
7. Tras ejecutar: `lumina_episodic_remember(...)` para poder responder después a "¿qué hice esta mañana?"

## Avatar y estados (Nivel 6 + 7)

Status nuevos en Start Talk: `idle, dormant, connecting, listening, understanding, thinking, planning, executing, waiting, speaking, alert, emergency, error` (13 en total).

El avatar reacciona con `data-mascot-state` + 4 CSS vars publicadas por `mascot-lifelike-controller.ts`. Expresiones nuevas: `searching`, `executing`, `learning`, `error`, `alert`.

Sonidos por estado: opcionales en `ui/public/sounds/{connect,listen,execute,alert,emergency,error}.mp3`. Si no existen, no se reproduce nada (fallback silencioso).

## Lo que no se tocó (intencional)

- `lumina-pc/`, `lumina-presence/`, `lumina-observation/`, `lumina-input-control/`, `lumina-memory/` — siguen tal cual; la nueva extensión coexiste.
- Los `setup.exe` del repo — no se compilaron ni modificaron, como pediste.
- La UI Vite + Gateway WSL del setup actual — sólo se agregaron archivos nuevos al `ui/src/`; nada se reemplazó.

## Próximo paso sugerido

Ejecutar `pnpm install` en `Lumina_PC/Open_PC` para que el monorepo descubra el nuevo paquete `@openclaw/lumina-cognitive-os`. Luego habilitar el plugin desde la UI de OpenClaw — la flag `enabled` viene en true por defecto, las features que necesitan Python (`browserDriverEnabled`, `wakeWordEnabled`) en false.
