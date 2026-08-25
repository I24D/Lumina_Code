import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { SkillUsageView } from "core/learning/types";
import type { SkillWithUsage } from "core/protocol/core";
import { vi } from "vitest";

import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { SkillsSection } from "./SkillsSection";

function skill(name: string, usage?: SkillUsageView): SkillWithUsage {
  return {
    name,
    description: `use ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: "",
    files: [],
    usage,
  };
}

function activeUsage(overrides: Partial<SkillUsageView> = {}): SkillUsageView {
  return {
    name: "unused",
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    useCount: 4,
    patchCount: 0,
    pinned: false,
    state: "active",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SkillsSection", () => {
  it("shows how often a skill has actually been used", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [
      skill("deploy", activeUsage({ name: "deploy", useCount: 4 })),
    ];
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    expect(await screen.findByTestId("skill-usage-deploy")).toHaveTextContent(
      "Used 4 times",
    );
  });

  it("distinguishes a skill never reached for from one used zero times", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [skill("fresh")];
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    // No telemetry at all is the normal state of a hand-written skill; it must
    // not read as a failing grade.
    expect(await screen.findByTestId("skill-usage-fresh")).toHaveTextContent(
      "Not used yet",
    );
  });

  it("marks the skills Lumina wrote for herself", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [
      skill("learned", activeUsage({ name: "learned", createdBy: "agent" })),
      skill("manual", activeUsage({ name: "manual", createdBy: "user" })),
    ];
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    await screen.findByTestId("skill-card-learned");
    expect(screen.getAllByText("Learned by Lumina")).toHaveLength(1);
  });

  it("archives a skill and renders what core sent back", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [
      skill("stale-one", activeUsage({ name: "stale-one" })),
    ];
    mockIdeMessenger.responses["skills/curate"] = [
      skill("stale-one", activeUsage({ name: "stale-one", state: "archived" })),
    ];
    const spy = vi.spyOn(mockIdeMessenger, "request");
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    await screen.findByTestId("skill-card-stale-one");
    await userEvent.click(screen.getByTestId("skill-archive-stale-one"));

    const curateCall = spy.mock.calls.find(
      (call) => call[0] === "skills/curate",
    );
    expect(curateCall?.[1]).toMatchObject({
      name: "stale-one",
      action: "archive",
    });
    // The list must reflect what was persisted, not an optimistic guess.
    expect(await screen.findByText("Archived")).toBeInTheDocument();
  });

  it("opens the SKILL.md rather than curating when the card itself is clicked", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [
      skill("deploy", activeUsage({ name: "deploy" })),
    ];
    const post = vi.spyOn(mockIdeMessenger, "post");
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    await userEvent.click(await screen.findByTestId("skill-card-deploy"));

    expect(
      post.mock.calls.some((call) => call[0] === "openFile"),
    ).toBe(true);
  });

  it("says the list is empty only once it is actually known to be", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["skills/list"] = [];
    await renderWithProviders(<SkillsSection />, { mockIdeMessenger });

    expect(await screen.findByText(/No skills yet/u)).toBeInTheDocument();
  });
});
