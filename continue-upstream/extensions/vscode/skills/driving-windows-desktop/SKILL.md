---
name: driving-windows-desktop
description: Opens the eyes and ears of the Lumina Windows Bridge before any desktop task, then verifies the real screen state after every action. Use for tasks outside the code workspace that click, type, launch apps or read the Windows desktop.
---

# Driving the Windows Desktop

Acting on the desktop without perception is acting blind. A click that lands on
nothing and a click that opens a dialog look identical from the caller's side:
both return success.

Every call in this skill goes through the `lumina_windows_bridge` tool.

## When to Use

Use this skill for tasks **outside** the code workspace: launching or driving a
Windows application, reading what is on screen, controlling playback, or
inspecting notifications.

Do **not** use it for project files. Creating, editing, moving or deleting files
in the workspace is done with the native tools — `create_new_file`,
`edit_existing_file`, `multi_edit`, `read_file`. Never drive the bridge to edit
code.

## Initialisation

Run this before the first desktop action of a session. Do not skip it because
the task "looks simple".

```
Bridge startup:
- [ ] 1. Start vision      → /vision_stream_control { action: "start" }
- [ ] 2. Confirm vision    → /vision_stream
- [ ] 3. Start perception  → /perception_control { action: "start" }
- [ ] 4. Confirm perception→ /perception
- [ ] 5. Confirm hearing   → /now_playing
```

**Step 2 must confirm all three:** `mode` is `dxgi_desktop_duplication`,
`streaming` is `true`, and `framesSeen` advances between two reads. A stream
that is "on" but frozen reports the desktop as it was minutes ago.

**Step 4 must confirm** the daemon is running and the current foreground window
is visible.

If any step fails, stop and report it. Do not continue half-blind — a task done
against a stale frame produces confident, wrong answers.

## The Action Loop

For every single action:

1. **Observe** — read `/perception` or `/ui_capture` to know the current state.
2. **Act** — click, type, or launch.
3. **Verify** — read the screen again and confirm the expected change happened.

Never collapse these three into one. The verification step is the skill.

### Verifying properly

A launch, click, keypress or command returning success proves only that the
call was dispatched. Prove the *result*:

| Tool | Use it to |
|---|---|
| `/vision_stream` | Confirm frames are still advancing |
| `/perception` | Read the current foreground window and semantic state |
| `/ui_capture` | Capture and analyse the current window's UI tree |
| `/ui_wait` | Wait for an element to appear instead of sleeping blindly |
| `/screenshot` | Look at the actual pixels when the UI tree is not enough |
| `/now_playing` | Confirm real audio state |

Prefer `/ui_wait` over waiting a fixed number of seconds. A fixed sleep is
either too short, and you verify a screen that has not updated, or too long, and
you waste the user's time.

## UWP Applications

Classic UWP apps (Weather, Phone Link, Settings) do not own their own window.
The frame belongs to `ApplicationFrameHost.exe`; the app owns only a
`Windows.UI.Core.CoreWindow` child inside it.

Consequences worth knowing before debugging for an hour:

- Matching a window by process name finds the frame host, not the app.
- A suspended UWP app has an empty UI tree. Restore the window first.
- A resident process can serve data captured at boot. If a value looks stale,
  trigger the app's own refresh rather than reading again.

## Failure Rule

If verification does not prove the action worked, report the blocker. Do not
say it worked.

"I clicked the button" is not a result. "The dialog is now open, confirmed with
`/ui_capture`" is a result.
