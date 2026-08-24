// Valid config tab names
export type ConfigTab =
  | "models"
  | "rules"
  | "tools"
  | "skills"
  | "configs"
  | "indexing"
  | "privacy"
  | "settings"
  | "help"
  | "runtime"
  | "talk";

// TODO: Move all the routes here
export const ROUTES = {
  HOME: "/",
  HOME_INDEX: "/index.html",
  CONFIG: "/config",
  THEME: "/theme",
  STATS: "/stats",
  CHANGES: "/changes",
  WORK: "/work",
  SCHEDULE: "/schedule",
  ASSISTANT: "/assistant",
  HISTORY: "/history",
  CONNECTIONS: "/connections",
  KNOWLEDGE: "/knowledge",
  // EXAMPLE_ROUTE_WITH_PARAMS: (params: ParamsType) => `/route/${params}`,
};

// Helper function to build config URLs with tabs
export const buildConfigRoute = (tab?: ConfigTab): string => {
  return tab ? `${ROUTES.CONFIG}?tab=${tab}` : ROUTES.CONFIG;
};

// Typed config route builders for common tabs
export const CONFIG_ROUTES = {
  MODELS: buildConfigRoute("models"),
  RULES: buildConfigRoute("rules"),
  TOOLS: buildConfigRoute("tools"),
  SKILLS: buildConfigRoute("skills"),
  CONFIGS: buildConfigRoute("configs"),
  INDEXING: buildConfigRoute("indexing"),
  PRIVACY: buildConfigRoute("privacy"),
  SETTINGS: buildConfigRoute("settings"),
  HELP: buildConfigRoute("help"),
  RUNTIME: buildConfigRoute("runtime"),
  TALK: buildConfigRoute("talk"),
} as const;
