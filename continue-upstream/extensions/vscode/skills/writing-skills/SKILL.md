---
name: writing-skills
description: Writes a new SKILL.md that passes the linter and actually triggers, capturing procedure learned from a solved task. Use after solving a non-trivial problem worth repeating, or when asked to create or edit a skill.
---

# Writing Skills

A skill is procedural memory: what was learned once, so it is not rediscovered
every session. It is worth writing when the knowledge was expensive to get and
will be needed again.

## When to Use

Write a skill when **both** are true:

- The task took real effort — dead ends, a non-obvious constraint, a sequence
  that must happen in one order.
- It will come up again.

Do **not** write a skill for a one-off fix, for something already obvious from
reading the code, or for facts that belong in a comment next to the code.

## The Two Fields That Decide Everything

Only `name` and `description` are loaded on every request. The body is read
only if the description convinced the model to open it. A perfect body behind a
vague description is never read.

**name** — lowercase, digits, hyphens. Gerund form reads best:
`verifying-changes`, `debugging-systematically`. Never `helper`, `utils`,
`tools`.

**description** — third person, and it must answer two questions: *what does
this do* and *when should it be used*. Keep it under 240 characters; the index
truncates there.

```
Good: Detects how this project really builds and tests instead of guessing
      commands. Use before saying a task is finished.

Bad:  A powerful and comprehensive skill for testing.
```

Never write "I can help you…" or "You can use this to…". Never use marketing
words — `powerful`, `comprehensive`, `seamless`, `advanced`, `robust`. The
linter rejects them, and they crowd out the trigger the model actually needs.

## Required Structure

```markdown
---
name: <slug>
description: <what it does + when to use it>
---

# <Title>

<One or two lines: what problem this prevents.>

## When to Use

<Trigger conditions. Bullet list. Include when NOT to use it.>

## Workflow

<Numbered steps. A checklist for anything over three steps.>

## Failure Rule

<What to do when it goes wrong.>
```

The `## When to Use` heading is mandatory — the linter warns without it, and
without it the body explains how but never says under what conditions.

## Writing the Body

**Assume the model is competent.** Add only what it does not already know.
Project-specific facts, exact commands, the constraint that is not guessable.
Do not explain what a PDF is, what a test is, or how git works.

**Be concrete.** Real commands, real file paths, real tool names from this
project. Forward slashes always, even on Windows.

**Match freedom to fragility.** Where several approaches work, give direction.
Where the sequence is fragile, give the exact commands and say not to deviate.

**Prefer one default with an escape hatch** over a menu of options. A list of
five libraries is a decision the model now has to make badly.

**Keep it under 500 lines.** Past that, split into sibling files and link them
from SKILL.md, one level deep only — a link inside a linked file often gets
read partially.

**No dates or "as of now".** Time-sensitive text becomes wrong silently. Put
superseded material under an "Old patterns" heading instead.

## Saving It

Use `create_skill`. Choose the scope deliberately:

- **workspace** — the procedure only makes sense in this repository.
- **global** — it applies anywhere.

The linter runs before the write. Errors block the save; warnings are advice
worth taking. If it blocks, fix the finding and save again — do not work around
it by renaming.

## Failure Rule

If a skill exists but the model never opens it, the body is not the problem.
Rewrite the description: lead with the trigger condition, and name the exact
words a user would say when they need it.
