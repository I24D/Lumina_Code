# Portable language-server diagnostics

The CLI exposes a read-only `Diagnostics` tool that speaks Language Server
Protocol over standard input/output. It is available when Lumina runs outside
VS Code, including `cn`, `cn serve`, ACP clients, and isolated child worktrees.

The manager discovers a compatible server on `PATH`, initializes it at the Git
project root, opens the requested document, and waits for
`textDocument/publishDiagnostics`. It currently recognizes:

| Files                   | Server                       | Installation example                                   |
| ----------------------- | ---------------------------- | ------------------------------------------------------ |
| TypeScript / JavaScript | `typescript-language-server` | `npm install -g typescript typescript-language-server` |
| Python                  | `pyright-langserver`         | `npm install -g pyright`                               |
| Go                      | `gopls`                      | `go install golang.org/x/tools/gopls@latest`           |
| Rust                    | `rust-analyzer`              | `rustup component add rust-analyzer`                   |
| C / C++                 | `clangd`                     | Install clangd and add it to `PATH`                    |

Lumina does not download or execute an unknown server automatically. Missing,
broken, and unsupported servers produce an actionable message. Each CLI tool
call shuts its server down cleanly after collecting diagnostics, so no child
process keeps the CLI alive. File paths still use the active request scope, so
a delegated agent diagnoses its isolated worktree rather than the primary tree.

The transport implements JSON-RPC `Content-Length` framing, fragmented and
back-to-back messages, initialization, server configuration requests,
`didOpen` / `didChange`, timeouts, and graceful `shutdown` / `exit`. Tests use a
real child-process fixture, not a mocked parser.
