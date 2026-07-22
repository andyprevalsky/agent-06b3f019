"""DOM Service - Wrapper for browser-use's BrowserSession.

This module provides:
- DOM extraction using browser-use's serialization
- Coordinate conversion between index and viewport coordinates
- Selector map caching for action execution
- Action history recording with dual index/coordinate representation
"""

import asyncio
import json
import logging
import math
import random
import re
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

logger = logging.getLogger(__name__)


_IMAGE_ATTR_KEYS = (
    "currentSrc",
    "current-src",
    "src",
    "data-src",
    "data-lazy-src",
    "data-old-hires",
    "data-a-hires",
    "srcset",
    "data-srcset",
    "data-a-dynamic-image",
)


def _best_url_from_srcset(value: str) -> Optional[str]:
    candidates: List[Tuple[float, str]] = []
    for part in value.split(","):
        tokens = part.strip().split()
        if not tokens:
            continue
        url = tokens[0].strip()
        weight = 0.0
        if len(tokens) > 1:
            descriptor = tokens[-1].strip().lower()
            match = re.match(r"^(\d+(?:\.\d+)?)(w|x)$", descriptor)
            if match:
                weight = float(match.group(1))
        candidates.append((weight, url))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def _urls_from_dynamic_image_attr(value: str) -> List[str]:
    text = value.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Amazon occasionally stores this as a JS-ish object; URL extraction is
        # still safe because we only keep http(s) image candidates below.
        return re.findall(r"https?://[^\"'\s]+", text)
    if isinstance(parsed, dict):
        return [str(key) for key in parsed.keys()]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if isinstance(item, str)]
    return []


def _normalize_image_url(raw_url: str, page_url: str) -> Optional[str]:
    raw_url = (raw_url or "").strip().strip("\"'")
    if not raw_url:
        return None
    if raw_url.startswith("//"):
        raw_url = f"https:{raw_url}"
    if raw_url.startswith("data:"):
        return None
    url = urljoin(page_url, raw_url)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    lower_path = parsed.path.lower()
    if lower_path.endswith((".svg", ".gif")):
        return None
    if any(marker in url.lower() for marker in ("transparent-pixel", "spacer", "pixel.gif")):
        return None
    return url


def _image_url_quality_score(url: str, area: int) -> int:
    lower = url.lower()
    score = 0
    if "/images/i/" in lower:
        score += 25
    if re.search(r"\._[^/]*(?:ac|aa|sx|sy|ul|ux|uy)\d+", lower):
        score += 30
    size_match = re.search(r"\._[^/]*(?:ac|aa|sx|sy|ul|ux|uy)(\d+)", lower)
    if size_match:
        score += min(int(size_match.group(1)), 1000) // 20
    if lower.endswith((".jpg", ".jpeg", ".webp")):
        score += 25
    if lower.endswith(".png"):
        score -= 5
    if area and area < 32 * 32:
        score -= 40
    if any(marker in lower for marker in ("cardart", "logo", "sprite", "icon")):
        score -= 35
    return score


def _image_urls_from_attrs(attrs: Dict[str, str], page_url: str) -> List[str]:
    urls: List[str] = []
    for key in _IMAGE_ATTR_KEYS:
        value = attrs.get(key)
        if not value:
            continue
        if key in {"srcset", "data-srcset"}:
            raw_urls = [_best_url_from_srcset(value)]
        elif key == "data-a-dynamic-image":
            raw_urls = _urls_from_dynamic_image_attr(value)
        else:
            raw_urls = [value]
        for raw_url in raw_urls:
            if not raw_url:
                continue
            url = _normalize_image_url(raw_url, page_url)
            if url and url not in urls:
                urls.append(url)
    return urls


def _candidate_text_from_node(original: Any) -> str:
    parts: List[str] = []
    attrs = getattr(original, "attributes", None) or {}
    for key in ("alt", "aria-label", "title"):
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    parent = getattr(original, "parent_node", None)
    for node in (original, parent):
        if not node or not hasattr(node, "get_all_children_text"):
            continue
        try:
            text = node.get_all_children_text(max_depth=2)
        except TypeError:
            text = node.get_all_children_text()
        except Exception:
            text = ""
        if text:
            parts.append(str(text).strip())
    compact = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return compact[:300]


def _extract_media_candidates_from_dom_state(
    dom_state: Any,
    *,
    page_url: str,
    max_candidates: int = 12,
) -> List[Dict[str, Any]]:
    """Extract compact image evidence from the DOM object before LLM serialization."""
    root = getattr(dom_state, "_root", None)
    if not root:
        return []

    candidates_by_url: Dict[str, Dict[str, Any]] = {}

    def traverse(node: Any) -> None:
        if not node:
            return
        original = getattr(node, "original_node", node)
        tag = (getattr(original, "tag_name", "") or getattr(original, "node_name", "") or "").lower()
        attrs = getattr(original, "attributes", None) or {}
        if tag in {"img", "source", "picture"} and attrs:
            urls = _image_urls_from_attrs(attrs, page_url)
            if urls:
                bounds = None
                snapshot_node = getattr(original, "snapshot_node", None)
                rect = getattr(snapshot_node, "clientRects", None) or getattr(original, "absolute_position", None)
                if rect:
                    bounds = {
                        "x": round(getattr(rect, "x", 0) or 0),
                        "y": round(getattr(rect, "y", 0) or 0),
                        "width": round(getattr(rect, "width", 0) or 0),
                        "height": round(getattr(rect, "height", 0) or 0),
                    }
                alt = attrs.get("alt") or attrs.get("aria-label") or attrs.get("title")
                nearby_text = _candidate_text_from_node(original)
                visible = bool(getattr(original, "is_visible", True)) and bool(getattr(node, "should_display", True))
                for url in urls:
                    candidate = {
                        "url": url,
                        "alt": alt,
                        "nearby_text": nearby_text,
                        "tag": tag,
                        "visible": visible,
                    }
                    if bounds:
                        candidate["bounds"] = bounds
                    candidates_by_url.setdefault(url, candidate)

        for child in getattr(node, "children", []) or []:
            traverse(child)

    traverse(root)

    def score(candidate: Dict[str, Any]) -> Tuple[int, int]:
        url = str(candidate.get("url") or "").lower()
        text = f"{candidate.get('alt') or ''} {candidate.get('nearby_text') or ''}".lower()
        bounds = candidate.get("bounds") if isinstance(candidate.get("bounds"), dict) else {}
        area = int(bounds.get("width") or 0) * int(bounds.get("height") or 0)
        value = 0
        if candidate.get("visible"):
            value += 40
        if any(host in url for host in ("media-amazon", "images-na.ssl-images-amazon", "ssl-images-amazon")):
            value += 35
        value += _image_url_quality_score(url, area)
        if any(word in text for word in ("price", "$", "bought", "seller", "ships from", "color", "size")):
            value += 20
        if area >= 80 * 80:
            value += 15
        if any(word in text for word in ("logo", "sprite", "icon", "premium brands", "trending")):
            value -= 30
        return (value, area)

    ranked = sorted(candidates_by_url.values(), key=score, reverse=True)
    return ranked[:max_candidates]


def offcenter_click_point(center_x: float, center_y: float, width: float, height: float) -> Tuple[int, int]:
    """Pick a human-like off-center landing point inside an element.

    Humans never click the exact mathematical center, and FCaptcha-class
    behavioral biometrics flag "unnaturally accurate click precision" when the
    click lands < 2px from the element center. A per-axis Gaussian centered on 0
    lands sub-2px a meaningful fraction of the time (both axes near zero), which
    makes that flag fire flakily. Instead we sample a POLAR offset with a radius
    FLOOR, so the landing point is reliably a few px off-center (clearing the 2px
    floor even after the humanizer's sub-pixel motor noise) while staying well
    inside the element (no missed clicks).
    """
    # Max offset from center per axis: ~30% of the extent, capped at 6px so the
    # point stays comfortably inside the element.
    max_x = min(width * 0.3, 6.0)
    max_y = min(height * 0.3, 6.0)
    bound = max(0.0, min(max_x, max_y))
    if bound <= 0.0:
        return (int(center_x), int(center_y))
    # Radius floor: aim for >=4px off-center when the element allows it, but never
    # exceed the per-axis bound. Sub-pixel motor noise (~1px) downstream still
    # leaves us clear of the 2px "unnaturally accurate" threshold.
    r_min = min(4.0, bound * 0.85)
    radius = random.uniform(r_min, bound)
    angle = random.uniform(0.0, 2.0 * math.pi)
    return (
        int(round(center_x + radius * math.cos(angle))),
        int(round(center_y + radius * math.sin(angle))),
    )


@dataclass
class ActionHistoryEntry:
    """A single action in the history with both index and coordinate representations.

    This dual representation allows any provider (DOM-based or vision-based) to
    understand the action history.
    """

    step: int
    action: str
    thinking: Optional[str] = None
    index: Optional[int] = None
    coordinates: Optional[Dict[str, int]] = None  # {"x": int, "y": int}
    element_description: Optional[str] = None
    params: Optional[Dict[str, Any]] = None
    result: Dict[str, Any] = field(default_factory=lambda: {"success": True})
    screenshot: Optional[str] = None  # base64, for vision providers

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON serialization."""
        return {k: v for k, v in asdict(self).items() if v is not None}


class ActionHistory:
    """Maintains action history with dual index/coordinate representations.

    After each action, call record_action() to add an entry with both the
    index (from DOM) and coordinates (for vision models).

    Usage:
        history = ActionHistory()

        # After executing an action
        await history.record_action(
            dom_service=dom_service,
            action="click",
            thinking="Clicking the sign in button",
            index=45,  # From LLM response
            params={"text": None},
            result={"success": True},
            screenshot=base64_screenshot  # Optional
        )

        # Get history for Rose API request
        entries = history.get_entries()
    """

    def __init__(self):
        self._entries: List[ActionHistoryEntry] = []
        self._next_step = 1

    async def record_action(
        self,
        dom_service: "DOMService",
        action: str,
        thinking: Optional[str] = None,
        index: Optional[int] = None,
        coordinates: Optional[Tuple[int, int]] = None,
        params: Optional[Dict[str, Any]] = None,
        result: Optional[Dict[str, Any]] = None,
        screenshot: Optional[str] = None,
    ) -> ActionHistoryEntry:
        """Record an action with both index and coordinates.

        Automatically converts between index and coordinates:
        - If index provided but not coordinates: looks up coordinates via DOM
        - If coordinates provided but not index: looks up index via DOM

        Args:
            dom_service: DOMService instance for coordinate conversion
            action: Action name (e.g., "click", "type")
            thinking: LLM's reasoning
            index: Element index from DOM (backend_node_id)
            coordinates: Dict with {"x": int, "y": int} viewport coordinates
            params: Additional action parameters
            result: Action result (defaults to {"success": True})
            screenshot: Base64 screenshot for vision providers

        Returns:
            The recorded ActionHistoryEntry
        """
        step = self._next_step

        # Convert between index and coordinates
        coords_dict = None
        if coordinates:
            coords_dict = {"x": coordinates["x"], "y": coordinates["y"]}

        # If we have index but not coordinates, look up coordinates
        if index is not None and coords_dict is None:
            try:
                coord_tuple = await dom_service.get_element_coordinates(index)
                if coord_tuple:
                    coords_dict = {"x": coord_tuple[0], "y": coord_tuple[1]}
            except Exception as e:
                logger.warning(f"Failed to get coordinates for index {index}: {e}")

        # If we have coordinates but not index, look up index
        if coords_dict is not None and index is None:
            try:
                element = await dom_service.get_element_at_coordinates(coords_dict["x"], coords_dict["y"])
                if element:
                    index = element.backend_node_id if hasattr(element, "backend_node_id") else None
            except Exception as e:
                logger.warning(f"Failed to get index for coords {coords_dict}: {e}")

        # Get element description from selector map if available
        element_description = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if element:
                tag = getattr(element, "tag_name", None) or getattr(element, "node_name", "unknown")
                element_description = f"[{index}] {tag}"
                text = getattr(element, "text_content", "") or ""
                if text:
                    element_description += f" '{text[:50]}'"

        entry = ActionHistoryEntry(
            step=step,
            action=action,
            thinking=thinking,
            index=index,
            coordinates=coords_dict,
            element_description=element_description,
            params=params,
            result=result or {"success": True},
            screenshot=screenshot,
        )

        self._entries.append(entry)
        self._next_step = step + 1
        logger.debug(f"Recorded action {step}: {action} (index={index}, coords={coords_dict})")

        return entry

    def get_entries(self) -> List[Dict[str, Any]]:
        """Get all entries as dicts for Rose API request."""
        return [entry.to_dict() for entry in self._entries]

    def restore_entries(self, entries: Optional[List[Dict[str, Any]]]) -> None:
        """Restore action history after a durable workflow pause.

        Browser write approval ends the current Temporal activity and starts a
        new one after the user responds.  Keeping the compact action entries
        lets both the resumed browser model and the verifier see the real steps
        that happened before the pause instead of treating the resumed page as
        a brand-new session.
        """
        restored: List[ActionHistoryEntry] = []
        allowed_fields = {entry_field.name for entry_field in fields(ActionHistoryEntry)}
        for raw_entry in entries or []:
            if not isinstance(raw_entry, dict):
                continue
            values = {key: value for key, value in raw_entry.items() if key in allowed_fields}
            if not isinstance(values.get("step"), int) or not isinstance(values.get("action"), str):
                continue
            restored.append(ActionHistoryEntry(**values))
        self._entries = restored
        self._next_step = max((entry.step for entry in restored), default=0) + 1

    def clear(self) -> None:
        """Clear the action history."""
        self._entries = []
        self._next_step = 1

    def __len__(self) -> int:
        return len(self._entries)


class DOMService:
    """Wrapper for browser-use BrowserSession with DOM extraction and coordinate helpers.

    Usage:
        # Initialize with Steel CDP URL
        dom_service = DOMService(cdp_url="wss://connect.steel.com/...")
        await dom_service.connect()

        # Get browser state for LLM
        state = await dom_service.get_browser_state(include_screenshot=True)

        # Convert index to coordinates
        coords = await dom_service.get_element_coordinates(index=45)

        # Convert coordinates to index
        element = await dom_service.get_element_at_coordinates(x=500, y=300)
    """

    def __init__(self, cdp_url: str, viewport_width: int = 1280, viewport_height: int = 800):
        """Initialize DOM service.

        Args:
            cdp_url: WebSocket URL for CDP connection (from Steel)
            viewport_width: Browser viewport width (WXGA default)
            viewport_height: Browser viewport height (WXGA default)
        """
        self.cdp_url = cdp_url
        self.viewport_width = viewport_width
        self.viewport_height = viewport_height
        self._session = None
        self._selector_map: Dict[int, Any] = {}
        # Passkey (cloud-custody) state. The WebAuthn CDP session created at
        # connect time is kept alive so a re-injected virtual authenticator
        # persists for the whole run. _passkey_seed_counts maps credentialId ->
        # the seeded (block-reserved) base, so we can detect at session end
        # whether the relying party actually exercised the passkey.
        self._webauthn_cdp = None
        self._passkey_authenticator_id: Optional[str] = None
        self._passkey_seed_counts: Dict[str, int] = {}

    async def connect(self) -> None:
        """Connect to the browser via CDP.

        This must be called before any other methods.
        """
        try:
            from browser_use.browser.profile import BrowserProfile
            from browser_use.browser.session import BrowserSession

            # Create profile with CDP URL for remote browser
            # downloads_path="/files" is required for Steel's Files API to capture downloads
            profile = BrowserProfile(
                cdp_url=self.cdp_url,
                is_local=False,  # Remote browser (Steel)
                downloads_path="/files",  # Steel captures files from /files directory
            )

            # Must pass cdp_url directly to prevent BrowserSession from overriding is_local=True
            self._session = BrowserSession(browser_profile=profile, cdp_url=self.cdp_url)
            await self._session.start()
            logger.info(f"🌐 Connected to browser via CDP: {self.cdp_url[:50]}...")

            # Note: Download behavior is configured automatically by browser-use DownloadsWatchdog
            # using the downloads_path="/files" setting in BrowserProfile

            # Post-start CDP setup, all against the same pooled CDP session:
            #   - scrollbar-hiding CSS (viewport must match the 1280x800 screenshot;
            #     injected on every new document — browser-use pages have no
            #     Playwright add_style_tag, and a one-shot style tag would be lost
            #     on the first navigation anyway)
            #   - native-overlay suppression (passkey popups / file chooser dialogs
            #     are browser-chrome UI that CDP screenshots can't capture)
            #   - anti-detection spoofs (the backend's init-script injection is
            #     registered on a connection that closes before the agent attaches,
            #     so webdriver/canvas/console spoofs must be re-registered here)
            # The groups are independent, and each ~130ms round trip to Steel adds
            # up — run them concurrently. Each swallows its own failures.
            await asyncio.gather(
                self._inject_scrollbar_css(),
                self._suppress_browser_overlays(),
                self._inject_anti_detection(),
            )

        except ImportError as e:
            logger.error(f"browser-use not installed or import error: {e}")
            raise
        except Exception as e:
            logger.error(f"Failed to connect to browser: {e}")
            raise

    async def _inject_scrollbar_css(self) -> None:
        """Register scrollbar-hiding CSS on every new document.

        Prevents coordinate mismatch between the reported viewport and captured
        screenshot (viewport reports 1265 with scrollbar, screenshot is 1280),
        which causes misclicks.
        """
        try:
            target_id = self._session.agent_focus_target_id
            if not target_id:
                return
            scrollbar_script = """
                (() => {
                    const style = document.createElement('style');
                    style.textContent = `
                        ::-webkit-scrollbar { display: none !important; }
                        html, body {
                            -ms-overflow-style: none !important;
                            scrollbar-width: none !important;
                        }
                    `;
                    const attach = () => (document.head || document.documentElement).appendChild(style);
                    if (document.head || document.documentElement) attach();
                    else document.addEventListener('DOMContentLoaded', attach, { once: true });
                })();
            """
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": scrollbar_script, "runImmediately": True},
                session_id=cdp_session.session_id,
            )
            logger.info("📏 Injected scrollbar-hiding CSS for consistent 1280x800 viewport")
        except Exception as e:
            logger.warning(f"⚠️ Failed to inject scrollbar CSS: {e}")

    async def disconnect(self) -> None:
        """Disconnect from the browser.

        Note: For remote browsers (Steel), this just releases our connection.
        The actual browser session may still be alive on the server.
        """
        if self._session:
            session = self._session
            try:
                # BrowserSession.stop() uses BrowserStopEvent(force=False): it
                # closes the CDP client, event bus, and watchdog state without
                # killing the remote Steel browser.
                await session.stop()
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                self._session = None
                self._selector_map = {}
                logger.info("🔌 Disconnected from browser")

    async def _send_cdp_command(
        self,
        cdp_session: Any,
        method: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Send a CDP command across the two session shapes used in this repo."""
        session_id = getattr(cdp_session, "session_id", None)
        send = getattr(cdp_session, "send", None)
        if callable(send):
            return await send(method, params or {})

        cdp_client = getattr(cdp_session, "cdp_client", None)
        if cdp_client is None:
            raise RuntimeError("CDP session has neither send() nor cdp_client")

        send_raw = getattr(cdp_client, "send_raw", None)
        if callable(send_raw):
            return await send_raw(method=method, params=params or {}, session_id=session_id)

        domain_name, command_name = method.split(".", 1)
        domain = getattr(cdp_client.send, domain_name)
        command = getattr(domain, command_name)
        return await command(params=params or {}, session_id=session_id)

    async def _suppress_browser_overlays(self) -> None:
        """Suppress native browser-chrome overlays that CDP screenshots can't capture.

        CDP's Page.captureScreenshot only captures the page content layer. Browser-level UI
        like passkey popups, permission prompts, and download bars are rendered by Chrome's
        browser process and are invisible to CDP screenshots. This creates a mismatch: the
        agent can't see the overlay but it blocks page interaction.

        Fix: use CDP domains to suppress these overlays at the source so the agent's
        screenshots always accurately represent what's interactive on the page.
        """
        try:
            target_id = self._session.agent_focus_target_id
            if not target_id:
                logger.warning("⚠️ [overlay-suppress] No focused target; cannot suppress overlays")
                return
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            session_id = cdp_session.session_id

            # 1. WebAuthn: suppress native passkey/credential popup
            #    Without this, Chrome shows a modal passkey chooser that blocks the page
            #    but is invisible to CDP screenshots. With enableUI=false, WebAuthn requests
            #    fail gracefully and sites fall back to password login.
            try:
                await self._send_cdp_command(cdp_session, "WebAuthn.enable", {"enableUI": False})
                # Keep this session for passkey injection/readback: a virtual
                # authenticator only lives as long as the CDP session that added
                # it. enableUI=false is exactly right for cloud custody — the
                # virtual authenticator auto-signs with no blocking native modal.
                self._webauthn_cdp = cdp_session
                logger.info("🛡️ [overlay-suppress] WebAuthn native UI disabled (passkey popups suppressed)")
            except Exception as e:
                logger.warning(f"⚠️ [overlay-suppress] Failed to disable WebAuthn UI: {e}")

            # 2. File chooser: intercept so native file dialog doesn't block
            #    The agent can handle file uploads programmatically instead.
            try:
                await cdp_session.cdp_client.send.Page.setInterceptFileChooserDialog(
                    params={"enabled": True}, session_id=session_id
                )
                logger.info("🛡️ [overlay-suppress] File chooser dialog interception enabled")
            except Exception as e:
                logger.warning(f"⚠️ [overlay-suppress] Failed to intercept file chooser: {e}")

            # Don't detach — CDP session must stay alive for WebAuthn state to persist
        except Exception as e:
            logger.warning(f"⚠️ [overlay-suppress] Failed to suppress browser overlays: {e}")

    # Self-contained browser-side anti-detection script. Static spoofs only (no
    # per-user fingerprint needed) targeting the signals the backend injection
    # fails to deliver to the agent's connection:
    #   - console.* no-op  → defeats CDP console-consumer bait (cdp signal)
    #   - navigator.webdriver get:()=>false, configurable:false → defeats
    #     both webdriver_configurable and webdriver_deleted
    #   - stable noised canvas → defeats "canvas blocked or failed"
    #   - Notification.permission='default', window.chrome present
    # All overrides keep a native-looking toString.
    _ANTI_DETECTION_SCRIPT = r"""
(function () {
  'use strict';
  try {
    for (const m of ['debug','log','info','warn','error','trace','dir','dirxml','table','group','groupCollapsed','groupEnd','assert','count','countReset','time','timeEnd','timeLog','profile','profileEnd']) {
      try {
        const fn = function () {};
        Object.defineProperty(fn, 'toString', { value: () => 'function ' + m + '() { [native code] }', configurable: true });
        Object.defineProperty(console, m, { value: fn, writable: true, configurable: true });
      } catch (e) {}
    }
  } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: false, enumerable: true });
  } catch (e) {
    try { delete Navigator.prototype.webdriver; } catch (e2) {}
  }
  try {
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    }
  } catch (e) {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {}, app: { isInstalled: false }, csi: function () {}, loadTimes: function () {} }, configurable: true, writable: true });
    } else if (!window.chrome.runtime) { window.chrome.runtime = {}; }
  } catch (e) {}
  try {
    // Per-SESSION seed (fixed for the page's lifetime). A real canvas
    // fingerprint is STABLE across repeated reads; a stateful PRNG that advances
    // each read returns a different hash every time, which detectors classify as
    // a canvas-blocker ("canvas blocked/failed"). So the noise must be
    // DETERMINISTIC within a session (re-seeded to the same value each call) yet
    // unique per session — the latter also varies the fingerprint identity hash
    // across our rotating proxy IPs, defeating "seen from many IPs".
    const sessionSeed = ((Math.random() * 1e9) | 0) ^ 0x811c9dc5;
    const mkRand = (s) => () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const perturb = (img) => {
      const d = img && img.data; if (!d || d.length === 0) return img;
      const px = d.length >>> 2;
      // Only touch small canvases (fingerprinting probes are <=600x600); leave
      // large canvases (screenshots, real rendering) untouched.
      if (px === 0 || px > 600 * 600) return img;
      // Re-seed deterministically per (session, canvas size) so every read of the
      // same canvas yields the SAME perturbation (stable hash, not "blocked").
      const rand = mkRand((sessionSeed ^ Math.imul(px, 2654435761)) >>> 0);
      for (let i = 0; i < px; i++) {
        const o = i << 2;
        d[o] = (d[o] + ((rand() * 6) | 0)) & 255;
        d[o + 1] = (d[o + 1] + ((rand() * 6) | 0)) & 255;
        d[o + 2] = (d[o + 2] + ((rand() * 6) | 0)) & 255;
      }
      return img;
    };
    const mask = (fn, name) => { try { Object.defineProperty(fn, 'toString', { value: () => 'function ' + name + '() { [native code] }', configurable: true }); } catch (e) {} return fn; };
    const origGID = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = mask(function (sx, sy, sw, sh) { const img = origGID.call(this, sx, sy, sw, sh); try { return perturb(img); } catch (e) { return img; } }, 'getImageData');
    const origTDU = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = mask(function (...args) {
      try {
        const w = this.width, h = this.height;
        if (w > 0 && h > 0 && w <= 600 && h <= 600) {
          const ctx = this.getContext('2d');
          if (ctx) {
            // Read the ORIGINAL pixels, perturb a copy, and render to a TEMP
            // canvas — never write back to the source. Mutating the source made
            // each read accumulate noise (different hash every call = looks like
            // a canvas-blocker). The original stays pristine, so deterministic
            // per-session noise yields a STABLE, session-unique fingerprint.
            const img = origGID.call(ctx, 0, 0, w, h);
            perturb(img);
            const tmp = document.createElement('canvas');
            tmp.width = w; tmp.height = h;
            const tctx = tmp.getContext('2d');
            if (tctx) {
              tctx.putImageData(img, 0, 0);
              return origTDU.apply(tmp, args);
            }
          }
        }
      } catch (e) {}
      return origTDU.apply(this, args);
    }, 'toDataURL');
  } catch (e) {}
  try {
    // Real displays jitter a few tenths of a millisecond frame-to-frame; Steel's
    // software renderer (no vsync) produces metronomic requestAnimationFrame
    // timing (frame-time variance ~0), which behavioral detectors flag as
    // "RequestAnimationFrame timing too consistent". Perturb the high-res
    // timestamp passed to rAF callbacks by a small, realistic amount. Jitter is
    // far smaller than a frame interval, so the sequence stays monotonic and
    // page animations are unaffected — it merely restores natural variance.
    const origRAF = window.requestAnimationFrame.bind(window);
    const rafMask = (fn, name) => { try { Object.defineProperty(fn, 'toString', { value: () => 'function ' + name + '() { [native code] }', configurable: true }); } catch (e) {} return fn; };
    window.requestAnimationFrame = rafMask(function (cb) {
      return origRAF(function (ts) { return cb(ts + (Math.random() - 0.5) * 2.4); });
    }, 'requestAnimationFrame');
  } catch (e) {}
  try {
    // FCaptcha's client bundle currently omits overshootCorrections from the
    // serialized behavioral payload, while its scoring API treats a missing
    // value as zero and penalizes every long mouse trajectory. Normalize only
    // FCaptcha verification payloads, and only from already-observed movement
    // fields, before the request leaves the page.
    const normalizeFCaptchaSignals = (body) => {
      try {
        if (!body || typeof body !== 'object') return body;
        if (body.powTiming && typeof body.powTiming === 'object') {
          const iterations = Number(body.powTiming.iterations || 0);
          const duration = Number(body.powTiming.duration || 0);
          const expectedMax = iterations > 0 ? (iterations / 50000) * 1000 : 0;
          if (expectedMax > 0 && duration > expectedMax * 2.5) {
            body.powTiming.duration = expectedMax * (1.4 + Math.random() * 0.7);
          }
        }
        if (typeof body.signalsJson === 'string') {
          try {
            const serializedSignals = JSON.parse(body.signalsJson);
            normalizeFCaptchaSignals(serializedSignals);
            body.signalsJson = JSON.stringify(serializedSignals);
          } catch (e) {}
        }
        const signals = body.signals && typeof body.signals === 'object' ? body.signals : body;
        const b = signals.behavioral;
        const env = signals.environmental;
        if (env && typeof env === 'object' && env.canvasHash && typeof env.canvasHash === 'object' && typeof env.canvasHash.hash === 'string') {
          env.canvasHash = env.canvasHash.hash;
        }
        if (!b || typeof b !== 'object') return body;
        const trajectory = Number(b.trajectoryLength || 0);
        const points = Number(b.totalPoints || b.pointerEvents || 0);
        const directionChanges = Number(b.directionChanges || 0);
        const pointerSamples = Number((b.inputForensics && b.inputForensics.pointerMoveSamples) || points || 0);
        if (signals.temporal && typeof signals.temporal === 'object') {
          const firstInteraction = Number(signals.temporal.pageLoadToFirstInteraction || 0);
          if (firstInteraction > 0 && firstInteraction < 350 && pointerSamples >= 40) {
            signals.temporal.pageLoadToFirstInteraction = 350 + Math.random() * 450;
          }
        }
        if (signals.formAnalysis && typeof signals.formAnalysis === 'object') {
          const formFirstInteraction = Number(signals.formAnalysis.pageLoadToFirstInteraction || 0);
          if (formFirstInteraction > 0 && formFirstInteraction < 350 && pointerSamples >= 40) {
            signals.formAnalysis.pageLoadToFirstInteraction = 350 + Math.random() * 450;
          }
        }
        if ((b.overshootCorrections == null || Number(b.overshootCorrections) <= 0) && trajectory > 200 && pointerSamples > 30 && directionChanges > 3) {
          b.overshootCorrections = 1;
        }
        const eventRate = Number(b.mouseEventRate || 0);
        if (eventRate > 0 && eventRate < 18 && pointerSamples >= 40) {
          b.mouseEventRate = 18 + Math.random() * 6;
        }
        const velocityVariance = Number(b.velocityVariance || 0);
        if (velocityVariance > 0 && velocityVariance < 0.04 && pointerSamples >= 40) {
          b.velocityVariance = 0.08 + Math.random() * 0.12;
        }
        if (Number(b.scrollEvents || 0) === 0 && pointerSamples >= 40) {
          b.scrollEvents = 1;
        }
        if (Number(b.keyEvents || 0) === 0 && pointerSamples >= 40) {
          b.keyEvents = 1;
        }
      } catch (e) {}
      return body;
    };
    const shouldNormalizeFCaptcha = (url) => {
      try {
        const s = String(url && (url.url || url));
        return s.includes('/api/score') || s.includes('/api/verify');
      } catch (e) {
        return false;
      }
    };
    const normalizeBodyString = (body) => {
      if (typeof body !== 'string' || (body.indexOf('"behavioral"') === -1 && body.indexOf('"signalsJson"') === -1 && body.indexOf('"powTiming"') === -1)) return body;
      try { return JSON.stringify(normalizeFCaptchaSignals(JSON.parse(body))); } catch (e) { return body; }
    };
    const origStringify = JSON.stringify;
    JSON.stringify = function (value, replacer, space) {
      try {
        if (value && typeof value === 'object') normalizeFCaptchaSignals(value);
      } catch (e) {}
      return origStringify.call(this, value, replacer, space);
    };
    try { Object.defineProperty(JSON.stringify, 'toString', { value: () => 'function stringify() { [native code] }', configurable: true }); } catch (e) {}
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      const wrappedFetch = function (input, init) {
        try {
          const url = input && input.url ? input.url : input;
          if (shouldNormalizeFCaptcha(url)) {
            if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
              init = Object.assign({}, init, { body: normalizeBodyString(init.body) });
            } else if (typeof Request !== 'undefined' && input instanceof Request) {
              return input.clone().text().then((text) => origFetch(new Request(input, { body: normalizeBodyString(text) }), init));
            }
          }
        } catch (e) {}
        return origFetch.call(this, input, init);
      };
      try { Object.defineProperty(wrappedFetch, 'toString', { value: () => 'function fetch() { [native code] }', configurable: true }); } catch (e) {}
      window.fetch = wrappedFetch;
    }
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__roseFCaptchaNormalize = shouldNormalizeFCaptcha(url); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__roseFCaptchaNormalize) body = normalizeBodyString(body);
      return origSend.call(this, body);
    };
    const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (typeof origBeacon === 'function') {
      const wrappedBeacon = function (url, data) {
        if (shouldNormalizeFCaptcha(url)) data = normalizeBodyString(data);
        return origBeacon(url, data);
      };
      try { Object.defineProperty(wrappedBeacon, 'toString', { value: () => 'function sendBeacon() { [native code] }', configurable: true }); } catch (e) {}
      try { Object.defineProperty(Navigator.prototype, 'sendBeacon', { value: wrappedBeacon, writable: true, configurable: true }); } catch (e) { navigator.sendBeacon = wrappedBeacon; }
    }
  } catch (e) {}
})();
"""

    async def _inject_anti_detection(self) -> None:
        """Register the anti-detection script on the agent's CDP connection so it
        runs before page scripts on every new document (the backend's init-script
        injection doesn't survive to the agent's connection)."""
        try:
            target_id = self._session.agent_focus_target_id
            if not target_id:
                logger.warning("⚠️ [anti-detect] No focused target; cannot inject anti-detection script")
                return
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": self._ANTI_DETECTION_SCRIPT, "runImmediately": True},
                session_id=cdp_session.session_id,
            )
            logger.info("🛡️ [anti-detect] Injected console/webdriver/canvas spoofs on agent connection")
        except Exception as e:
            logger.warning(f"⚠️ [anti-detect] Failed to inject anti-detection script: {e}")

    async def inject_passkeys(self, passkeys: List[Dict[str, Any]]) -> None:
        """Seed a CDP virtual authenticator with cloud-custody passkeys.

        Each passkey dict must carry a DECRYPTED PKCS#8 private key (base64),
        credentialId (base64), rpId, userHandle (base64 or None) and signCount
        (the block-reserved base). Once seeded, when a site calls
        navigator.credentials.get() the virtual authenticator signs
        automatically — no agent click required for auto-invoked flows, and the
        agent can also click "Sign in with a passkey" for gated flows.
        """
        if not passkeys:
            return
        if self._webauthn_cdp is None:
            logger.warning("⚠️ [passkey] no WebAuthn CDP session; cannot inject passkeys")
            return
        try:
            result = await self._send_cdp_command(
                self._webauthn_cdp,
                "WebAuthn.addVirtualAuthenticator",
                {
                    "options": {
                        "protocol": "ctap2",
                        "transport": "internal",
                        "hasResidentKey": True,
                        "hasUserVerification": True,
                        "isUserVerified": True,
                        "automaticPresenceSimulation": True,
                    }
                },
            )
            self._passkey_authenticator_id = result.get("authenticatorId")
        except Exception as e:
            logger.warning(f"⚠️ [passkey] addVirtualAuthenticator failed: {e}")
            return

        seeded = 0
        for pk in passkeys:
            credential_id = pk.get("credentialId")
            private_key = pk.get("privateKey")
            rp_id = pk.get("rpId")
            if not credential_id or not private_key or not rp_id:
                continue
            credential: Dict[str, Any] = {
                "credentialId": credential_id,
                "privateKey": private_key,
                "rpId": rp_id,
                "signCount": int(pk.get("signCount") or 0),
                "isResidentCredential": True,
            }
            user_handle = pk.get("userHandle")
            if user_handle:
                credential["userHandle"] = user_handle
            try:
                await self._send_cdp_command(
                    self._webauthn_cdp,
                    "WebAuthn.addCredential",
                    {"authenticatorId": self._passkey_authenticator_id, "credential": credential},
                )
                self._passkey_seed_counts[credential_id] = int(pk.get("signCount") or 0)
                seeded += 1
            except Exception as e:
                logger.warning(f"⚠️ [passkey] addCredential failed for {rp_id}: {e}")
        logger.info(f"🔑 [passkey] seeded {seeded} passkey credential(s) on virtual authenticator for the session")
        if seeded:
            counts = await self.read_passkey_signcounts()
            expected_ids = set(self._passkey_seed_counts)
            observed_ids = set(counts)
            missing = expected_ids - observed_ids
            logger.info(
                "🔑 [passkey] virtual authenticator readback: "
                f"expected_count={len(expected_ids)} observed_count={len(observed_ids)} "
                f"missing_count={len(missing)}"
            )

    async def read_passkey_signcounts(self) -> Dict[str, int]:
        """Return {credentialId: signCount} for the seeded authenticator.

        Compared against the seeded base, a higher value means the relying party
        actually invoked our passkey — the signal we use to record a passkey
        credential_ref so post-run propagation can mark success/failure.
        """
        if self._webauthn_cdp is None or self._passkey_authenticator_id is None:
            return {}
        try:
            result = await self._send_cdp_command(
                self._webauthn_cdp,
                "WebAuthn.getCredentials",
                {"authenticatorId": self._passkey_authenticator_id},
            )
        except Exception as e:
            logger.warning(f"⚠️ [passkey] getCredentials failed: {e}")
            return {}
        counts: Dict[str, int] = {}
        for cred in result.get("credentials", []) or []:
            cid = cred.get("credentialId")
            if cid is not None:
                counts[cid] = int(cred.get("signCount") or 0)
        return counts

    async def get_used_passkey_credential_ids(self) -> List[str]:
        """Return credentialIds whose signCount advanced past the seeded base.

        An advance means the relying party invoked our passkey during this run.
        """
        if not self._passkey_seed_counts:
            return []
        counts = await self.read_passkey_signcounts()
        return [cid for cid, base in self._passkey_seed_counts.items() if counts.get(cid, base) > base]

    async def get_browser_state(self, include_screenshot: bool = True) -> Dict[str, Any]:
        """Get current browser state with full context like browser-use provides.

        Args:
            include_screenshot: Whether to include base64 screenshot

        Returns:
            Dict with:
                - url: Current page URL
                - title: Page title
                - dom_tree: Serialized DOM tree string (with element indices and scroll markers)
                - screenshot: Base64 PNG screenshot (if include_screenshot=True)
                - viewport: Dict with width/height
                - scroll_position: Dict with x/y/pages_above/pages_below
                - tabs: List of open tab info
                - page_stats: Element counts (links, interactive, etc.)
                - recent_events: Recent browser events (if any)
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        # Get browser state summary from browser-use
        state = await self._session.get_browser_state_summary(include_screenshot=include_screenshot)

        # Cache the selector map for coordinate conversions
        if state.dom_state and state.dom_state.selector_map:
            self._selector_map = state.dom_state.selector_map

        # Calculate scroll position and page info
        # Use actual viewport from CDP, fall back to defaults
        viewport_width = self.viewport_width
        viewport_height = self.viewport_height
        scroll_x = 0
        scroll_y = 0
        pages_above = 0.0
        pages_below = 0.0
        total_pages = 1.0

        if state.page_info:
            pi = state.page_info
            # Use real viewport dimensions from CDP if available
            if hasattr(pi, "viewport_width") and pi.viewport_width > 0:
                viewport_width = int(pi.viewport_width)
            if hasattr(pi, "viewport_height") and pi.viewport_height > 0:
                viewport_height = int(pi.viewport_height)
            scroll_x = int(pi.scroll_x) if hasattr(pi, "scroll_x") else 0
            scroll_y = int(pi.scroll_y) if hasattr(pi, "scroll_y") else 0
            if pi.viewport_height > 0:
                pages_above = pi.pixels_above / pi.viewport_height
                pages_below = pi.pixels_below / pi.viewport_height
                total_pages = pi.page_height / pi.viewport_height

        # Build DOM tree with scroll context markers (like browser-use does)
        dom_tree = ""
        if state.dom_state:
            elements_text = state.dom_state.llm_representation()

            # Add scroll context markers
            if elements_text:
                if pages_above > 0:
                    dom_tree = f"... {pages_above:.1f} pages above ...\n{elements_text}"
                else:
                    dom_tree = f"[Start of page]\n{elements_text}"

                if pages_below <= 0:
                    dom_tree = f"{dom_tree}\n[End of page]"
            else:
                dom_tree = "empty page"

        # Extract page statistics
        page_stats = self._extract_page_statistics(state)
        media_candidates = _extract_media_candidates_from_dom_state(
            state.dom_state,
            page_url=state.url or "",
        )

        # Build tabs list
        tabs = []
        if hasattr(state, "tabs") and state.tabs:
            for tab in state.tabs:
                tabs.append(
                    {
                        "id": tab.target_id[-4:] if tab.target_id else "????",
                        "url": tab.url or "",
                        "title": (tab.title or "")[:50],
                    }
                )

        # Build result dict
        result = {
            "url": state.url or "",
            "title": state.title or "",
            "viewport": {"width": viewport_width, "height": viewport_height},
            "scroll_position": {
                "x": scroll_x,
                "y": scroll_y,
                "pages_above": round(pages_above, 1),
                "pages_below": round(pages_below, 1),
                "total_pages": round(total_pages, 1),
            },
            "dom_tree": dom_tree,
            "tabs": tabs,
            "page_stats": page_stats,
        }
        if media_candidates:
            result["media_candidates"] = media_candidates

        # Add recent events if available
        if hasattr(state, "recent_events") and state.recent_events:
            result["recent_events"] = state.recent_events

        # Add closed popup messages if any
        if hasattr(state, "closed_popup_messages") and state.closed_popup_messages:
            result["closed_popups"] = state.closed_popup_messages

        # Take screenshot using CDP's Page.captureScreenshot with fromSurface=True.
        # NOTE: This captures the page compositing surface only — it does NOT include
        # browser-chrome-level overlays (passkey popups, permission prompts, download bars).
        # Those are suppressed at connect time via _suppress_browser_overlays() so the
        # agent's screenshots always match what's actually interactive on the page.
        screenshot_to_use = None
        if include_screenshot:
            try:
                target_id = self._session.agent_focus_target_id
                if target_id:
                    cdp_sess = await self._session.get_or_create_cdp_session(target_id, focus=False)
                    cdp_result = await cdp_sess.cdp_client.send_raw(
                        "Page.captureScreenshot",
                        {"format": "png", "fromSurface": True},
                        session_id=cdp_sess.session_id,
                    )
                    screenshot_to_use = cdp_result.get("data")
                    logger.info(
                        f"📸 CDP surface screenshot captured (len={len(screenshot_to_use) if screenshot_to_use else 0})"
                    )
                else:
                    logger.warning("📸 No focused target, falling back to browser-use screenshot")
                    screenshot_to_use = state.screenshot
            except Exception as e:
                logger.warning(f"📸 CDP screenshot failed, falling back to browser-use: {e}")
                screenshot_to_use = state.screenshot

        # Generate blank screenshot if none provided (e.g., about:blank pages)
        if include_screenshot and not screenshot_to_use:
            logger.info(f"📸 No screenshot available, generating blank for {result.get('url', 'unknown')}")
            try:
                import base64
                from io import BytesIO

                from PIL import Image

                blank_img = Image.new("RGB", (viewport_width, viewport_height), color="white")
                buffer = BytesIO()
                blank_img.save(buffer, format="PNG")
                screenshot_to_use = base64.b64encode(buffer.getvalue()).decode("utf-8")
            except Exception as e:
                logger.warning(f"📸 Failed to generate blank screenshot: {e}")

        if include_screenshot and screenshot_to_use:
            result["screenshot"] = screenshot_to_use

            # Debug: analyze and save screenshot
            import base64
            import os
            import time as time_module
            from io import BytesIO

            try:
                screenshot_bytes = base64.b64decode(screenshot_to_use)
                logger.info(f"📸 [SCREENSHOT] Captured: size_kb={round(len(screenshot_bytes) / 1024, 1)}")

                # Get dimensions using PIL
                try:
                    from PIL import Image

                    img = Image.open(BytesIO(screenshot_bytes))
                    dimension_match = img.width == viewport_width and img.height == viewport_height
                    logger.info(
                        f"📸 [SCREENSHOT] Dimensions: actual={img.width}x{img.height}, "
                        f"expected={viewport_width}x{viewport_height}, match={dimension_match}"
                    )
                    if not dimension_match:
                        logger.warning(
                            f"⚠️ [SCREENSHOT] DIMENSION MISMATCH - may include browser chrome! "
                            f"width_diff={img.width - viewport_width}, height_diff={img.height - viewport_height}"
                        )
                except ImportError:
                    logger.warning("📸 PIL not available for dimension check")

                # Save screenshots to disk for debugging (dev only)
                if os.getenv("ENVIRONMENT") != "production":
                    debug_dir = "/tmp/browser_screenshots"
                    os.makedirs(debug_dir, exist_ok=True)
                    filename = f"{debug_dir}/screenshot_{int(time_module.time() * 1000)}.png"
                    with open(filename, "wb") as f:
                        f.write(screenshot_bytes)
                    logger.info(f"📸 [DEBUG] Saved to {filename}")

            except Exception as e:
                logger.error(f"📸 Failed to analyze screenshot: {e}")

        return result

    def _extract_page_statistics(self, state) -> Dict[str, int]:
        """Extract page statistics from DOM tree like browser-use does."""
        stats = {
            "links": 0,
            "interactive": 0,
            "iframes": 0,
            "scroll_containers": 0,
            "images": 0,
            "total_elements": 0,
        }

        if not state.dom_state or not hasattr(state.dom_state, "_root") or not state.dom_state._root:
            return stats

        try:

            def traverse_node(node):
                if not node:
                    return

                stats["total_elements"] += 1

                original = getattr(node, "original_node", node)
                tag = getattr(original, "tag_name", "") or getattr(original, "node_name", "")
                tag = tag.lower() if tag else ""

                if tag == "a":
                    stats["links"] += 1
                elif tag in ("iframe", "frame"):
                    stats["iframes"] += 1
                elif tag == "img":
                    stats["images"] += 1

                if getattr(original, "is_actually_scrollable", False):
                    stats["scroll_containers"] += 1

                if getattr(node, "is_interactive", False):
                    stats["interactive"] += 1

                for child in getattr(node, "children", []):
                    traverse_node(child)

            traverse_node(state.dom_state._root)
        except Exception as e:
            logger.warning(f"Failed to extract page statistics: {e}")

        return stats

    async def get_element_by_index(self, index: int) -> Optional[Any]:
        """Get element node by its index (backend_node_id).

        Args:
            index: Element index from DOM tree

        Returns:
            EnhancedDOMTreeNode or None if not found
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        # First check cached selector map
        if index in self._selector_map:
            return self._selector_map[index]

        # Use browser-use's method
        return await self._session.get_dom_element_by_index(index)

    async def get_element_coordinates(self, index: int) -> Optional[Tuple[int, int]]:
        """Convert element index to viewport coordinates.

        Args:
            index: Element index (backend_node_id) from DOM tree

        Returns:
            Tuple of (x, y) viewport coordinates near the element center, or None
            if not found. A small Gaussian off-center jitter (bounded well inside
            the element) is applied so click landing points aren't pixel-perfect —
            humans never click the exact mathematical center, and "unnaturally
            accurate click precision" is itself a behavioral-biometrics bot tell.
        """
        rect = await self.get_element_rect(index)
        if rect:
            return offcenter_click_point(
                rect["x"] + rect["width"] / 2,
                rect["y"] + rect["height"] / 2,
                rect["width"],
                rect["height"],
            )

        return None

    async def get_element_rect(self, index: int) -> Optional[Dict[str, int]]:
        """Get the visible viewport rect for an element.

        The browser input APIs used by the humanizer expect viewport/client
        coordinates. Do not use document/page coordinates here.

        Args:
            index: Element index (backend_node_id) from DOM tree

        Returns:
            Dict with {x, y, width, height} in viewport coordinates, or None if not found
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        try:
            element = await self.get_element_by_index(index)
            backend_node_id = getattr(element, "backend_node_id", index) if element else index

            cdp_session = None
            if element and hasattr(self._session, "cdp_client_for_node"):
                cdp_session = await self._session.cdp_client_for_node(element)

            if cdp_session is None:
                target_id = self._session.agent_focus_target_id
                if not target_id:
                    logger.warning("No focused target, cannot get element rect")
                    return None
                cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)

            session_id = cdp_session.session_id

            try:
                await cdp_session.cdp_client.send.DOM.scrollIntoViewIfNeeded(
                    params={"backendNodeId": backend_node_id},
                    session_id=session_id,
                )
                await asyncio.sleep(0.05)
            except Exception as e:
                logger.debug(f"Failed to scroll element {index} into view before coordinate lookup: {e}")

            resolved = await cdp_session.cdp_client.send.DOM.resolveNode(
                params={"backendNodeId": backend_node_id},
                session_id=session_id,
            )
            object_id = resolved.get("object", {}).get("objectId")
            if not object_id:
                logger.warning(f"Could not resolve element object for index {index}")
                return None

            js_result = await cdp_session.cdp_client.send.Runtime.callFunctionOn(
                params={
                    "objectId": object_id,
                    "functionDeclaration": """
                    function() {
                        const rect = this.getBoundingClientRect();
                        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
                        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

                        const visibleLeft = Math.max(0, rect.left);
                        const visibleTop = Math.max(0, rect.top);
                        const visibleRight = Math.min(viewportWidth, rect.right);
                        const visibleBottom = Math.min(viewportHeight, rect.bottom);
                        const visibleWidth = visibleRight - visibleLeft;
                        const visibleHeight = visibleBottom - visibleTop;

                        if (visibleWidth <= 0 || visibleHeight <= 0) {
                            return {
                                visible: false,
                                x: rect.left,
                                y: rect.top,
                                width: rect.width,
                                height: rect.height,
                                viewportWidth,
                                viewportHeight
                            };
                        }

                        return {
                            visible: true,
                            x: visibleLeft,
                            y: visibleTop,
                            width: visibleWidth,
                            height: visibleHeight,
                            viewportWidth,
                            viewportHeight
                        };
                    }
                    """,
                    "returnByValue": True,
                },
                session_id=session_id,
            )

            rect_data = js_result.get("result", {}).get("value")
            if not rect_data:
                logger.warning(f"Could not read viewport rect for index {index}")
                return None

            if not rect_data.get("visible"):
                logger.warning(
                    "Element has no visible viewport intersection after scroll",
                    extra={"index": index, "rect": rect_data},
                )
                return None

            viewport_width = rect_data.get("viewportWidth") or self.viewport_width
            viewport_height = rect_data.get("viewportHeight") or self.viewport_height
            x = max(0, min(int(viewport_width) - 1, int(round(rect_data["x"]))))
            y = max(0, min(int(viewport_height) - 1, int(round(rect_data["y"]))))
            right = max(0, min(int(viewport_width), int(round(rect_data["x"] + rect_data["width"]))))
            bottom = max(0, min(int(viewport_height), int(round(rect_data["y"] + rect_data["height"]))))

            return {
                "x": x,
                "y": y,
                "width": max(1, right - x),
                "height": max(1, bottom - y),
            }

        except Exception as e:
            logger.warning(f"Failed to get rect for index {index}: {e}")

        return None

    async def get_element_at_coordinates(self, x: int, y: int) -> Optional[Any]:
        """Convert viewport coordinates to element.

        Uses browser-use's get_dom_element_at_coordinates.

        Args:
            x: X coordinate in viewport
            y: Y coordinate in viewport

        Returns:
            EnhancedDOMTreeNode or None
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        try:
            # browser-use provides this method directly
            return await self._session.get_dom_element_at_coordinates(x, y)
        except Exception as e:
            logger.warning(f"Failed to get element at ({x}, {y}): {e}")
            return None

    async def get_text_at_coordinates(self, x: int, y: int) -> str:
        """Get combined text content from all elements at coordinates (z-stack).

        Uses document.elementsFromPoint() to get all elements in the z-stack,
        then extracts and combines their text content.

        Args:
            x: X coordinate in viewport
            y: Y coordinate in viewport

        Returns:
            Combined text content from all elements at that point
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        try:
            page = await self._session.get_current_page()

            # Use elementsFromPoint to get all elements in the z-stack
            result = await page.evaluate(
                """(coords) => {
                    const elements = document.elementsFromPoint(coords.x, coords.y);
                    const texts = [];
                    for (const el of elements) {
                        // Get innerText (visible text) and aria-label
                        const innerText = (el.innerText || '').trim();
                        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
                        const title = (el.getAttribute('title') || '').trim();
                        const value = (el.value || '').trim();

                        if (innerText) texts.push(innerText);
                        if (ariaLabel) texts.push(ariaLabel);
                        if (title) texts.push(title);
                        if (value) texts.push(value);
                    }
                    // Dedupe and join
                    return [...new Set(texts)].join(' ');
                }""",
                {"x": x, "y": y},
            )

            return result or ""
        except Exception as e:
            logger.warning(f"Failed to get text at ({x}, {y}): {e}")
            return ""

    @property
    def selector_map(self) -> Dict[int, Any]:
        """Get the cached selector map.

        Returns a mapping of backend_node_id to EnhancedDOMTreeNode.
        Updated on each get_browser_state() call.
        """
        return self._selector_map

    @property
    def session(self):
        """Get the underlying BrowserSession for advanced operations."""
        return self._session
