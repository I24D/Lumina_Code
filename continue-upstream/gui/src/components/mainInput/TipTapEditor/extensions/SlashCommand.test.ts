import { describe, expect, it, vi } from "vitest";
import { executeSlashCommand } from "./SlashCommand";

function createEditor() {
  const chain = {
    focus: vi.fn(),
    deleteRange: vi.fn(),
    run: vi.fn(),
  };
  chain.focus.mockReturnValue(chain);
  chain.deleteRange.mockReturnValue(chain);

  return {
    editor: {
      chain: () => chain,
      commands: { insertPrompt: vi.fn() },
    } as any,
    chain,
  };
}

describe("executeSlashCommand", () => {
  it("removes the query and executes an action without inserting prompt text", () => {
    const { editor, chain } = createEditor();
    const action = vi.fn();

    executeSlashCommand(
      editor,
      { from: 1, to: 6 },
      {
        title: "/goal",
        description: "Set session goal",
        type: "action",
        action,
      },
    );

    expect(chain.focus).toHaveBeenCalledOnce();
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 1, to: 6 });
    expect(chain.run).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(editor.commands.insertPrompt).not.toHaveBeenCalled();
  });

  it("keeps the existing insertion behavior for prompt commands", () => {
    const { editor } = createEditor();
    const item = { title: "/review", type: "slashCommand" } as any;

    executeSlashCommand(editor, { from: 1, to: 8 }, item);

    expect(editor.commands.insertPrompt).toHaveBeenCalledWith(item);
  });
});
