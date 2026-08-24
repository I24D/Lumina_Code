// Adapted from SlashCommand extension (@tiptap/extension-mention/src/mention.ts)

import { Editor, Node } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { SuggestionOptions } from "@tiptap/suggestion";
import { ComboBoxItem } from "../../types";

export type SlashCommandOptions = {
  suggestion: Omit<SuggestionOptions<ComboBoxItem, ComboBoxItem>, "editor">;
};

export function executeSlashCommand(
  editor: Editor,
  range: { from: number; to: number },
  props: ComboBoxItem,
) {
  // Always consume `/query` and restore the caret before invoking an action.
  // Otherwise TipTap leaves its suggestion plugin active over the input.
  editor.chain().focus().deleteRange(range).run();

  if (props.type === "action") {
    props.action?.();
    return;
  }

  editor.commands.insertPrompt(props);
}

export const SlashCommand = Node.create<SlashCommandOptions>({
  name: "slash-command",

  addOptions() {
    return {
      suggestion: {
        allow: ({ editor }) =>
          // the first character is "/". we want to avoid slash commands when there is a space after it
          editor.getText().at(1) !== " ",
        char: "/",
        pluginKey: new PluginKey(this.name),
        startOfLine: true,
        command: ({ editor, range, props }) => {
          executeSlashCommand(editor, range, props);
        },
      },
    };
  },

  group: "inline",
  inline: true,
  selectable: false,
  atom: true,

  // We don't need attributes since we won't be rendering any node
  addAttributes() {
    return {};
  },

  // No need to parse HTML since we're not rendering anything
  parseHTML() {
    return [];
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
