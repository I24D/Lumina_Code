/**
 * Arranque del orbe de Start Talk en el navegador.
 *
 * Se inyecta en el `index.html` que sirve `OrbBridgeServer`, ANTES de que
 * arranque la gui, y le da dos cosas que dentro de VS Code aporta el webview:
 *
 *   - `window.vscode.postMessage`, aquí sobre el WebSocket del puente;
 *   - `window.luminaOrbAutostart`, que hace que la app monte solo el overlay de
 *     Start Talk en vez del chat completo (ver `App.tsx`).
 *
 * Antes este mismo script lo inyectaba el shell Tauri (`src-tauri/src/lib.rs`)
 * como `initialization_script`. Al pasar el orbe a una pestaña, el responsable
 * de inyectarlo es quien sirve la página.
 *
 * El token viaja en la URL porque el navegador necesita recibirlo de algún
 * modo, pero se borra de la barra de direcciones nada más leerlo para que no
 * quede en el historial ni se filtre por `Referer` al copiar la URL.
 */

/** Devuelve el JavaScript de arranque para una URL de puente concreta. */
export function buildOrbBootstrapScript(bridgeUrl: string): string {
  return `
window.__LUMINA_BRIDGE_URL__ = ${JSON.stringify(bridgeUrl)};
window.luminaOrbAutostart = true;

(() => {
  // El token ya está en el script inyectado: fuera de la barra de direcciones.
  try {
    if (window.location.search.includes("token=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  } catch (error) {
    // Sin history API la página sigue funcionando igual.
  }

  const bridgeUrl = window.__LUMINA_BRIDGE_URL__;
  const pending = [];
  let socket;
  let reconnectTimer;
  let heartbeatTimer;
  let reconnectAttempt = 0;
  let lastHeartbeatAck = Date.now();
  let hasOpened = false;
  let reloadOnNextOpen = false;

  const connect = () => {
    if (!bridgeUrl) {
      console.error("[Lumina Orb] Bridge URL is missing.");
      return;
    }

    const nextSocket = new WebSocket(bridgeUrl);
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      reconnectAttempt = 0;
      lastHeartbeatAck = Date.now();
      // Tras una recarga del host de la extensión el puente vuelve en el mismo
      // puerto, pero core ya no conserva el estado de la sesión anterior: la
      // página se recarga para volver a arrancar limpia.
      if (reloadOnNextOpen) {
        window.location.reload();
        return;
      }
      hasOpened = true;
      while (pending.length > 0 && nextSocket.readyState === WebSocket.OPEN) {
        nextSocket.send(JSON.stringify(pending.shift()));
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (nextSocket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastHeartbeatAck > 15000) {
          nextSocket.close(4000, "heartbeat timeout");
          return;
        }
        nextSocket.send(JSON.stringify({
          messageType: "__lumina/heartbeat",
          messageId: String(Date.now()),
          data: { at: Date.now() },
        }));
      }, 5000);
    });

    nextSocket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data?.messageType === "__lumina/heartbeatAck") {
          lastHeartbeatAck = Date.now();
          return;
        }
        window.dispatchEvent(new MessageEvent("message", { data }));
      } catch (error) {
        console.error("[Lumina Orb] Invalid bridge message.", error);
      }
    });

    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) {
        return;
      }
      socket = undefined;
      clearInterval(heartbeatTimer);
      reloadOnNextOpen = hasOpened;
      clearTimeout(reconnectTimer);
      reconnectAttempt += 1;
      const delay = Math.min(10000, 500 * (2 ** Math.min(reconnectAttempt - 1, 5)));
      reconnectTimer = setTimeout(connect, delay);
    });

    nextSocket.addEventListener("error", () => {
      nextSocket.close();
    });
  };

  const vscodeApi = {
    postMessage(message) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      } else {
        pending.push(message);
        // A closed browser tab or extension reload must not grow this forever.
        if (pending.length > 500) pending.splice(0, pending.length - 500);
      }
      return vscodeApi;
    },
  };

  window.vscode = vscodeApi;
  connect();
})();
`;
}
