/**
 * How to bootstrap, build, test and run a project.
 *
 * Ported from Hermes's verification recipes. The problem it solves is small
 * but constant: an agent asked to "run the tests" otherwise guesses, and
 * guessing wrong costs a failed command, an apology and another turn. The
 * project already states what its commands are — in package.json scripts, in a
 * Makefile, in the conventions of its ecosystem — so the answer is detectable
 * rather than guessable.
 */

export interface VerificationRecipe {
  /** Human-readable, e.g. "Node.js (Vite)". */
  name: string;
  /** Stable identifier for the detector that produced this, e.g. "node-vite". */
  kind: string;
  /** Install dependencies. */
  bootstrap: string[];
  /** Compile or prepare. Empty when the ecosystem has no build step. */
  build: string[];
  /** Run the test suite. Empty when none could be identified. */
  test: string[];
  /** Start the app for manual checking, when it is the kind of project that runs. */
  start?: string;
  /** Port `start` is expected to listen on. */
  port?: number;
  /** Path to probe once it is up. */
  readinessPath?: string;
  /**
   * The files and fields that led here. Without this a wrong detection is
   * indistinguishable from a right one, and the user cannot tell which.
   */
  evidence: string[];
}

/**
 * The slice of the workspace a detector needs.
 *
 * Deliberately not the IDE interface: detection is pure decision-making over
 * file contents, and keeping it behind two methods is what lets every rule be
 * tested against a literal file map instead of a mocked editor.
 */
export interface ProjectFiles {
  exists(relativePath: string): Promise<boolean>;
  read(relativePath: string): Promise<string | undefined>;
}
