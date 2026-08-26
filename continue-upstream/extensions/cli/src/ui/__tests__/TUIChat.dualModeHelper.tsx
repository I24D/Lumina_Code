import { render } from "ink-testing-library";
import React from "react";

import { createUITestContext } from "../../test-helpers/ui-test-context.js";
import { AppRoot } from "../AppRoot.js";

export type TestMode = "local" | "remote";

export interface DualModeRender {
  stdin: { write(data: string): void };
  lastFrame(): string | undefined;
  unmount(): void;
}

const activeRenders = new Set<DualModeRender>();

function cleanupRenders() {
  for (const instance of activeRenders) instance.unmount();
  activeRenders.clear();
}

// Dummy test to satisfy Vitest
describe("TUIChat dual mode helper", () => {
  it("exports helper functions", () => {
    expect(testBothModes).toBeDefined();
    expect(renderInMode).toBeDefined();
    expect(testSingleMode).toBeDefined();
  });
});

/**
 * Helper to run a test in both local and remote modes
 * This creates two test suites - one for each mode
 */
export function testBothModes(
  name: string,
  testFn: (mode: TestMode) => void | Promise<void>,
) {
  describe(`${name} [LOCAL MODE]`, () => {
    let context: any;

    beforeEach(() => {
      context = createUITestContext({
        allServicesReady: true,
        serviceState: "ready",
      });
    });

    afterEach(() => {
      cleanupRenders();
      context.cleanup();
    });

    it("works in local mode", async () => {
      await testFn("local");
    });
  });

  describe(`${name} [REMOTE MODE]`, () => {
    let context: any;

    beforeEach(() => {
      context = createUITestContext({
        allServicesReady: true,
        serviceState: "ready",
      });
    });

    afterEach(() => {
      cleanupRenders();
      context.cleanup();
    });

    it("works in remote mode", async () => {
      await testFn("remote");
    });
  });
}

/**
 * Helper to render TUIChat in the specified mode
 */
export function renderInMode(mode: TestMode, props?: any): DualModeRender {
  const instance = render(
    mode === "remote"
      ? React.createElement(AppRoot, {
          remoteUrl: "http://localhost:3000",
          ...props,
        })
      : React.createElement(AppRoot, props),
  ) as DualModeRender;
  activeRenders.add(instance);
  return instance;
}

/**
 * Helper to run a test in only one mode
 */
export function testSingleMode(
  name: string,
  mode: TestMode,
  testFn: () => void | Promise<void>,
) {
  describe(`${name} [${mode.toUpperCase()} MODE ONLY]`, () => {
    let context: any;

    beforeEach(() => {
      context = createUITestContext({
        allServicesReady: true,
        serviceState: "ready",
      });
    });

    afterEach(() => {
      cleanupRenders();
      context.cleanup();
    });

    it(`works in ${mode} mode`, async () => {
      await testFn();
    });
  });
}
