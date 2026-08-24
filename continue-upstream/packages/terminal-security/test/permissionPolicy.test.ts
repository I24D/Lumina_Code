import { describe, expect, it } from "vitest";

import {
  evaluatePermissionPolicies,
  evaluateSurfaceAuthorization,
} from "../src/permissionPolicy.js";

describe("shared permission policy", () => {
  it("uses first-match tool and argument rules", () => {
    const result = evaluatePermissionPolicies(
      { name: "Bash", arguments: { command: "git status" } },
      {
        policies: [
          { tool: "Bash(git *)", permission: "allow" },
          { tool: "Bash", permission: "exclude" },
        ],
      },
    );
    expect(result.permission).toBe("allow");
  });

  it("defaults unmatched tools to ask", () => {
    expect(
      evaluatePermissionPolicies(
        { name: "external_tool", arguments: {} },
        { policies: [] },
      ).permission,
    ).toBe("ask");
  });

  it("never treats a Start Talk model request as user approval", () => {
    expect(
      evaluateSurfaceAuthorization({
        surface: "start-talk",
        capability: "delegate-agent",
        userApproved: false,
        policy: "allow",
      }),
    ).toEqual({
      authorized: false,
      reason: "explicit-user-approval-required",
    });
    expect(
      evaluateSurfaceAuthorization({
        surface: "start-talk",
        capability: "delegate-agent",
        userApproved: true,
        policy: "allow",
      }).authorized,
    ).toBe(true);
  });

  it("lets an explicit exclusion override user approval", () => {
    expect(
      evaluateSurfaceAuthorization({
        surface: "vscode",
        capability: "execute-terminal",
        userApproved: true,
        policy: "exclude",
      }),
    ).toEqual({ authorized: false, reason: "policy-excluded" });
  });
});
