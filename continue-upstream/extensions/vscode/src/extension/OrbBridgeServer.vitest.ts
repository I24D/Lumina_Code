import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// El servidor solo toca `vscode` en el camino de autorización de delegaciones,
// que estas pruebas no ejercitan.
vi.mock("vscode", () => ({ window: {}, commands: {}, Uri: {} }));

import { OrbBridgeServer, resolveOrbFrontendRoot } from "./OrbBridgeServer";

import type { VsCodeWebviewProtocol } from "../webviewProtocol";

/** El servidor solo usa el protocolo al abrir un WebSocket; aquí basta un doble. */
const protocolStub = {
  addExternalSink: () => () => undefined,
  handleExternalMessage: async () => undefined,
} as unknown as VsCodeWebviewProtocol;

let root: string;
let secretRoot: string;
const servers: OrbBridgeServer[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-frontend-"));
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<html><head><title>Lumina</title></head><body></body></html>",
    "utf8",
  );
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "index.js"), "export {};", "utf8");

  // Un archivo FUERA de la raíz, para probar el recorrido de rutas.
  secretRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orb-secret-"));
  fs.writeFileSync(path.join(secretRoot, "secret.txt"), "no salir", "utf8");
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.dispose();
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(secretRoot, { recursive: true, force: true });
});

async function startServer(): Promise<{
  server: OrbBridgeServer;
  url: string;
}> {
  const server = new OrbBridgeServer(protocolStub, root);
  servers.push(server);
  await server.start();
  return { server, url: server.orbUrl() };
}

describe("resolveOrbFrontendRoot", () => {
  it("returns undefined when no bundle is present", () => {
    expect(resolveOrbFrontendRoot(secretRoot)).toBeUndefined();
  });

  it("finds the bundle shipped next to the extension", () => {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), "orb-ext-"));
    fs.mkdirSync(path.join(extensionPath, "gui"));
    fs.writeFileSync(path.join(extensionPath, "gui", "index.html"), "<html>");

    expect(resolveOrbFrontendRoot(extensionPath)).toBe(
      path.join(extensionPath, "gui"),
    );
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  it("prefers the freshly built bundle in development", () => {
    // En un checkout conviven la copia empaquetada (que solo se refresca al
    // generar el VSIX) y gui/dist. Servir la primera en desarrollo mostraría
    // una interfaz vieja sin que nada fallara.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orb-ws-"));
    const extensionPath = path.join(workspace, "extensions", "vscode");
    fs.mkdirSync(path.join(extensionPath, "gui"), { recursive: true });
    fs.writeFileSync(path.join(extensionPath, "gui", "index.html"), "<html>");
    const built = path.join(workspace, "gui", "dist");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "index.html"), "<html>");

    expect(resolveOrbFrontendRoot(extensionPath, true)).toBe(built);
    expect(resolveOrbFrontendRoot(extensionPath, false)).toBe(
      path.join(extensionPath, "gui"),
    );

    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

describe("serving the orb", () => {
  it("injects the bridge bootstrap into the served page", async () => {
    const { url } = await startServer();

    const response = await fetch(url);
    const html = await response.text();

    expect(response.status).toBe(200);
    // Sin esto la gui arrancaría como el chat normal y sin transporte.
    expect(html).toContain("window.luminaOrbAutostart = true");
    expect(html).toContain("window.__LUMINA_BRIDGE_URL__");
    expect(html).toContain("ws://127.0.0.1:");
    // Y el contenido original sigue ahí.
    expect(html).toContain("<title>Lumina</title>");
  });

  it("refuses the page without the session token", async () => {
    const { server } = await startServer();
    const withoutToken = server.orbUrl().replace(/\?token=.*$/u, "");

    const response = await fetch(withoutToken);

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("__LUMINA_BRIDGE_URL__");
  });

  it("refuses the page with a wrong token", async () => {
    const { server } = await startServer();
    const wrong = server.orbUrl().replace(/token=.*$/u, "token=nope");

    expect((await fetch(wrong)).status).toBe(403);
  });

  it("serves bundle assets with their content type", async () => {
    const { server } = await startServer();
    const base = server.orbUrl().replace(/\/\?token=.*$/u, "");

    const response = await fetch(`${base}/assets/index.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });

  it("never serves a file outside the bundle root", async () => {
    // Un traversal serviría archivos arbitrarios del disco del usuario.
    const { server } = await startServer();
    const base = server.orbUrl().replace(/\/\?token=.*$/u, "");
    const escape = encodeURIComponent(
      path.join(secretRoot, "secret.txt"),
    ).replace(/%2F/gu, "/");

    const response = await fetch(`${base}/../../../../${escape}`);

    expect(response.status).not.toBe(200);
  });

  it("is a WebSocket-only transport when no bundle root is given", async () => {
    // Así lo usa el puente MCP: mismo transporte, sin interfaz que servir.
    const server = new OrbBridgeServer(protocolStub);
    servers.push(server);
    await server.start();

    expect((await fetch(server.orbUrl())).status).toBe(404);
  });
});

describe("bridge lifecycle", () => {
  it("reuses port and token so an open tab reconnects after a reload", async () => {
    const first = new OrbBridgeServer(protocolStub, root);
    const { port, token } = await first.start();
    first.dispose();

    const second = new OrbBridgeServer(protocolStub, root);
    servers.push(second);
    const restored = await second.start({ preferredPort: port, token });

    expect(restored.token).toBe(token);
    expect(restored.port).toBe(port);
  });

  it("falls back to an ephemeral port when the preferred one is taken", async () => {
    const holder = new OrbBridgeServer(protocolStub, root);
    servers.push(holder);
    const { port } = await holder.start();

    const other = new OrbBridgeServer(protocolStub, root);
    servers.push(other);
    const result = await other.start({ preferredPort: port });

    expect(result.port).not.toBe(port);
    expect(result.port).toBeGreaterThan(0);
  });
});
