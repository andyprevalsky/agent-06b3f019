"""Re-export shim -- domain logic lives in domains/display/."""

from domains.display.handler import DisplayManager, display, get_manager
from domains.display.repo import display_media_activity

__all__ = ["DisplayManager", "display", "display_media_activity", "get_manager"]
