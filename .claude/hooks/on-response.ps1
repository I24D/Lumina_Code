# Reads the Stop-hook JSON payload from stdin (Claude Code or Codex — both
# expose `last_assistant_message` on this event) and hands the finished
# response text to Lumina Start Talk so she can read it aloud.
# Fire-and-forget: never blocks or fails the CLI, even if nothing is listening.
#
# -Source is what Lumina announces ("Claude Code ha terminado..."). Both CLIs
# run this same file, so whoever registers the hook says which one it is.
param([string] $Source = "Claude Code")

$ErrorActionPreference = "SilentlyContinue"

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $text = $payload.last_assistant_message
    if ([string]::IsNullOrWhiteSpace($text)) {
        exit 0
    }

    $bridgeBase = $env:LUMINA_BRIDGE_URL
    if ([string]::IsNullOrWhiteSpace($bridgeBase)) {
        $port = $env:LUMINA_BRIDGE_PORT
        if ([string]::IsNullOrWhiteSpace($port)) { $port = "8765" }
        $bridgeBase = "http://127.0.0.1:$port"
    }

    $body = @{ text = $text; source = $Source } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$bridgeBase/voice/claude-response" -Method Post `
        -ContentType "application/json" -Body $body -TimeoutSec 5 | Out-Null
}
catch {
    # Bridge not running/unreachable: drop silently, never block the CLI.
}

exit 0
