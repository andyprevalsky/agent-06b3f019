"""DOM Service - Wrapper for browser-use's BrowserSession.

This module provides:
- DOM extraction using browser-use's serialization
- Coordinate conversion between index and viewport coordinates
- Selector map caching for action execution
- Action history recording with dual index/coordinate representation
"""

import logging
from dataclasses import dataclass, field, asdict
from typing import Optional, Tuple, Dict, Any, List

logger = logging.getLogger(__name__)


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
        step = len(self._entries) + 1
        
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
                element = await dom_service.get_element_at_coordinates(
                    coords_dict["x"], coords_dict["y"]
                )
                if element:
                    index = element.backend_node_id if hasattr(element, 'backend_node_id') else None
            except Exception as e:
                logger.warning(f"Failed to get index for coords {coords_dict}: {e}")
        
        # Get element description from selector map if available
        element_description = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if element:
                tag = getattr(element, 'tag_name', None) or getattr(element, 'node_name', 'unknown')
                element_description = f"[{index}] {tag}"
                text = getattr(element, 'text_content', '') or ''
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
        logger.debug(f"Recorded action {step}: {action} (index={index}, coords={coords_dict})")
        
        return entry
    
    def get_entries(self) -> List[Dict[str, Any]]:
        """Get all entries as dicts for Rose API request."""
        return [entry.to_dict() for entry in self._entries]
    
    def clear(self) -> None:
        """Clear the action history."""
        self._entries = []
    
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
        
    async def connect(self) -> None:
        """Connect to the browser via CDP.

        This must be called before any other methods.
        """
        try:
            from browser_use.browser.session import BrowserSession
            from browser_use.browser.profile import BrowserProfile

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

            # Hide scrollbars to ensure viewport matches screenshot dimensions (1280x800)
            # This prevents coordinate mismatch between reported viewport and captured screenshot
            # which causes Yutori to misclick (viewport reports 1265 with scrollbar, screenshot is 1280)
            try:
                page = await self._session.get_current_page()
                await page.add_style_tag(content="""
                    ::-webkit-scrollbar { display: none !important; }
                    html, body {
                        -ms-overflow-style: none !important;
                        scrollbar-width: none !important;
                    }
                """)
                logger.info("📏 Injected scrollbar-hiding CSS for consistent 1280x800 viewport")
            except Exception as e:
                logger.warning(f"⚠️ Failed to inject scrollbar CSS: {e}")

            # Note: Download behavior is configured automatically by browser-use DownloadsWatchdog
            # using the downloads_path="/files" setting in BrowserProfile

            # Suppress native browser overlays that CDP can't capture in screenshots.
            # CDP's Page.captureScreenshot only captures page content, not browser-chrome-level UI
            # (passkey popups, permission prompts, etc.). These invisible overlays block interaction
            # and confuse the agent. Instead of trying to capture them, we suppress them.
            await self._suppress_browser_overlays()

        except ImportError as e:
            logger.error(f"browser-use not installed or import error: {e}")
            raise
        except Exception as e:
            logger.error(f"Failed to connect to browser: {e}")
            raise

    async def disconnect(self) -> None:
        """Disconnect from the browser.
        
        Note: For remote browsers (Steel), this just releases our connection.
        The actual browser session may still be alive on the server.
        """
        if self._session:
            try:
                # For remote browsers, we don't want to kill the browser,
                # just release our connection. The browser session remains alive.
                pass  # Don't call stop/kill - session persists on Steel
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                self._session = None
                self._selector_map = {}
                logger.info("🔌 Disconnected from browser")
    
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
            page = await self._session.get_current_page()
            cdp_session = await page.context.new_cdp_session(page)

            # 1. WebAuthn: suppress native passkey/credential popup
            #    Without this, Chrome shows a modal passkey chooser that blocks the page
            #    but is invisible to CDP screenshots. With enableUI=false, WebAuthn requests
            #    fail gracefully and sites fall back to password login.
            try:
                await cdp_session.send("WebAuthn.enable", {"enableUI": False})
                logger.info("🛡️ [overlay-suppress] WebAuthn native UI disabled (passkey popups suppressed)")
            except Exception as e:
                logger.warning(f"⚠️ [overlay-suppress] Failed to disable WebAuthn UI: {e}")

            # 2. File chooser: intercept so native file dialog doesn't block
            #    The agent can handle file uploads programmatically instead.
            try:
                await cdp_session.send("Page.setInterceptFileChooserDialog", {"enabled": True})
                logger.info("🛡️ [overlay-suppress] File chooser dialog interception enabled")
            except Exception as e:
                logger.warning(f"⚠️ [overlay-suppress] Failed to intercept file chooser: {e}")

            # Don't detach — CDP session must stay alive for WebAuthn state to persist
            # (same pattern as fingerprint_injection.py)
        except Exception as e:
            logger.warning(f"⚠️ [overlay-suppress] Failed to suppress browser overlays: {e}")

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
        state = await self._session.get_browser_state_summary(
            include_screenshot=include_screenshot
        )
        
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
            if hasattr(pi, 'viewport_width') and pi.viewport_width > 0:
                viewport_width = int(pi.viewport_width)
            if hasattr(pi, 'viewport_height') and pi.viewport_height > 0:
                viewport_height = int(pi.viewport_height)
            scroll_x = int(pi.scroll_x) if hasattr(pi, 'scroll_x') else 0
            scroll_y = int(pi.scroll_y) if hasattr(pi, 'scroll_y') else 0
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
        
        # Build tabs list
        tabs = []
        if hasattr(state, 'tabs') and state.tabs:
            for tab in state.tabs:
                tabs.append({
                    "id": tab.target_id[-4:] if tab.target_id else "????",
                    "url": tab.url or "",
                    "title": (tab.title or "")[:50]
                })
        
        # Build result dict
        result = {
            "url": state.url or "",
            "title": state.title or "",
            "viewport": {
                "width": viewport_width,
                "height": viewport_height
            },
            "scroll_position": {
                "x": scroll_x,
                "y": scroll_y,
                "pages_above": round(pages_above, 1),
                "pages_below": round(pages_below, 1),
                "total_pages": round(total_pages, 1)
            },
            "dom_tree": dom_tree,
            "tabs": tabs,
            "page_stats": page_stats,
        }
        
        # Add recent events if available
        if hasattr(state, 'recent_events') and state.recent_events:
            result["recent_events"] = state.recent_events
        
        # Add closed popup messages if any
        if hasattr(state, 'closed_popup_messages') and state.closed_popup_messages:
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
                    logger.info(f"📸 CDP surface screenshot captured (len={len(screenshot_to_use) if screenshot_to_use else 0})")
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

                blank_img = Image.new('RGB', (viewport_width, viewport_height), color='white')
                buffer = BytesIO()
                blank_img.save(buffer, format='PNG')
                screenshot_to_use = base64.b64encode(buffer.getvalue()).decode('utf-8')
            except Exception as e:
                logger.warning(f"📸 Failed to generate blank screenshot: {e}")

        if include_screenshot and screenshot_to_use:
            result["screenshot"] = screenshot_to_use

            # Debug: analyze and save screenshot
            import base64
            from io import BytesIO
            import os
            import time as time_module

            try:
                screenshot_bytes = base64.b64decode(screenshot_to_use)
                logger.info(f"📸 [SCREENSHOT] Captured: size_kb={round(len(screenshot_bytes) / 1024, 1)}")

                # Get dimensions using PIL
                try:
                    from PIL import Image
                    img = Image.open(BytesIO(screenshot_bytes))
                    dimension_match = (img.width == viewport_width and img.height == viewport_height)
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

                # Always save screenshots to disk for debugging
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
        
        if not state.dom_state or not hasattr(state.dom_state, '_root') or not state.dom_state._root:
            return stats
        
        try:
            def traverse_node(node):
                if not node:
                    return
                
                stats["total_elements"] += 1
                
                original = getattr(node, 'original_node', node)
                tag = getattr(original, 'tag_name', '') or getattr(original, 'node_name', '')
                tag = tag.lower() if tag else ''
                
                if tag == 'a':
                    stats["links"] += 1
                elif tag in ('iframe', 'frame'):
                    stats["iframes"] += 1
                elif tag == 'img':
                    stats["images"] += 1
                
                if getattr(original, 'is_actually_scrollable', False):
                    stats["scroll_containers"] += 1
                
                if getattr(node, 'is_interactive', False):
                    stats["interactive"] += 1
                
                for child in getattr(node, 'children', []):
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
        
        Uses browser-use's get_element_coordinates which returns a DOMRect.
        
        Args:
            index: Element index (backend_node_id) from DOM tree
            
        Returns:
            Tuple of (x, y) viewport coordinates (center of element), or None if not found
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")
        
        try:
            # browser-use's get_element_coordinates requires the cdp_session for the focused tab
            target_id = self._session.agent_focus_target_id
            if not target_id:
                logger.warning("No focused target, cannot get element coordinates")
                return None
            
            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            rect = await self._session.get_element_coordinates(
                backend_node_id=index,
                cdp_session=cdp_session
            )
            
            if rect:
                # DOMRect has x, y, width, height - calculate center
                center_x = int(rect.x + rect.width / 2)
                center_y = int(rect.y + rect.height / 2)
                return (center_x, center_y)
                
        except Exception as e:
            logger.warning(f"Failed to get coordinates for index {index}: {e}")
        
        # Fallback: check if element has center_coords in selector map
        element = self._selector_map.get(index)
        if element:
            if hasattr(element, 'center_coords') and element.center_coords:
                return (int(element.center_coords[0]), int(element.center_coords[1]))
        
        return None

    async def get_element_rect(self, index: int) -> Optional[Dict[str, int]]:
        """Get full bounding rect for element.

        Similar to get_element_coordinates but returns the full bounding box,
        useful for input field clicks where we want to click in a specific
        region of the element (e.g., right side for text inputs).

        Args:
            index: Element index (backend_node_id) from DOM tree

        Returns:
            Dict with {x, y, width, height} or None if not found
        """
        if not self._session:
            raise RuntimeError("Not connected. Call connect() first.")

        try:
            target_id = self._session.agent_focus_target_id
            if not target_id:
                logger.warning("No focused target, cannot get element rect")
                return None

            cdp_session = await self._session.get_or_create_cdp_session(target_id, focus=False)
            rect = await self._session.get_element_coordinates(
                backend_node_id=index,
                cdp_session=cdp_session
            )

            if rect:
                return {
                    "x": int(rect.x),
                    "y": int(rect.y),
                    "width": int(rect.width),
                    "height": int(rect.height)
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
                {"x": x, "y": y}
            )

            return result or ''
        except Exception as e:
            logger.warning(f"Failed to get text at ({x}, {y}): {e}")
            return ''

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
