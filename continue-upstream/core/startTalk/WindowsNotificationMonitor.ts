import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  StartTalkNotification,
  StartTalkNotificationAccess,
} from "./types.js";
import { enrichPhoneLinkNotification } from "./PhoneLinkNotificationPolicy.js";

const MAX_NOTIFICATION_TEXT_LENGTH = 1_000;

type NotificationMonitorMessage =
  | {
      kind: "status";
      status: StartTalkNotificationAccess;
      message?: string;
    }
  | {
      kind: "notification";
      notification: StartTalkNotification;
    };

export interface WindowsNotificationMonitorOptions {
  onNotification: (notification: StartTalkNotification) => void;
  onStatus: (
    status: StartTalkNotificationAccess,
    message?: string,
  ) => void;
  onError?: (error: Error) => void;
}

function trimNotificationText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_NOTIFICATION_TEXT_LENGTH)
    : "";
}

export function parseNotificationMonitorLine(
  line: string,
): NotificationMonitorMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.kind === "status") {
    const allowedStatuses: StartTalkNotificationAccess[] = [
      "checking",
      "allowed",
      "denied",
      "unsupported",
      "error",
    ];
    if (!allowedStatuses.includes(record.status as StartTalkNotificationAccess)) {
      return undefined;
    }
    return {
      kind: "status",
      status: record.status as StartTalkNotificationAccess,
      message: trimNotificationText(record.message) || undefined,
    };
  }

  if (record.kind !== "notification") {
    return undefined;
  }

  const rawNotification = record.notification;
  if (!rawNotification || typeof rawNotification !== "object") {
    return undefined;
  }

  const notificationRecord = rawNotification as Record<string, unknown>;
  const id = trimNotificationText(notificationRecord.id);
  const appName = trimNotificationText(notificationRecord.appName);
  const appUserModelId = trimNotificationText(
    notificationRecord.appUserModelId,
  );
  const createdAt = trimNotificationText(notificationRecord.createdAt);
  if (!id || !appName || !createdAt) {
    return undefined;
  }

  const textElements = Array.isArray(notificationRecord.textElements)
    ? notificationRecord.textElements
        .map(trimNotificationText)
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return {
    kind: "notification",
    notification: enrichPhoneLinkNotification({
      id,
      appName,
      appUserModelId: appUserModelId || undefined,
      title: trimNotificationText(notificationRecord.title),
      body: trimNotificationText(notificationRecord.body) || undefined,
      createdAt,
      textElements,
      sourceKind: "windows",
    }),
  };
}

const POWERSHELL_NOTIFICATION_MONITOR = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-MonitorMessage([object] $Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = [string]$listener.GetAccessStatus()
  if ($access -ne 'Allowed') {
    Write-MonitorMessage ([pscustomobject]@{
      kind = 'status'
      status = 'denied'
      message = 'Windows no permite leer las notificaciones.'
    })
    exit 0
  }

  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethod -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  $resultType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  $isBaseline = $true

  Write-MonitorMessage ([pscustomobject]@{ kind = 'status'; status = 'allowed' })

  while ($true) {
    $operation = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
    $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()

    foreach ($item in @($task.Result)) {
      $appId = ''
      $appName = ''
      try { $appId = [string]$item.AppInfo.AppUserModelId } catch {}
      try { $appName = [string]$item.AppInfo.DisplayInfo.DisplayName } catch {}
      if ([string]::IsNullOrWhiteSpace($appName)) { $appName = $appId }
      if ([string]::IsNullOrWhiteSpace($appName)) { $appName = 'Windows' }

      $key = '{0}|{1}|{2}' -f $item.Id, $item.CreationTime.Ticks, $appId
      if (-not $seen.Add($key) -or $isBaseline) { continue }

      $texts = @()
      try {
        $binding = $item.Notification.Visual.GetBinding(
          [Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric
        )
        if ($null -ne $binding) {
          $texts = @($binding.GetTextElements() | ForEach-Object { [string]$_.Text })
        }
      } catch {}

      $title = if ($texts.Count -gt 0) { $texts[0] } else { '' }
      $body = if ($texts.Count -gt 1) { ($texts[1..($texts.Count - 1)] -join ' ') } else { '' }
      Write-MonitorMessage ([pscustomobject]@{
        kind = 'notification'
        notification = [pscustomobject]@{
          id = $key
          appName = $appName
          appUserModelId = $appId
          title = $title
          body = $body
          textElements = $texts
          createdAt = $item.CreationTime.UtcDateTime.ToString('o')
        }
      })
    }

    $isBaseline = $false
    Start-Sleep -Milliseconds 700
  }
} catch {
  Write-MonitorMessage ([pscustomobject]@{
    kind = 'status'
    status = 'error'
    message = $_.Exception.Message
  })
  exit 1
}
`;

export class WindowsNotificationMonitor {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private stdoutBuffer = "";

  constructor(private readonly options: WindowsNotificationMonitorOptions) {}

  start(): void {
    if (this.child || this.stopped) {
      return;
    }

    if (process.platform !== "win32") {
      this.options.onStatus(
        "unsupported",
        "Las notificaciones de Start Talk solo estan disponibles en Windows.",
      );
      return;
    }

    this.options.onStatus("checking");
    const encodedCommand = Buffer.from(
      POWERSHELL_NOTIFICATION_MONITOR,
      "utf16le",
    ).toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      { windowsHide: true },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });

    child.on("error", (error) => {
      if (!this.stopped) {
        this.options.onStatus("error", error.message);
        this.options.onError?.(error);
      }
    });

    child.on("close", (code) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.stopped && code && code !== 0) {
        const message = stderr.trim() || `Notification monitor exited (${code}).`;
        this.options.onStatus("error", message);
        this.options.onError?.(new Error(message));
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.stdoutBuffer = "";
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const message = parseNotificationMonitorLine(line);
      if (!message) {
        continue;
      }
      if (message.kind === "status") {
        this.options.onStatus(message.status, message.message);
      } else {
        this.options.onNotification(message.notification);
      }
    }
  }
}
