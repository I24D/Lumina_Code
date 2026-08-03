"""
browser_drive.py — Playwright-driven browser actions for Lumina.

A short-lived process per action: spin up Chromium with persistent
context, perform one operation, return JSON, exit. The TS tool side
serialises actions so the user never has two concurrent browser sessions
unless they ask for it.

Requirements:
  pip install playwright
  playwright install chromium

Supported actions:
  goto            — open a URL (and screenshot)
  click           — click a CSS/text selector
  type            — type into a CSS selector
  screenshot      — PNG of the current page (returns base64)
  dom_screenshot  — PNG of viewport saved to disk, returns absolute path
  read            — return innerText / title / url
  smart_click     — click by NL name using accessibility tree (getByRole + fallbacks)
  smart_type      — focus by NL name and fill a value
  dom_observe     — return top interactable elements (role+name+href+visible)
  screencast_start — start programmatic video recording (Playwright 1.59+)
  screencast_stop  — stop recording and return video path

Stdin: JSON {"action": "...", "args": {...}, "userDataDir": "..."}
Stdout: JSON {"ok": bool, ...}
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Dict


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def fail(reason: str, code: int = 2) -> None:
    emit({"ok": False, "error": reason}, code)


def parse_input() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("empty stdin; expected JSON {action, args}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"invalid JSON on stdin: {e}")
        return {}


def main() -> None:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError:
        fail("playwright not installed. pip install playwright && playwright install chromium")
        return

    payload = parse_input()
    action = payload.get("action")
    args = payload.get("args", {}) or {}
    user_data_dir = payload.get("userDataDir")
    if not user_data_dir:
        fail("userDataDir is required")
        return
    Path(user_data_dir).mkdir(parents=True, exist_ok=True)

    # Screencast state: stored in a temp file for cross-call persistence
    screencast_state_file = Path(user_data_dir) / ".screencast_state.json"

    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir,
                headless=bool(args.get("headless", True)),
                viewport={"width": 1440, "height": 900},
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            result: Dict[str, Any] = {"ok": True, "action": action}

            if action == "goto":
                url = args.get("url")
                if not url:
                    fail("url required for goto")
                page.goto(url, wait_until=args.get("waitUntil", "domcontentloaded"))
                shot = page.screenshot(full_page=False)
                result.update({
                    "url": page.url,
                    "title": page.title(),
                    "screenshotBase64": base64.b64encode(shot).decode("ascii"),
                })

            elif action == "click":
                selector = args.get("selector")
                if not selector:
                    fail("selector required for click")
                page.locator(selector).first.click(timeout=args.get("timeoutMs", 5000))
                result.update({"clicked": selector, "url": page.url})

            elif action == "type":
                selector = args.get("selector")
                text = args.get("text", "")
                if not selector:
                    fail("selector required for type")
                page.locator(selector).first.fill(text, timeout=args.get("timeoutMs", 5000))
                result.update({"typed": selector, "len": len(text)})

            elif action == "screenshot":
                shot = page.screenshot(full_page=bool(args.get("fullPage", False)))
                result.update({
                    "screenshotBase64": base64.b64encode(shot).decode("ascii"),
                    "url": page.url,
                })

            elif action == "dom_screenshot":
                # Fast viewport screenshot saved to disk. Faster than the Windows
                # Bridge /screenshot (no PowerShell roundtrip, no full desktop)
                # and ALWAYS captures the current page exactly — useful for the
                # PC Operator Loop when the foreground is a browser.
                import tempfile
                import time
                out_dir = args.get("outDir") or Path(tempfile.gettempdir()) / "lumina-dom-shots"
                out_dir = Path(out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                # ms timestamp to avoid collisions when the loop iterates fast.
                ts = int(time.time() * 1000)
                full_page = bool(args.get("fullPage", False))
                ext = "png"
                out_path = out_dir / f"dom-{ts}.{ext}"
                shot = page.screenshot(full_page=full_page, type="png")
                out_path.write_bytes(shot)
                result.update({
                    "path": str(out_path),
                    "url": page.url,
                    "fullPage": full_page,
                    "sizeBytes": len(shot),
                })

            elif action == "read":
                selector = args.get("selector")
                if selector:
                    result.update({
                        "text": page.locator(selector).first.inner_text(timeout=args.get("timeoutMs", 5000)),
                        "selector": selector,
                    })
                else:
                    result.update({
                        "title": page.title(),
                        "url": page.url,
                        "text": page.locator("body").inner_text()[:8000],
                    })

            elif action == "smart_click":
                query = (args.get("query") or "").strip()
                if not query:
                    fail("query required for smart_click")
                    return
                role_hint = args.get("role")
                timeout_ms = int(args.get("timeoutMs", 6000))
                exact = bool(args.get("exact", False))
                url_before = page.url
                pre_html_len = len(page.content() or "")

                roles_to_try = []
                if role_hint:
                    roles_to_try.append(role_hint)
                # Most-likely-first fallback chain (visible interactables first).
                for default_role in ["button", "link", "menuitem", "tab", "checkbox", "radio", "option"]:
                    if default_role not in roles_to_try:
                        roles_to_try.append(default_role)

                strategy_used = None
                candidate_count = 0
                last_error = None
                max_retries = 2  # Self-healing: retry once if element not found immediately

                # Self-healing wrapper: retry with small delay if initial attempt fails.
                # This handles cases where the DOM needs a moment to settle after navigation.
                for attempt in range(max_retries):
                    if attempt > 0:
                        # Wait a bit for DOM to settle before retrying
                        page.wait_for_timeout(500)
                        try:
                            page.wait_for_load_state("domcontentloaded", timeout=2000)
                        except Exception:
                            pass  # Continue anyway

                    # 1) Try each role with the query as accessible name.
                    for role in roles_to_try:
                        try:
                            loc = page.get_by_role(role, name=query, exact=exact)
                            count = loc.count()
                            if count >= 1:
                                loc.first.click(timeout=timeout_ms)
                                strategy_used = f"role:{role}"
                                candidate_count = count
                                break
                        except Exception as e:  # noqa: BLE001
                            last_error = f"role:{role}: {e!s}"
                            continue
                    
                    if strategy_used is not None:
                        break  # Success, exit retry loop

                # 2) Fallback: getByText (visible text contains).
                if strategy_used is None:
                    try:
                        loc = page.get_by_text(query, exact=exact)
                        count = loc.count()
                        if count >= 1:
                            loc.first.click(timeout=timeout_ms)
                            strategy_used = "text"
                            candidate_count = count
                    except Exception as e:  # noqa: BLE001
                        last_error = f"text: {e!s}"

                # 3) Fallback: ARIA label substring.
                if strategy_used is None:
                    safe = query.replace("'", "\\'")
                    try:
                        loc = page.locator(f"[aria-label*='{safe}' i]")
                        count = loc.count()
                        if count >= 1:
                            loc.first.click(timeout=timeout_ms)
                            strategy_used = "aria-label"
                            candidate_count = count
                    except Exception as e:  # noqa: BLE001
                        last_error = f"aria-label: {e!s}"

                # 4) Fallback: placeholder substring (for input-button hybrids).
                if strategy_used is None:
                    safe = query.replace("'", "\\'")
                    try:
                        loc = page.locator(f"[placeholder*='{safe}' i]")
                        count = loc.count()
                        if count >= 1:
                            loc.first.click(timeout=timeout_ms)
                            strategy_used = "placeholder"
                            candidate_count = count
                    except Exception as e:  # noqa: BLE001
                        last_error = f"placeholder: {e!s}"

                if strategy_used is None:
                    # YouTube and similar sites often expose the useful target as a
                    # thumbnail/title anchor without a clean role/name pair. Try a
                    # broad partial href fallback before giving up.
                    try:
                        ql = query.lower()
                        if any(token in ql for token in ["first video", "primer video", "video result", "resultado"]):
                            loc = page.locator("a#video-title, a[href*='/watch'], ytd-video-renderer a[href*='/watch']")
                            count = loc.count()
                            if count >= 1:
                                loc.first.click(timeout=timeout_ms)
                                strategy_used = "youtube-first-watch-link"
                                candidate_count = count
                    except Exception as e:  # noqa: BLE001
                        last_error = f"youtube-watch-link: {e!s}"

                if strategy_used is None:
                    fail(f"no_match: tried role+text+aria-label+placeholder+youtube-watch-link (with {max_retries} attempts) for {query!r}. last={last_error}")
                    return

                # Verify: URL changed OR DOM size changed by > 2%.
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=2_000)
                except Exception:
                    pass
                url_after = page.url
                try:
                    post_html_len = len(page.content() or "")
                except Exception:
                    post_html_len = pre_html_len
                dom_change = abs(post_html_len - pre_html_len) / max(pre_html_len, 1)
                verified = (url_after != url_before) or (dom_change > 0.02)
                result.update({
                    "query": query,
                    "strategy": strategy_used,
                    "candidateCount": candidate_count,
                    "urlBefore": url_before,
                    "urlAfter": url_after,
                    "domChangeRatio": round(dom_change, 4),
                    "verified": verified,
                })

            elif action == "smart_type":
                query = (args.get("query") or "").strip()
                text = args.get("text", "")
                if not query:
                    fail("query required for smart_type")
                    return
                timeout_ms = int(args.get("timeoutMs", 6000))
                press_enter = bool(args.get("pressEnter", False))

                strategy_used = None
                for role in ["textbox", "searchbox", "combobox"]:
                    try:
                        loc = page.get_by_role(role, name=query)
                        if loc.count() >= 1:
                            loc.first.fill(text, timeout=timeout_ms)
                            strategy_used = f"role:{role}"
                            break
                    except Exception:
                        continue
                if strategy_used is None:
                    try:
                        loc = page.get_by_label(query)
                        if loc.count() >= 1:
                            loc.first.fill(text, timeout=timeout_ms)
                            strategy_used = "label"
                    except Exception:
                        pass
                if strategy_used is None:
                    safe = query.replace("'", "\\'")
                    try:
                        loc = page.locator(
                            f"input[placeholder*='{safe}' i], textarea[placeholder*='{safe}' i]"
                        )
                        if loc.count() >= 1:
                            loc.first.fill(text, timeout=timeout_ms)
                            strategy_used = "placeholder"
                    except Exception:
                        pass
                if strategy_used is None:
                    # YouTube search uses an input with id=search and name=search_query
                    # that may not expose a stable accessible label in Playwright.
                    try:
                        loc = page.locator("input#search, input[name='search_query'], input[aria-label*='Search' i]")
                        if loc.count() >= 1:
                            loc.first.fill(text, timeout=timeout_ms)
                            strategy_used = "youtube-search-input"
                    except Exception:
                        pass
                if strategy_used is None:
                    fail(f"no_match: tried role+label+placeholder+youtube-search-input for {query!r}")
                    return
                if press_enter:
                    try:
                        page.keyboard.press("Enter")
                    except Exception:
                        pass
                result.update({
                    "query": query,
                    "strategy": strategy_used,
                    "length": len(text),
                    "pressedEnter": press_enter,
                })

            elif action == "dom_observe":
                limit = int(args.get("limit", 30))
                # Collect visible interactables with their accessible name + bbox.
                js = """
                () => {
                  const out = [];
                  const sel = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"]';
                  const seen = new Set();
                  for (const el of document.querySelectorAll(sel)) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    if (r.bottom < 0 || r.top > window.innerHeight) continue;
                    if (r.right < 0 || r.left > window.innerWidth) continue;
                    const cs = getComputedStyle(el);
                    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
                    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 120);
                    const role = el.getAttribute('role') || el.tagName.toLowerCase();
                    const href = el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') : null;
                    const key = role + '|' + name + '|' + Math.round(r.left) + ',' + Math.round(r.top);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({
                      role, name, href,
                      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
                      center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
                    });
                  }
                  return out;
                }
                """
                try:
                    elements = page.evaluate(js) or []
                except Exception as e:  # noqa: BLE001
                    fail(f"dom_observe eval failed: {e!s}")
                    return
                if not isinstance(elements, list):
                    elements = []
                # Trim by area descending.
                elements.sort(key=lambda e: e.get("bbox", {}).get("w", 0) * e.get("bbox", {}).get("h", 0), reverse=True)
                elements = elements[:limit]
                result.update({
                    "url": page.url,
                    "title": page.title(),
                    "elementCount": len(elements),
                    "elements": elements,
                })

            elif action == "scroll":
                direction = args.get("direction", "down")
                amount = int(args.get("amount", 3))  # number of notches
                scroll_amount = amount * 100  # pixels per notch
                if direction == "down":
                    page.evaluate(f"window.scrollBy(0, {scroll_amount})")
                elif direction == "up":
                    page.evaluate(f"window.scrollBy(0, -{scroll_amount})")
                elif direction == "left":
                    page.evaluate(f"window.scrollBy(-{scroll_amount}, 0)")
                elif direction == "right":
                    page.evaluate(f"window.scrollBy({scroll_amount}, 0)")
                result.update({"scrolled": direction, "amount": amount})

            elif action == "navigate_back":
                page.go_back()
                result.update({"url": page.url, "title": page.title()})

            elif action == "navigate_forward":
                page.go_forward()
                result.update({"url": page.url, "title": page.title()})

            elif action == "refresh":
                page.reload(wait_until=args.get("waitUntil", "domcontentloaded"))
                result.update({"url": page.url, "title": page.title()})

            elif action == "screencast_start":
                # Playwright 1.59+ Screencast API for programmatic video recording.
                # Useful for debugging PC Operator loops and generating proof of execution.
                import time
                out_dir = args.get("outDir") or Path(user_data_dir) / "screencasts"
                out_dir = Path(out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                ts = int(time.time() * 1000)
                video_path = out_dir / f"screencast-{ts}.webm"
                max_duration_ms = int(args.get("maxDurationMs", 300000))  # 5 min default
                scale = float(args.get("scale", 0.5))  # 50% scale default

                # Start screencast
                screencast = page.screencast(
                    path=str(video_path),
                    maxDuration=max_duration_ms,
                    scale=scale,
                )
                screencast.start()

                # Save state for later stop call
                screencast_state_file.write_text(json.dumps({
                    "active": True,
                    "videoPath": str(video_path),
                    "startedAt": ts,
                    "maxDurationMs": max_duration_ms,
                    "scale": scale,
                }))

                result.update({
                    "status": "recording",
                    "videoPath": str(video_path),
                    "startedAt": ts,
                    "maxDurationMs": max_duration_ms,
                    "scale": scale,
                })

            elif action == "screencast_stop":
                # Stop active screencast and return final video path
                if not screencast_state_file.exists():
                    fail("no active screencast; call screencast_start first")
                    return

                state = json.loads(screencast_state_file.read_text())
                if not state.get("active"):
                    fail("screencast already stopped")
                    return

                # Note: In sync API, we can't directly stop an ongoing screencast.
                # The recording stops when the context closes or maxDuration is reached.
                # For our use case, we just mark it as stopped and return the path.
                state["active"] = False
                state["stoppedAt"] = int(time.time() * 1000)
                screencast_state_file.write_text(json.dumps(state))

                result.update({
                    "status": "stopped",
                    "videoPath": state["videoPath"],
                    "durationMs": state["stoppedAt"] - state["startedAt"],
                })

            else:
                fail(f"unknown action: {action}")
                return

            ctx.close()
            emit(result)
    except Exception as e:  # noqa: BLE001
        fail(f"browser_drive failure: {e!s}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
