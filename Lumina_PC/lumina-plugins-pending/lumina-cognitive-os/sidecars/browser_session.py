"""
browser_session.py — Persistent browser session manager for Playwright 1.59+.

Implements browser.bind() pattern: a long-lived browser session that can be
shared across multiple agent calls. Sessions are identified by session_id
and can be created, used, and destroyed on demand.

Requirements:
  pip install playwright
  playwright install chromium

Supported actions:
  create_session  — create a new persistent browser session
  use_session     — execute an action on an existing session
  close_session   — close and cleanup a session
  list_sessions   — list all active sessions
  session_status  — get status of a specific session

Stdin: JSON {"action": "...", "session_id": "...", "args": {...}}
Stdout: JSON {"ok": bool, ...}
"""
from __future__ import annotations

import base64
import json
import sys
import traceback
import time
from pathlib import Path
from typing import Any, Dict, Optional
from playwright.sync_api import sync_playwright, BrowserContext, Page  # type: ignore


# Global session store (in-memory for this process lifetime)
SESSIONS: Dict[str, Dict[str, Any]] = {}

# Auto-expire configuration
SESSION_TIMEOUT_MINUTES = 30  # Sessions expire after 30 minutes of inactivity
CLEANUP_INTERVAL_SECONDS = 60  # Check for expired sessions every minute
last_cleanup_time = 0.0


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def fail(reason: str, code: int = 2) -> None:
    emit({"ok": False, "error": reason}, code)


def parse_input() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("empty stdin; expected JSON {action, session_id, args}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"invalid JSON on stdin: {e}")
        return {}


def cleanup_expired_sessions() -> list[str]:
    """Remove sessions that have been inactive for more than SESSION_TIMEOUT_MINUTES.
    Returns list of expired session IDs."""
    global last_cleanup_time
    now = time.time()
    
    # Skip if we cleaned up recently
    if now - last_cleanup_time < CLEANUP_INTERVAL_SECONDS:
        return []
    
    last_cleanup_time = now
    expired = []
    timeout_seconds = SESSION_TIMEOUT_MINUTES * 60
    
    for session_id, session in list(SESSIONS.items()):
        if now - session["last_used"] > timeout_seconds:
            try:
                session["context"].close()
                session["playwright"].stop()
                del SESSIONS[session_id]
                expired.append(session_id)
            except Exception as e:
                print(f"Warning: Failed to cleanup expired session {session_id}: {e}", file=sys.stderr)
    
    return expired


def create_session(session_id: str, user_data_dir: str, headless: bool = True) -> Dict[str, Any]:
    """Create a new persistent browser session."""
    if session_id in SESSIONS:
        return {"ok": False, "error": f"session '{session_id}' already exists"}
    
    try:
        p = sync_playwright().start()
        ctx = p.chromium.launch_persistent_context(
            user_data_dir,
            headless=headless,
            viewport={"width": 1440, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        
        SESSIONS[session_id] = {
            "playwright": p,
            "context": ctx,
            "page": page,
            "created_at": time.time(),
            "last_used": time.time(),
            "action_count": 0,
        }
        
        return {
            "ok": True,
            "session_id": session_id,
            "status": "created",
            "url": page.url,
            "title": page.title(),
        }
    except Exception as e:
        return {"ok": False, "error": f"failed to create session: {str(e)}"}


def close_session(session_id: str) -> Dict[str, Any]:
    """Close and cleanup a session."""
    if session_id not in SESSIONS:
        return {"ok": False, "error": f"session '{session_id}' not found"}
    
    try:
        session = SESSIONS[session_id]
        session["context"].close()
        session["playwright"].stop()
        del SESSIONS[session_id]
        
        return {
            "ok": True,
            "session_id": session_id,
            "status": "closed",
            "total_actions": session["action_count"],
        }
    except Exception as e:
        return {"ok": False, "error": f"failed to close session: {str(e)}"}


def use_session(session_id: str, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute an action on an existing session."""
    if session_id not in SESSIONS:
        return {"ok": False, "error": f"session '{session_id}' not found"}
    
    session = SESSIONS[session_id]
    page = session["page"]
    session["last_used"] = time.time()
    
    result: Dict[str, Any] = {"ok": True, "session_id": session_id, "action": action}
    
    try:
        if action == "goto":
            url = args.get("url")
            if not url:
                return {"ok": False, "error": "url required for goto"}
            page.goto(url, wait_until=args.get("waitUntil", "domcontentloaded"))
            result.update({
                "url": page.url,
                "title": page.title(),
            })
        
        elif action == "click":
            selector = args.get("selector")
            if not selector:
                return {"ok": False, "error": "selector required for click"}
            page.locator(selector).first.click(timeout=args.get("timeoutMs", 5000))
            result.update({
                "url": page.url,
                "title": page.title(),
            })
        
        elif action == "type":
            selector = args.get("selector")
            text = args.get("text")
            if not selector:
                return {"ok": False, "error": "selector required for type"}
            if text is None:
                return {"ok": False, "error": "text required for type"}
            page.locator(selector).first.fill(text, timeout=args.get("timeoutMs", 5000))
            if args.get("pressEnter"):
                page.locator(selector).first.press("Enter")
            result.update({
                "url": page.url,
                "title": page.title(),
            })
        
        elif action == "screenshot":
            shot = page.screenshot(full_page=args.get("fullPage", False))
            result.update({
                "screenshotBase64": base64.b64encode(shot).decode("ascii"),
                "url": page.url,
            })
        
        elif action == "read":
            result.update({
                "url": page.url,
                "title": page.title(),
                "innerText": page.inner_text("body"),
            })
        
        elif action == "evaluate":
            js = args.get("javascript")
            if not js:
                return {"ok": False, "error": "javascript required for evaluate"}
            eval_result = page.evaluate(js)
            result.update({"result": eval_result})
        
        elif action == "navigate_back":
            page.go_back()
            result.update({"url": page.url, "title": page.title()})
        
        elif action == "navigate_forward":
            page.go_forward()
            result.update({"url": page.url, "title": page.title()})
        
        elif action == "wait_for_load":
            page.wait_for_load_state(args.get("state", "load"))
            result.update({"url": page.url, "title": page.title()})
        
        else:
            return {"ok": False, "error": f"unknown action: {action}"}
        
        session["action_count"] += 1
        result["action_count"] = session["action_count"]
        
    except Exception as e:
        return {"ok": False, "error": f"action failed: {str(e)}"}
    
    return result


def list_sessions() -> Dict[str, Any]:
    """List all active sessions."""
    now = time.time()
    sessions = []
    for sid, sess in SESSIONS.items():
        sessions.append({
            "session_id": sid,
            "url": sess["page"].url,
            "title": sess["page"].title(),
            "created_at": sess["created_at"],
            "last_used": sess["last_used"],
            "idle_seconds": int(now - sess["last_used"]),
            "action_count": sess["action_count"],
        })
    return {"ok": True, "sessions": sessions, "count": len(sessions)}


def session_status(session_id: str) -> Dict[str, Any]:
    """Get status of a specific session."""
    if session_id not in SESSIONS:
        return {"ok": False, "error": f"session '{session_id}' not found"}
    
    sess = SESSIONS[session_id]
    now = time.time()
    return {
        "ok": True,
        "session_id": session_id,
        "url": sess["page"].url,
        "title": sess["page"].title(),
        "created_at": sess["created_at"],
        "last_used": sess["last_used"],
        "idle_seconds": int(now - sess["last_used"]),
        "action_count": sess["action_count"],
    }


def main() -> None:
    global last_cleanup_time
    last_cleanup_time = time.time()  # Initialize cleanup timer
    
    payload = parse_input()
    action = payload.get("action")
    session_id = payload.get("session_id")
    args = payload.get("args", {}) or {}
    
    # Cleanup expired sessions periodically
    expired = cleanup_expired_sessions()
    if expired:
        print(f"Cleaned up {len(expired)} expired sessions: {expired}", file=sys.stderr)
    
    try:
        if action == "create_session":
            if not session_id:
                fail("session_id is required for create_session")
                return
            user_data_dir = args.get("userDataDir", Path.home() / ".lumina-browser-sessions" / session_id)
            headless = args.get("headless", True)
            result = create_session(session_id, str(user_data_dir), headless)
        
        elif action == "close_session":
            if not session_id:
                fail("session_id is required for close_session")
                return
            result = close_session(session_id)
        
        elif action == "use_session":
            if not session_id:
                fail("session_id is required for use_session")
                return
            if not action:
                fail("action is required for use_session")
                return
            # Extract the actual browser action from args
            browser_action = args.get("action")
            if not browser_action:
                fail("args.action is required for use_session")
                return
            result = use_session(session_id, browser_action, args)
        
        elif action == "list_sessions":
            result = list_sessions()
        
        elif action == "session_status":
            if not session_id:
                fail("session_id is required for session_status")
                return
            result = session_status(session_id)
        
        else:
            fail(f"unknown action: {action}")
            return
        
        emit(result)
    
    except Exception as e:
        fail(f"browser_session failure: {str(e)}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
