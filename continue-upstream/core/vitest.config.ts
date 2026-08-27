import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTransformMode: {
      web: ["/.[jt]s?$/"],
      ssr: ["/.[jt]s?$/"],
    },
    globalSetup: "./test/vitest.global-setup.ts",
    setupFiles: "./test/vitest.setup.ts",
    fileParallelism: false,
    include: ["**/*.vitest.ts"],
    /**
     * Vitest defaults to 5s, and this suite does not fit in it. Nine tests
     * failed against that default — every one of them a test that does real
     * I/O rather than one with a bug: `git init` plus a worktree create and
     * remove, `node -e` subprocesses, a tree-sitter WASM load. The Git
     * integration test alone measures 5.02s on this machine, so it sat exactly
     * on the line and would have kept flaking either way.
     *
     * 30s is chosen to cover that work on a loaded Windows box while still
     * being short enough that a genuine hang fails the run instead of parking
     * it. Raise a single test's own timeout rather than this number.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
