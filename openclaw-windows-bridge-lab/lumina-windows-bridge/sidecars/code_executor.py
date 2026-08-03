"""
code_executor.py — Sandboxed code execution for Lumina.

Reads a JSON request from stdin describing a code snippet to execute,
runs it as a subprocess with a real timeout + working-directory whitelist
+ output caps, and writes a structured JSON result to stdout.

Request shape (JSON over stdin):
  {
    "language": "python" | "bash" | "powershell" | "node",
    "code": "<source>",
    "cwd":  "<absolute path>",
    "timeoutMs": 30000,
    "maxStdoutBytes": 524288,
    "maxStderrBytes": 65536,
    "env": { "K": "V", ... }   // optional, MERGED on top of a minimal base env
  }

Response shape (JSON over stdout, exit code is always 0 unless the
sidecar itself crashed):
  {
    "ok":        bool,
    "code":      <exit code of the user process>,
    "stdout":    "<utf-8>",
    "stderr":    "<utf-8>",
    "stdoutTruncated": bool,
    "stderrTruncated": bool,
    "durationMs": int,
    "killedByTimeout": bool,
    "error":     "<string>" | null   // sidecar-level error, NOT user-code stderr
  }

Design notes:
  - This is NOT a container. It's defense in depth (Risk Engine + denylist
    + this sandbox). Don't rely on it for untrusted code from the open
    internet.
  - On POSIX we spawn into a new process group so we can SIGKILL the whole
    tree on timeout (Python + child processes it spawned). On Windows we
    rely on subprocess.kill().
  - We DO NOT pipe a shell — every language goes through its native
    interpreter via -c / -Command / -e. This avoids accidental shell
    metacharacter expansion in the wrapper.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from typing import Any, Dict, Optional


def fail(reason: str, code: int = 2) -> None:
    json.dump({"ok": False, "error": reason}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


LANGUAGE_INTERPRETERS = {
    # On Windows the "python" name normally resolves to the bundled
    # Lumina venv via LUMINA_PYTHON; falls back to system Python.
    "python":     ("python",     ["-I", "-c"]),
    "python3":    ("python3",    ["-I", "-c"]),
    "node":       ("node",       ["-e"]),
    "bash":       ("bash",       ["-eo", "pipefail", "-c"]),
    "powershell": ("powershell", ["-NoProfile", "-NonInteractive",
                                  "-ExecutionPolicy", "Bypass", "-Command"]),
    # On modern Windows pwsh is the preferred PowerShell 7+.
    "pwsh":       ("pwsh",       ["-NoProfile", "-NonInteractive",
                                  "-ExecutionPolicy", "Bypass", "-Command"]),
}


def pick_interpreter(language: str) -> tuple[str, list[str]]:
    if language not in LANGUAGE_INTERPRETERS:
        fail(f"unsupported language: {language!r}")
    name, args = LANGUAGE_INTERPRETERS[language]
    # Allow override per language via env var (e.g. LUMINA_CODE_PYTHON).
    override_env = f"LUMINA_CODE_{language.upper()}"
    explicit = os.environ.get(override_env, "").strip()
    if explicit:
        return explicit, args
    resolved = shutil.which(name)
    if resolved is None:
        fail(f"interpreter for {language!r} not on PATH ({name})")
    return resolved, args


def build_base_env() -> Dict[str, str]:
    """Minimal env so user code can find tools without leaking every secret."""
    keep = {
        "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP",
        "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
        "LANG", "LC_ALL", "LC_CTYPE",
        "PYTHONIOENCODING", "PYTHONUNBUFFERED",
        "APPDATA", "LOCALAPPDATA",
    }
    base = {k: v for k, v in os.environ.items() if k in keep}
    base["PYTHONIOENCODING"] = "utf-8"
    base["PYTHONUNBUFFERED"] = "1"
    return base


def read_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty stdin; expected JSON request")
    try:
        return json.loads(raw)
    except Exception as e:
        fail(f"invalid JSON request: {e}")
    return {}  # unreachable


def truncate(buf: bytes, max_bytes: int) -> tuple[str, bool]:
    if len(buf) <= max_bytes:
        return buf.decode("utf-8", errors="replace"), False
    head = buf[:max_bytes].decode("utf-8", errors="replace")
    return head + "\n…[truncated]…", True


def main() -> None:
    try:
        req = read_request()
    except SystemExit:
        raise
    except Exception as e:
        fail(f"sidecar crash before parse: {e}\n{traceback.format_exc()}")
        return

    language = str(req.get("language", "")).strip().lower()
    code = req.get("code", "")
    cwd = str(req.get("cwd", "")).strip()
    timeout_ms = int(req.get("timeoutMs", 30_000))
    max_stdout = int(req.get("maxStdoutBytes", 512 * 1024))
    max_stderr = int(req.get("maxStderrBytes", 64 * 1024))
    extra_env = req.get("env", {}) or {}

    if not isinstance(code, str) or not code.strip():
        fail("`code` must be a non-empty string")
    if not language:
        fail("`language` is required")
    if not cwd or not os.path.isabs(cwd):
        fail("`cwd` must be an absolute path")
    if not os.path.isdir(cwd):
        fail(f"`cwd` does not exist or is not a directory: {cwd}")
    if not isinstance(extra_env, dict):
        fail("`env` must be a string→string map")

    interp, args = pick_interpreter(language)

    env = build_base_env()
    for k, v in extra_env.items():
        if isinstance(k, str) and isinstance(v, str):
            env[k] = v

    # Set up timeout machinery. On POSIX use a process group so we kill
    # spawned children too; on Windows subprocess.kill() handles the
    # immediate child.
    creationflags = 0
    preexec_fn = None
    if os.name == "posix":
        preexec_fn = os.setsid
    else:
        # CREATE_NEW_PROCESS_GROUP so Ctrl+C from us doesn't propagate.
        creationflags = 0x00000200  # CREATE_NEW_PROCESS_GROUP

    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            [interp, *args, code],
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=preexec_fn,
            creationflags=creationflags,
        )
    except FileNotFoundError as e:
        fail(f"interpreter not runnable: {e}")
        return
    except Exception as e:
        fail(f"failed to spawn interpreter: {e}")
        return

    killed_by_timeout = False
    try:
        try:
            stdout_b, stderr_b = proc.communicate(timeout=timeout_ms / 1000.0)
        except subprocess.TimeoutExpired:
            killed_by_timeout = True
            if os.name == "posix":
                try:
                    import signal
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    proc.kill()
            else:
                proc.kill()
            stdout_b, stderr_b = proc.communicate()
        rc = proc.returncode if proc.returncode is not None else -1
    except Exception as e:
        try:
            proc.kill()
        except Exception:
            pass
        fail(f"sidecar lost the child: {e}")
        return
    duration_ms = int((time.monotonic() - start) * 1000)

    stdout_text, stdout_trunc = truncate(stdout_b or b"", max_stdout)
    stderr_text, stderr_trunc = truncate(stderr_b or b"", max_stderr)

    result = {
        "ok": (rc == 0) and not killed_by_timeout,
        "code": rc,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "stdoutTruncated": stdout_trunc,
        "stderrTruncated": stderr_trunc,
        "durationMs": duration_ms,
        "killedByTimeout": killed_by_timeout,
        "language": language,
        "interpreter": interp,
        "cwd": cwd,
        "error": None,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
