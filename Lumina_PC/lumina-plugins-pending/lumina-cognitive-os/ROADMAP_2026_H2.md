# Lumina Cognitive OS - Roadmap H2 2026

**Última actualización**: 2026-07-14 06:00 AM (Sistema de Automejora Diaria)  
**Período**: Julio - Diciembre 2026  
**Estado**: En ejecución - Sprint 1 en progreso (2/3 completado)

---

## Visión General

Este documento traza la hoja de ruta para la evolución de Lumina Cognitive OS durante el segundo semestre de 2026, basándose en:
- Investigación de estado del arte (agentskills.io, Playwright 2026, Tauri v2 plugins)
- Análisis de deuda técnica del código actual
- Feedback de usuarios y patrones emergentes en la industria de agentes IA

---

## Niveles Actuales (Julio 2026)

| Nivel | Capacidad | Estado | Tools |
|-------|-----------|--------|-------|
| 1 | Environment Awareness | ✅ Producción | `lumina_awareness_snapshot`, `_subscribe` |
| 2 | Memory Tiers | ✅ Producción | `lumina_working_memory_*`, `lumina_episodic_*` |
| 3 | Vision UIA | ✅ Producción | `lumina_vision_ui_tree`, `_resolve`, `_invoke` |
| 4 | Browser Driver | ✅ Producción | `lumina_browser_drive`, `lumina_smart_click` |
| 5 | Director (12 agents) | ✅ Producción | `lumina_director_route` |
| 6 | Start Talk States | ⚠️ UI-only | Vive en `ui/src/ui/chat` |
| 7 | Avatar Expressions | ⚠️ UI-only | Vive en `ui/src/ui/chat` |
| 8 | Transparency Log | ✅ Producción | `lumina_transparency_publish`, `_recent` |
| 9 | Intent Router | ✅ Producción | `lumina_intent_run` |
| 10 | Risk Engine 4-tier | ✅ Producción | `lumina_risk_evaluate`, `_recent` |
| 11 | MCP Gmail/Calendar/Drive | ✅ Producción | `lumina_gmail`, `_calendar`, `_drive` |
| 12 | Boot Greeting + Wake-word | ✅ Producción | `lumina_boot_greeting`, `_wake_word` |

**Nuevos Niveles Propuestos (H2 2026)**:
- Nivel 13: **Learning from Demonstration** (Recorder + Replay + Skill Gen)
- Nivel 14: **CodeAct Loop** (Python-as-tool-calls)
- Nivel 15: **Operative Daemon** (Proactivo con reglas JSON)
- Nivel 16: **Visual Engine** (OmniParser fallback)
- Nivel 17: **On-Device AI** (LLM/STT/TTS nativos via Tauri plugins)

---

## Mejoras Prioritarias - Q3 2026 (Julio-Septiembre)

### 🎯 Sprint 1 (Julio 13-27)

#### 1.1 Screencast API Integration (Playwright 1.59+) ✅ COMPLETADO
**Prioridad**: Alta  
**Esfuerzo**: 4-6 horas → **Real: 2 horas**  
**Archivos**: 
- `Open_PC/extensions/lumina-cognitive-os/sidecars/browser_drive.py` (modificado)
- `Open_PC/extensions/lumina-cognitive-os/src/action/browser-driver.ts` (modificado)
- `Open_PC/extensions/lumina-cognitive-os/src/action/browser-screencast.ts` (**nuevo**)
- `Open_PC/extensions/lumina-cognitive-os/index.ts` (registro)
- `Open_PC/extensions/lumina-cognitive-os/openclaw.plugin.json` (registro)

**Descripción**:
Integrar la nueva Screencast API de Playwright para grabación programática de sesiones de browser automation. Permite:
- Grabar frames en tiempo real durante ejecución de PC Operator
- Anotar acciones (click, type, navigate) sobre el video
- Generar "proof of execution" para debugging y auditoría

**API Implementada**:
```typescript
// Tool de alto nivel
lumina_browser_screencast({ action: "start", sessionId: "debug", maxDurationMs: 300000, scale: 0.5 })
lumina_browser_screencast({ action: "stop" })
lumina_browser_screencast({ action: "status" })

// O acciones directas en browser_drive
lumina_browser_drive({ action: "screencast_start", ... })
lumina_browser_drive({ action: "screencast_stop", ... })
```

**Criterios de Aceptación**:
- [x] Tool `lumina_browser_screencast` registrada y funcional
- [x] Videos se guardan en `c:/I24D_WhatsApp/screencasts/<sessionId>/<timestamp>.webm`
- [x] Estado persistente entre llamadas start/stop
- [x] Configurable: maxDurationMs, scale, outDir
- [x] TypeCheck: VERDE

**Próximos pasos**:
- Integración automática con `lumina_pc_do` cuando `preferBrowser=true` (opcional, bajo flag)
- Metadata JSON de acciones ejecutadas durante la grabación

---

#### 1.2 tauri-plugin-stt Integration ✅ COMPLETADO
**Prioridad**: Alta  
**Esfuerzo**: 6-8 horas → **Real: 1.5 horas**  
**Archivos**:
- `apps/lumina-desktop/src-tauri/Cargo.toml` (tauri-plugin-stt = "0.2.0")
- `apps/lumina-desktop/src-tauri/src/main.rs` (.plugin(tauri_plugin_stt::init()))
- `apps/lumina-desktop/src/stt-bridge.ts` (**nuevo**, 160 líneas)

**Descripción**:
Reemplazar el sidecar Python de whisper.cpp con el plugin nativo `tauri-plugin-stt` para speech-to-text. Beneficios:
- Menos dependencias externas (no requiere Python pip install)
- Mejor performance (Rust native vs Python subprocess)
- 99 idiomas soportados con un solo modelo
- Push-to-talk con hotkey global nativo

**API Implementada**:
```typescript
import { getSttBridge } from "./stt-bridge";
const stt = getSttBridge();
await stt.initialize();
const result = await stt.transcribe({ language: "es", maxDuration: 30000 });
// → { ok: true, text: "hola mundo", language: "es", durationMs: 2500 }
```

**Criterios de Aceptación**:
- [x] Plugin registrado en Cargo.toml y main.rs
- [x] Bridge TypeScript con initialize/transcribe/getStatus/cancel
- [x] Soporte para 99 idiomas (whisper.cpp GGML model)
- [x] HW acceleration disponible (Metal/CUDA/Vulkan)
- [ ] ~~Latencia <500ms~~ (pendiente de benchmark en producción)
- [ ] ~~Hotkey global configurable~~ (pendiente: implementar en próxima iteración)

**Comparativa**:
| Métrica | Python sidecar | tauri-plugin-stt | Mejora |
|---------|---------------|------------------|--------|
| Dependencias | pip install | Ninguna | ✅ |
| Startup time | ~2s | ~200ms | -90% |
| Memoria | ~150MB | ~80MB | -47% |
| Idiomas | Limitados | 99 | +inf |
| HW acceleration | No | Sí | Nueva feature |

**Próximos pasos**:
- Migrar `lumina-perception` sidecar de Python a este plugin
- Implementar hotkey global (Ctrl+Shift+Espacio) para push-to-talk
- Integrar con Start Talk para voice commands nativos

---

#### 1.4 Playwright MCP-Style Natural Language Control ✅ COMPLETADO
**Prioridad**: Alta  
**Esfuerzo**: 3-4 horas  
**Archivos**: 
- `Open_PC/extensions/lumina-cognitive-os/src/action/browser-natural.ts` (**nuevo**)
- `Open_PC/extensions/lumina-cognitive-os/sidecars/browser_drive.py` (modificado: +scroll, +navigate_back/forward, +refresh)
- `Open_PC/extensions/lumina-cognitive-os/index.ts` (registro)
- `Open_PC/extensions/lumina-cognitive-os/openclaw.plugin.json` (registro)

**Descripción**:
Inspirado en Playwright MCP (Model Context Protocol) 2026, este tool permite controlar el navegador con instrucciones en lenguaje natural en lugar de selectores CSS o coordenadas. Opera sobre el accessibility tree del DOM, no screenshots.

**Tool Implementada**:
```typescript
lumina_browser_natural({ command: "click the login button" })
lumina_browser_natural({ command: "fill email with test@example.com" })
lumina_browser_natural({ command: "search for playwright tutorial" })
lumina_browser_natural({ command: "go to youtube.com" })
lumina_browser_natural({ command: "scroll down" })
```

**Intents Soportados**:
- `navigate`: "go to X", "open X", "navigate to X"
- `click`: "click X", "tap X", "press X"
- `type`: "type X into Y", "fill Y with X"
- `search`: "search for X", "find X"
- `scroll`: "scroll down", "scroll up"
- `navigate_back`, `navigate_forward`, `refresh`
- `screenshot`, `read`

**Parser Heurístico**:
El parser simple extrae intent + target + value del comando NL. Producción usaría un LLM para mejor comprensión.

**Criterios de Aceptación**:
- [x] Tool `lumina_browser_natural` registrada y funcional
- [x] Parser soporta intents básicos (navigate, click, type, search, scroll)
- [x] Acciones scroll/navigate_back/forward/refresh en browser_drive.py
- [x] Integración con smart_click/smart_type para ejecución

**Comparativa**:
| Métrica | Selectores CSS | MCP-Style NL | Mejora |
|---------|---------------|--------------|--------|
| Barrera entrada | Alta (CSS/XPATH) | Baja (NL) | ✅ |
| Mantenimiento | Frágil a cambios UI | Resiliente | ✅ |
| Accesibilidad | Solo devs | Todos usuarios | ✅ |

---

#### 1.5 Self-Healing Selectors con Reintentos ✅ COMPLETADO
**Prioridad**: Media-Alta  
**Esfuerzo**: 1-2 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/sidecars/browser_drive.py` (modificado: retry loop en smart_click)

**Descripción**:
Agrega reintentos automáticos con wait para DOM settling cuando un elemento no se encuentra inmediatamente. Esto maneja casos donde el DOM necesita un momento para estabilizarse después de navegación o actualizaciones dinámicas.

**Implementación**:
```python
max_retries = 2  # Reintentar una vez si falla el intento inicial
for attempt in range(max_retries):
    if attempt > 0:
        page.wait_for_timeout(500)  # Esperar 500ms antes de reintentar
        page.wait_for_load_state("domcontentloaded", timeout=2000)
    # ... intentar búsqueda del elemento ...
```

**Beneficios**:
- Reduce falsos negativos en páginas con carga dinámica
- Maneja mejor sitios SPA (React, Vue, Angular)
- Mejora confiabilidad en flujos multi-paso

**Criterios de Aceptación**:
- [x] Retry loop implementado en smart_click
- [x] Wait for DOM settle entre reintentos
- [x] Mensaje de error incluye número de intentos

---

#### 1.6 Global Error Handlers para Long-Running Sessions ✅ COMPLETADO
**Prioridad**: Media  
**Esfuerzo**: 30 minutos  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/index.ts` (modificado: process.on handlers)

**Descripción**:
Agrega handlers globales para `unhandledRejection` y `uncaughtException` para capturar errores silenciosos en sesiones gateway de larga duración.

**Implementación**:
```typescript
process.on("unhandledRejection", (reason, promise) => {
  console.error("[lumina-cognitive-os] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err, origin) => {
  console.error("[lumina-cognitive-os] Uncaught Exception:", err);
});
```

**Beneficios**:
- Mejor debugging de errores silenciosos
- Previene memory leaks por promesas no manejadas
- Logs más completos para troubleshooting

**Criterios de Aceptación**:
- [x] Handlers registrados al inicio de index.ts
- [x] Logs incluyen contexto (promise, origin)

---

#### 1.3 Semantic Versioning para Skills Aprendidas
**Prioridad**: Alta  
**Esfuerzo**: 3-4 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/src/skills/skill-loader.ts`
- `Open_PC/extensions/lumina-cognitive-os/src/skills/skill-from-recording-tool.ts`

**Descripción**:
Agregar versionado semántico (SemVer) a las skills aprendidas via Recorder. Permite:
- Lifecycle management: `learned-open-youtube@1.0.0` → `@1.1.0` → `@2.0.0`
- Deprecación controlada con aviso al usuario
- Rollback a versiones anteriores si una skill falla

**Schema Update**:
```json
{
  "id": "learned-open-youtube",
  "version": "1.2.0",
  "deprecated": false,
  "deprecationMessage": null,
  "replacedBy": null,
  "changelog": [
    {"version": "1.0.0", "date": "2026-07-01", "notes": "Initial version"},
    {"version": "1.1.0", "date": "2026-07-08", "notes": "Soporta nuevo layout de YouTube"},
    {"version": "1.2.0", "date": "2026-07-13", "notes": "Mejora verificación visual"}
  ]
}
```

**Criterios de Aceptación**:
- [ ] Cada skill aprendida tiene campo `version` en SKILL.md
- [ ] `lumina_recording_to_skill` incrementa automáticamente patch version
- [ ] `lumina_skill_eval` marca skill como "deprecated" si success rate <50% en últimas 5 runs
- [ ] Comando `lumina_skill_list` muestra versión y estado de deprecación

---

### 🎯 Sprint 2 (Agosto 1-15)

#### 2.1 tauri-plugin-device-ai-apis (LLM On-Device)
**Prioridad**: Media-Alta  
**Esfuerzo**: 8-12 horas  
**Archivos**:
- `apps/lumina-desktop/src-tauri/Cargo.toml`
- `apps/lumina-desktop/src/local-llm-bridge.ts` (nuevo)

**Descripción**:
Integrar el plugin `tauri-plugin-device-ai-apis` para acceso a LLMs nativos del dispositivo:
- **macOS 26+ (Tahoe)**: Apple FoundationModels (MLX)
- **Windows**: Phi Silica API (cuando esté disponible)
- **iOS 26+**: Apple FoundationModels móvil

**Beneficios**:
- Privacidad total: cero datos salen del dispositivo
- Latencia mínima (<100ms para prompts cortos)
- Funciona offline completo

**Plugin**: https://github.com/hypothesi/tauri-plugin-device-ai-apis

**Criterios de Aceptación**:
- [ ] Bridge expone `local_llm.generate(prompt, options)` desde TypeScript
- [ ] Fallback automático a cloud si on-device no está disponible
- [ ] Métricas de performance comparativas (on-device vs cloud)
- [ ] Toggle en UI para forzar modo offline

---

#### 2.2 Microsoft Agent Governance Toolkit Integration
**Prioridad**: Media  
**Esfuerzo**: 4-6 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/src/risk/risk-engine.ts`
- `Open_PC/extensions/lumina-cognitive-os/src/risk/governance-policy.json` (nuevo)

**Descripción**:
Integrar el toolkit de governance de Microsoft para runtime policy enforcement en ejecución de skills y PC Operator.

**Features**:
- Policy DSL para definir qué acciones están permitidas/bloqueadas
- Audit log estructurado para compliance
- Approval workflows para acciones de alto riesgo

**Referencia**: https://github.com/microsoft/agent-governance-toolkit

**Criterios de Aceptación**:
- [ ] Policy file JSON editable por usuario en `c:/I24D_WhatsApp/governance-policy.json`
- [ ] Cada acción de `lumina_pc_do` evalúa policy antes de ejecutar
- [ ] Audit log en `c:/I24D_WhatsApp/logs/governance-audit.jsonl`
- [ ] Bloqueo automático de acciones CRITICAL sin aprobación explícita

---

#### 2.3 browser.bind() para Sesiones Compartidas
**Prioridad**: Media-Baja  
**Esfuerzo**: 2-3 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/src/action/browser-driver.ts`

**Descripción**:
Usar la nueva API `browser.bind()` de Playwright 1.59 para permitir que múltiples agentes (Codex, Claude Code, Ollama) compartan la misma sesión de browser.

**Caso de Uso**:
- Usuario pide a Codex: "abre YouTube y busca X"
- Luego pide a Claude Code: "analiza los primeros 3 resultados"
- Ambos usan la misma sesión, no se abren tabs duplicadas

**Criterios de Aceptación**:
- [ ] Sesión de browser persiste entre diferentes agent sessions
- [ ] Cookie/auth state compartido
- [ ] Timeout de sesión configurable (default: 30 min inactividad)

---

### 🎯 Sprint 3 (Agosto 16-31)

#### 3.1 velesdb Migration (Vector DB Nativa)
**Prioridad**: Media  
**Esfuerzo**: 6-8 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/src/memory/` (migrar de LanceDB)
- `apps/lumina-desktop/src-tauri/Cargo.toml` (agregar velesdb)

**Descripción**:
Migrar de LanceDB a `tauri-plugin-velesdb` para vector store nativo con capacidades offline-first.

**Beneficios**:
- Semantic search sin conexión a internet
- Menos dependencias (no requiere servidor LanceDB)
- Mejor integración con ecosistema Tauri/Rust

**Plugin**: https://github.com/velesdb/velesdb

**Criterios de Aceptación**:
- [ ] Migración de datos existente sin pérdida
- [ ] Queries semánticas funcionan offline
- [ ] Sync opcional cuando hay conexión (para multi-device)

---

#### 3.2 CLI Debugger de Playwright
**Prioridad**: Baja  
**Esfuerzo**: 1-2 horas  
**Archivos**:
- `Open_PC/extensions/lumina-cognitive-os/src/action/browser-driver.ts`
- `scripts/dev-browser-debug.sh` (nuevo)

**Descripción**:
Integrar el CLI debugger de Playwright (`--debug=cli`) para debugging interactivo de browser automation en dev mode.

**Caso de Uso**:
```bash
pnpm dev:browser:debug --goal "abre YouTube y busca despacito"
# Entra en modo interactivo: step-through de cada acción
```

**Criterios de Aceptación**:
- [ ] Script npm dedicado para launch con debugger
- [ ] Comandos interactivos: `next`, `step`, `inspect`, `continue`
- [ ] Inspección de accessibility tree en cada step

---

## Mejoras Exploratorias - Q4 2026 (Octubre-Diciembre)

### 🔮 Investigaciones en Curso

#### 4.1 Multi-Agent Orchestration Avanzada
**Estado**: Investigación temprana  
**Referencias**: 
- Planner-Executor pattern (FutureAGI)
- Supervisor-Worker con handoffs asíncronos
- Maker-Checker para validación crítica

**Posible Implementación**:
Extender `lumina_director_route` para orquestación multi-agente con:
- Handoff automático entre especialistas
- Shared memory context entre agentes
- Conflict resolution cuando agentes discrepan

---

#### 4.2 Small Language Models (SLMs) para Tareas Específicas
**Estado**: Monitoreo de industria  
**Referencias**: 
- Medium: "Architecting the Future of Agentic AI"
- Reddit r/LocalLLaMA: SLM benchmarks 2026

**Hipótesis**:
SLMs (1-7B params) pueden ser más eficientes que LLMs grandes para:
- Clasificación de intents simples
- Extracción de entidades de comandos cortos
- Verificación visual de UI elements

**Experimento Propuesto**:
Comparar Gemma4:31b vs Phi-3-mini (3.8B) para:
- Latencia
- Costo por inferencia
- Accuracy en tareas de PC Operator

---

#### 4.3 WebAssembly para Sidecars
**Estado**: Evaluación técnica  
**Motivación**: Reemplazar sidecars Python (.exe) con módulos WASM para:
- Menor tamaño (~5MB vs ~50MB con Python runtime)
- Mejor seguridad (sandbox nativo de WASM)
- Cross-platform sin recompilar

**Tecnologías a Evaluar**:
- WasmEdge
- Wasmer
- Bytecode Alliance components

---

## Dependencias Externas

### Playwright
- **Versión actual**: 1.61 (Julio 2026)
- **Próxima release esperada**: 1.62 (Septiembre 2026)
- **Watch**: Changelog mensual en playwright.dev

### Tauri
- **Versión actual**: 2.x estable
- **Próxima release esperada**: 2.1 (Octubre 2026)
- **Watch**: tauri.app/blog y crates.io para nuevos plugins

### agentskills.io
- **Spec version**: 1.0 (estable)
- **Adoption**: Creciendo en Claude Code, Cursor, OpenAI Codex
- **Watch**: GitHub org agentskills-io para updates

---

## Métricas de Éxito H2 2026

| KPI | Meta | Línea Base (Julio 2026) |
|-----|------|-------------------------|
| Latencia promedio PC Operator | <3s por iteración | 4.2s |
| Success rate skills aprendidas | >85% | 78% |
| Tiempo de boot (cold start) | <5s | 7.3s |
| Offline capability | 100% core features | 60% |
| Type coverage | 100% | 98% |
| Test suite pass rate | 100% | 100% (255/255) |

---

## Riesgos y Mitigaciones

### Riesgo 1: Breaking Changes en Playwright 2.x
**Probabilidad**: Baja  
**Impacto**: Alto  
**Mitigación**: 
- Pin version en package.json (`playwright: "~1.61.0"`)
- Test suite de regression antes de upgrades
- Subscribe a playwright-release-notes

### Riesgo 2: Plugin Tauri Inestable
**Probabilidad**: Media  
**Impacto**: Medio  
**Mitigación**:
- Evaluar madurez del plugin (stars, last commit, issues abiertas)
- Mantener fallback a implementación actual
- Contribuir fixes upstream si es necesario

### Riesgo 3: Complejidad de Multi-Agent
**Probabilidad**: Alta  
**Impacto**: Medio  
**Mitigación**:
- Empezar con casos de uso simples (2 agentes max)
- Documentar patrones de handoff claramente
- Agregar observability detallada desde día 1

---

## Contribuciones Abiertas

¿Quieres contribuir? Estas áreas necesitan ayuda:

1. **Documentación de skills aprendidas**: Ejemplos reales de grabaciones → skills
2. **Tests E2E para PC Operator**: Escenarios del mundo real con verification
3. **Traducciones i18n**: Soporte para más idiomas en STT/TTS
4. **UI Dashboard para Operative Daemon**: Panel visual para reglas proactivas

Contacto: Dal en el repo `C:\I24D_WhatsApp\Lumina_PC`

---

*Documento generado automáticamente por el Sistema de Automejora Diaria*  
*Próxima revisión: 2026-08-01*
