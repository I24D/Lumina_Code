# Instalación y generación del VSIX

Esta guía documenta el flujo oficial para abrir Lumina Code en modo desarrollador, generar un VSIX funcional para Windows x64 e instalarlo manualmente en VS Code.

> [!WARNING]
> Lumina Code continúa en desarrollo activo, pero la extensión disponible desde el código fuente es estable y funcional. El VSIX se genera localmente: todavía no está firmado ni publicado en Visual Studio Marketplace.

## Estado actual

| Elemento                                 | Estado                                            |
| ---------------------------------------- | ------------------------------------------------- |
| Código fuente                            | Disponible en `main`                              |
| Development Host                         | Verificado con launcher automatizado para Windows |
| Generación manual del VSIX               | Disponible para usuarios y colaboradores          |
| VSIX descargable desde Releases          | No disponible                                     |
| Publicación en Marketplace               | No disponible                                     |
| Preparación reproducible de dependencias | Implementada y validada en Windows x64            |
| Plataforma documentada                   | Windows 10/11 x64                                 |

## Requisitos

| Herramienta               | Versión o uso                                           |
| ------------------------- | ------------------------------------------------------- |
| Git                       | Clonar y actualizar el repositorio                      |
| Node.js                   | `20.20.1`, definido en `continue-upstream/.nvmrc`       |
| npm                       | Incluido con Node.js                                    |
| VS Code                   | `1.70` o posterior, según el manifiesto de la extensión |
| Navegador                 | Cualquiera moderno, para la pestaña de Start Talk       |
| PowerShell                | Ejecución de los scripts Windows                        |
| Conexión de red           | Descarga de dependencias npm y binarios nativos         |

Rust, Microsoft C++ Build Tools y WebView2 **ya no hacen falta**: eran requisitos del orbe nativo Tauri, retirado el 2026-08-28 en favor de una pestaña del navegador.

Node.js 22 se utiliza en algunos bridges TypeScript opcionales, pero **no sustituye** la versión `20.20.1` utilizada por el monorepo y el empaquetado de la extensión.

## 1. Clonar y verificar herramientas

```powershell
git clone https://github.com/I24D/Lumina_Code.git
cd Lumina_Code

git --version
node --version
npm --version
code --version
```

El resultado de `node --version` debe coincidir con:

```powershell
Get-Content .\continue-upstream\.nvmrc
```

No copies un `.env` privado ni agregues tokens, contraseñas o rutas personales al checkout.

## 2. Start Talk no necesita un paso propio

Start Talk se abre como una pestaña del navegador y la extensión la sirve desde
la misma copia de la GUI que ya viaja en el VSIX (`extensions/vscode/gui`). No
hay ningún binario que compilar ni copiar: el paso que antes exigía Rust, MSVC
Build Tools y un `cargo build` de ~7 minutos desapareció junto con el orbe
nativo.

Basta con que la GUI esté construida, cosa que hace el paso siguiente.

## 3. Preparar dependencias y generar el primer VSIX

```powershell
cd .\continue-upstream
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dependencies.ps1
```

Este script **no es una verificación pasiva**. Actualmente realiza varias operaciones:

- instala dependencias npm del monorepo, core, GUI, extensión, binary y documentación;
- compila paquetes compartidos;
- enlaza `@continuedev/core` para el desarrollo local;
- construye la GUI;
- ejecuta el preempaquetado y genera un VSIX.

Puede tardar y consumir espacio considerable. Revisa el primer error que aparezca: algunas herramientas nativas no detienen inmediatamente todos los pasos posteriores del script.

Al terminar, localiza el artefacto sin depender de un nombre o versión fija:

```powershell
Get-ChildItem .\extensions\vscode\build\*.vsix |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 FullName, Length, LastWriteTime
```

El manifiesto actual identifica la extensión como `LuminaCode.lumina-code`, versión `1.3.43`. La versión y el nombre del archivo cambiarán conforme avance el proyecto.

## 4. Regenerar el VSIX después de preparar el entorno

Si ya se completó la preparación y solo quieres volver a empaquetar cambios, ejecuta desde la raíz de `Lumina_Code`:

```powershell
Push-Location .\continue-upstream\extensions\vscode
npm run package -- --target win32-x64
Get-ChildItem .\build\*.vsix
Pop-Location
```

`npm run package` ejecuta primero el script asociado `prepackage`. Ese paso:

- reconstruye y copia la GUI (que es también la interfaz de Start Talk);
- prepara dependencias nativas para el target;
- valida que existan los archivos requeridos;
- ejecuta `@vscode/vsce` para crear el VSIX.

Un cambio en Start Talk no necesita ningún paso extra: su interfaz es la GUI que
este mismo script reconstruye.

No uses `npm run package-all` para una build comunitaria. El script cross-platform continúa marcado como experimental y el flujo público documentado actualmente es `win32-x64`.

## 5. Instalar el VSIX en VS Code

### Desde la interfaz

1. Abre la vista **Extensions** en VS Code.
2. Abre el menú de acciones `...`.
3. Selecciona **Install from VSIX...**.
4. Elige el archivo generado dentro de `continue-upstream\extensions\vscode\build`.
5. Recarga VS Code cuando lo solicite.

### Desde PowerShell

Ejecuta esto desde la raíz de `Lumina_Code`:

```powershell
$vsix = Get-ChildItem .\continue-upstream\extensions\vscode\build\*.vsix |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $vsix) { throw "No se encontró ningún VSIX" }
code --install-extension $vsix.FullName
```

Verifica la instalación:

```powershell
code --list-extensions --show-versions |
  Select-String -Pattern 'LuminaCode\.lumina-code'
```

Para desinstalar esa extensión:

```powershell
code --uninstall-extension LuminaCode.lumina-code
```

VS Code también documenta la [instalación manual de extensiones VSIX](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix). Las extensiones instaladas de esta manera no reciben actualizaciones automáticas de forma predeterminada.

## 6. Probar sin instalar el VSIX

Después de preparar las dependencias, ejecuta desde la raíz del repositorio:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ABRIR_LUMINA_CODE_DEV.ps1
```

El launcher:

- compila la extensión con esbuild;
- inicia la GUI de desarrollo en `127.0.0.1:5174`;
- abre un Extension Development Host aislado;
- mantiene desactivadas por defecto las automatizaciones de aplicaciones personales.

Dentro del Development Host, usa **Lumina Code: Start Talk** para abrir Lumina Live con su puente de sesión.

## Contenido del VSIX

El proceso de preempaquetado prepara, copia y valida al menos:

- el bundle de la extensión y la GUI;
- la GUI web de Start Talk servida por el puente local autenticado;
- SQLite, LanceDB, ONNX Runtime y ripgrep para el target;
- modelos y archivos WASM requeridos por el contexto de código;
- licencia y atribución del proyecto.

El VSIX contiene una extensión funcional. El chat y el agente requieren configurar un proveedor de modelos, mientras que Start Talk requiere una clave independiente de OpenAI o Gemini, según el proveedor de voz elegido. Algunas integraciones avanzadas también necesitan servicios o permisos opcionales.

## Errores frecuentes

| Mensaje o síntoma                            | Causa probable                             | Comprobación                                                  |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Start Talk abre una pestaña con 403          | Se abrió la URL a mano, sin token de sesión | Ábrelo desde el botón del chat o la paleta de comandos       |
| Start Talk abre una interfaz vieja           | `gui/dist` sin reconstruir                 | `npm run build` en `continue-upstream/gui` y recarga (F5)     |
| La versión de Node no coincide               | Se está usando otro runtime                | Compara `node --version` con `.nvmrc`                         |
| No aparece ningún `.vsix`                    | Falló prepackage o `vsce`                  | Busca el primer error y revisa `extensions\vscode\build`      |
| `code` no se reconoce                        | La CLI de VS Code no está en `PATH`        | Instala desde la interfaz o corrige el PATH                   |
| La extensión abre pero un modelo no responde | Falta configuración de runtime o proveedor | Revisa los logs antes de reportar el problema                 |

## Seguridad y procedencia

Las extensiones tienen los mismos permisos que VS Code. Antes de instalar un VSIX:

- revisa el commit desde el cual fue generado;
- no instales archivos compartidos por una fuente desconocida;
- no empaquetes archivos `.env`, tokens ni registros personales;
- conserva `LICENSE` y `NOTICE` al redistribuir una build permitida;
- recuerda que el VSIX local es funcional, pero no está firmado ni recibe actualizaciones automáticas.

Los reportes deben seguir la [política de seguridad](../SECURITY.md).

## Archivos que definen este flujo

- [`continue-upstream/.nvmrc`](../continue-upstream/.nvmrc)
- [`continue-upstream/scripts/install-dependencies.ps1`](../continue-upstream/scripts/install-dependencies.ps1)
- [`continue-upstream/extensions/vscode/src/extension/OrbBridgeServer.ts`](../continue-upstream/extensions/vscode/src/extension/OrbBridgeServer.ts)
- [`continue-upstream/extensions/vscode/package.json`](../continue-upstream/extensions/vscode/package.json)
- [`continue-upstream/extensions/vscode/scripts/prepackage.js`](../continue-upstream/extensions/vscode/scripts/prepackage.js)
- [`continue-upstream/extensions/vscode/scripts/package.js`](../continue-upstream/extensions/vscode/scripts/package.js)

## English quick reference

Lumina Code provides a stable, functional Windows x64 extension from source. Prepare the monorepo with `continue-upstream\scripts\install-dependencies.ps1`, then generate the extension from `continue-upstream\extensions\vscode` with `npm run package -- --target win32-x64`. Start Talk needs no separate build step: it opens as a browser tab served from the same GUI bundle that ships in the VSIX. Install the newest file under `build\*.vsix` through **Install from VSIX...** or `code --install-extension <path>`. The locally generated VSIX is not signed and is not yet distributed through Marketplace.
