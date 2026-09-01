---
name: verifying-changes
description: Detects how this project really builds, tests and lints instead of guessing commands, then proves the change works before reporting it. Use before saying a task is finished, or before running any build, test or lint command.
---

# Verifying Changes

Guessing `npm test` in a repo that uses `vitest run`, or `pytest` in one that
uses `tox`, burns a turn and teaches nothing. This project already exposes its
real commands — ask for them.

## When to Use

Use this skill:

- Before reporting any code change as finished.
- Before running a build, test, lint or typecheck command for the first time in a session.
- When a command you guessed failed with "script not found" or "command not found".

Skip it only for changes that cannot be verified by running anything, such as
editing a README.

## Workflow

Copy this checklist and tick it off:

```
Verification:
- [ ] 1. Detect the project commands (verify_project)
- [ ] 2. Run the narrowest relevant check
- [ ] 3. Read the real output, not the exit code alone
- [ ] 4. Widen to the full check
- [ ] 5. Report what ran, with its result
```

### 1. Detect the project commands

Call `verify_project`. It reads the manifests actually present at the workspace
root and returns the real build, test and lint commands.

If it answers that no manifest was recognised, ask the user how the project
builds. Do not guess, and do not invent a command that looks plausible.

### 2. Run the narrowest relevant check

Run only what covers the file you touched, using `run_terminal_command`:

- One test file beats the whole suite.
- A typecheck beats a full build.

A narrow check that fails tells you more, sooner, than a broad one that takes
four minutes.

### 3. Read the real output

Exit code 0 is not proof. Read the output and confirm:

- The tests you expected actually ran, and the count is not zero.
- No suite was skipped or filtered out by a bad path.

A test command that matches no files exits 0 and proves nothing.

### 4. Widen to the full check

Once the narrow check is green, run the full test and typecheck commands that
`verify_project` reported. Changes in shared code break files you did not open.

### 5. Report what ran

State the command and its result: `189/189 vitest`, `tsc exit 0`. Never write
"tests pass" without saying which command produced that.

## Failure Rule

If a check fails, you are not finished. Fix it and run the check again. Report a
failure only when you have decided it is a real blocker, and then quote the
actual error output.

Never report a task as complete with a known failing check. Never turn a red
check green by deleting or skipping the test.
