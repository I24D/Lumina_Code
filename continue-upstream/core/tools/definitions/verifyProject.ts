import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

/**
 * verify_project — the project's own commands, read off the project.
 *
 * Ported from Hermes's verification recipes. It reports rather than runs: the
 * commands come back so they can go through run_terminal_command, which is
 * where the user's approval and the terminal UI already live. A tool that
 * shelled out on its own would bypass both.
 */
export const verifyProjectTool: Tool = {
  type: "function",
  displayTitle: "Project Commands",
  wouldLikeTo: "work out how this project builds and tests",
  isCurrently: "working out how this project builds and tests",
  hasAlready: "worked out how this project builds and tests",
  readonly: true,
  isInstant: true,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.VerifyProject,
    description: `Find out how this project is bootstrapped, built, tested and started, by reading its manifests (package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, Makefile, docker-compose).

Call this BEFORE running build or test commands instead of guessing. Guessing produces a confident wrong command — "npm test" in a project with no test script, "pytest" where the suite is Django's. The result includes the evidence it was detected from, so you can tell a good match from a bad one.

Then run the commands it reports with the terminal tool.`,
    parameters: {
      type: "object",
      required: [],
      properties: {},
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To find the project's real build and test commands before running anything, call the ${BuiltInToolNames.VerifyProject} tool. For example:`,
    exampleArgs: [],
  },
  toolCallIcon: "BeakerIcon",
};
