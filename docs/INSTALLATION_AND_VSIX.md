# Instalación y generación del VSIX

Esta guía documenta el flujo que existe actualmente en el código de Lumina Code. Está orientada a colaboradores que desean abrir la extensión en modo desarrollador, generar un VSIX para Windows x64 o instalar ese VSIX manualmente.

> [!WARNING]
> Lumina Code continúa en desarrollo activo. No hay una release estable, un VSIX firmado ni una publicación oficial en Visual Studio Marketplace. El flujo se analizó a partir de los manifiestos y scripts del repositorio, pero todavía debe validarse de principio a fin en un equipo Windows limpio.

## Estado actual

| Elemento | Estado |
|---|---|
| Código fuente | Disponible en `main` |
| Development Host | Launcher disponible para Windows |
| Generación manual del VSIX | Implementada para colaboradores |
| VSIX descargable desde Releases | No disponible |
| Publicación en Marketplace | No disponible |
| Build reproducible desde equipo limpio | Pendiente de validación |
| Plataforma documentada | Windows 10/11 x64 |

## Requisitos

| Herramienta | Versión o uso |
|---|---|
| Git | Clonar y actualizar el repositorio |
| Node.js | `20.20.1`, definido en `continue-upstream/.nvmrc` |
| npm | Incluido con Node.js |
| VS Code | `1.70` o posterior, según el manifiesto de la extensión |
| Rust | Toolchain estable MSVC |
| Microsoft C++ Build Tools | Carga de trabajo **Desktop development with C++** |
| Microsoft Edge WebView2 | Runtime utilizado por Tauri |
| PowerShell | Ejecución de los scripts Windows |
| Conexión de red | Descarga de dependencias npm y binarios nativos |

Tauri mantiene sus [requisitos oficiales para Windows](https://v2.tauri.app/start/prerequisites/). En Windows 10 actualizado y Windows 11, WebView2 normalmente ya está presente.

Node.js 22 se utiliza en algunos bridges TypeScript opcionales, pero **no sustituye** la versión `20.20.1` utilizada por el monorepo y el empaquetado de la extensión.

## 1. Clonar y verificar herramientas

```powershell
git clone https://github.com/I24D/Lumina_Code.git
cd Lumina_Code

git --version
node --version
npm --version
rustc --version
cargo --version
code --version
```

El resultado de `node --version` debe coincidir con:

```powershell
Get-Content .\continue-upstream\.nvmrc
```

No copies un `.env` privado ni agregues tokens, contraseñas o rutas personales al checkout.

## 2. Compilar Start Talk para el VSIX

El preempaquetado copia Start Talk dentro de la extensión y se detiene si no encuentra este archivo:

```text
Start-talk\src-tauri\target\release\start-talk.exe
```

Desde la raíz de `Lumina_Code`:

```powershell
cd .\Start-talk
npm install
npm run tauri build -- --no-bundle
Test-Path .\src-tauri\target\release\start-talk.exe
cd ..
```

`--no-bundle` crea el ejecutable de release que necesita el VSIX sin generar instaladores MSI o NSIS. Tauri documenta este flujo en su guía de [build y bundling](https://v2.tauri.app/distribute/#bundling).

No abras `start-talk.exe` directamente para probar la integración. El comando de Lumina Code crea un puente de sesión antes de lanzar el orbe.

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

- reconstruye y copia la GUI;
- prepara dependencias nativas para el target;
- copia `start-talk.exe` al paquete;
- valida que existan los archivos requeridos;
- ejecuta `@vscode/vsce` para crear el VSIX.

Si cambiaste Start Talk, vuelve a ejecutar antes:

```powershell
Push-Location .\Start-talk
npm run tauri build -- --no-bundle
Pop-Location
```

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

Dentro del Development Host, usa **Lumina Code: Start Talk (orbe de escritorio)** para iniciar el orbe con su puente de sesión.

## Contenido del VSIX

El proceso de preempaquetado prepara, copia y valida al menos:

- el bundle de la extensión y la GUI;
- el ejecutable nativo de Start Talk;
- SQLite, LanceDB, ONNX Runtime y ripgrep para el target;
- modelos y archivos WASM requeridos por el contexto de código;
- licencia y atribución del proyecto.

El VSIX no convierte el snapshot actual en una release estable. Algunas funciones necesitan configuración de modelos o servicios que todavía no tiene un `.env.example` raíz unificado.

## Errores frecuentes

| Mensaje o síntoma | Causa probable | Comprobación |
|---|---|---|
| `Start Talk release binary was not found` | No se compiló el orbe antes del VSIX | Verifica `Start-talk\src-tauri\target\release\start-talk.exe` |
| Error de linker o compilación Rust | Falta toolchain MSVC o C++ Build Tools | Ejecuta `rustc --version` y revisa los requisitos de Tauri |
| La versión de Node no coincide | Se está usando otro runtime | Compara `node --version` con `.nvmrc` |
| No aparece ningún `.vsix` | Falló prepackage o `vsce` | Busca el primer error y revisa `extensions\vscode\build` |
| `code` no se reconoce | La CLI de VS Code no está en `PATH` | Instala desde la interfaz o corrige el PATH |
| La extensión abre pero un modelo no responde | Falta configuración de runtime o proveedor | Revisa los logs antes de reportar el problema |

## Seguridad y procedencia

Las extensiones tienen los mismos permisos que VS Code. Antes de instalar un VSIX:

- revisa el commit desde el cual fue generado;
- no instales archivos compartidos por una fuente desconocida;
- no empaquetes archivos `.env`, tokens ni registros personales;
- conserva `LICENSE` y `NOTICE` al redistribuir una build permitida;
- trata cualquier VSIX local como software experimental y no firmado.

Los reportes deben seguir la [política de seguridad](../SECURITY.md).

## Archivos que definen este flujo

- [`continue-upstream/.nvmrc`](../continue-upstream/.nvmrc)
- [`continue-upstream/scripts/install-dependencies.ps1`](../continue-upstream/scripts/install-dependencies.ps1)
- [`Start-talk/src-tauri/tauri.conf.json`](../Start-talk/src-tauri/tauri.conf.json)
- [`continue-upstream/extensions/vscode/package.json`](../continue-upstream/extensions/vscode/package.json)
- [`continue-upstream/extensions/vscode/scripts/prepackage.js`](../continue-upstream/extensions/vscode/scripts/prepackage.js)
- [`continue-upstream/extensions/vscode/scripts/package.js`](../continue-upstream/extensions/vscode/scripts/package.js)

## English quick reference

Lumina Code currently documents an experimental Windows x64 contributor build. Build `Start-talk\src-tauri\target\release\start-talk.exe` first with `npm run tauri build -- --no-bundle`, prepare the monorepo with `continue-upstream\scripts\install-dependencies.ps1`, and regenerate the extension from `continue-upstream\extensions\vscode` with `npm run package -- --target win32-x64`. Install the newest file under `build\*.vsix` through **Install from VSIX...** or `code --install-extension <path>`. No signed release or Marketplace package is available yet.
