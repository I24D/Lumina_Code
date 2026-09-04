import { Navigate, RouterProvider, createMemoryRouter } from "react-router-dom";
import Layout from "./components/Layout";
import { MainEditorProvider } from "./components/mainInput/TipTapEditor";
import { LuminaVoiceDelegationBridge } from "./components/startTalk/LuminaVoiceDelegationBridge";
import { ScheduledTaskBridge } from "./components/scheduler/ScheduledTaskBridge";
import { SubmenuContextProvidersProvider } from "./context/SubmenuContextProviders";
import { VscThemeProvider } from "./context/VscTheme";
import ParallelListeners from "./hooks/ParallelListeners";
import ConfigPage from "./pages/config";
import ConnectionsPage from "./pages/connections";
import ErrorPage from "./pages/error";
import AssistantPanel from "./pages/assistant";
import Chat from "./pages/gui";
import History from "./pages/history";
import KnowledgePage from "./pages/knowledge";
import Stats from "./pages/stats";
import ChangesWalkthrough from "./pages/changes";
import WorkPanel from "./pages/work";
import SchedulePage from "./pages/schedule";
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
        path: ROUTES.SCHEDULE,
        element: <SchedulePage />,
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
      {
        path: ROUTES.CONNECTIONS,
        element: <ConnectionsPage />,
      },
      {
        path: ROUTES.KNOWLEDGE,
        element: <KnowledgePage />,
      },
      // Route vocabulary compatible with the Lumina-Openclaw workspace. These
      // are aliases into the SAME React UI and existing Continue/Lumina
      // backends; they never mount a second application.
      { path: "/chat", element: <Navigate replace to={ROUTES.HOME} /> },
      {
        path: "/sessions",
        element: <History />,
      },
      { path: "/worktrees", element: <History /> },
      { path: "/usage", element: <Navigate replace to={ROUTES.STATS} /> },
      { path: "/dashboard", element: <Navigate replace to={ROUTES.WORK} /> },
      { path: "/tasks", element: <Navigate replace to={ROUTES.WORK} /> },
      {
        path: "/automations",
        element: <Navigate replace to={ROUTES.SCHEDULE} />,
      },
      {
        // The workboard is a section of the Work panel; /changes is the diff
        // walkthrough and has never had a board on it.
        path: "/workboard",
        element: <Navigate replace to={ROUTES.WORK} />,
      },
      {
        path: "/settings/general",
        element: <Navigate replace to="/config?tab=settings" />,
      },
      {
        path: "/settings/model-providers",
        element: <Navigate replace to="/config?tab=models" />,
      },
      {
        path: "/settings/mcp",
        element: <Navigate replace to="/config?tab=tools" />,
      },
      {
        path: "/skills",
        element: <Navigate replace to="/config?tab=skills" />,
      },
      {
        path: "/settings/memory",
        element: <Navigate replace to="/config?tab=indexing" />,
      },
      {
        path: "/settings/security",
        element: <Navigate replace to="/config?tab=privacy" />,
      },
      {
        path: "/settings/talk",
        element: <Navigate replace to="/config?tab=talk" />,
      },
      {
        path: "/settings/appearance",
        element: <Navigate replace to={ROUTES.THEME} />,
      },
      {
        path: "/settings/infrastructure",
        element: <Navigate replace to="/config?tab=runtime" />,
      },
      {
        path: "/logs",
        element: <Navigate replace to="/config?tab=runtime" />,
      },
      {
        path: "/debug",
        element: <Navigate replace to="/config?tab=runtime" />,
      },
    ],
  },
]);


/*
  ParallelListeners prevents entire app from rerendering on any change in the listeners,
  most of which interact with redux etc.
*/
function App() {
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
      <ScheduledTaskBridge />
    </VscThemeProvider>
  );
}

export default App;
