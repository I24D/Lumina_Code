import type { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import {
  CORE_TO_WEBVIEW_PASS_THROUGH,
  WEBVIEW_TO_CORE_PASS_THROUGH,
} from "core/protocol/passThrough";

import type { DesktopIde } from "./DesktopIde";
import type { WebviewProtocolHost } from "./WebviewProtocolHost";

/**
 * Puente entre el orbe (WebviewProtocolHost) y core (InProcessMessenger).
 *
 * Es el port de la parte reutilizable de `VsCodeMessenger`: descarta los
 * listeners que solo tenian sentido dentro del editor (diffs, apply, abrir
 * ficheros en pestanas, recargar ventana...) y conserva lo que Start Talk
 * necesita:
 *   1. PASS-THROUGH webview -> core  (startTalk/connect, sendAudio, ...).
 *   2. PASS-THROUGH core -> webview  (startTalk/event, mainResultReady, ...).
 *   3. Las llamadas al IDE que core resuelve por el messenger (getIdeInfo,
 *      getWorkspaceDirs, readFile, subprocess, ...) -> delegadas al DesktopIde.
 *
 * IMPORTANTE: hay que instanciarlo ANTES de `new Core(...)`, porque el
 * constructor de Core pide `getIdeInfo`/`getIdeSettings` por el messenger.
 */
export class HostMessenger {
  constructor(
    private readonly messenger: InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >,
    private readonly webviewProtocol: WebviewProtocolHost,
    private readonly ide: DesktopIde,
  ) {
    this.wirePassThroughs();
    this.wireIdeHandlers();
  }

  /** Registra un handler tanto para el webview como para el core (como el IDE). */
  private onWebviewOrCore(
    messageType: string,
    handler: (msg: Message) => any,
  ): void {
    this.webviewProtocol.on(messageType, handler);
    this.messenger.externalOn(messageType as any, handler);
  }

  private wirePassThroughs(): void {
    // webview -> core: reenvia la peticion del orbe al handler de Core.
    WEBVIEW_TO_CORE_PASS_THROUGH.forEach((messageType) => {
      this.webviewProtocol.on(messageType as string, async (msg: Message) =>
        this.messenger.externalRequest(
          messageType as any,
          msg.data,
          msg.messageId,
        ),
      );
    });

    // core -> webview: reenvia el evento de Core al orbe (startTalk/event, etc.).
    CORE_TO_WEBVIEW_PASS_THROUGH.forEach((messageType) => {
      this.messenger.externalOn(messageType as any, async (msg: Message) =>
        this.webviewProtocol.request(messageType as string, msg.data),
      );
    });
  }

  /** Delegaciones al IDE (mismo listado que VsCodeMessenger, sin las de editor). */
  private wireIdeHandlers(): void {
    const ide = this.ide as any;

    this.onWebviewOrCore("getIdeInfo", () => ide.getIdeInfo());
    this.onWebviewOrCore("getIdeSettings", () => ide.getIdeSettings());
    this.onWebviewOrCore("getUniqueId", () => ide.getUniqueId());
    this.onWebviewOrCore("isTelemetryEnabled", () => ide.isTelemetryEnabled());
    this.onWebviewOrCore("getWorkspaceDirs", () => ide.getWorkspaceDirs());
    this.onWebviewOrCore("getTags", (msg) => ide.getTags(msg.data));
    this.onWebviewOrCore("getDiff", (msg) => ide.getDiff(msg.data.includeUnstaged));
    this.onWebviewOrCore("getTerminalContents", () => ide.getTerminalContents());
    this.onWebviewOrCore("getWorkspaceConfigs", () => ide.getWorkspaceConfigs?.());
    this.onWebviewOrCore("writeFile", (msg) =>
      ide.writeFile(msg.data.path, msg.data.contents),
    );
    this.onWebviewOrCore("showVirtualFile", (msg) =>
      ide.showVirtualFile(msg.data.name, msg.data.content),
    );
    this.onWebviewOrCore("openFile", (msg) => ide.openFile(msg.data.path));
    this.onWebviewOrCore("runCommand", (msg) => ide.runCommand(msg.data.command));
    this.onWebviewOrCore("getSearchResults", (msg) =>
      ide.getSearchResults(msg.data.query, msg.data.maxResults),
    );
    this.onWebviewOrCore("getFileResults", (msg) =>
      ide.getFileResults(msg.data.pattern, msg.data.maxResults),
    );
    this.onWebviewOrCore("subprocess", (msg) =>
      ide.subprocess(msg.data.command, msg.data.cwd),
    );
    this.onWebviewOrCore("getProblems", (msg) => ide.getProblems(msg.data.filepath));
    this.onWebviewOrCore("getBranch", (msg) => ide.getBranch(msg.data.dir));
    this.onWebviewOrCore("getOpenFiles", () => ide.getOpenFiles());
    this.onWebviewOrCore("getCurrentFile", () => ide.getCurrentFile());
    this.onWebviewOrCore("getPinnedFiles", () => ide.getPinnedFiles());
    this.onWebviewOrCore("showLines", (msg) =>
      ide.showLines(msg.data.filepath, msg.data.startLine, msg.data.endLine),
    );
    this.onWebviewOrCore("showToast", (msg) => ide.showToast(...msg.data));
    this.onWebviewOrCore("saveFile", (msg) => ide.saveFile(msg.data.filepath));
    this.onWebviewOrCore("readFile", (msg) => ide.readFile(msg.data.filepath));
    this.onWebviewOrCore("fileExists", (msg) => ide.fileExists(msg.data.filepath));
    this.onWebviewOrCore("gotoDefinition", (msg) =>
      ide.gotoDefinition(msg.data.location),
    );
    this.onWebviewOrCore("getReferences", (msg) =>
      ide.getReferences?.(msg.data.location),
    );
    this.onWebviewOrCore("getDocumentSymbols", (msg) =>
      ide.getDocumentSymbols(msg.data.textDocumentIdentifier),
    );
    this.onWebviewOrCore("getFileStats", (msg) => ide.getFileStats(msg.data.files));
    this.onWebviewOrCore("getGitRootPath", (msg) => ide.getGitRootPath(msg.data.dir));
    this.onWebviewOrCore("listDir", (msg) => ide.listDir(msg.data.dir));
    this.onWebviewOrCore("getRepoName", (msg) => ide.getRepoName(msg.data.dir));
    this.onWebviewOrCore("readSecrets", (msg) => ide.readSecrets(msg.data.keys));
    this.onWebviewOrCore("writeSecrets", (msg) => ide.writeSecrets(msg.data.secrets));
  }
}
