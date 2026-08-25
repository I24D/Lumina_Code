/**
 * The `/learn` instruction.
 *
 * Ported from Hermes's learn prompt. `create_skill` already exists and the
 * model is told about it, but a tool the model *may* call after a hard task is
 * not the same as the user saying "capture what we just did". This turns that
 * request into one ordinary turn: the agent gathers the sources with the tools
 * it already has, then writes the skill.
 *
 * Deliberately free of Node imports so the webview can build the prompt
 * without pulling the filesystem half of this module's siblings into the
 * browser bundle.
 */

/** Used when `/learn` is invoked with nothing after it. */
export const LEARN_FROM_CONVERSATION =
  "the workflow we just went through in this conversation — review the steps " +
  "actually taken and distil them into a reusable procedure";

const AUTHORING_RULES = `Authoring standards:
- The description is a routing hint. Say WHEN to reach for this skill, not how good it is. It is the only thing visible before the skill is opened.
- Include a "## When to Use" section listing the trigger conditions.
- Write the body as steps someone could follow without this conversation in front of them: exact commands, exact paths, and the gotchas that cost time.
- Record what actually worked, including the dead ends worth avoiding. Omit anything that was specific to this one run (temporary paths, one-off ids, secrets).
- Prefer one focused skill over one sprawling one. If the material covers two unrelated tasks, write two skills.`;

const SOURCE_RULES = `Source hygiene:
- Gather the sources the user named first — read the files, fetch the URLs, re-read the relevant part of this conversation — before writing anything.
- Never invent a step you did not verify. If something is unknown, say so in the skill rather than guessing.
- Never copy credentials, tokens, or personal data into a skill.`;

/**
 * Builds the turn the agent runs for `/learn`.
 *
 * @param userRequest free text after `/learn`: a workflow, paths, URLs, or
 *   nothing at all, in which case the conversation itself is the source.
 */
export function buildLearnPrompt(userRequest?: string): string {
  const request =
    userRequest && userRequest.trim() !== ""
      ? userRequest.trim()
      : LEARN_FROM_CONVERSATION;

  return [
    "[/learn] Learn a reusable skill from the request below, and save it with the create_skill tool.",
    "",
    request,
    "",
    AUTHORING_RULES,
    "",
    SOURCE_RULES,
    "",
    "When the skill is written, confirm what you saved in one or two sentences and name the skill so it can be recalled later.",
  ].join("\n");
}
