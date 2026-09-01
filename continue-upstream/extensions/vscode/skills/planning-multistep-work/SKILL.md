---
name: planning-multistep-work
description: Keeps a durable task list for work with more than two steps and drives it to completion instead of stopping after the first one. Use when a request contains several parts, or when a task will span many tool calls.
---

# Planning Multistep Work

The failure this prevents is specific: announcing a plan, doing the first step,
and stopping. A plan written only in prose is forgotten by the next turn. A plan
written to `manage_todos` survives.

## When to Use

Use this skill:

- When a request contains more than two distinct pieces of work.
- When the user says "do everything", "all of it", or "do not stop".
- When the work will span many tool calls, or touch several files.

Skip it for a single edit to a single file.

## Workflow

### 1. Write the list before the first edit

Call `manage_todos` with the full list, in order. Every item must be a concrete
action with a verifiable end, not a theme.

Good: `Fix the else-if in sessionSlice so tool calls survive content`
Bad: `Improve tool calling`

Write the list once, up front. Discovering step 4 while doing step 2 is normal —
use `mode: "merge"` to add it without losing progress.

### 2. Mark exactly one item in progress

Set one item to `in_progress` before starting it. Never two. If the work needs
two things at once, the list is wrong: split it.

### 3. Work the item, then close it

Complete the item, verify it, and set it to `completed` in the same turn you
finish it. A list updated later is a list that drifts.

Use `cancelled`, not `completed`, for work you decided not to do — and say why
in the final report.

### 4. Do not stop while items are pending

After closing an item, read the list. If anything is `pending`, start the next
one immediately in the same turn. Do not return to the user to ask whether to
continue: the list is the instruction.

Stop early only for a real blocker — a decision only the user can make, or a
failure you cannot resolve. Then say which items remain and why.

### 5. Close the loop

Before the final report, read the list one last time. Every item must be
`completed` or `cancelled`. Report the list state, not a feeling of doneness.

## Announcing and Acting

Never end a turn with an announcement. If you write "I am going to read these
files", the tool calls belong in that same turn.

An announcement with no tool call after it reads to the user as stopping, and
costs a full round trip to recover.

## Failure Rule

If you notice you have stopped with pending items and the user had to prompt
you, do not apologise at length. Read the list and resume from the first pending
item.
