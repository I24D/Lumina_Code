/**
 * This is the entry point for the extension.
 */

import { setupCa } from "core/util/ca";
import * as vscode from "vscode";

import { stopLuminaRuntime } from "./extension/backendLifecycle";

export { default as buildTimestamp } from "./.buildTimestamp";

async function dynamicImportAndActivate(context: vscode.ExtensionContext) {
  await setupCa();
  const { activateExtension } = await import("./activation/activate");
  return await activateExtension(context);
}

function formatActivationError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

export async function activate(context: vscode.ExtensionContext) {
  const activationOutput = vscode.window.createOutputChannel(
    "Lumina Code: Activation",
  );
  context.subscriptions.push(activationOutput);
  const activationLogUri = vscode.Uri.joinPath(
    context.logUri,
    "activation.log",
  );

  try {
    const result = await dynamicImportAndActivate(context);
    try {
      await vscode.workspace.fs.delete(activationLogUri);
    } catch {
      // There is no stale activation error to remove.
    }
    return result;
  } catch (error) {
    const details = formatActivationError(error);
    const logContents = `${new Date().toISOString()}\n${details}\n`;

    console.error("Error activating extension:", error);
    activationOutput.appendLine(logContents);

    try {
      await vscode.workspace.fs.createDirectory(context.logUri);
      await vscode.workspace.fs.writeFile(
        activationLogUri,
        Buffer.from(logContents, "utf8"),
      );
    } catch (logError) {
      console.error(
        "Unable to persist the Lumina Code activation log:",
        logError,
      );
    }

    const selection = await vscode.window.showWarningMessage(
      "Error activating the Lumina Code extension.",
      "View Logs",
      "Retry",
    );
    if (selection === "View Logs") {
      activationOutput.show(true);
      try {
        const document =
          await vscode.workspace.openTextDocument(activationLogUri);
        await vscode.window.showTextDocument(document, { preview: true });
      } catch {
        // The output channel above still contains the complete error.
      }
    } else if (selection === "Retry") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return undefined;
  }
}

export function deactivate() {
  stopLuminaRuntime();
}
