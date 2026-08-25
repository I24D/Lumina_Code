import { expect } from "vitest";
import MockLLM from "../../../llm/llms/Mock";
import { testConfigHandler, testIde } from "../../../test/fixtures";
import { joinPathsToUri } from "../../../util/uri";
import { CompletionProvider } from "../../CompletionProvider";
import { AutocompleteInput } from "../../util/types";

const FIM_DELIMITER = "<|fim|>";

function parseFimExample(text: string): { prefix: string; suffix: string } {
  const [prefix, suffix] = text.split(FIM_DELIMITER);
  return { prefix, suffix };
}

export interface AutocompleteFileringTestInput {
  description: string;
  filename: string;
  input: string;
  llmOutput: string;
  expectedCompletion: string | null | undefined;
  options?: {
    only?: boolean;
  };
}

export async function testAutocompleteFiltering(
  test: AutocompleteFileringTestInput,
) {
  const { prefix, suffix } = parseFimExample(test.input);

  // Setup necessary objects
  const llm = new MockLLM({
    model: "mock",
  });
  llm.completion = test.llmOutput;
  // Two production defaults make these assertions depend on the clock, which
  // is why this file used to fail a *different* case on each run rather than
  // the same one. `llm.autocompleteOptions` is merged last into the resolved
  // options, so it is the narrowest place to opt out without touching what
  // ships.
  //
  //   modelTimeout (150ms) is handed to `showWhateverWeHaveAtXMs`, which stops
  //   the line stream once that long has passed, and to
  //   `stopAfterMaxProcessingTime` at 2.5x. Starved of CPU under the full
  //   suite a case takes seconds, the cut fires, and a multi-line completion
  //   arrives truncated to its first line -- the assertion then blames the
  //   filtering for what the scheduler did.
  //
  //   useCache points at a module-level SQLite cache that is keyed by prefix,
  //   outlives the run, and is written fire-and-forget (`void cache.put(...)`).
  //   Across 110 cases with overlapping prefixes a neighbour's answer can be
  //   served instead of this case's, which is never the thing under test.
  llm.autocompleteOptions = {
    useCache: false,
    debounceDelay: 0,
    modelTimeout: 60_000,
  };
  const ide = testIde;
  const configHandler = testConfigHandler;

  // Create a real file
  const [workspaceDir] = await ide.getWorkspaceDirs();
  const fileUri = joinPathsToUri(workspaceDir, test.filename);
  await ide.writeFile(fileUri, test.input.replace(FIM_DELIMITER, ""));

  // Prepare completion input and provider
  const completionProvider = new CompletionProvider(
    configHandler,
    ide,
    async () => llm,
    () => {},
    async () => [],
  );

  const line = prefix.split("\n").length - 1;
  const character = prefix.split("\n")[line].length;
  const autocompleteInput: AutocompleteInput = {
    isUntitledFile: false,
    completionId: "test-completion-id",
    filepath: fileUri,
    pos: {
      line,
      character,
    },
    recentlyEditedRanges: [],
    recentlyVisitedRanges: [],
  };

  // Generate a completion
  const result = await completionProvider.provideInlineCompletionItems(
    autocompleteInput,
    undefined,
  );

  // Ensure that we return the text that is wanted to be displayed
  expect(result?.completion).toEqual(test.expectedCompletion);
}
