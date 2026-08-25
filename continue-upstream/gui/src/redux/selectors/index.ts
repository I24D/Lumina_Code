import { createSelector } from "@reduxjs/toolkit";
import {
  ComboBoxItem,
  ComboBoxItemType,
} from "../../components/mainInput/types";
import { RootState } from "../store";

/**
 * Turns a skill name into a slash command. Hermes does the same thing, and for
 * the same reason: a skill called "Deploy to Render" has to survive becoming
 * `/deploy-to-render` without colliding with the next skill along.
 */
export function skillCommandSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Every skill, offered as `/its-name` in the input dropdown.
 *
 * The inserted prompt tells the model to open the skill with read_skill rather
 * than pasting the skill body into the editor. Two reasons: the body can be
 * long, and going through read_skill is what records the skill as used — which
 * is what ranks it in the index next time.
 *
 * First name wins on a collision, so a skill can never make another one
 * unreachable by shadowing its command.
 */
export const selectSkillSlashCommands = createSelector(
  [(state: RootState) => state.config.config.skills],
  (skills) => {
    const claimed = new Set<string>();
    const items: ComboBoxItem[] = [];

    for (const skill of skills ?? []) {
      const slug = skillCommandSlug(skill.name);
      if (slug === "" || claimed.has(slug)) {
        continue;
      }
      claimed.add(slug);
      items.push({
        title: `/${slug}`,
        description: skill.description,
        type: "slashCommand" as ComboBoxItemType,
        content:
          `Use the "${skill.name}" skill for this. Read it first with ` +
          `read_skill (skillName="${skill.name}"), then follow it.\n\n`,
        category: "SKILLS",
        icon: "academic",
      } as ComboBoxItem);
    }

    return items;
  },
);

export const selectSlashCommandComboBoxInputs = createSelector(
  [(state: RootState) => state.config.config.slashCommands],
  (slashCommands) => {
    return (
      slashCommands?.map((cmd) => {
        let content = cmd.prompt;

        // For MCP prompts without content, show that it failed to load
        if (cmd.source === "mcp-prompt" && !content) {
          content = "[MCP Prompt - failed to load content during startup]";
        }

        return {
          title: cmd.name,
          description: cmd.description,
          type: "slashCommand" as ComboBoxItemType,
          content: content,
          source: cmd.source,
        } as ComboBoxItem;
      }) || []
    );
  },
);

export const selectSlashCommands = createSelector(
  [(state: RootState) => state.config.config.slashCommands],
  (slashCommands) => {
    return slashCommands || [];
  },
);

export const selectSubmenuContextProviders = createSelector(
  [(state: RootState) => state.config.config.contextProviders],
  (providers) => {
    return providers?.filter((desc) => desc.type === "submenu") || [];
  },
);

export const selectDefaultContextProviders = createSelector(
  [(state: RootState) => state.config.config.experimental?.defaultContext],
  (defaultProviders) => {
    return defaultProviders ?? [];
  },
);

export const selectUseActiveFile = createSelector(
  [(state: RootState) => state.config.config.experimental?.defaultContext],
  (defaultContext) => defaultContext?.includes("activeFile" as any),
);
