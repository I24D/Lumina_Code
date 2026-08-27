import react from "@vitejs/plugin-react-swc";
import { resolve } from "path";
import tailwindcss from "tailwindcss";
import { createLogger } from "vite";
import { defineConfig } from "vitest/config";
import { assertBrowserBuildWarningIsSafe } from "./browserBuildGuard";

const browserSafeLogger = createLogger();
const viteWarn = browserSafeLogger.warn.bind(browserSafeLogger);
browserSafeLogger.warn = (message, options) => {
  assertBrowserBuildWarningIsSafe(message);
  viteWarn(message, options);
};

// https://vitejs.dev/config/
export default defineConfig(() => ({
  customLogger: browserSafeLogger,
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: true,

    // Change the output .js filename to not include a hash
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        indexConsole: resolve(__dirname, "indexConsole.html"),
      },
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
  server: {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["*", "Content-Type", "Authorization"],
      credentials: true,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/util/test/setupTests.ts",
    /**
     * Vitest defaults to 5s and this suite does not fit in it: a full run
     * spends ~18 minutes, most of it in collect and in standing up jsdom, and
     * a test that renders a settings page and drives it through user-event was
     * timing out on the render rather than on anything it asserts. 30s covers
     * that on a loaded machine while still failing a genuine hang.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    onConsoleLog(log, type) {
      if (type === "stderr") {
        if (
          [
            "contentEditable",
            "An update to Chat inside a test was not wrapped in act",
            "An update to TipTapEditor inside a test was not wrapped in act",
            "An update to ThinkingIndicator inside a test was not wrapped in act",
            "The current testing environment is not configured to support act",
            "target.getClientRects is not a function",
            "prosemirror",
          ].some((text) => log.includes(text))
        ) {
          return false;
        }
      }
      return true;
    },
    onUnhandledRejection(err) {
      // Suppress ProseMirror DOM errors in test environment
      if (
        err.message?.includes("getClientRects") ||
        err.message?.includes("prosemirror")
      ) {
        return false;
      }
      return true;
    },
  },
}));
