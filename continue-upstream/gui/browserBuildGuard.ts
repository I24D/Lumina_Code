const NODE_EXTERNALIZATION_WARNING =
  /has been externalized for browser compatibility/i;

/**
 * Vite normally turns an accidental Node import into a warning plus an empty
 * browser shim. The bundle still succeeds and the webview can then fail as a
 * blank screen at runtime. Convert that specific warning into a build error.
 */
export function assertBrowserBuildWarningIsSafe(message: string) {
  if (NODE_EXTERNALIZATION_WARNING.test(message)) {
    throw new Error(
      `Node-only code reached the Lumina webview bundle:\n${message}\n` +
        "Move the runtime import behind the extension protocol or use an import type.",
    );
  }
}
