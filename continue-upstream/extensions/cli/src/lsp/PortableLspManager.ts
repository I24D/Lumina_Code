/* eslint-disable max-classes-per-file -- protocol parser/session are private implementation details of this manager */
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface PortableLspServerDefinition {
  id: string;
  command: string;
  args: string[];
  versionArgs: string[];
  extensions: string[];
  languageId: string;
  installHint: string;
}

export interface PortableDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface PortableDiagnosticsResult {
  serverId: string;
  diagnostics: PortableDiagnostic[];
  timedOut: boolean;
}

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export const PORTABLE_LSP_SERVERS: PortableLspServerDefinition[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    versionArgs: ["--version"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
    languageId: "typescript",
    installHint: "npm install -g typescript typescript-language-server",
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    versionArgs: ["--version"],
    extensions: [".py", ".pyi"],
    languageId: "python",
    installHint: "npm install -g pyright",
  },
  {
    id: "gopls",
    command: "gopls",
    args: [],
    versionArgs: ["version"],
    extensions: [".go"],
    languageId: "go",
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    versionArgs: ["--version"],
    extensions: [".rs"],
    languageId: "rust",
    installHint: "rustup component add rust-analyzer",
  },
  {
    id: "clangd",
    command: "clangd",
    args: [],
    versionArgs: ["--version"],
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
    languageId: "cpp",
    installHint: "Install clangd and add it to PATH",
  },
];

export function encodeLspMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export class LspMessageParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        throw new Error("LSP response is missing Content-Length");
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const messageEnd = bodyStart + contentLength;
      if (this.buffer.length < messageEnd) break;
      const body = this.buffer.subarray(bodyStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      messages.push(JSON.parse(body) as JsonRpcMessage);
    }
    return messages;
  }
}

export function selectPortableLspServer(
  filepath: string,
  definitions = PORTABLE_LSP_SERVERS,
): PortableLspServerDefinition | undefined {
  const extension = path.extname(filepath).toLowerCase();
  return definitions.find((definition) =>
    definition.extensions.includes(extension),
  );
}

function commandIsAvailable(definition: PortableLspServerDefinition): boolean {
  try {
    if (path.isAbsolute(definition.command)) {
      if (!fs.existsSync(definition.command)) return false;
    } else {
      execFileSync(
        process.platform === "win32" ? "where.exe" : "which",
        [definition.command],
        { stdio: "ignore" },
      );
    }
    execFileSync(definition.command, definition.versionArgs, {
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function findProjectRoot(filepath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.dirname(filepath),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return path.dirname(filepath);
  }
}

class PortableLspSession {
  private readonly parser = new LspMessageParser();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly diagnosticWaiters = new Map<
    string,
    (diagnostics: PortableDiagnostic[]) => void
  >();
  private requestId = 0;
  private documentVersion = 0;
  private readonly openedDocuments = new Set<string>();
  private stderr = "";

  constructor(
    private readonly definition: PortableLspServerDefinition,
    private readonly root: string,
    private readonly process: ChildProcessWithoutNullStreams,
  ) {
    process.stdout.on("data", (chunk: Buffer) => {
      for (const message of this.parser.push(chunk))
        this.handleMessage(message);
    });
    process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    process.on("error", (error) => this.rejectPending(error));
    process.on("exit", (code) => {
      this.rejectPending(
        new Error(
          `${definition.id} exited with code ${code ?? "unknown"}${
            this.stderr ? `: ${this.stderr.trim()}` : ""
          }`,
        ),
      );
    });
  }

  private write(message: JsonRpcMessage): void {
    this.process.stdin.write(encodeLspMessage({ jsonrpc: "2.0", ...message }));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.definition.id} timed out during ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending && message.method) {
        const result =
          message.method === "workspace/configuration"
            ? Array(
                (message.params as { items?: unknown[] } | undefined)?.items
                  ?.length ?? 0,
              ).fill(null)
            : null;
        this.write({ id: message.id, result });
        return;
      }
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "LSP request failed"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== "textDocument/publishDiagnostics") return;
    const params = message.params as
      | { uri?: string; diagnostics?: PortableDiagnostic[] }
      | undefined;
    if (!params?.uri) return;
    const waiter = this.diagnosticWaiters.get(params.uri);
    if (waiter) {
      this.diagnosticWaiters.delete(params.uri);
      waiter(params.diagnostics ?? []);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.diagnosticWaiters.values()) waiter([]);
    this.diagnosticWaiters.clear();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).toString(),
      capabilities: {
        textDocument: { publishDiagnostics: { relatedInformation: true } },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(this.root).toString(),
          name: path.basename(this.root),
        },
      ],
    });
    this.notify("initialized", {});
  }

  async diagnostics(
    filepath: string,
    timeoutMs: number,
  ): Promise<PortableDiagnosticsResult> {
    const uri = pathToFileURL(filepath).toString();
    const text = fs.readFileSync(filepath, "utf8");
    let timedOut = false;
    const diagnostics = await new Promise<PortableDiagnostic[]>((resolve) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        this.diagnosticWaiters.delete(uri);
        resolve([]);
      }, timeoutMs);
      this.diagnosticWaiters.set(uri, (items) => {
        clearTimeout(timeout);
        resolve(items);
      });
      const version = ++this.documentVersion;
      if (this.openedDocuments.has(uri)) {
        this.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      } else {
        this.openedDocuments.add(uri);
        this.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: this.definition.languageId,
            version,
            text,
          },
        });
      }
    });
    return { serverId: this.definition.id, diagnostics, timedOut };
  }

  async dispose(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      if (this.process.exitCode === null) {
        this.process.once("exit", () => resolve());
      } else {
        resolve();
      }
    });
    try {
      await Promise.race([
        this.request("shutdown", null),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      this.notify("exit", null);
    } finally {
      if (this.process.exitCode === null) this.process.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  }
}

export class PortableLspManager {
  private readonly sessions = new Map<string, Promise<PortableLspSession>>();

  constructor(
    private readonly definitions: PortableLspServerDefinition[] = PORTABLE_LSP_SERVERS,
  ) {}

  async getDiagnostics(
    filepath: string,
    timeoutMs = 5000,
  ): Promise<PortableDiagnosticsResult> {
    if (!fs.existsSync(filepath))
      throw new Error(`File does not exist: ${filepath}`);
    const definition = selectPortableLspServer(filepath, this.definitions);
    if (!definition) {
      throw new Error(
        `No portable LSP is configured for ${path.extname(filepath) || "this file type"}.`,
      );
    }
    if (!commandIsAvailable(definition)) {
      throw new Error(
        `${definition.id} is not installed or is not on PATH. Install it with: ${definition.installHint}`,
      );
    }

    const root = findProjectRoot(filepath);
    const key = `${definition.id}:${root}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = this.startSession(definition, root);
      this.sessions.set(key, session);
      session.catch(() => this.sessions.delete(key));
    }
    return (await session).diagnostics(filepath, timeoutMs);
  }

  private async startSession(
    definition: PortableLspServerDefinition,
    root: string,
  ): Promise<PortableLspSession> {
    const child = spawn(definition.command, definition.args, {
      cwd: root,
      shell:
        process.platform === "win32" && !path.isAbsolute(definition.command),
      stdio: "pipe",
      windowsHide: true,
    });
    const session = new PortableLspSession(definition, root, child);
    await session.initialize();
    return session;
  }

  async dispose(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    await Promise.all(
      sessions
        .filter(
          (item): item is PromiseFulfilledResult<PortableLspSession> =>
            item.status === "fulfilled",
        )
        .map((item) => item.value.dispose()),
    );
  }
}

export const portableLspManager = new PortableLspManager();
