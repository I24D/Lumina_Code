# OpenClaw Windows Bridge Lab

Laboratory folder for testing `openclaw-windows-node` against the existing
`C:\I24D_WhatsApp\openclaw-main` checkout without changing OpenClaw source.

## What Is Here

- `windows-node-source`: clean clone of `openclaw/openclaw-windows-node`.
- `lumina-windows-bridge`: canonical Lumina HTTP bridge moved from
  `C:\I24D_WhatsApp\Lumina_PC\apps\lumina-windows-bridge`.
- `tray-data`: isolated Tray profile used only for this lab.
- `scripts/start-tray-lab.ps1`: launches the dev Tray with MCP on port `18795`.
- `scripts/test-mcp-lab.ps1`: verifies the local MCP surface with `winnode.exe`.
- `scripts/stop-tray-lab.ps1`: stops lab Tray processes.
- `scripts/start-lumina-bridge-lab.ps1`: starts the Lumina HTTP bridge on port
  `8765` with `LUMINA_REPO_ROOT=C:\I24D_WhatsApp\Lumina_PC`.
- `scripts/test-lumina-bridge-lab.ps1`: checks `/health` and `/schema`.
- `scripts/stop-lumina-bridge-lab.ps1`: stops the Lumina HTTP bridge.
- `artifacts`: place for future screenshots, camera captures, or command output.

The old path under `Lumina_PC\apps\lumina-windows-bridge` is now a junction to
this lab folder, so existing Lumina references keep working without maintaining
two physical bridge copies.

## Current Decisions

- Keep `openclaw-main` as the main UI/runtime.
- Use the Windows companion only as a native capability bridge first.
- Do not absorb a duplicate chat UI yet.
- Use port `18795` because `127.0.0.1:8765` is already occupied by a Node process.
- Start with local MCP proof before gateway node pairing.

## Commands

Start the Lumina HTTP bridge:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
.\scripts\start-lumina-bridge-lab.ps1
.\scripts\test-lumina-bridge-lab.ps1
```

Build already completed once:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab\windows-node-source
.\build.ps1 -Project WinNodeCli
.\build.ps1 -Project WinUI -DevBuild
```

Launch isolated Tray:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
.\scripts\start-tray-lab.ps1 -NoBuild
```

Test local MCP:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
.\scripts\test-mcp-lab.ps1
```

Connect the lab Tray to the existing OpenClaw Gateway:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
.\scripts\connect-gateway-lab.ps1
```

Validate Gateway -> Windows Node:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
node .\scripts\test-gateway-node-lab.mjs
```

Stop lab Tray:

```powershell
cd C:\I24D_WhatsApp\openclaw-windows-bridge-lab
.\scripts\stop-tray-lab.ps1
```

## Next Proofs

Completed:

1. `winnode --list-tools` returns real tools from the Tray.
2. `system.which` returns local binary paths over MCP.
3. `tts.status` reports Windows TTS ready.
4. `tts.speak` works with the female Windows voice `Microsoft Zira`.
5. `system.notify` sends a Windows notification over MCP and Gateway.
6. `screen.snapshot` returns a real PNG over MCP and Gateway.
7. `camera.list` sees `Integrated Webcam` over MCP and Gateway.
8. Gateway Node Mode is paired, approved, and connected as `Windows Node (LUMINA)`.

Still intentionally not done:

1. `camera.snap` was not run because it would save a real webcam photo.
2. `camera.snap`, `camera.clip`, `screen.record`, and `tts.speak` are available over local MCP, but are not currently advertised in the Gateway-approved command surface.
3. The lab logs show an MCP token ACL warning. This is acceptable for local lab work, but should be fixed before using this as a production companion profile.
