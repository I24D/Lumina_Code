use tauri::{LogicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[tauri::command]
fn set_orb_window_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

// Orbe de Start Talk: ventana sin bordes, siempre-encima y fuera de la barra de
// tareas, que carga la MISMA gui de Lumina Code (ensamblada en `orb-frontend`).
// El shell inyecta, ANTES de que arranque la gui, la URL del bridge WebSocket a
// core (env `LUMINA_ORB_BRIDGE`) y el flag de autoarranque de Live mode, para
// que Start Talk y la delegación al agente funcionen igual que dentro de VS Code.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![set_orb_window_size])
        .setup(|app| {
            let bridge = std::env::var("LUMINA_ORB_BRIDGE").unwrap_or_default();
            let bridge_json = serde_json::to_string(&bridge).unwrap_or_else(|_| "\"\"".to_string());
            let init_script = [
                "window.__LUMINA_BRIDGE_URL__ = ",
                &bridge_json,
                r#";
window.luminaOrbAutostart = true;

(() => {
  const bridgeUrl = window.__LUMINA_BRIDGE_URL__;
  const pending = [];
  let socket;
  let reconnectTimer;
  let hasOpened = false;
  let reloadOnNextOpen = false;

  const connect = () => {
    if (!bridgeUrl) {
      console.error("[Lumina Orb] LUMINA_ORB_BRIDGE is missing.");
      return;
    }

    const nextSocket = new WebSocket(bridgeUrl);
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      if (reloadOnNextOpen) {
        window.location.reload();
        return;
      }
      hasOpened = true;
      while (pending.length > 0 && nextSocket.readyState === WebSocket.OPEN) {
        nextSocket.send(JSON.stringify(pending.shift()));
      }
    });

    nextSocket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
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
      reloadOnNextOpen = hasOpened;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 500);
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
      }
      return vscodeApi;
    },
  };

  window.vscode = vscodeApi;
  connect();
})();
"#,
            ]
            .concat();

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Lumina Live")
                .inner_size(420.0, 620.0)
                // El modo mini reduce la ventana nativa a un circulo de 88 px.
                .min_inner_size(88.0, 88.0)
                .maximized(false)
                .fullscreen(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(true)
                .center()
                .initialization_script(&init_script)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
