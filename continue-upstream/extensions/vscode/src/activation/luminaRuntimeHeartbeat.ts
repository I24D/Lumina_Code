import * as vscode from "vscode";

const HEARTBEAT_INTERVAL_MS = 30_000;

function coreUrl(): string {
  return (process.env.LUMINA_CORE_URL || "http://127.0.0.1:3000").replace(/\/+$/u, "");
}

export function startLuminaRuntimeHeartbeat(context: vscode.ExtensionContext): void {
  const instanceId = `${vscode.env.machineId}:${vscode.env.sessionId}`;
  const send = async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    try {
      await fetch(`${coreUrl()}/lumina/extension/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceId,
          workspace,
          version: String(context.extension.packageJSON?.version || ""),
          userId: process.env.LUMINA_CANONICAL_USER_ID || "lumina-user:owner",
        }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // Core may be intentionally offline; the next heartbeat retries quietly.
    }
  };

  void send();
  const timer = setInterval(() => void send(), HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
}
