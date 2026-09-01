---
name: debugging-systematically
description: Finds the true cause of a bug by reproducing it first and proving the fix, instead of patching the nearest symptom. Use when something is broken, throws, returns the wrong value, or when a previous fix did not hold.
---

# Debugging Systematically

A fix you cannot demonstrate is a guess. The discipline here is one rule: prove
the bug exists before you fix it, and prove the fix removes it.

## When to Use

Use this skill:

- When something crashes, hangs, or produces a wrong result.
- When a previous fix did not change the behaviour.
- When the cause is not obvious from reading the code once.

## Workflow

```
Debugging:
- [ ] 1. Reproduce it
- [ ] 2. Isolate it
- [ ] 3. Explain it
- [ ] 4. Fix it
- [ ] 5. Prove the fix
```

### 1. Reproduce it

Find the smallest command or input that shows the failure, and run it. Capture
the real error text.

If you cannot reproduce it, you cannot fix it. Ask the user for the exact steps,
the exact message, or a screenshot before continuing. Never fix a bug you have
only heard described.

### 2. Isolate it

Narrow until you have one function, one branch, one line. Useful cuts:

- Does it fail with the simplest possible input?
- Did it work before? `view_diff` shows what changed.
- Does the value arriving match the value expected? Check the boundary between
  two components — that is where most bugs live.

### 3. Explain it

Before editing, write the mechanism in one sentence:

> `<X>` happens because `<Y>`, so `<Z>` ends up wrong.

If the sentence needs a "maybe", go back to step 2. A fix built on a maybe will
need a second fix.

### 4. Fix the cause

Fix the mechanism you named. Resist the nearby patch that makes the symptom go
away — a guard around a null does not explain why the null arrived.

If a workaround is genuinely the right call, say so explicitly and say what the
real cause is.

### 5. Prove the fix

This step is not optional, and it is the one most often skipped.

1. Write or run a check that **fails** with the bug present.
2. Apply the fix.
3. Confirm the same check now passes.

If you wrote a test, confirm it actually fails without the fix — temporarily
revert the fix and watch it go red. A test that passes either way proves
nothing, and is worse than no test because it looks like proof.

Then follow the `verifying-changes` skill for the full check.

## Failure Rule

Two failed fixes on the same bug means the model of the cause is wrong. Stop
editing. Return to step 1 and reproduce again, this time instrumenting the code
to print the real values rather than reasoning about them.
