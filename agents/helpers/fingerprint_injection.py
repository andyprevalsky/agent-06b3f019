"""
Fingerprint injection helper for applying fingerprint spoofing via CDP.

CDP settings (Network.setUserAgentOverride, addInitScript) do NOT persist across connections.
When the backend calls injectUserData() and closes its CDP connection, those settings are lost.
The agent must re-apply them when it connects via its own CDP connection.

Usage:
    from helpers.fingerprint_injection import apply_fingerprint_injection

    # After connecting to CDP
    await apply_fingerprint_injection(playwright_page, fingerprint_injection)
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def apply_fingerprint_injection(
    page: Any,  # playwright.async_api.Page
    fingerprint_injection: Optional[dict],
) -> bool:
    """
    Apply fingerprint injection settings to a Playwright page via CDP.

    This must be called IMMEDIATELY after connecting to CDP, BEFORE any navigation.
    The settings only apply to pages loaded after this call.

    Args:
        page: Playwright Page object (async)
        fingerprint_injection: Dict containing userAgentOverride and initScript
                              (as returned by /api/browser-session/init)

    Returns:
        True if injection was applied successfully, False otherwise
    """
    if not fingerprint_injection:
        logger.info("[fingerprint] No fingerprint injection data provided")
        return False

    try:
        user_agent_override = fingerprint_injection.get("userAgentOverride")
        init_script = fingerprint_injection.get("initScript")

        if not user_agent_override:
            logger.warning("[fingerprint] Missing userAgentOverride in injection data")
            return False

        # Get CDP session from page
        cdp_session = await page.context.new_cdp_session(page)

        # IMPORTANT: Network.enable MUST be called before setUserAgentOverride
        # Without this, userAgentMetadata won't affect HTTP headers (Sec-CH-UA-*)
        await cdp_session.send("Network.enable")
        logger.info("[fingerprint] CDP Network.enable called")

        # Apply Network.setUserAgentOverride with full metadata
        await cdp_session.send("Network.setUserAgentOverride", user_agent_override)

        platform = user_agent_override.get("userAgentMetadata", {}).get("platform", "unknown")
        arch = user_agent_override.get("userAgentMetadata", {}).get("architecture", "unknown")
        logger.info(f"[fingerprint] Applied CDP userAgentOverride: platform={platform}, arch={arch}")

        # Apply init script for JS-level spoofing
        if init_script:
            await page.context.add_init_script(init_script)
            logger.info("[fingerprint] Applied fingerprint init script")

        # Also add scrollbar-hiding CSS for consistent viewport
        scrollbar_script = """
            (function() {
                const style = document.createElement('style');
                style.id = 'yutori-scrollbar-hide';
                style.textContent = `
                    /* Hide scrollbars on ALL elements for consistent 1280x800 viewport */
                    *::-webkit-scrollbar {
                        display: none !important;
                        width: 0 !important;
                        height: 0 !important;
                    }
                    * {
                        -ms-overflow-style: none !important;
                        scrollbar-width: none !important;
                    }
                `;
                if (document.head) {
                    document.head.appendChild(style);
                } else {
                    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
                }
            })();
        """
        await page.context.add_init_script(scrollbar_script)

        logger.info("[fingerprint] Fingerprint injection complete")
        return True

    except Exception as e:
        logger.error(f"[fingerprint] Failed to apply fingerprint injection: {e}")
        return False


async def apply_fingerprint_to_context(
    context: Any,  # playwright.async_api.BrowserContext
    fingerprint_injection: Optional[dict],
) -> bool:
    """
    Apply fingerprint injection to a Playwright BrowserContext.
    This applies init scripts to the context level (affects all pages).

    For CDP-level Network.setUserAgentOverride, you still need to call
    apply_fingerprint_injection() on a specific page after navigation.

    Args:
        context: Playwright BrowserContext (async)
        fingerprint_injection: Dict containing userAgentOverride and initScript

    Returns:
        True if injection was applied successfully, False otherwise
    """
    if not fingerprint_injection:
        logger.info("[fingerprint] No fingerprint injection data provided")
        return False

    try:
        init_script = fingerprint_injection.get("initScript")

        if init_script:
            await context.add_init_script(init_script)
            logger.info("[fingerprint] Applied fingerprint init script to context")

        # Add scrollbar-hiding CSS
        scrollbar_script = """
            (function() {
                const style = document.createElement('style');
                style.id = 'yutori-scrollbar-hide';
                style.textContent = `
                    *::-webkit-scrollbar {
                        display: none !important;
                        width: 0 !important;
                        height: 0 !important;
                    }
                    * {
                        -ms-overflow-style: none !important;
                        scrollbar-width: none !important;
                    }
                `;
                if (document.head) {
                    document.head.appendChild(style);
                } else {
                    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
                }
            })();
        """
        await context.add_init_script(scrollbar_script)

        return True

    except Exception as e:
        logger.error(f"[fingerprint] Failed to apply fingerprint to context: {e}")
        return False
