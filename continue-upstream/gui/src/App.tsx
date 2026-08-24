import { RouterProvider, createMemoryRouter } from "react-router-dom";
import Layout from "./components/Layout";
import { MainEditorProvider } from "./components/mainInput/TipTapEditor";
import { LiveConversationOverlay } from "./components/startTalk/LiveConversationOverlay";
import { LuminaVoiceDelegationBridge } from "./components/startTalk/LuminaVoiceDelegationBridge";
import { SubmenuContextProvidersProvider } from "./context/SubmenuContextProviders";
import { VscThemeProvider } from "./context/VscTheme";
import ParallelListeners from "./hooks/ParallelListeners";
import ConfigPage from "./pages/config";
import ErrorPage from "./pages/error";
import AssistantPanel from "./pages/assistant";
import Chat from "./pages/gui";
import History from "./pages/history";
import Stats from "./pages/stats";
import ChangesWalkthrough from "./pages/changes";
import WorkPanel from "./pages/work";
import ThemePage from "./styles/ThemePage";
import { ROUTES } from "./util/navigation";

const router = createMemoryRouter([
  {
    path: ROUTES.HOME,
    element: <Layout />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "/index.html",
        element: <Chat />,
      },
      {
        path: ROUTES.HOME,
        element: <Chat />,
      },
      {
        path: "/history",
        element: <History />,
      },
      {
        path: ROUTES.STATS,
        element: <Stats />,
      },
      {
        path: ROUTES.CHANGES,
        element: <ChangesWalkthrough />,
      },
      {
        path: ROUTES.WORK,
        element: <WorkPanel />,
      },
      {
        path: ROUTES.CONFIG,
        element: <ConfigPage />,
      },
      {
        path: ROUTES.ASSISTANT,
        element: <AssistantPanel />,
      },
      {
        path: ROUTES.THEME,
        element: <ThemePage />,
      },
    ],
  },
]);

function closeOrbWindow() {
  // En el orbe de escritorio (Tauri) cerrar Start Talk cierra la ventana.
  const tauri = (window as any).__TAURI__;
  try {
    tauri?.window?.getCurrentWindow?.().close();
  } catch {
    window.close();
  }
}

/**
 * Modo orbe: la ventana Tauri flotante monta SOLO el overlay de Start Talk
 * (no todo el chat de Lumina Code), reutilizando los mismos providers y
 * `ParallelListeners` (que carga la config desde core). El overlay es una
 * tarjeta flotante con click-through alrededor → parece un widget sobre el
 * escritorio. La activa el flag `window.luminaOrbAutostart` (shell Rust).
 */
function OrbApp() {
  return (
    <VscThemeProvider>
      <MainEditorProvider>
        <SubmenuContextProvidersProvider>
          <LiveConversationOverlay isOpen onClose={closeOrbWindow} />
        </SubmenuContextProvidersProvider>
      </MainEditorProvider>
      <ParallelListeners />
    </VscThemeProvider>
  );
}

/*
  ParallelListeners prevents entire app from rerendering on any change in the listeners,
  most of which interact with redux etc.
*/
function App() {
  if ((window as any).luminaOrbAutostart) {
    return <OrbApp />;
  }

  return (
    <VscThemeProvider>
      <MainEditorProvider>
        <SubmenuContextProvidersProvider>
          <RouterProvider router={router} />
        </SubmenuContextProvidersProvider>
      </MainEditorProvider>
      <ParallelListeners />
      {/* Runs voice-delegated tasks in the real chat (sidebar only). */}
      <LuminaVoiceDelegationBridge />
    </VscThemeProvider>
  );
}

export default App;
