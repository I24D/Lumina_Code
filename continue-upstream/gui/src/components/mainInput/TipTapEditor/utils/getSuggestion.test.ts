import { describe, expect, it, vi } from "vitest";
import type { ComboBoxItem } from "../../types";
import { getSlashCommandDropdownOptions } from "./getSuggestion";

function createOptions(items: ComboBoxItem[]) {
  return getSlashCommandDropdownOptions(
    { current: items },
    vi.fn(),
    vi.fn(),
    {} as any,
    vi.fn() as any,
    "main-input",
  );
}

describe("getSlashCommandDropdownOptions", () => {
  const action = vi.fn();
  const commands: ComboBoxItem[] = [
    {
      title: "/new",
      description: "Start a new session",
      type: "action",
      category: "SESSION",
      badge: "instant",
      icon: "plus",
      action,
    },
    {
      title: "/compact",
      description: "Compact conversation",
      type: "action",
      category: "SESSION",
      icon: "sparkles",
      action: vi.fn(),
    },
  ];

  it.each([
    ["new", "/new"],
    ["compact", "/compact"],
    ["/new", "/new"],
  ])("matches query %s against slash-prefixed titles", async (query, title) => {
    const options = createOptions(commands);

    const result = await options.items({ query });

    expect(result.map((item) => item.title)).toEqual([title]);
  });

  it("preserves action behavior and presentation metadata", async () => {
    const options = createOptions(commands);

    const [result] = await options.items({ query: "new" });

    expect(result).toMatchObject({
      title: "/new",
      type: "action",
      category: "SESSION",
      badge: "instant",
      icon: "plus",
    });
    result.action?.();
    expect(action).toHaveBeenCalledOnce();
  });
});
