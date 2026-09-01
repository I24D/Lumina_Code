---
name: investigating-before-editing
description: Locates and reads the real code behind a request before changing anything, so edits land on the actual cause instead of the first plausible match. Use before the first edit of any task in unfamiliar code.
---

# Investigating Before Editing

The first file that matches a grep is rarely the file that owns the behaviour.
Editing it produces a change that looks right, passes review, and fixes nothing.

## When to Use

Use this skill:

- Before the first edit in any file you have not already read this session.
- When a symptom's cause is not obvious from the request alone.
- When the same symptom has already survived one attempted fix.

Skip it when the user names the exact file and the exact line to change.

## Workflow

```
Investigation:
- [ ] 1. Find every candidate, not the first one
- [ ] 2. Read the whole unit, not the matching line
- [ ] 3. Follow the data, not the name
- [ ] 4. State the cause before editing
```

### 1. Find every candidate

Use `grep_search` for behaviour and `file_glob_search` for names. Search for
the string the user saw — an error message, a label, a number — before searching
for concepts.

Count the matches. If there is exactly one, be suspicious: the behaviour may be
spelled differently somewhere else.

### 2. Read the whole unit

Use `read_file` for a short file, `read_file_range` for a region of a long one.
Read the entire function or branch that contains the match, plus its callers.

A conditional you did not read is a conditional you will break.

### 3. Follow the data

Trace where the value comes from and where it goes. Names lie; assignments do
not. When a value looks wrong, walk backwards to where it was produced, not
forwards to where it was displayed.

`codebase` is useful when you know the behaviour but not the vocabulary the
project uses for it.

### 4. State the cause before editing

Before the first edit, write one sentence in this shape:

> `<file>:<line>` does `<X>`, but the case `<Y>` needs `<Z>`.

If you cannot fill that sentence in, you have not found the cause yet. Keep
reading. An edit made without it is a guess.

## Failure Rule

If your fix does not change the observed behaviour, do not stack a second fix on
top. Revert to investigating: your model of the cause was wrong, and the second
fix will be built on the same wrong model.
