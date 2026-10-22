"""DOM Service - Wrapper for browser-use's BrowserSession.

This module provides:
- DOM extraction using browser-use's serialization
- Coordinate conversion between index and viewport coordinates
- Selector map caching for action execution
- Action history recording with dual index/coordinate representation
"""

import asyncio
import contextlib
import inspect
import json
import logging
import math
import random
import re
import time
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urljoin, urlparse

from browser_tools.secret_refs import mask_secret_values, register_logging_secret_refs

logger = logging.getLogger(__name__)

# Steel's Files API only sees CDP downloads written under /files.
# Kernel session file listing only scans /tmp/downloads (+ uploads / share).
STEEL_DOWNLOADS_PATH = "/files"
KERNEL_DOWNLOADS_PATH = "/tmp/downloads"


def normalize_action_coordinates(coordinates: Optional[Any]) -> Optional[Dict[str, Any]]:
    """Accept ``{"x","y"}`` or ``(x, y)`` from click/drag ``record_action`` callers.

    ``_execute_drag`` and ``_execute_click_coordinates`` pass a tuple; other
    callers pass a dict. Indexing a tuple with ``"x"`` raises TypeError and
    turns a successful CDP drag into a failed TOOL step.
    """
    if not coordinates:
        return None
    if isinstance(coordinates, Mapping):
        try:
            return {"x": coordinates["x"], "y": coordinates["y"]}
        except KeyError as exc:
            raise TypeError(
                f"coordinate mapping must include x and y, got {dict(coordinates)!r}"
            ) from exc
    if isinstance(coordinates, (tuple, list)) and len(coordinates) >= 2:
        return {"x": coordinates[0], "y": coordinates[1]}
    raise TypeError(
        f"coordinates must be {{'x', 'y'}} or (x, y), got {type(coordinates).__name__}"
    )


DOM_TREES_TIMEOUT_SECONDS = 10.0
DOM_TREES_GRACE_SECONDS = 2.0


async def _no_pending_network_requests(self: Any) -> list:
    return []


def disable_browser_use_pending_request_probe() -> None:
    """Drop browser-use's per-observe "pending network requests" evaluate.

    It reads ``performance.getEntriesByType('resource')`` and keeps entries with
    ``responseEnd === 0``, but resource-timing entries are only recorded once a
    resource finishes, so the list is practically always empty and its 0.3s
    stability sleep never fires. The probe still costs one Runtime.evaluate
    over every resource entry before each DOM build (Amazon: ~50ms p50, ~0.5s
    p90), and nothing here reads ``pending_network_requests``.
    """
    from browser_use.browser.watchdogs.dom_watchdog import DOMWatchdog

    DOMWatchdog._get_pending_network_requests = _no_pending_network_requests


async def _get_all_trees_without_serial_probes(self: Any, target_id: Any) -> Any:
    """browser-use ``DomService._get_all_trees`` minus its serial page evaluates.

    Upstream runs three Runtime.evaluate calls one after another before the
    parallel snapshot / DOM / AX requests: a ``document.readyState`` read whose
    result is discarded, an iframe scroll-position read that is only logged,
    and a ``getEventListeners`` walk over every element. Each waits on the
    renderer main thread (listener walk: up to ~2.8s p90 on retail pages).
    Clickability still comes from tags, ARIA/AX properties, cursor style, and
    attributes; the agent can also act by coordinates.
    """
    from browser_use.dom.enhanced_snapshot import REQUIRED_COMPUTED_STYLES
    from browser_use.dom.views import TargetAllTrees
    from browser_use.utils import create_task_with_error_handling

    cdp_session = await self.browser_session.get_or_create_cdp_session(target_id=target_id, focus=False)

    def snapshot_request() -> Any:
        return cdp_session.cdp_client.send.DOMSnapshot.captureSnapshot(
            params={
                "computedStyles": REQUIRED_COMPUTED_STYLES,
                "includePaintOrder": True,
                "includeDOMRects": True,
                "includeBlendedBackgroundColors": False,
                "includeTextColorOpacities": False,
            },
            session_id=cdp_session.session_id,
        )

    def dom_tree_request() -> Any:
        return cdp_session.cdp_client.send.DOM.getDocument(
            params={"depth": -1, "pierce": True}, session_id=cdp_session.session_id
        )

    factories = {
        "snapshot": snapshot_request,
        "dom_tree": dom_tree_request,
        "ax_tree": lambda: self._get_ax_tree_for_all_frames(target_id),
        "device_pixel_ratio": lambda: self._get_viewport_ratio(target_id),
    }
    started = time.time()
    tasks = {key: create_task_with_error_handling(factory(), name=f"get_{key}") for key, factory in factories.items()}
    # Upstream cancels and re-sends slow requests after 10s, but a cancelled CDP
    # request keeps running in the renderer, so the retry doubles the work on an
    # already-stalled main thread. Give the originals the extra 2s instead.
    _, pending = await asyncio.wait(tasks.values(), timeout=DOM_TREES_TIMEOUT_SECONDS)
    if pending:
        _, pending = await asyncio.wait(pending, timeout=DOM_TREES_GRACE_SECONDS)
        for task in pending:
            task.cancel()

    # The AX tree only enriches names/roles; a page structure without it is
    # still usable, so only the snapshot / DOM / viewport are required.
    results: Dict[str, Any] = {}
    failed: List[str] = []
    for key, task in tasks.items():
        if task.done() and not task.cancelled():
            try:
                results[key] = task.result()
                continue
            except Exception as exc:
                logger.warning("CDP request %s failed: %s", key, exc)
        else:
            logger.warning("CDP request %s timed out", key)
        if key == "ax_tree":
            results[key] = {"nodes": []}
        else:
            failed.append(key)
    if failed:
        raise TimeoutError(f"CDP requests failed or timed out: {', '.join(failed)}")

    snapshot = results["snapshot"]
    if snapshot and "documents" in snapshot and len(snapshot["documents"]) > self.max_iframes:
        logger.warning("Limiting DOM snapshot to the first %s of %s frames", self.max_iframes, len(snapshot["documents"]))
        snapshot["documents"] = snapshot["documents"][: self.max_iframes]

    return TargetAllTrees(
        snapshot=snapshot,
        dom_tree=results["dom_tree"],
        ax_tree=results["ax_tree"],
        device_pixel_ratio=results["device_pixel_ratio"],
        cdp_timing={
            "iframe_scroll_detection_ms": 0.0,
            "js_listener_detection_ms": 0.0,
            "cdp_parallel_calls_ms": (time.time() - started) * 1000,
            "snapshot_processing_ms": 0.0,
        },
        js_click_listener_backend_ids=None,
    )


def drop_browser_use_serial_dom_probes() -> None:
    from browser_use.dom.service import DomService

    DomService._get_all_trees = _get_all_trees_without_serial_probes


VIEWPORT_SCREENSHOT_TIMEOUT_SECONDS = 10.0


def browser_downloads_path_for_provider(provider: Optional[str] = None) -> str:
    """Return the CDP download directory for the active browser provider.

    ``Browser.setDownloadBehavior`` must write into a directory the provider's
    session-file listing actually exposes. Kernel and Browser Use use
    ``/tmp/downloads``; Steel uses ``/files``. Tilion has no file listing; its
    Chrome writes to ``/tmp/downloads`` and the worker reads files back over
    its own CDP socket.
    """
    import os

    resolved = (provider if provider is not None else os.getenv("BROWSER_PROVIDER", "kernel")).strip().lower()
    if resolved == "steel":
        return STEEL_DOWNLOADS_PATH
    if resolved in ("browser-use", "tilion"):
        return KERNEL_DOWNLOADS_PATH
    return KERNEL_DOWNLOADS_PATH


# Per-activity memory of rendered image URLs (receipt image provenance).
_MAX_REMEMBERED_IMAGE_URLS = 400
# document.images read per state observation: browser-use's snapshot tree
# prunes far-below-viewport <img>s that the page really rendered.
_DOCUMENT_IMAGES_TIMEOUT_SECONDS = 3.0
_MAX_DOCUMENT_IMAGES_PER_READ = 200
_DOCUMENT_IMAGES_JS = f"""(() => {{
  const out = [];
  for (const el of Array.from(document.images).slice(0, {_MAX_DOCUMENT_IMAGES_PER_READ})) {{
    const src = el.getAttribute('src');
    if (src) out.push(src);
    if (el.currentSrc) out.push(el.currentSrc);
    const srcset = el.getAttribute('srcset');
    if (srcset) for (const part of srcset.split(',')) {{
      const candidate = part.trim().split(/\\s+/)[0];
      if (candidate) out.push(candidate);
    }}
  }}
  return {{base: document.baseURI, urls: out}};
}})()"""

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
        return [str(key) for key in parsed]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if isinstance(item, str)]
    return []


def _resolve_http_image_url(raw_url: str, page_url: str) -> Optional[str]:
    raw_url = (raw_url or "").strip().strip("\"'")
    if not raw_url or raw_url.startswith("data:"):
        return None
    if raw_url.startswith("//"):
        raw_url = f"https:{raw_url}"
    url = urljoin(page_url, raw_url)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return url


def _normalize_image_url(raw_url: str, page_url: str) -> Optional[str]:
    url = _resolve_http_image_url(raw_url, page_url)
    if not url:
        return None
    lower_path = urlparse(url).path.lower()
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


def _media_bounds(original: Any) -> Optional[Dict[str, int]]:
    snapshot_node = getattr(original, "snapshot_node", None)
    rect = getattr(snapshot_node, "clientRects", None) or getattr(original, "absolute_position", None)
    if not rect:
        return None
    return {
        "x": round(getattr(rect, "x", 0) or 0),
        "y": round(getattr(rect, "y", 0) or 0),
        "width": round(getattr(rect, "width", 0) or 0),
        "height": round(getattr(rect, "height", 0) or 0),
    }


def _media_candidates_for_node(node: Any, page_url: str) -> List[Dict[str, Any]]:
    original = getattr(node, "original_node", node)
    tag = (getattr(original, "tag_name", "") or getattr(original, "node_name", "") or "").lower()
    attrs = getattr(original, "attributes", None) or {}
    if tag not in {"img", "source", "picture"} or not attrs:
        return []

    urls = _image_urls_from_attrs(attrs, page_url)
    if not urls:
        return []

    bounds = _media_bounds(original)
    alt = attrs.get("alt") or attrs.get("aria-label") or attrs.get("title")
    nearby_text = _candidate_text_from_node(original)
    visible = bool(getattr(original, "is_visible", True)) and bool(getattr(node, "should_display", True))
    candidates: List[Dict[str, Any]] = []
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
        candidates.append(candidate)
    return candidates


def _score_media_candidate(candidate: Dict[str, Any]) -> Tuple[int, int]:
    url = str(candidate.get("url") or "").lower()
    text = f"{candidate.get('alt') or ''} {candidate.get('nearby_text') or ''}".lower()
    bounds = candidate.get("bounds") if isinstance(candidate.get("bounds"), dict) else {}
    area = int(bounds.get("width") or 0) * int(bounds.get("height") or 0)
    value = 40 if candidate.get("visible") else 0
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
        for candidate in _media_candidates_for_node(node, page_url):
            candidates_by_url.setdefault(candidate["url"], candidate)

        for child in getattr(node, "children", []) or []:
            traverse(child)

    traverse(root)
    ranked = sorted(candidates_by_url.values(), key=_score_media_candidate, reverse=True)
    return ranked[:max_candidates]


def _extract_image_urls_from_dom_state(dom_state: Any, *, page_url: str) -> List[str]:
    """Every image URL the page renders, uncapped and unranked, including each srcset candidate."""
    root = getattr(dom_state, "_root", None)
    if not root:
        return []

    urls: Dict[str, None] = {}

    def traverse(node: Any) -> None:
        if not node:
            return
        original = getattr(node, "original_node", node)
        tag = (getattr(original, "tag_name", "") or getattr(original, "node_name", "") or "").lower()
        attrs = getattr(original, "attributes", None) or {}
        if tag in {"img", "source", "picture"}:
            for key in _IMAGE_ATTR_KEYS:
                value = attrs.get(key)
                if not value:
                    continue
                if key in {"srcset", "data-srcset"}:
                    raw_urls = [part.split()[0] for part in value.split(",") if part.split()]
                elif key == "data-a-dynamic-image":
                    raw_urls = _urls_from_dynamic_image_attr(value)
                else:
                    raw_urls = [value]
                for raw_url in raw_urls:
                    url = _resolve_http_image_url(raw_url, page_url)
                    if url:
                        urls.setdefault(url, None)
        for child in getattr(node, "children", []) or []:
            traverse(child)

    traverse(root)
    return list(urls)


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
        self._dom_service: Optional["DOMService"] = None

    def bind_dom_service(self, dom_service: "DOMService") -> None:
        """Keep one private redaction policy across browser reconnections."""
        if self._dom_service is not None and self._dom_service is not dom_service:
            dom_service.restore_secret_redaction_state(self._dom_service.secret_redaction_state())
        self._dom_service = dom_service

    def _model_visible_entry(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        if self._dom_service is None:
            return entry
        safe_entry = self._dom_service.model_visible_value(entry)
        for key in ("params", "result"):
            if key in entry:
                # Their outer keys are tool protocol. Nested evaluate result
                # keys still belong to the page and remain subject to masking.
                value = entry[key]
                if key == "result" and entry.get("action") == "read_browser_state" and isinstance(value, dict) and isinstance(value.get("formatted_state"), str):
                    safe_entry[key] = self._dom_service.model_visible_value({k: v for k, v in value.items() if k != "formatted_state"})
                    safe_entry[key]["formatted_state"] = self._dom_service.model_visible_value(value["formatted_state"])
                else:
                    safe_entry[key] = self._dom_service.model_visible_value(value)
        if not self._dom_service.secret_values_used and entry.get("screenshot"):
            safe_entry["screenshot"] = entry["screenshot"]
        # These are harness-owned mechanics, rather than page echoes. A CVV
        # equal to a step/index must not change the chosen target or make a
        # durable history entry invalid on restore.
        for key in ("step", "action", "index", "coordinates"):
            if key in entry:
                safe_entry[key] = entry[key]
        return safe_entry

    def secret_redaction_state(self) -> Dict[str, Any]:
        return self._dom_service.secret_redaction_state() if self._dom_service is not None else {}

    def model_visible_value(self, value: Any) -> Any:
        return self._dom_service.model_visible_value(value) if self._dom_service is not None else value

    async def record_action(
        self,
        dom_service: "DOMService",
        action: str,
        thinking: Optional[str] = None,
        index: Optional[int] = None,
        coordinates: Optional[Any] = None,
        params: Optional[Dict[str, Any]] = None,
        result: Optional[Dict[str, Any]] = None,
        screenshot: Optional[str] = None,
        element_description_override: Optional[str] = None,
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
            coordinates: {"x","y"} dict or (x, y) tuple/list viewport coordinates
            params: Additional action parameters
            result: Action result (defaults to {"success": True})
            screenshot: Base64 screenshot for vision providers

        Returns:
            The recorded ActionHistoryEntry
        """
        step = self._next_step
        # Bind before deriving descriptions: DOM labels can echo a value that
        # was just entered, even when params and the tool result are safe.
        if callable(inspect.getattr_static(dom_service, "model_visible_value", None)):
            self.bind_dom_service(dom_service)

        # Convert between index and coordinates
        coords_dict = None
        if coordinates:
            coords_dict = normalize_action_coordinates(coordinates)

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

        # Clicks can replace their target before the action is recorded. Keep
        # the pre-action target when the caller captured one.
        element_description = element_description_override
        if element_description is None and index is not None:
            element = dom_service.selector_map.get(index)
            if element:
                tag = getattr(element, "tag_name", None) or getattr(element, "node_name", "unknown")
                element_description = f"[{index}] {tag}"
                # Browser DOM nodes often keep a button's visible label in
                # children while text_content on the button itself is empty.
                # Preserve that label so later decisions can identify the
                # control that was actually clicked.
                try:
                    text = element.get_all_children_text() or ""
                except Exception:
                    text = ""
                text = str(text or getattr(element, "text_content", "") or "").strip()
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

        entry = ActionHistoryEntry(**self._model_visible_entry(asdict(entry)))
        self._entries.append(entry)
        self._next_step = step + 1
        logger.debug(f"Recorded action {step}: {action} (index={index}, coords={coords_dict})")

        return entry

    def last_action_step(self) -> Optional[int]:
        """Return the latest recorded receipt ID without copying DOM history."""
        return self._entries[-1].step if self._entries else None

    def attach_observed_result(self, step: int, result: Dict[str, Any]) -> None:
        """Keep the delivered page observation on its exact action receipt."""
        if not self._entries or self._entries[-1].step != step:
            raise ValueError("Observed result does not belong to the latest action")
        for key in ("url", "current_url", "title"):
            value = result.get(key)
            if isinstance(value, str) and value:
                self._entries[-1].result[key] = value

        # Retain only the normalized observation actually delivered by the
        # native state reader. A failed coherence check withdraws its snapshot.
        if self._entries[-1].action == "read_browser_state":
            state = result.get("formatted_state")
            if result.get("success", True) and isinstance(state, str) and state:
                self._entries[-1].result["formatted_state"] = self.model_visible_value(state)
            else:
                self._entries[-1].result.pop("formatted_state", None)

    def get_entries(self) -> List[Dict[str, Any]]:
        """Get all entries as dicts for Rose API request."""
        return [self._model_visible_entry(entry.to_dict()) for entry in self._entries]

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
            restored.append(ActionHistoryEntry(**self._model_visible_entry(values)))
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

    def __init__(
        self,
        cdp_url: str,
        viewport_width: int = 1280,
        viewport_height: int = 800,
        downloads_path: Optional[str] = None,
        cdp_multiplexer: Any = None,
    ):
        """Initialize DOM service.

        Args:
            cdp_url: WebSocket URL for CDP connection (from Steel/Kernel)
            viewport_width: Browser viewport width (WXGA default)
            viewport_height: Browser viewport height (WXGA default)
            downloads_path: CDP download directory. Defaults to the path for
                ``BROWSER_PROVIDER`` (Kernel/Browser Use ``/tmp/downloads``, Steel ``/files``).
            cdp_multiplexer: Loopback single-socket multiplexer for providers that
                admit one CDP client per session (Tilion). This service owns it and
                closes it on disconnect, releasing the provider's client slot.
        """
        self.cdp_url = cdp_url
        self.cdp_multiplexer = cdp_multiplexer
        self.viewport_width = viewport_width
        self.viewport_height = viewport_height
        self.downloads_path = downloads_path or browser_downloads_path_for_provider()
        self._session = None
        self._selector_map: Dict[int, Any] = {}
        self._runtime_current_url = ""
        # Image URLs rendered by any page this browser activity observed, oldest
        # first. A receipt image is often copied on the product/event page and
        # submitted from checkout, which does not render it. Bounded per activity.
        self._rendered_image_urls: Dict[str, None] = {}
        # Execution bindings may change realms. Retain every prior value only
        # for output redaction, scoped to this browser activity/session.
        self._secret_redaction_refs: Dict[str, str] = {}
        self.secret_values_used = False
        # Passkey (cloud-custody) state.
        #
        # Chrome scopes a CDP virtual authenticator (and WebAuthn.enable's
        # native-UI suppression) to the TARGET it was installed on. So this state
        # is keyed by target id, never cached as a single connect-time session:
        # the agent follows links into new tabs, and a connect-time handle keeps
        # reporting a healthy credential on the abandoned target while the live
        # one is served by Chrome's real platform authenticator.
        #
        # _passkey_seed_counts maps credentialId -> the seeded (block-reserved)
        # base, so we can detect at session end whether the relying party
        # actually exercised the passkey. It is cross-target on purpose: the
        # ceremony may happen on any target we armed.
        self._armed_targets: set = set()
        # CDP session_id we last issued WebAuthn.enable on, per target. Kernel
        # can replace the pooled session under the same target id; WebAuthn is
        # per-session, so a stale session_id means the environment is gone even
        # when our authenticator cache still looks healthy.
        self._passkey_armed_session_by_target: Dict[str, str] = {}
        self._passkey_authenticator_by_target: Dict[str, str] = {}
        self._passkey_seeded_by_target: Dict[str, set] = {}
        self._held_passkeys_by_credential_id: Dict[str, Dict[str, Any]] = {}
        self._passkey_seed_counts: Dict[str, int] = {}
        # Highest signCount seen per credential before an invalidate/rebuild.
        # Invalidate removes the Chrome authenticator; without this map the
        # re-seed restores the original base and usage detection misses the
        # assertion that advanced the counter on the dying authenticator.
        self._passkey_observed_max_counts: Dict[str, int] = {}
        # Monotonic timestamp of the last successful seed/readback per target.
        # Used to grace mid-ceremony getCredentials flaps without rebuilding
        # (rebuild = WebAuthn.enable gap → Amazon "No passkeys available").
        self._passkey_seeded_at_by_target: Dict[str, float] = {}
        # Cooldown so auth-page reload after environment-loss rebuild cannot loop.
        self._passkey_auth_reload_at_by_target: Dict[str, float] = {}
        # href last reloaded after VA rebuild, per target — at most once per
        # navigation (same href must not wipe typed credentials every step).
        self._passkey_auth_reload_url_by_target: Dict[str, str] = {}
        # Targets that must reload an auth document after the next successful
        # VA rebuild (environment loss / CDP session swap).
        self._passkey_pending_auth_reload_targets: set = set()
        self._captcha_indicator_task: Optional[asyncio.Task] = None

    def register_secret_refs(self, refs: Optional[Dict[str, str]]) -> None:
        """Retain private bindings without reusing a previous realm for input."""
        current = {
            str(ref): value for ref, value in (refs or {}).items()
            if isinstance(value, str) and value
        }
        for ref, value in current.items():
            prior = self._secret_redaction_refs.get(ref)
            if prior is not None and prior != value:
                key = ref + ":previous"
                while key in self._secret_redaction_refs and self._secret_redaction_refs[key] != prior:
                    key += ":previous"
                self._secret_redaction_refs[key] = prior
        # Current aliases come first so readbacks advertise a reference that
        # execution can still resolve; historical aliases are redaction only.
        self._secret_redaction_refs = {
            **current,
            **{ref: value for ref, value in self._secret_redaction_refs.items() if ref not in current},
        }
        register_logging_secret_refs(self._secret_redaction_refs)

    def mark_secret_used(self) -> None:
        """Stop raster/media observations before a private value reaches a page."""
        self.secret_values_used = True

    def secret_redaction_state(self) -> Dict[str, Any]:
        """Private durable state; callers must encrypt it before persistence."""
        return {
            "secret_redaction_refs": dict(self._secret_redaction_refs),
            "secret_values_used": self.secret_values_used,
        }

    def restore_secret_redaction_state(self, state: Any) -> None:
        if not isinstance(state, dict):
            return
        refs = state.get("secret_redaction_refs")
        if isinstance(refs, dict):
            self.register_secret_refs(refs)
        if state.get("secret_values_used"):
            self.mark_secret_used()

    def model_visible_value(self, value: Any) -> Any:
        """Redact registered values and omit media after private entry.

        Raster pixels, canvas output and arbitrary remote images cannot be
        validated with string redaction. Once a secret has been entered, use
        redacted DOM observations for this session, including durable resumes.
        """
        def omit_media(item: Any) -> Any:
            if isinstance(item, dict):
                if isinstance(item.get("type"), str) and item["type"] in {"image_url", "image", "input_image"}:
                    return {"type": "text", "text": "[image withheld after private credential entry]"}
                return {
                    key: omit_media(nested)
                    for key, nested in item.items()
                    if key not in {
                        "screenshot", "screenshot_b64", "media_candidates", "frame", "website_frame",
                        "image_url", "media",
                    }
                }
            if isinstance(item, list):
                return [omit_media(nested) for nested in item]
            if isinstance(item, tuple):
                return tuple(omit_media(nested) for nested in item)
            if isinstance(item, str) and item.lstrip().startswith("data:image/"):
                return "[image withheld after private credential entry]"
            return item

        safe_value = omit_media(value) if self.secret_values_used else value
        return mask_secret_values(safe_value, self._secret_redaction_refs)

    def model_visible_action_result(self, action_name: str, result: Any) -> Any:
        """Redact page payloads while preserving trusted action bookkeeping."""
        safe = self.model_visible_value(result)
        if not isinstance(result, dict) or not isinstance(safe, dict):
            return safe
        if "credential_ref" in result:
            safe["credential_ref"] = result["credential_ref"]
        if action_name == "request_payment_card":
            # Typed operational receipt text must survive every action projection,
            # before the activity's final return. Raster/media policy stays generic.
            payment = result.get("payment_request")
            visible_payment = safe.get("payment_request")
            if isinstance(payment, dict) and isinstance(visible_payment, dict):
                items_key = "line_items" if "line_items" in payment else "lineItems"
                original_items = payment.get(items_key)
                visible_items = visible_payment.get(items_key)
                if isinstance(original_items, list) and isinstance(visible_items, list):
                    for original, visible in zip(original_items, visible_items):
                        if not isinstance(original, dict) or not isinstance(visible, dict):
                            continue
                        url = original.get("image_url")
                        if isinstance(url, str) and url.startswith(("https://", "http://")):
                            visible["image_url"] = self.model_visible_value(url)
        if action_name in {"screenshot", "read_browser_state"} and not self.secret_values_used:
            # Only these action outputs contain trusted raster transport.
            # A coincidental CVV in PNG base64 is not a page-text readback.
            for key in ("screenshot", "screenshot_b64"):
                if isinstance(result.get(key), str):
                    safe[key] = result[key]
        if action_name != "read_browser_state":
            return safe
        for key in ("viewport", "scroll_position", "page_stats"):
            if key in result:
                safe[key] = result[key]
        if isinstance(result.get("tabs"), list):
            safe["tabs"] = []
            for tab in result["tabs"]:
                visible_tab = self.model_visible_value(tab)
                if isinstance(tab, dict) and "id" in tab:
                    visible_tab["id"] = tab["id"]
                safe["tabs"].append(visible_tab)
        if "formatted_state" in result and "dom_tree" in safe:
            from providers.rose.browser_use import format_browser_state_for_tool

            # Rebuild from redacted page strings plus exact harness geometry;
            # never reuse an unredacted preformatted page string.
            safe["formatted_state"] = format_browser_state_for_tool(safe)
        return safe

    async def connect(self) -> None:
        """Connect to the browser via CDP.

        This must be called before any other methods.
        """
        try:
            from browser_use.browser.profile import BrowserProfile
            from browser_use.browser.session import BrowserSession

            disable_browser_use_pending_request_probe()
            drop_browser_use_serial_dom_probes()

            # Create profile with CDP URL for remote browser.
            # downloads_path must match the provider's session-file root:
            # Steel Files API → /files; Kernel fs.listFiles → /tmp/downloads.
            profile = BrowserProfile(
                cdp_url=self.cdp_url,
                is_local=False,  # Remote browser (Steel/Kernel)
                # The provider owns the existing window and viewport. Host display
                # detection must not resize every attached tab during reconnect.
                headless=False,
                no_viewport=True,
                downloads_path=self.downloads_path,
            )

            # Must pass cdp_url directly to prevent BrowserSession from overriding is_local=True
            self._session = BrowserSession(browser_profile=profile, cdp_url=self.cdp_url)
            await self._session.start()
            logger.info(
                f"🌐 Connected to browser via CDP: {self.cdp_url[:50]}... "
                f"(downloads_path={self.downloads_path})"
            )

            # Note: Download behavior is configured automatically by browser-use DownloadsWatchdog
            # using the downloads_path setting in BrowserProfile

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
                self._inject_captcha_solve_indicator(),
                self.ensure_browser_overlays_suppressed(),
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

    async def _inject_captcha_solve_indicator(self) -> None:
        """Show a live-view banner while Kernel/Steel auto-solve a CAPTCHA.

        Providers solve transparently with no UI. Validation-connection init
        scripts from the backend do not reliably survive until this agent CDP
        attach, so re-register here (same pattern as anti-detection spoofs).
        """
        try:
            from browser_tools.captcha_solve_indicator import CAPTCHA_SOLVE_INDICATOR_SCRIPT

            target_id = self._session.agent_focus_target_id
            if not target_id:
                return
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": CAPTCHA_SOLVE_INDICATOR_SCRIPT, "runImmediately": True},
                session_id=cdp_session.session_id,
            )
            logger.info("🧩 Injected CAPTCHA auto-solve live-view indicator")
        except Exception as e:
            logger.warning(f"⚠️ Failed to inject CAPTCHA auto-solve indicator: {e}")

    async def set_captcha_indicator_phase(self, phase: str) -> None:
        """Push provider CAPTCHA phase (idle|solving|succeeded|failed) into the live-view chip."""
        try:
            from browser_tools.captcha_solve_indicator import (
                captcha_solve_indicator_set_phase_script,
            )

            target_id = self._session.agent_focus_target_id if self._session else None
            if not target_id:
                return
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            await cdp_session.cdp_client.send.Runtime.evaluate(
                params={
                    "expression": captcha_solve_indicator_set_phase_script(phase),
                    "returnByValue": True,
                },
                session_id=cdp_session.session_id,
            )
        except Exception as e:
            logger.debug(f"CAPTCHA indicator telemetry push failed: {e}")

    async def set_captcha_auto_solve_active(self, solving: bool) -> None:
        """Back-compat: map boolean solving onto chip phase."""
        await self.set_captcha_indicator_phase("solving" if solving else "idle")

    async def probe_captcha_widgets_present(self) -> bool:
        """Kernel has no in-flight solver flag — probe challenge widgets via CDP."""
        try:
            from browser_tools.captcha_solve_indicator import CAPTCHA_WIDGET_PRESENT_SCRIPT

            target_id = self._session.agent_focus_target_id if self._session else None
            if not target_id:
                return False
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": CAPTCHA_WIDGET_PRESENT_SCRIPT, "returnByValue": True},
                session_id=cdp_session.session_id,
            )
            value = (result or {}).get("result", {}).get("value")
            return value is True
        except Exception:
            return False

    def start_captcha_telemetry_indicator(
        self,
        poll_phase,
    ) -> None:
        """Poll provider CAPTCHA telemetry and mirror phase into the live-view chip."""
        if self._captcha_indicator_task is not None and not self._captcha_indicator_task.done():
            return

        async def _loop() -> None:
            while self._session is not None:
                try:
                    phase = str(await poll_phase() or "idle")
                    await self.set_captcha_indicator_phase(phase)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.debug(f"CAPTCHA telemetry indicator poll failed: {e}")
                await asyncio.sleep(1.0)

        self._captcha_indicator_task = asyncio.create_task(_loop())

    @property
    def single_cdp_client(self) -> bool:
        """True when the provider admits only this worker's CDP socket (Tilion).

        Such providers fail REST drive calls (screenshot, key press, file fetch)
        while the worker is attached, so those must go over this connection.
        """
        return self.cdp_multiplexer is not None

    async def capture_viewport_png(self) -> str:
        """Base64 PNG of the focused tab's viewport over this service's CDP socket."""
        target_id = self._session.agent_focus_target_id
        if not target_id:
            raise RuntimeError("No focused browser tab to screenshot")
        cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(
                cdp_session.cdp_client.send_raw(
                    "Page.captureScreenshot",
                    {"format": "png", "fromSurface": True},
                    session_id=cdp_session.session_id,
                ),
                timeout=VIEWPORT_SCREENSHOT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            elapsed_ms = round((time.monotonic() - started) * 1000)
            logger.warning(
                f"📸 Browser CDP call timed out: Page.captureScreenshot after {elapsed_ms} ms "
                f"(limit {VIEWPORT_SCREENSHOT_TIMEOUT_SECONDS:g}s)"
            )
            raise TimeoutError(
                f"Page.captureScreenshot timed out after {VIEWPORT_SCREENSHOT_TIMEOUT_SECONDS:g}s"
            ) from None
        data = result.get("data")
        if not data:
            raise RuntimeError("Page.captureScreenshot returned no image")
        return data

    async def disconnect(self) -> None:
        """Disconnect from the browser.

        Note: For remote browsers (Steel), this just releases our connection.
        The actual browser session may still be alive on the server.
        """
        try:
            await self._disconnect_session()
        finally:
            multiplexer, self.cdp_multiplexer = self.cdp_multiplexer, None
            if multiplexer is not None:
                with contextlib.suppress(Exception):
                    await multiplexer.close()

    async def _disconnect_session(self) -> None:
        if self._session:
            session = self._session
            task = self._captcha_indicator_task
            self._captcha_indicator_task = None
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
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
                self._armed_targets.clear()
                self._passkey_authenticator_by_target.clear()
                self._passkey_seeded_by_target.clear()
                self._held_passkeys_by_credential_id.clear()
                self._passkey_seed_counts.clear()
                self._passkey_observed_max_counts.clear()
                self._passkey_seeded_at_by_target.clear()
                self._passkey_armed_session_by_target.clear()
                self._passkey_auth_reload_at_by_target.clear()
                self._passkey_auth_reload_url_by_target.clear()
                self._passkey_pending_auth_reload_targets.clear()
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

    async def _live_cdp_session(self) -> Tuple[Optional[str], Any]:
        """Resolve the agent's CURRENT focus target and a CDP session for it.

        Every other CDP consumer in this class re-resolves agent_focus_target_id
        per call; browser-process state must do the same or it strands itself on
        whichever target happened to be focused at connect time.
        """
        session = self._session
        if session is None:
            return None, None
        target_id = getattr(session, "agent_focus_target_id", None)
        if not target_id:
            return None, None
        return target_id, await session.get_or_create_cdp_session(target_id, focus=False)

    async def ensure_browser_overlays_suppressed(self) -> None:
        """Arm native-overlay suppression and passkey state on the LIVE target.

        CDP's Page.captureScreenshot only captures the page content layer. Browser-level UI
        like passkey popups, permission prompts, and download bars are rendered by Chrome's
        browser process and are invisible to CDP screenshots. Worse, while such a modal holds
        focus the renderer receives no input at all — CDP key AND mouse events are swallowed
        while still reporting success — so the agent can neither see it nor clear it.

        So suppress at the source, and keep it armed. A navigation/provider
        reconnect can invalidate the target's virtual-authenticator id; the sync
        below health-checks that id without disturbing a healthy environment,
        and only re-enables/rebuilds after Chrome reports it missing.

        Suppression is armed even when we hold no passkey for the site. The native
        chooser is a dead end in a cloud browser either way — it can only offer a
        local authenticator (ours, which would not prompt) or a cross-device QR
        nobody can scan. With enableUI=false the ceremony rejects immediately with
        NotAllowedError and the site falls back to password, instead of wedging the
        agent behind a modal it cannot reach.
        """
        try:
            target_id, cdp_session = await self._live_cdp_session()
            if not target_id or cdp_session is None:
                logger.warning("⚠️ [overlay-suppress] No focused target; cannot suppress overlays")
                return

            await self._arm_target(target_id, cdp_session)
        except Exception as e:
            logger.warning(f"⚠️ [overlay-suppress] Failed to suppress browser overlays: {e}")

    async def _arm_target(self, target_id: str, cdp_session: Any) -> int:
        """Install browser-process overlay suppression + passkeys on one target.

        The single place any of this is armed. Returns credentials newly seeded.
        """
        session_id = getattr(cdp_session, "session_id", None)
        armed_session_id = self._passkey_armed_session_by_target.get(target_id)
        # Kernel can hand us a fresh CDP session for the same target id while our
        # cache still thinks WebAuthn is armed. WebAuthn.enable is per-session
        # ("environment has not been enabled for this session" — agent
        # c1ebd389), so a session_id change must re-issue enable.
        #
        # It must NOT throw the authenticator away. The authenticator belongs to
        # the target, not the session, and a new session arrives with every
        # action: forgetting it here removed and rebuilt a healthy authenticator
        # on the very click that started a passkey ceremony, and the site got no
        # assertion. The sync below health-checks the kept id through the new
        # session and rebuilds only if Chrome no longer knows it.
        session_changed = (
            session_id is not None
            and armed_session_id is not None
            and session_id != armed_session_id
        )
        newly_armed = target_id not in self._armed_targets or session_changed
        if session_changed:
            logger.warning(
                "⚠️ [passkey] CDP session changed under live target; "
                f"re-arming WebAuthn target={target_id[:12]} "
                f"was={str(armed_session_id)[:12]} now={str(session_id)[:12]}"
            )
            self._armed_targets.discard(target_id)

        # 1. WebAuthn: suppress the native passkey/credential popup on a new
        # target. Do NOT reissue WebAuthn.enable on an already-healthy target:
        # live Chrome invalidates the old virtual-authenticator id when its
        # environment is re-enabled, which used to force a rebuild before every
        # action and opened a race with conditional WebAuthn. Existing targets
        # are health-checked below and re-enabled only after a concrete reset.
        if newly_armed:
            await self._send_cdp_command(cdp_session, "WebAuthn.enable", {"enableUI": False})
            self._armed_targets.add(target_id)
            if session_id is not None:
                self._passkey_armed_session_by_target[target_id] = session_id
            logger.info(
                "🛡️ [overlay-suppress] WebAuthn native UI disabled "
                f"(passkey popups suppressed) target={target_id[:12]}"
            )

        # 2. File chooser: interception persists for the life of this target, so
        # install it once. WebAuthn.enable is intentionally re-issued above at
        # every ceremony boundary because that environment can reset in-place.
        if newly_armed:
            try:
                await self._send_cdp_command(
                    cdp_session, "Page.setInterceptFileChooserDialog", {"enabled": True}
                )
                logger.info(
                    "🛡️ [overlay-suppress] File chooser dialog interception enabled "
                    f"target={target_id[:12]}"
                )
            except Exception as e:
                logger.warning(f"⚠️ [overlay-suppress] Failed to intercept file chooser: {e}")

        # 3. Restore every passkey we hold onto this target's authenticator.
        return await self._sync_passkeys_onto_live_target(target_id, cdp_session)

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

    async def invalidate_passkey_state_for_live_target(self) -> None:
        """Force the next sync to rebuild the live authenticator (post-nav/rotation).

        Kernel/Chrome can leave ``WebAuthn.getCredentials`` succeeding briefly
        after a navigation while the virtual-authenticator environment is already
        dying. Agents f380ca3c / c3b1ca09 (browser-amazon-return 2026-09-28):
        ``after start navigation`` logged ``seeded 0`` (health check trusted the
        stale id), then ~5–6s later reported ``environment has not been enabled``
        — so Amazon's sign-in page probed an empty authenticator and disabled the
        passkey CTA.

        Forgetting our cache alone is not enough: Chrome still holds the old
        internal authenticator, and ``addVirtualAuthenticator`` then fails with
        ``Chrome only supports one internal authenticator per environment``
        (agent f203ae7b). Remove the Chrome-side authenticator first; if remove
        fails, ``WebAuthn.disable`` wipes the environment so the next sync can
        re-enable + create cleanly.
        """
        session = self._session
        target_id = getattr(session, "agent_focus_target_id", None) if session is not None else None
        if not target_id:
            return
        authenticator_id = self._passkey_authenticator_by_target.get(target_id)
        had_state = (
            authenticator_id is not None
            or target_id in self._passkey_seeded_by_target
            or target_id in self._armed_targets
        )
        removed = False
        if session is not None:
            try:
                cdp_session = await session.get_or_create_cdp_session(target_id, focus=False)
            except Exception as e:
                logger.warning(
                    f"⚠️ [passkey] could not open CDP session during invalidate: {e}"
                )
                cdp_session = None
            if cdp_session is not None and authenticator_id:
                # Snapshot signCounts before remove so a mid-nav assertion is not
                # lost when re-seed restores the original block-reserved base.
                pre_remove_counts = await self._read_signcounts_for_target(
                    target_id, cdp_session
                )
                if pre_remove_counts:
                    for cid, value in pre_remove_counts.items():
                        prev = self._passkey_observed_max_counts.get(cid, -1)
                        if value > prev:
                            self._passkey_observed_max_counts[cid] = value
                try:
                    await self._send_cdp_command(
                        cdp_session,
                        "WebAuthn.removeVirtualAuthenticator",
                        {"authenticatorId": authenticator_id},
                    )
                    removed = True
                except Exception as e:
                    logger.warning(
                        "⚠️ [passkey] removeVirtualAuthenticator failed during "
                        f"invalidate; disabling WebAuthn environment: {e}"
                    )
                    try:
                        await self._send_cdp_command(cdp_session, "WebAuthn.disable", {})
                    except Exception as e2:
                        logger.warning(
                            f"⚠️ [passkey] WebAuthn.disable failed during invalidate: {e2}"
                        )
            elif cdp_session is not None and target_id in self._armed_targets:
                # No cached authenticator id but environment was armed — wipe so
                # a leftover Chrome-side authenticator cannot block recreate.
                try:
                    await self._send_cdp_command(cdp_session, "WebAuthn.disable", {})
                except Exception as e:
                    logger.warning(
                        f"⚠️ [passkey] WebAuthn.disable failed during invalidate: {e}"
                    )

        self._passkey_authenticator_by_target.pop(target_id, None)
        self._passkey_seeded_by_target.pop(target_id, None)
        self._passkey_seeded_at_by_target.pop(target_id, None)
        self._passkey_armed_session_by_target.pop(target_id, None)
        # Always drop armed so `_arm_target` re-issues WebAuthn.enable. Keeping
        # armed after a successful remove (prior 0ec3092c2 path) skipped enable
        # on the next sync; Kernel then dropped the half-armed environment
        # ~5s later (agent c1ebd389: environment-not-enabled median 5.6s).
        self._armed_targets.discard(target_id)
        if had_state:
            logger.info(
                "🔑 [passkey] invalidated cached authenticator state for live target "
                f"(force rebuild on next sync; removed={removed}) target={target_id[:12]}"
            )

    async def inject_passkeys(self, passkeys: List[Dict[str, Any]]) -> int:
        """Record cloud-custody passkeys and seed them onto the live target.

        Each passkey dict must carry a DECRYPTED PKCS#8 private key (base64),
        credentialId (base64), rpId, userHandle (base64 or None) and signCount
        (the block-reserved base). Once seeded, when a site calls
        navigator.credentials.get() the virtual authenticator signs
        automatically — no agent click required for auto-invoked flows, and the
        agent can also click "Sign in with a passkey" for gated flows.
        An empty list is NOT a no-op: it still arms native-UI suppression on the
        live target, which is what keeps a site whose passkey we do not hold from
        raising an unreachable native chooser over the agent.
        """
        validated_passkeys: List[tuple[str, Dict[str, Any]]] = []
        for pk in passkeys:
            credential_id = pk.get("credentialId")
            private_key = pk.get("privateKey")
            rp_id = pk.get("rpId")
            if not credential_id or not private_key or not rp_id:
                raise RuntimeError(f"Incomplete passkey payload for relying party {rp_id or 'unknown'}")
            validated_passkeys.append((credential_id, pk))
        for credential_id, pk in validated_passkeys:
            self._held_passkeys_by_credential_id[credential_id] = pk

        target_id, cdp_session = await self._live_cdp_session()
        if not target_id or cdp_session is None:
            # Match ensure_browser_overlays_suppressed: focus can be briefly
            # missing after navigation/CDP reconnect. Held keys stay in
            # `_held_passkeys_by_credential_id` and re-arm when focus returns.
            # Hard-raising here killed prod browser a890a362 mid-goto via
            # record_passkey_usage_once → sync_passkeys_onto_target.
            logger.warning(
                "⚠️ [passkey] No focused target; retaining held passkeys for re-arm "
                f"(held={len(self._held_passkeys_by_credential_id)})"
            )
            return 0
        return await self._arm_target(target_id, cdp_session)

    async def _sync_passkeys_onto_live_target(self, target_id: str, cdp_session: Any) -> int:
        """Make `target_id`'s virtual authenticator hold every passkey we hold.

        Chrome scopes virtual authenticators per target, so each target the agent
        lands on needs its own authenticator seeded with the full held set.
        Returns the number of credentials newly added to THIS target.
        """
        authenticator_id = self._passkey_authenticator_by_target.get(target_id)
        seeded_ids = self._passkey_seeded_by_target.setdefault(target_id, set())

        if authenticator_id is not None:
            try:
                result = await self._send_cdp_command(
                    cdp_session,
                    "WebAuthn.getCredentials",
                    {"authenticatorId": authenticator_id},
                )
                observed_ids = {
                    credential.get("credentialId")
                    for credential in result.get("credentials", []) or []
                    if credential.get("credentialId")
                }
                if not seeded_ids.issubset(observed_ids):
                    logger.warning(
                        "⚠️ [passkey] virtual authenticator lost seeded credentials; rebuilding it"
                    )
                    authenticator_id = None
                    seeded_ids.clear()
                    self._armed_targets.discard(target_id)
                    self._passkey_armed_session_by_target.pop(target_id, None)
                    self._passkey_pending_auth_reload_targets.add(target_id)
                else:
                    self._passkey_seeded_at_by_target[target_id] = time.monotonic()
            except Exception as e:
                error = str(e).lower()
                environment_was_reset = (
                    "virtual authenticator environment has not been enabled" in error
                    or "could not find a virtual authenticator matching the id" in error
                )
                if not environment_was_reset:
                    raise RuntimeError("Failed to verify the browser passkey authenticator") from e
                # "environment has not been enabled for this session" is a HARD
                # reset on Kernel (agent c1ebd389: dies ~5.6s after every seed and
                # never recovers on retry). Ceremony-grace retries only delay the
                # rebuild while Amazon's sign-in page probes an empty authenticator
                # and disables the passkey CTA. Keep grace solely for the
                # authenticator-id flap that can happen mid-assertion.
                missing_environment = (
                    "virtual authenticator environment has not been enabled" in error
                )
                if missing_environment:
                    logger.warning(
                        "⚠️ [passkey] WebAuthn environment/authenticator was reset; rebuilding it"
                    )
                    authenticator_id = None
                    seeded_ids.clear()
                    self._armed_targets.discard(target_id)
                    self._passkey_armed_session_by_target.pop(target_id, None)
                    self._passkey_pending_auth_reload_targets.add(target_id)
                else:
                    # Mid-ceremony authenticator-id flap: retry before rebuild so
                    # we do not kill an in-flight assertion (agent f380ca3c).
                    seeded_at = self._passkey_seeded_at_by_target.get(target_id)
                    in_ceremony_grace = (
                        seeded_at is not None and (time.monotonic() - seeded_at) < 5.0
                    )
                    retry_attempts = 5 if in_ceremony_grace else 1
                    recovered = False
                    for attempt in range(retry_attempts):
                        await asyncio.sleep(0.2 if in_ceremony_grace else 0.15)
                        try:
                            result = await self._send_cdp_command(
                                cdp_session,
                                "WebAuthn.getCredentials",
                                {"authenticatorId": authenticator_id},
                            )
                            observed_ids = {
                                credential.get("credentialId")
                                for credential in result.get("credentials", []) or []
                                if credential.get("credentialId")
                            }
                            if seeded_ids.issubset(observed_ids):
                                logger.info(
                                    "🔑 [passkey] authenticator recovered after transient "
                                    f"getCredentials failure (attempt {attempt + 1}/"
                                    f"{retry_attempts}); skipping rebuild"
                                )
                                self._passkey_seeded_at_by_target[target_id] = time.monotonic()
                                recovered = True
                                break
                            logger.warning(
                                "⚠️ [passkey] virtual authenticator lost seeded credentials after retry; "
                                "rebuilding it"
                            )
                            authenticator_id = None
                            seeded_ids.clear()
                            self._armed_targets.discard(target_id)
                            self._passkey_armed_session_by_target.pop(target_id, None)
                            self._passkey_pending_auth_reload_targets.add(target_id)
                            break
                        except Exception:
                            continue
                    if not recovered and authenticator_id is not None:
                        logger.warning(
                            "⚠️ [passkey] WebAuthn environment/authenticator was reset; rebuilding it"
                        )
                        authenticator_id = None
                        seeded_ids.clear()
                        # Authenticator-id errors after a full environment wipe
                        # (Chrome deletes authenticators when WebAuthn is
                        # disabled) still leave `_armed_targets` set — discard
                        # so the create path re-issues WebAuthn.enable.
                        self._armed_targets.discard(target_id)
                        self._passkey_armed_session_by_target.pop(target_id, None)
                        self._passkey_pending_auth_reload_targets.add(target_id)

        rebuilt_environment = False
        if authenticator_id is None:
            try:
                # Re-enable only when this target is not already armed. `_arm_target`
                # enables on first arm / session change; a mid-sync environment
                # reset discards `_armed_targets` above so we re-enable here.
                # Always-enable used to double-fire after `_arm_target` and also
                # skip enable entirely after invalidate-with-remove left armed set
                # (agent c1ebd389).
                if target_id not in self._armed_targets:
                    await self._send_cdp_command(
                        cdp_session,
                        "WebAuthn.enable",
                        {"enableUI": False},
                    )
                    rebuilt_environment = True
                    self._armed_targets.add(target_id)
                    session_id = getattr(cdp_session, "session_id", None)
                    if session_id is not None:
                        self._passkey_armed_session_by_target[target_id] = session_id
                result = await self._send_cdp_command(
                    cdp_session,
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
                authenticator_id = result.get("authenticatorId")
            except Exception as e:
                # Stale Chrome-side authenticator left after a cache-only
                # invalidate (or a failed remove) blocks recreate. Remove any
                # leftover we still know about / wipe the environment, then retry
                # once — agent f203ae7b hit this exact CDP error after nav.
                error = str(e).lower()
                one_internal = "only supports one internal authenticator" in error
                if not one_internal:
                    raise RuntimeError("Failed to create the browser passkey authenticator") from e
                logger.warning(
                    "⚠️ [passkey] addVirtualAuthenticator blocked by existing internal "
                    "authenticator; removing stale authenticator and retrying"
                )
                stale_id = self._passkey_authenticator_by_target.get(target_id)
                try:
                    if stale_id:
                        await self._send_cdp_command(
                            cdp_session,
                            "WebAuthn.removeVirtualAuthenticator",
                            {"authenticatorId": stale_id},
                        )
                    else:
                        await self._send_cdp_command(cdp_session, "WebAuthn.disable", {})
                        await self._send_cdp_command(
                            cdp_session,
                            "WebAuthn.enable",
                            {"enableUI": False},
                        )
                        self._armed_targets.add(target_id)
                        session_id = getattr(cdp_session, "session_id", None)
                        if session_id is not None:
                            self._passkey_armed_session_by_target[target_id] = session_id
                    result = await self._send_cdp_command(
                        cdp_session,
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
                    authenticator_id = result.get("authenticatorId")
                    rebuilt_environment = True
                except Exception as retry_error:
                    raise RuntimeError(
                        "Failed to create the browser passkey authenticator"
                    ) from retry_error
            if not authenticator_id:
                raise RuntimeError("Browser passkey authenticator did not return an id")
        self._passkey_authenticator_by_target[target_id] = authenticator_id

        seeded = 0
        for credential_id, pk in self._held_passkeys_by_credential_id.items():
            if credential_id in seeded_ids:
                continue
            sign_count = int(pk.get("signCount") or 0)
            observed = self._passkey_observed_max_counts.get(credential_id)
            if observed is not None:
                sign_count = max(sign_count, observed)
            credential: Dict[str, Any] = {
                "credentialId": credential_id,
                "privateKey": pk.get("privateKey"),
                "rpId": pk.get("rpId"),
                "signCount": sign_count,
                "isResidentCredential": True,
            }
            user_handle = pk.get("userHandle")
            if user_handle:
                credential["userHandle"] = user_handle
            try:
                await self._send_cdp_command(
                    cdp_session,
                    "WebAuthn.addCredential",
                    {"authenticatorId": authenticator_id, "credential": credential},
                )
                seeded_ids.add(credential_id)
                self._passkey_seed_counts.setdefault(credential_id, sign_count)
                seeded += 1
            except Exception as e:
                raise RuntimeError(f"Failed to inject passkey for {pk.get('rpId')}") from e

        logger.info(
            f"🔑 [passkey] seeded {seeded} passkey credential(s) on virtual authenticator "
            f"for target={target_id[:12]}"
        )
        if seeded:
            counts = await self._read_signcounts_for_target(target_id, cdp_session)
            if counts is None:
                logger.warning(
                    "⚠️ [passkey] readback unavailable; keeping seeded authenticator "
                    f"target={target_id[:12]}"
                )
            else:
                observed_ids = set(counts)
                missing = seeded_ids - observed_ids
                logger.info(
                    "🔑 [passkey] virtual authenticator readback: "
                    f"expected_count={len(seeded_ids)} observed_count={len(observed_ids)} "
                    f"missing_count={len(missing)} target={target_id[:12]}"
                )
                if missing:
                    raise RuntimeError(
                        f"Browser passkey readback is missing {len(missing)} injected credential(s)"
                    )
            self._passkey_seeded_at_by_target[target_id] = time.monotonic()
        # Amazon (and similar) probe Conditional UI / platform-authenticator
        # availability once on document load. If Kernel dropped the VA before
        # that probe, the passkey CTA stays disabled even after we rebuild.
        # Reload the auth document once while the VA is fresh so the page
        # re-probes (agent c1ebd389: disabled "Sign in with a passkey" burned
        # the write_lock budget on password → WAF CAPTCHA).
        if (
            target_id in self._passkey_pending_auth_reload_targets
            and self._held_passkeys_by_credential_id
            and (rebuilt_environment or seeded)
        ):
            await self._reload_auth_page_after_passkey_rebuild(target_id, cdp_session)
            self._passkey_pending_auth_reload_targets.discard(target_id)
        return seeded

    async def _reload_auth_page_after_passkey_rebuild(
        self, target_id: str, cdp_session: Any
    ) -> None:
        """Reload sign-in documents after VA environment rebuild (cooldown-gated).

        At most once per target href (so a long LLM step past the 8s cooldown
        cannot wipe typed credentials). Host must match a held passkey rpId so
        an Amazon credential cannot reload an unrelated merchant login page.

        Never repeats a form submission. A page that a form submit produced is
        left alone, and the load itself is a plain GET of the same URL rather
        than Page.reload, which re-sends a POST body: on a failed sign-in that
        submitted every saved password twice.
        """
        last = self._passkey_auth_reload_at_by_target.get(target_id)
        if last is not None and (time.monotonic() - last) < 8.0:
            return
        try:
            result = await self._send_cdp_command(
                cdp_session,
                "Runtime.evaluate",
                {
                    "expression": "location.href",
                    "returnByValue": True,
                },
            )
            href = (
                ((result or {}).get("result") or {}).get("value")
                if isinstance(result, dict)
                else None
            )
            if not isinstance(href, str) or not href:
                return
            if self._passkey_auth_reload_url_by_target.get(target_id) == href:
                return
            lower = href.lower()
            auth_markers = (
                "/ap/signin",
                "/ap/cvf",
                "/ap/mfa",
                "/aaut/verify",
                "signin",
                "/login",
                "passport",
            )
            if not any(marker in lower for marker in auth_markers):
                return
            host = (urlparse(href).hostname or "").lower()
            held_rp_ids = {
                str(pk.get("rpId") or "").lower()
                for pk in self._held_passkeys_by_credential_id.values()
            }
            if not any(rp and (host == rp or host.endswith("." + rp)) for rp in held_rp_ids):
                return
            if await self._document_came_from_form_submit(cdp_session):
                return
            await self._send_cdp_command(cdp_session, "Page.navigate", {"url": href})
            self._passkey_auth_reload_at_by_target[target_id] = time.monotonic()
            self._passkey_auth_reload_url_by_target[target_id] = href
            logger.info(
                "🔑 [passkey] reloaded auth page after VA environment rebuild "
                f"so relying party can re-probe passkeys url={href[:120]}"
            )
        except Exception as e:
            logger.warning(
                f"⚠️ [passkey] auth-page reload after VA rebuild failed: {e}"
            )

    async def _document_came_from_form_submit(self, cdp_session: Any) -> bool:
        """True unless the browser reports the current page was reached some other way."""
        try:
            history = await self._send_cdp_command(cdp_session, "Page.getNavigationHistory", {})
            entries = history.get("entries") or []
            transition = entries[int(history.get("currentIndex"))].get("transitionType")
        except Exception as e:
            logger.warning(f"⚠️ [passkey] navigation history unavailable; not reloading: {e}")
            return True
        return not transition or transition == "form_submit"

    async def _read_signcounts_for_target(
        self, target_id: str, cdp_session: Any
    ) -> Optional[Dict[str, int]]:
        authenticator_id = self._passkey_authenticator_by_target.get(target_id)
        if authenticator_id is None:
            return {}
        try:
            result = await self._send_cdp_command(
                cdp_session,
                "WebAuthn.getCredentials",
                {"authenticatorId": authenticator_id},
            )
        except Exception as e:
            logger.warning(f"⚠️ [passkey] getCredentials failed: {e}")
            return None
        counts: Dict[str, int] = {}
        for cred in result.get("credentials", []) or []:
            cid = cred.get("credentialId")
            if cid is not None:
                counts[cid] = int(cred.get("signCount") or 0)
        return counts

    async def read_passkey_signcounts(self) -> Dict[str, int]:
        """Return {credentialId: highest observed signCount} across armed targets.

        Compared against the seeded base, a higher value means the relying party
        actually invoked our passkey — the signal we use to record a passkey
        credential_ref so post-run propagation can mark success/failure. The
        ceremony can happen on any target we armed, so take the max across all of
        them rather than trusting a single handle.
        """
        # Seed from observed maxima first: invalidate_passkey_state_for_live_target
        # may have removed the authenticator after saving an advanced signCount.
        # Disconnect / get_used_passkey_credential_ids must still see that count
        # when reinject fails and _passkey_authenticator_by_target is empty.
        counts: Dict[str, int] = dict(self._passkey_observed_max_counts)
        session = self._session
        if session is None or not self._passkey_authenticator_by_target:
            return counts
        for target_id in list(self._passkey_authenticator_by_target):
            try:
                cdp_session = await session.get_or_create_cdp_session(target_id, focus=False)
            except Exception:
                continue
            target_counts = await self._read_signcounts_for_target(target_id, cdp_session)
            if target_counts is None:
                continue
            for cid, value in target_counts.items():
                if value > counts.get(cid, -1):
                    counts[cid] = value
        return counts

    async def get_used_passkey_credential_ids(self) -> List[str]:
        """Return credentialIds whose signCount advanced past the seeded base.

        An advance means the relying party invoked our passkey during this run.
        """
        if not self._passkey_seed_counts:
            return []
        counts = await self.read_passkey_signcounts()
        return [cid for cid, base in self._passkey_seed_counts.items() if counts.get(cid, base) > base]

    def _page_geometry(self, state: Any) -> Dict[str, Any]:
        geometry: Dict[str, Any] = {
            "viewport_width": self.viewport_width,
            "viewport_height": self.viewport_height,
            "scroll_x": 0,
            "scroll_y": 0,
            "pages_above": 0.0,
            "pages_below": 0.0,
            "total_pages": 1.0,
        }
        page_info = getattr(state, "page_info", None)
        if not page_info:
            return geometry
        if getattr(page_info, "viewport_width", 0) > 0:
            geometry["viewport_width"] = int(page_info.viewport_width)
        if getattr(page_info, "viewport_height", 0) > 0:
            geometry["viewport_height"] = int(page_info.viewport_height)
        geometry["scroll_x"] = int(getattr(page_info, "scroll_x", 0))
        geometry["scroll_y"] = int(getattr(page_info, "scroll_y", 0))
        if getattr(page_info, "viewport_height", 0) > 0:
            geometry["pages_above"] = page_info.pixels_above / page_info.viewport_height
            geometry["pages_below"] = page_info.pixels_below / page_info.viewport_height
            geometry["total_pages"] = page_info.page_height / page_info.viewport_height
        return geometry

    @staticmethod
    def _serialized_dom_tree(dom_state: Any, pages_above: float, pages_below: float) -> str:
        if not dom_state:
            return ""
        elements_text = dom_state.llm_representation()
        if not elements_text:
            return "empty page"
        prefix = f"... {pages_above:.1f} pages above ...\n" if pages_above > 0 else "[Start of page]\n"
        suffix = "\n[End of page]" if pages_below <= 0 else ""
        return f"{prefix}{elements_text}{suffix}"

    @staticmethod
    def _summarized_tabs(state: Any) -> List[Dict[str, str]]:
        return [
            {
                "id": tab.target_id[-4:] if tab.target_id else "????",
                "url": tab.url or "",
                "title": (tab.title or "")[:50],
            }
            for tab in (getattr(state, "tabs", None) or [])
        ]

    async def _capture_surface_screenshot(self, state: Any) -> Optional[str]:
        if self.secret_values_used:
            return None
        try:
            target_id = self._session.agent_focus_target_id
            if not target_id:
                logger.warning("📸 No focused target, falling back to browser-use screenshot")
                return state.screenshot
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            cdp_result = await cdp_session.cdp_client.send_raw(
                "Page.captureScreenshot",
                {"format": "png", "fromSurface": True},
                session_id=cdp_session.session_id,
            )
            if self.secret_values_used:
                return None
            screenshot = cdp_result.get("data")
            logger.info(f"📸 CDP surface screenshot captured (len={len(screenshot) if screenshot else 0})")
            return screenshot
        except Exception as error:
            logger.warning(f"📸 CDP screenshot failed, falling back to browser-use: {error}")
            return state.screenshot

    @staticmethod
    def _blank_screenshot(viewport_width: int, viewport_height: int) -> Optional[str]:
        try:
            import base64
            from io import BytesIO

            from PIL import Image

            blank_image = Image.new("RGB", (viewport_width, viewport_height), color="white")
            buffer = BytesIO()
            blank_image.save(buffer, format="PNG")
            return base64.b64encode(buffer.getvalue()).decode("utf-8")
        except Exception as error:
            logger.warning(f"📸 Failed to generate blank screenshot: {error}")
            return None

    @staticmethod
    def _analyze_screenshot(screenshot: str, viewport_width: int, viewport_height: int) -> None:
        import base64
        import os
        import time as time_module
        from io import BytesIO

        try:
            screenshot_bytes = base64.b64decode(screenshot)
            logger.info(f"📸 [SCREENSHOT] Captured: size_kb={round(len(screenshot_bytes) / 1024, 1)}")
            try:
                from PIL import Image

                image = Image.open(BytesIO(screenshot_bytes))
                dimension_match = image.width == viewport_width and image.height == viewport_height
                logger.info(
                    f"📸 [SCREENSHOT] Dimensions: actual={image.width}x{image.height}, "
                    f"expected={viewport_width}x{viewport_height}, match={dimension_match}"
                )
                if not dimension_match:
                    logger.warning(
                        "⚠️ [SCREENSHOT] DIMENSION MISMATCH - may include browser chrome! "
                        f"width_diff={image.width - viewport_width}, height_diff={image.height - viewport_height}"
                    )
            except ImportError:
                logger.warning("📸 PIL not available for dimension check")

            if os.getenv("ENVIRONMENT") != "production":
                debug_dir = "/tmp/browser_screenshots"
                os.makedirs(debug_dir, exist_ok=True)
                filename = f"{debug_dir}/screenshot_{int(time_module.time() * 1000)}.png"
                with open(filename, "wb") as screenshot_file:
                    screenshot_file.write(screenshot_bytes)
                logger.info(f"📸 [DEBUG] Saved to {filename}")
        except Exception as error:
            logger.error(f"📸 Failed to analyze screenshot: {error}")

    async def get_current_url(self, *, fallback: str = "") -> str:
        """Return the focused tab URL without serializing the DOM tree.

        Prefer a page/CDP URL read over ``get_browser_state_summary`` — that
        path still builds the DOM via DOMWatchdog even when screenshots are off.
        """
        if not self._session:
            return fallback
        try:
            page = await self._session.get_current_page()
            page_url = getattr(page, "url", None)
            if page_url:
                self._runtime_current_url = str(page_url)
                return self._runtime_current_url
            evaluated = await page.evaluate("() => location.href")
            if evaluated:
                self._runtime_current_url = str(evaluated)
            return self.runtime_current_url(fallback=fallback)
        except Exception as error:
            logger.warning(f"Failed to read current URL: {error}")
            return fallback

    def runtime_current_url(self, *, fallback: str = "") -> str:
        """Return private browser identity for navigation/auth mechanics only."""
        return self._runtime_current_url or fallback

    def get_parked_page_identity(self) -> Dict[str, Any]:
        """One event-loop snapshot of the native selected target, not page text."""
        session = self._session
        if session is None or not session.agent_focus_target_id:
            raise RuntimeError("No focused browser target")
        target_id = session.agent_focus_target_id
        target = session.session_manager.get_target(target_id)
        if target is None or target.target_id != target_id or target.target_type != "page":
            raise RuntimeError("Focused browser target is unavailable")
        return {"url": str(target.url), "target_id": str(target_id)}

    async def get_page_identity(self) -> Dict[str, Any]:
        """Return ``{url, title}`` of the focused tab without touching the renderer.

        Reads browser-use's target info (kept current by Target.targetInfoChanged),
        the same source ``get_browser_state`` takes its URL from. A renderer
        round trip here would queue behind page JS / an in-flight DOM snapshot
        on the main thread (0.8-3.6s on Amazon vs 45ms idle). Frozen renderers
        are caught by the action timeouts instead. The result deliberately has
        no ``dom_tree`` key.
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")
        if not self._session.agent_focus_target_id:
            raise RuntimeError("No focused target")
        self._runtime_current_url = str(await self._session.get_current_page_url() or "")
        return {
            "url": self._runtime_current_url,
            "title": str(await self._session.get_current_page_title() or ""),
        }

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

        capture_screenshot = include_screenshot and not self.secret_values_used
        state = await self._session.get_browser_state_summary(include_screenshot=capture_screenshot)
        self._runtime_current_url = str(state.url or "")
        if state.dom_state and state.dom_state.selector_map:
            self._selector_map = state.dom_state.selector_map
        geometry = self._page_geometry(state)
        viewport_width = geometry["viewport_width"]
        viewport_height = geometry["viewport_height"]
        page_stats = self._extract_page_statistics(state)
        self._remember_rendered_image_urls(state)
        await self._remember_document_images()
        media_candidates = _extract_media_candidates_from_dom_state(
            state.dom_state,
            page_url=state.url or "",
        )
        result = {
            "url": state.url or "",
            "title": state.title or "",
            "viewport": {"width": viewport_width, "height": viewport_height},
            "scroll_position": {
                "x": geometry["scroll_x"],
                "y": geometry["scroll_y"],
                "pages_above": round(geometry["pages_above"], 1),
                "pages_below": round(geometry["pages_below"], 1),
                "total_pages": round(geometry["total_pages"], 1),
            },
            "dom_tree": self._serialized_dom_tree(
                state.dom_state,
                geometry["pages_above"],
                geometry["pages_below"],
            ),
            "tabs": self._summarized_tabs(state),
            "page_stats": page_stats,
        }
        if media_candidates and not self.secret_values_used:
            result["media_candidates"] = media_candidates
        if getattr(state, "recent_events", None):
            result["recent_events"] = state.recent_events
        if getattr(state, "closed_popup_messages", None):
            result["closed_popups"] = state.closed_popup_messages
        screenshot_to_use = await self._capture_surface_screenshot(state) if capture_screenshot else None
        if self.secret_values_used:
            capture_screenshot = False
            screenshot_to_use = None
        if include_screenshot and self.secret_values_used:
            result["screenshot_placeholder"] = True
            result["screenshot_suppressed_reason"] = "Private credentials were entered; use redacted DOM observations."
        if capture_screenshot and not screenshot_to_use:
            logger.info(f"📸 No screenshot available, generating blank for {result.get('url', 'unknown')}")
            screenshot_to_use = self._blank_screenshot(viewport_width, viewport_height)
            # A synthetic white frame is not page evidence; evidence consumers
            # (the browser verifier) must not present it as the rendered page.
            result["screenshot_placeholder"] = True
        if include_screenshot and screenshot_to_use:
            result["screenshot"] = screenshot_to_use
            self._analyze_screenshot(screenshot_to_use, viewport_width, viewport_height)
        safe_result = self.model_visible_value(result)
        if not self.secret_values_used and screenshot_to_use:
            # PNG base64 is binary transport, not page text. A short CVV can
            # coincidentally occur in it; textual substitution corrupts pixels.
            safe_result["screenshot"] = screenshot_to_use
        # Geometry and counts come from the harness, not credential readbacks.
        # Preserve their numeric types even when a CVV equals a coordinate.
        for key in ("viewport", "scroll_position", "page_stats"):
            safe_result[key] = result[key]
        for original, visible in zip(result["tabs"], safe_result.get("tabs", [])):
            if "id" in original:
                visible["id"] = original["id"]
        return safe_result

    async def _remember_document_images(self) -> List[str]:
        """Record ``document.images`` (src, currentSrc, srcset) of the focused page.

        One bounded Runtime.evaluate over this service's own CDP session (the
        worker's single socket on Tilion; no Runtime.enable). Never fails a
        state read: errors and timeouts record nothing.
        """
        get_cdp_session = getattr(self._session, "get_or_create_cdp_session", None)
        if not callable(get_cdp_session):
            return []
        try:
            cdp_session = await asyncio.wait_for(get_cdp_session(focus=False), timeout=_DOCUMENT_IMAGES_TIMEOUT_SECONDS)
            evaluated = await asyncio.wait_for(
                cdp_session.cdp_client.send.Runtime.evaluate(
                    params={"expression": _DOCUMENT_IMAGES_JS, "returnByValue": True},
                    session_id=cdp_session.session_id,
                ),
                timeout=_DOCUMENT_IMAGES_TIMEOUT_SECONDS,
            )
        except Exception as error:
            logger.debug(f"document.images read skipped: {type(error).__name__}: {str(error)[:120]}")
            return []
        value = ((evaluated or {}).get("result") or {}).get("value") if isinstance(evaluated, dict) else None
        if not isinstance(value, dict) or not isinstance(value.get("urls"), list):
            return []
        base = str(value.get("base") or "")
        urls: Dict[str, None] = {}
        for raw_url in value["urls"][: 3 * _MAX_DOCUMENT_IMAGES_PER_READ]:
            if isinstance(raw_url, str):
                url = _resolve_http_image_url(raw_url, base)
                if url:
                    urls.setdefault(url, None)
        resolved = list(urls)
        self.restore_rendered_image_state(resolved)
        return resolved

    def rendered_image_state(self) -> List[str]:
        """Image URLs this activity has seen rendered, oldest first, for a replacement DOMService."""
        return list(self._rendered_image_urls)

    def restore_rendered_image_state(self, urls: Any) -> None:
        """Carry receipt-image provenance across a session switch (rotation, challenge
        recovery): the image was rendered by this activity's browser even if the
        current session generation never loaded that page."""
        for url in urls or []:
            if isinstance(url, str) and url:
                self._rendered_image_urls.pop(url, None)
                self._rendered_image_urls[url] = None
        while len(self._rendered_image_urls) > _MAX_REMEMBERED_IMAGE_URLS:
            self._rendered_image_urls.pop(next(iter(self._rendered_image_urls)))

    def _remember_rendered_image_urls(self, state: Any) -> List[str]:
        """Record the images ``state`` renders; return them in page order."""
        urls = _extract_image_urls_from_dom_state(state.dom_state, page_url=state.url or "")
        for url in urls:
            self._rendered_image_urls.pop(url, None)
            self._rendered_image_urls[url] = None
        while len(self._rendered_image_urls) > _MAX_REMEMBERED_IMAGE_URLS:
            self._rendered_image_urls.pop(next(iter(self._rendered_image_urls)))
        return urls

    async def get_page_image_urls(self) -> List[str]:
        """Image URLs this browser activity actually rendered: the current page from a
        fresh DOM snapshot first, then images rendered by pages observed earlier."""
        if self.secret_values_used:
            return []
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        state = await self._session.get_browser_state_summary(include_screenshot=False)
        if state.dom_state and state.dom_state.selector_map:
            self._selector_map = state.dom_state.selector_map
        current = self._remember_rendered_image_urls(state)
        current += await self._remember_document_images()
        return list(dict.fromkeys([*current, *reversed(self._rendered_image_urls)]))

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

    async def get_click_coordinates(self, index: int) -> Optional[Tuple[int, int]]:
        """Resolve humanized click coordinates, including visible labels for checkable inputs."""
        rect = await self.get_element_rect(index, use_associated_label=True)
        if rect:
            return offcenter_click_point(
                rect["x"] + rect["width"] / 2,
                rect["y"] + rect["height"] / 2,
                rect["width"],
                rect["height"],
            )

        return None

    async def get_element_rect(
        self,
        index: int,
        *,
        use_associated_label: bool = False,
    ) -> Optional[Dict[str, int]]:
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
                    function(useAssociatedLabel) {
                        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
                        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

                        const visibleViewportRect = (element) => {
                            const rect = element.getBoundingClientRect();
                            const visibleLeft = Math.max(0, rect.left);
                            const visibleTop = Math.max(0, rect.top);
                            const visibleRight = Math.min(viewportWidth, rect.right);
                            const visibleBottom = Math.min(viewportHeight, rect.bottom);
                            const visibleWidth = visibleRight - visibleLeft;
                            const visibleHeight = visibleBottom - visibleTop;

                            if (visibleWidth <= 0 || visibleHeight <= 0) {
                                return null;
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
                        };

                        const isReliableHitTarget = (element, rect) => {
                            const style = window.getComputedStyle(element);
                            if (style.visibility === "hidden" || style.visibility === "collapse"
                                || Number.parseFloat(style.opacity || "1") <= 0
                                || style.pointerEvents === "none") {
                                return false;
                            }

                            const centerX = rect.x + rect.width / 2;
                            const centerY = rect.y + rect.height / 2;
                            const radius = Math.min(rect.width * 0.3, rect.height * 0.3, 6);
                            const samples = [[0, 0]];
                            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                                samples.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
                            }

                            return samples.every(([dx, dy]) => {
                                const hit = document.elementFromPoint(centerX + dx, centerY + dy);
                                return hit === element || (hit && element.contains(hit));
                            });
                        };

                        const ownRect = visibleViewportRect(this);
                        const inputType = String(this.type || "").toLowerCase();
                        const isCheckableInput = this.tagName === "INPUT"
                            && (inputType === "checkbox" || inputType === "radio");
                        // A checkbox hidden via opacity:0, clip:rect(0,0,0,0),
                        // transform:scale(0) or pointer-events:none still reports a
                        // NON-EMPTY rect, so a bare `if (ownRect) return ownRect`
                        // would hand back coordinates the input does not actually
                        // own. Require it to be the real hit target before
                        // preferring it over its visible label.
                        const preferLabel = useAssociatedLabel && isCheckableInput
                            && !this.disabled && this.labels && this.labels.length > 0;
                        if (ownRect && (!preferLabel || isReliableHitTarget(this, ownRect))) {
                            return ownRect;
                        }

                        if (preferLabel) {
                            for (const label of this.labels) {
                                const labelRect = visibleViewportRect(label);
                                if (labelRect && isReliableHitTarget(label, labelRect)) {
                                    return labelRect;
                                }
                            }
                        }

                        const rect = this.getBoundingClientRect();
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
                    """,
                    "arguments": [{"value": use_associated_label}],
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
