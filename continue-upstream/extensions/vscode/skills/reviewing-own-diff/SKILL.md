---
name: reviewing-own-diff
description: Reads the complete diff before reporting work as finished, to catch debug leftovers, half-done renames and files changed by accident. Use as the last step of any task that edited files.
---

# Reviewing Your Own Diff

Edits are made one at a time; their effect is combined. The combined effect is
what the user receives, and it is the only thing nobody has looked at yet.

## When to Use

Use this skill as the final step of any task that changed files, immediately
before the final report. It costs one tool call.

## Workflow

### 1. Read the whole diff

Call `view_diff`. Read all of it, including files you do not remember touching.
A file you did not intend to change is the most valuable thing this catches.

### 2. Check against this list

```
Review:
- [ ] Every changed file was meant to change
- [ ] No debug leftovers (prints, console.log, commented-out code)
- [ ] No secrets, tokens, keys or absolute personal paths
- [ ] Renames are complete — no old name survives
- [ ] Deleted code is really unused
- [ ] The change matches what was asked, no more
```

**Debug leftovers.** Temporary logging added while diagnosing must come out.

**Secrets.** No key, token or credential in the diff, and no `.env` file. Check
that any new file holding configuration is covered by `.gitignore`.

**Incomplete renames.** If you renamed a symbol, `grep_search` the old name.
Zero hits, or an explicit reason for each survivor.

**Dead code.** When you replace an implementation, delete the old one in the
same change. Do not leave a fallback "just in case" — an unused branch is a
branch nobody will ever test.

**Scope.** Reformatting, drive-by refactors and unrequested improvements do not
belong in the diff. If you spotted something worth fixing, say so in the report
instead of doing it silently.

### 3. Fix or report

Fix what the review found, then read the diff again — the fix is also a change.

Report honestly. If something is left undone, say so plainly and say why. A
report that hides a known gap costs far more than the gap.

## Failure Rule

Never report work as finished without having read the diff. "I made the edits I
intended" is not the same claim as "the diff contains only what I intended".
