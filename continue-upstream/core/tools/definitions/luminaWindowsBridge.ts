import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

const ENDPOINT_DESCRIPTION = [
  "This bridge is for native Windows desktop control only, not project development.",
  "GET endpoints: /health, /processes, /camera_devices, /logs, /perception, /vision_stream, /schema.",
  "POST endpoints: /perception_control, /vision_stream_control, /open_application, /open_settings, /execute_powershell_safe, /clipboard, /notify_toast, /window_control, /screenshot, /input_control, /ui_inspect, /ui_interact, /ui_wait, /ui_capture, /play_media, /now_playing, /vision_click.",
  "Messaging is NOT handled here: to read/send WhatsApp desktop messages use the dedicated lumina_whatsapp tool, and to read/reply the phone's messages mirrored via Enlace móvil / Phone Link use lumina_phone_link. Do not drive those with the raw UI endpoints below.",
  'Startup sequence for VISUAL desktop tasks that need to see or click the screen (opening/operating apps, clicking, reading opaque UI): first activate continuous monitor video with /vision_stream_control { action: "start" }, then read /vision_stream and confirm mode is dxgi_desktop_duplication, streaming is true, and framesSeen advances; second activate semantic perception with /perception_control { action: "start" }, then read /perception; third activate hearing with /now_playing. Skip this ceremony for calls that are already deterministic (a single /open_application, /clipboard, /now_playing check, /window_control list, or a dedicated messaging tool).',
  "If /vision_stream cannot start, returns stale frames, or framesSeen does not advance, do not operate blindly. If /perception does not return current state, report the blocker. If /now_playing fails, report that the hearing/audio sensor is blocked before any task that depends on sound.",
  "Lumina must never claim a Windows desktop task succeeded from command execution alone. After every desktop action, verify observed reality with /vision_stream plus /perception, /ui_capture, /ui_wait, /now_playing, or another endpoint that reads current state.",
  "Use /vision_stream for Lumina's continuous monitor sight: it keeps a DXGI Desktop Duplication stream alive, tracks framesSeen, latestFrameAt, foreground window, and latest monitor frame path. Use /vision_stream_control to start, stop, restart, or check that stream.",
  "Use /perception for semantic UI sight: it starts/reads the continuous perception daemon and returns current foreground app, changed frame sequence, and actionable UIA elements. Use /perception_control to start, stop, restart, or check that daemon.",
  'When foreground remains VS Code but the target app exists, do not give up and do not click blindly. Use target-window parameters on /ui_capture, /ui_inspect, /ui_wait, and /ui_interact: { title: "Reloj" } or { hwnd } or { processName }. /ui_capture can capture the target window by hwnd with PrintWindow even while VS Code is foreground.',
  "Use /open_application with target, appName, application, app, name, or url.",
  "Use /window_control for list, focus, launch, close, and discover actions. Launch accepts application, target, appName, app, or name. Discover accepts query or filter.",
  "Use /input_control for mouse and keyboard actions; always include allowedApps so input only runs against the expected foreground app.",
  "Prefer UI Automation over raw coordinates: /ui_inspect returns the foreground window's interactable elements (name, automationId, controlType, bbox, center); pass a query to fuzzy-resolve a target.",
  "Use /ui_interact to act on an element by identity — { automationId or name, action: invoke|click|set_value|toggle|select|focus, value } — which works even if the window moves and does not need coordinates. It also accepts fuzzyMatch (resolve a partial name like 'Sandra' to 'Sandra Patricia'), waitForElementMs (poll for the element before acting), and thenPress: enter|tab|escape (focus the element and send a key after acting, to submit when the Send button is not in the UIA tree).",
  "Use /ui_wait to poll until an element appears — { query or name or automationId, timeoutMs } — before interacting, to avoid load races.",
  "Use /ui_capture for screenshot + UIA structure + OCR text in one call when a window's UI tree is opaque (Chromium/canvas/web apps). It accepts target selectors such as title, hwnd, processName, and pid.",
  "Use /play_media with { query } to play a requested song on YouTube — it resolves the query to the exact video and opens it in the browser.",
  "Use /now_playing to VERIFY audio is really playing before telling the user it worked — it returns the real audio peak, the loudest app, and the media-session title/artist/status. Never claim music is playing without confirming here.",
  "Use /vision_click for UIA-blind apps (Chromium/Electron/canvas/web) where /ui_inspect returns little: { text, action:find|click, allowedApps } — it OCRs the screen, finds the visible text, and clicks its center. This is the vision fallback when identity-based UIA can't see the element.",
  "Never use this tool to create, edit, move, delete, or generate project files. For code/workspace files, use create_new_file, edit_existing_file, multi_edit, read_file, ls, grep_search, file_glob_search, and run_terminal_command.",
  "When explaining examples to the user, describe them in normal text instead of emitting a real tool call unless you intend to execute it.",
].join(" ");

const FILE_MUTATION_COMMAND_PATTERNS = [
  /\bnew-item\b/i,
  /\bset-content\b/i,
  /\badd-content\b/i,
  /\bout-file\b/i,
  /\bcopy-item\b/i,
  /\bmove-item\b/i,
  /\bremove-item\b/i,
  /\brename-item\b/i,
  /\bni\b/i,
  /\bsc\b/i,
  /\bac\b/i,
  />\s*["']?[\w.~:/\\-]/i,
];

function getEndpoint(args: Record<string, unknown>): string {
  return typeof args.endpoint === "string" ? args.endpoint.trim() : "";
}

function getBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = args.body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function looksLikeWorkspaceFileMutation(command: unknown): boolean {
  if (typeof command !== "string") {
    return false;
  }

  return FILE_MUTATION_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(command),
  );
}

export const luminaWindowsBridgeTool: Tool = {
  type: "function",
  displayTitle: "Lumina Windows Bridge",
  wouldLikeTo: "use Lumina Windows Bridge",
  isCurrently: "using Lumina Windows Bridge",
  hasAlready: "used Lumina Windows Bridge",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.LuminaWindowsBridge,
    description: `Call Lumina's local Windows Bridge to inspect or control the native Windows desktop through a localhost-only service. ${ENDPOINT_DESCRIPTION}`,
    parameters: {
      type: "object",
      required: ["endpoint"],
      properties: {
        endpoint: {
          type: "string",
          enum: [
            "/health",
            "/processes",
            "/camera_devices",
            "/logs",
            "/perception",
            "/vision_stream",
            "/schema",
            "/perception_control",
            "/vision_stream_control",
            "/open_application",
            "/open_settings",
            "/execute_powershell_safe",
            "/clipboard",
            "/notify_toast",
            "/window_control",
            "/screenshot",
            "/input_control",
            "/ui_inspect",
            "/ui_interact",
            "/ui_wait",
            "/ui_capture",
            "/play_media",
            "/now_playing",
            "/vision_click",
          ],
          description: "The Lumina Windows Bridge endpoint to call.",
        },
        body: {
          type: "object",
          description:
            "The JSON body for POST endpoints. Leave empty for GET endpoints.",
        },
        bridgeUrl: {
          type: "string",
          description:
            "Optional override for the local Bridge URL. Defaults to LUMINA_BRIDGE_URL, LUMINA_BRIDGE_PORT, or http://127.0.0.1:8765.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    const endpoint = getEndpoint(parsedArgs);
    const body = getBody(parsedArgs);
    if (
      endpoint === "/execute_powershell_safe" &&
      looksLikeWorkspaceFileMutation(body.command)
    ) {
      return "disabled";
    }
    return basePolicy;
  },
  systemMessageDescription: {
    prefix: `To use native Windows desktop capabilities through Lumina, call the ${BuiltInToolNames.LuminaWindowsBridge} tool. This is not a code editing or project file creation tool. ${ENDPOINT_DESCRIPTION} For example, to list visible windows, you could respond with:`,
    exampleArgs: [
      ["endpoint", "/window_control"],
      ["body", { action: "list" } as any],
    ],
  },
  toolCallIcon: "CommandLineIcon",
};
