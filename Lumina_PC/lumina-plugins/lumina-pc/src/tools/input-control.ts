import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { normalizeInputAppAllowlist } from "../security/input-app-allowlist.js";
import { canRunPowerShell, runPowerShell } from "../utils/powershell.js";
import { bridgePost, isWindowsBridgeMode } from "../utils/windows-bridge.js";

const INPUT_ACTIONS = ["mouse_move", "mouse_click", "type_text", "key_press", "shortcut"] as const;
const MOUSE_BUTTONS = ["left", "right", "middle"] as const;

const VIRTUAL_KEYS: Record<string, number> = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CTRL: 0x11,
  ALT: 0x12,
  ESC: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  DELETE: 0x2e,
  WIN: 0x5b,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};

for (let code = 0x30; code <= 0x39; code += 1) {
  VIRTUAL_KEYS[String.fromCharCode(code)] = code;
}
for (let code = 0x41; code <= 0x5a; code += 1) {
  VIRTUAL_KEYS[String.fromCharCode(code)] = code;
}

export type InputControlConfig = {
  readonly enabled: boolean;
  readonly allowedApps: readonly string[];
  readonly onAudit?: (event: {
    action: string;
    processName: string;
    allowed: boolean;
    atISO: string;
  }) => void;
};

type InputControlParams = {
  action: (typeof INPUT_ACTIONS)[number];
  x?: number;
  y?: number;
  button?: (typeof MOUSE_BUTTONS)[number];
  clicks?: number;
  text?: string;
  keys?: string[];
  wait_ms?: number;
};

export function createInputControlTool(config: InputControlConfig): AnyAgentTool {
  const allowedApps = normalizeInputAppAllowlist(config.allowedApps);
  return {
    name: "lumina_input_control",
    label: "Lumina Input Control",
    description:
      "Controls mouse and keyboard input on Windows only when the currently focused application is in the configured allowlist. Supports mouse movement/clicks, Unicode text typing, single keys, and short keyboard shortcuts. Every action is owner-only, audited, and fails closed when the foreground app changes or is not allowed.",
    parameters: Type.Object({
      action: Type.Union(
        INPUT_ACTIONS.map((action) => Type.Literal(action)),
        { description: "Input action to perform." },
      ),
      x: Type.Optional(
        Type.Integer({
          minimum: -32768,
          maximum: 32767,
          description: "Screen X coordinate for mouse_move or an optional positioned click.",
        }),
      ),
      y: Type.Optional(
        Type.Integer({
          minimum: -32768,
          maximum: 32767,
          description: "Screen Y coordinate for mouse_move or an optional positioned click.",
        }),
      ),
      button: Type.Optional(
        Type.Union(
          MOUSE_BUTTONS.map((button) => Type.Literal(button)),
          { description: "Mouse button. Default: left." },
        ),
      ),
      clicks: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 3,
          description: "Number of clicks. Default: 1.",
        }),
      ),
      text: Type.Optional(
        Type.String({
          maxLength: 2_000,
          description: "Unicode text for type_text.",
        }),
      ),
      keys: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 16 }), {
          minItems: 1,
          maxItems: 4,
          description:
            "Keys for key_press or shortcut. Examples: ['ENTER'], ['CTRL','SHIFT','P'].",
        }),
      ),
      wait_ms: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 5_000,
          description: "Small delay after the input action. Default: 100 ms.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as InputControlParams;
      if (isWindowsBridgeMode()) {
        if (!config.enabled) {
          return jsonResult({ ok: false, error: "input_control_disabled" });
        }
        if (allowedApps.length === 0) {
          return jsonResult({ ok: false, error: "input_app_allowlist_empty" });
        }
        validateActionParams(input.action, input);
        resolveVirtualKeys(input.action, input.keys);
        const response = await bridgePost("/input_control", {
          action: input.action,
          x: input.x,
          y: input.y,
          button: input.button ?? "left",
          clicks: input.clicks ?? 1,
          text: input.text ?? "",
          keys: input.keys ?? [],
          wait_ms: input.wait_ms ?? 100,
          allowedApps,
        });
        const parsed = {
          ...response,
          ok: response.ok === true,
          via: "lumina-windows-bridge",
        };
        config.onAudit?.({
          action: input.action,
          processName: typeof response.processName === "string" ? response.processName : "",
          allowed: response.allowed === true,
          atISO: new Date().toISOString(),
        });
        return jsonResult(parsed);
      }

      if (!canRunPowerShell()) {
        return jsonResult({
          ok: false,
          error: "lumina_input_control needs Windows or WSL (powershell.exe over interop).",
        });
      }
      if (!config.enabled) {
        return jsonResult({ ok: false, error: "input_control_disabled" });
      }
      if (allowedApps.length === 0) {
        return jsonResult({ ok: false, error: "input_app_allowlist_empty" });
      }

      const action = input.action;
      const keys = resolveVirtualKeys(action, input.keys);
      validateActionParams(action, input);
      const script = buildInputScript({
        action,
        x: input.x,
        y: input.y,
        button: input.button ?? "left",
        clicks: input.clicks ?? 1,
        text: input.text ?? "",
        keys,
        waitMs: input.wait_ms ?? 100,
        allowedApps,
      });
      const result = await runPowerShell(script, 15_000);
      if (!result.ok) {
        return jsonResult({ ok: false, error: result.error ?? result.stderr });
      }

      const parsed = parseInputResult(result.stdout);
      config.onAudit?.({
        action,
        processName: parsed.processName,
        allowed: parsed.allowed,
        atISO: new Date().toISOString(),
      });
      return jsonResult(parsed);
    },
  };
}

function validateActionParams(
  action: (typeof INPUT_ACTIONS)[number],
  params: {
    x?: number;
    y?: number;
    text?: string;
  },
): void {
  if (action === "mouse_move" && (params.x === undefined || params.y === undefined)) {
    throw new ToolInputError("x and y are required for mouse_move.");
  }
  if (
    action === "mouse_click" &&
    ((params.x === undefined) !== (params.y === undefined))
  ) {
    throw new ToolInputError("mouse_click requires both x and y when positioning the cursor.");
  }
  if (action === "type_text" && !params.text) {
    throw new ToolInputError("text is required for type_text.");
  }
}

function resolveVirtualKeys(
  action: (typeof INPUT_ACTIONS)[number],
  rawKeys: readonly string[] | undefined,
): number[] {
  if (action !== "key_press" && action !== "shortcut") return [];
  const keys = rawKeys?.map((key) => key.trim().toUpperCase()).filter(Boolean) ?? [];
  if (action === "key_press" && keys.length !== 1) {
    throw new ToolInputError("key_press requires exactly one key.");
  }
  if (action === "shortcut" && (keys.length < 2 || keys.length > 4)) {
    throw new ToolInputError("shortcut requires between two and four keys.");
  }
  return keys.map((key) => {
    const code = VIRTUAL_KEYS[key];
    if (code === undefined) {
      throw new ToolInputError(`Unsupported key: ${key}.`);
    }
    return code;
  });
}

type InputScriptParams = {
  action: (typeof INPUT_ACTIONS)[number];
  x?: number;
  y?: number;
  button: (typeof MOUSE_BUTTONS)[number];
  clicks: number;
  text: string;
  keys: readonly number[];
  waitMs: number;
  allowedApps: readonly string[];
};

function buildInputScript(params: InputScriptParams): string {
  const allowedApps = params.allowedApps.map(toPowerShellLiteral).join(", ");
  const textBase64 = Buffer.from(params.text, "utf8").toString("base64");
  const keyCodes = params.keys.join(", ");
  const moveBeforeClick =
    params.x !== undefined && params.y !== undefined
      ? `[LuminaInput]::Move(${params.x}, ${params.y})`
      : "";
  const actionScript: Record<(typeof INPUT_ACTIONS)[number], string> = {
    mouse_move: `[LuminaInput]::Move(${params.x ?? 0}, ${params.y ?? 0})`,
    mouse_click: [
      moveBeforeClick,
      `[LuminaInput]::Click("${params.button}", ${params.clicks})`,
    ]
      .filter(Boolean)
      .join("\n"),
    type_text:
      `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${textBase64}"))\n` +
      "[LuminaInput]::TypeText($text)",
    key_press: `[LuminaInput]::Chord([UInt16[]]@(${keyCodes}))`,
    shortcut: `[LuminaInput]::Chord([UInt16[]]@(${keyCodes}))`,
  };

  return `
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class LuminaInput {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort virtualKey; public ushort scanCode; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }

  public static string ForegroundProcess() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("Could not move cursor.");
  }

  public static void Click(string button, int count) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    for (int i = 0; i < count; i++) {
      SendMouse(down);
      SendMouse(up);
    }
  }

  public static void Chord(ushort[] keys) {
    foreach (ushort key in keys) SendKey(key, false);
    for (int i = keys.Length - 1; i >= 0; i--) SendKey(keys[i], true);
  }

  public static void TypeText(string text) {
    foreach (char value in text) {
      SendUnicode(value, false);
      SendUnicode(value, true);
    }
  }

  static void SendMouse(uint flags) {
    INPUT input = new INPUT {
      type = 0,
      data = new INPUTUNION {
        mouse = new MOUSEINPUT { flags = flags }
      }
    };
    Send(new INPUT[] { input });
  }

  static void SendKey(ushort virtualKey, bool keyUp) {
    INPUT input = new INPUT {
      type = 1,
      data = new INPUTUNION {
        keyboard = new KEYBDINPUT { virtualKey = virtualKey, flags = keyUp ? 0x0002u : 0u }
      }
    };
    Send(new INPUT[] { input });
  }

  static void SendUnicode(char value, bool keyUp) {
    INPUT input = new INPUT {
      type = 1,
      data = new INPUTUNION {
        keyboard = new KEYBDINPUT {
          scanCode = value,
          flags = 0x0004u | (keyUp ? 0x0002u : 0u)
        }
      }
    };
    Send(new INPUT[] { input });
  }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != (uint)inputs.Length) throw new InvalidOperationException("Windows rejected the input.");
  }
}
"@

$allowedApps = @(${allowedApps})
$processName = [LuminaInput]::ForegroundProcess().ToLowerInvariant()
$allowed = $allowedApps -contains $processName
if (-not $allowed) {
  [PSCustomObject]@{
    ok = $false
    allowed = $false
    error = "foreground_app_not_allowed"
    processName = $processName
    action = "${params.action}"
  } | ConvertTo-Json -Compress
  exit 0
}

${actionScript[params.action]}
Start-Sleep -Milliseconds ${params.waitMs}
[PSCustomObject]@{
  ok = $true
  allowed = $true
  processName = $processName
  action = "${params.action}"
} | ConvertTo-Json -Compress
`.trim();
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseInputResult(stdout: string): {
  ok: boolean;
  allowed: boolean;
  processName: string;
  action?: string;
  error?: string;
} {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      ok: parsed.ok === true,
      allowed: parsed.allowed === true,
      processName: typeof parsed.processName === "string" ? parsed.processName : "",
      ...(typeof parsed.action === "string" ? { action: parsed.action } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return {
      ok: false,
      allowed: false,
      processName: "",
      error: "invalid_input_control_response",
    };
  }
}
