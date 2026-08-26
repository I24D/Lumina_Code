import { gracefulExit } from "./util/exit.js";

let tuiUnmount: (() => void) | null = null;
let showExitMessage = false;
let exitMessageCallback: (() => void) | null = null;
let lastCtrlCTime = 0;

export function setTUIUnmount(unmount: (() => void) | null) {
  tuiUnmount = unmount;
}

export function setExitMessageCallback(callback: (() => void) | null) {
  exitMessageCallback = callback;
}

export function enableSigintHandler() {
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", async () => {
    const now = Date.now();
    const isSecondPress = lastCtrlCTime !== 0 && now - lastCtrlCTime <= 1000;
    if (isSecondPress) {
      showExitMessage = false;
      tuiUnmount?.();
      await gracefulExit(0);
      return;
    }

    lastCtrlCTime = now;
    showExitMessage = true;
    exitMessageCallback?.();
    setTimeout(() => {
      showExitMessage = false;
      exitMessageCallback?.();
    }, 1000);
  });
}

export function shouldShowExitMessage(): boolean {
  return showExitMessage;
}
