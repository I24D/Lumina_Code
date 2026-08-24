# Shared permission policy

`@continuedev/terminal-security` is Lumina Code's host-neutral authorization
package. It owns:

- first-match tool and argument policy evaluation;
- conversion between `allow` / `ask` / `exclude` and core `ToolPolicy` values;
- terminal-command safety classification;
- explicit-user-approval requirements for CLI, VS Code, Start Talk, Windows
  Bridge, and ACP callers.

Model text is never approval evidence. A host may set `userApproved: true` only
after observing its own trusted user interaction. Start Talk checks delegated
agent tasks in the orb UI, extension bridge, core, and main chat before work is
started.

Keep platform prompts and UI outside this package. Hosts evaluate the common
policy and then render the native confirmation experience appropriate to their
surface.
