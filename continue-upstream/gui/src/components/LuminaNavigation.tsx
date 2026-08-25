import {
  AdjustmentsHorizontalIcon,
  ArrowTrendingUpIcon,
  Bars3Icon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ClockIcon,
  CircleStackIcon,
  CodeBracketSquareIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
  LinkIcon,
  PaintBrushIcon,
  PlusIcon,
  RectangleGroupIcon,
  SparklesIcon,
  Squares2X2Icon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { newSession } from "../redux/slices/sessionSlice";
import { exitEdit } from "../redux/thunks/edit";
import { loadSession, saveCurrentSession } from "../redux/thunks/session";
import { ROUTES } from "../util/navigation";
import { LuminaAvatarIcon } from "../pages/gui/LuminaAvatarStrip";
import { LuminaWorkspaceSwitcher } from "./LuminaWorkspaceSwitcher";

type NavigationItem = {
  label: string;
  description: string;
  path: string;
  icon: typeof ChatBubbleLeftRightIcon;
};

const PRIMARY_ITEMS: NavigationItem[] = [
  {
    label: "Chat",
    description: "Programar con Lumina",
    path: ROUTES.HOME,
    icon: ChatBubbleLeftRightIcon,
  },
  {
    label: "Trabajo",
    description: "Sesiones, metas y tareas",
    path: ROUTES.WORK,
    icon: Squares2X2Icon,
  },
  {
    label: "Cambios",
    description: "Recorrido y aprobaciones",
    path: ROUTES.CHANGES,
    icon: CodeBracketSquareIcon,
  },
  {
    label: "Programado",
    description: "Automatizaciones persistentes",
    path: ROUTES.SCHEDULE,
    icon: CalendarDaysIcon,
  },
];

const SECONDARY_ITEMS: NavigationItem[] = [
  {
    label: "Asistente",
    description: "Planes y ejecución",
    path: ROUTES.ASSISTANT,
    icon: SparklesIcon,
  },
  {
    label: "Uso",
    description: "Tokens y actividad",
    path: ROUTES.STATS,
    icon: ArrowTrendingUpIcon,
  },
  {
    label: "Conocimiento",
    description: "Contexto, reglas y habilidades",
    path: ROUTES.KNOWLEDGE,
    icon: CircleStackIcon,
  },
  {
    label: "Conexiones",
    description: "Modelos, MCP, voz y runtime",
    path: ROUTES.CONNECTIONS,
    icon: LinkIcon,
  },
  {
    label: "Sesiones",
    description: "Chats, forks y worktrees",
    path: ROUTES.HISTORY,
    icon: ClockIcon,
  },
];

const SETTINGS_ITEMS: NavigationItem[] = [
  {
    label: "Apariencia",
    description: "Tema y personalización",
    path: ROUTES.THEME,
    icon: PaintBrushIcon,
  },
  {
    label: "Configuración",
    description: "Modelos, reglas y herramientas",
    path: ROUTES.CONFIG,
    icon: AdjustmentsHorizontalIcon,
  },
];

const ALL_ITEMS = [...PRIMARY_ITEMS, ...SECONDARY_ITEMS, ...SETTINGS_ITEMS];

function isRouteActive(pathname: string, path: string) {
  if (path === ROUTES.HOME) {
    return pathname === ROUTES.HOME || pathname === ROUTES.HOME_INDEX;
  }
  if (path === ROUTES.HISTORY) {
    return [ROUTES.HISTORY, "/sessions", "/worktrees"].includes(pathname);
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

function titleForRoute(pathname: string) {
  return ALL_ITEMS.find((item) => isRouteActive(pathname, item.path))?.label;
}

export function LuminaAppShell({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const allSessions = useAppSelector(
    (state) => state.session.allSessionMetadata,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("luminaCode.navigationCollapsed") === "true",
  );

  const recentSessions = useMemo(
    () =>
      [...allSessions]
        .sort(
          (left, right) =>
            new Date(right.dateCreated).getTime() -
            new Date(left.dateCreated).getTime(),
        )
        .slice(0, 7),
    [allSessions],
  );

  const paletteItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return ALL_ITEMS;
    return ALL_ITEMS.filter((item) =>
      `${item.label} ${item.description}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [query]);

  const closeOverlays = useCallback(() => {
    setDrawerOpen(false);
    setPaletteOpen(false);
    setQuery("");
  }, []);

  const goTo = useCallback(
    (path: string) => {
      navigate(path);
      closeOverlays();
    },
    [closeOverlays, navigate],
  );

  const startNewSession = useCallback(async () => {
    navigate(ROUTES.HOME);
    if (isInEdit) {
      await dispatch(exitEdit({ openNewSession: true }));
    } else if (historyLength === 0) {
      dispatch(newSession());
    } else {
      await dispatch(
        saveCurrentSession({ openNewSession: true, generateTitle: true }),
      );
    }
    closeOverlays();
  }, [closeOverlays, dispatch, historyLength, isInEdit, navigate]);

  const openSession = useCallback(
    async (sessionId: string) => {
      await dispatch(exitEdit({}));
      if (sessionId !== currentSessionId) {
        await dispatch(loadSession({ sessionId, saveCurrentSession: true }));
      }
      goTo(ROUTES.HOME);
    },
    [currentSessionId, dispatch, goTo],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "Escape") {
        closeOverlays();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOverlays]);

  useEffect(() => {
    if (paletteOpen) {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [paletteOpen]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const renderNavigationItem = (item: NavigationItem) => {
    const Icon = item.icon;
    const active = isRouteActive(location.pathname, item.path);
    return (
      <button
        key={item.path}
        type="button"
        className="lumina-nav-item"
        data-active={active || undefined}
        title={collapsed ? `${item.label} — ${item.description}` : undefined}
        aria-current={active ? "page" : undefined}
        onClick={() => goTo(item.path)}
      >
        <Icon aria-hidden="true" />
        <span className="lumina-nav-item__copy">
          <strong>{item.label}</strong>
          <small>{item.description}</small>
        </span>
      </button>
    );
  };

  return (
    <div
      className="lumina-shell"
      data-nav-collapsed={collapsed || undefined}
      data-drawer-open={drawerOpen || undefined}
    >
      <a className="lumina-skip-link" href="#lumina-main-content">
        Saltar al contenido
      </a>

      <aside className="lumina-sidebar" aria-label="Navegación principal">
        <div className="lumina-sidebar__brand">
          <LuminaAvatarIcon className="lumina-sidebar__logo" />
          <div className="lumina-sidebar__brand-copy">
            <strong>Lumina Code</strong>
            <span>Developer workspace</span>
          </div>
          <button
            type="button"
            className="lumina-icon-button lumina-sidebar__close"
            aria-label="Cerrar navegación"
            onClick={() => setDrawerOpen(false)}
          >
            <XMarkIcon />
          </button>
        </div>

        <button
          type="button"
          className="lumina-new-chat"
          onClick={() => void startNewSession()}
          title={collapsed ? "Nueva conversación" : undefined}
        >
          <PlusIcon aria-hidden="true" />
          <span>Nueva conversación</span>
          <kbd>Ctrl L</kbd>
        </button>

        <div className="lumina-sidebar__scroll thin-scrollbar">
          <nav className="lumina-nav-group" aria-label="Espacio de trabajo">
            <span className="lumina-nav-group__label">Workspace</span>
            {PRIMARY_ITEMS.map(renderNavigationItem)}
          </nav>

          <nav className="lumina-nav-group" aria-label="Actividad">
            <span className="lumina-nav-group__label">Actividad</span>
            {SECONDARY_ITEMS.map(renderNavigationItem)}
          </nav>

          {!collapsed && recentSessions.length > 0 && (
            <section className="lumina-recents" aria-label="Sesiones recientes">
              <div className="lumina-recents__heading">
                <span>Recientes</span>
                <button type="button" onClick={() => goTo(ROUTES.HISTORY)}>
                  Ver todas
                </button>
              </div>
              {recentSessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className="lumina-recent-session"
                  data-active={
                    session.sessionId === currentSessionId || undefined
                  }
                  onClick={() => void openSession(session.sessionId)}
                  title={session.title}
                >
                  <ChatBubbleLeftRightIcon aria-hidden="true" />
                  <span>{session.title}</span>
                </button>
              ))}
            </section>
          )}
        </div>

        <div className="lumina-sidebar__footer">
          {SETTINGS_ITEMS.map(renderNavigationItem)}
          <button
            type="button"
            className="lumina-nav-collapse"
            aria-label={
              collapsed ? "Expandir navegación" : "Contraer navegación"
            }
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              localStorage.setItem(
                "luminaCode.navigationCollapsed",
                String(next),
              );
            }}
          >
            {collapsed ? <ChevronDoubleRightIcon /> : <ChevronDoubleLeftIcon />}
            <span>{collapsed ? "Expandir" : "Contraer"}</span>
          </button>
        </div>
      </aside>

      <button
        className="lumina-drawer-backdrop"
        aria-label="Cerrar navegación"
        type="button"
        onClick={() => setDrawerOpen(false)}
      />

      <section className="lumina-workspace">
        <LuminaWorkspaceSwitcher
          pageTitle={titleForRoute(location.pathname)}
          leading={
            <button
              type="button"
              className="lumina-icon-button lumina-menu-button"
              aria-label="Abrir navegación"
              onClick={() => setDrawerOpen(true)}
            >
              <Bars3Icon />
            </button>
          }
          trailing={
            <button
              type="button"
              className="lumina-command-trigger"
              onClick={() => setPaletteOpen(true)}
              aria-label="Abrir paleta de navegación"
            >
              <MagnifyingGlassIcon aria-hidden="true" />
              <span>Ir a…</span>
              <kbd>Ctrl K</kbd>
            </button>
          }
        />
        <main id="lumina-main-content" className="lumina-workspace__content">
          {children}
        </main>
      </section>

      {paletteOpen && (
        <div
          className="lumina-command-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeOverlays();
          }}
        >
          <section
            className="lumina-command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Navegar por Lumina Code"
          >
            <div className="lumina-command-palette__search">
              <CommandLineIcon aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar chats, trabajo, cambios o ajustes…"
                aria-label="Buscar destino"
              />
              <kbd>Esc</kbd>
            </div>
            <div className="lumina-command-palette__results thin-scrollbar">
              <button
                type="button"
                className="lumina-command-result"
                onClick={() => void startNewSession()}
              >
                <span className="lumina-command-result__icon">
                  <PlusIcon />
                </span>
                <span>
                  <strong>Nueva conversación</strong>
                  <small>Comenzar una sesión limpia</small>
                </span>
              </button>
              {paletteItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    type="button"
                    className="lumina-command-result"
                    onClick={() => goTo(item.path)}
                  >
                    <span className="lumina-command-result__icon">
                      <Icon />
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                    <RectangleGroupIcon className="lumina-command-result__go" />
                  </button>
                );
              })}
              {paletteItems.length === 0 && (
                <p className="lumina-command-palette__empty">
                  No hay destinos que coincidan con “{query}”.
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
