"""Find All domain config — constants, defaults, and pricing tables."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from domains.find_all.types import GeneratorPricing

# ── API ──
BASE_URL = "https://api.parallel.ai"
BETA_HEADER_VALUE = "findall-2025-09-15"

# ── Polling ──
MAX_POLL_SECONDS = 1200  # 20 minutes
INITIAL_POLL_INTERVAL = 2.0  # seconds
MAX_POLL_INTERVAL = 10.0  # seconds
POLL_BACKOFF_FACTOR = 1.5

# ── Display ──
TITLE_OBJECTIVE_MAX_LEN = 50
OBJECTIVE_PREVIEW_MAX_LEN = 100

TITLE_PREFIXES_TO_STRIP: list[str] = [
    "find all ",
    "find ",
    "search for ",
    "get all ",
    "list all ",
    "locate all ",
]

# ── Pricing (cents) — https://parallel.ai/pricing ──
GENERATOR_PRICING: dict[str, GeneratorPricing] = {
    "preview": {"fixed": 10, "per_match": 0},
    "base": {"fixed": 25, "per_match": 3},
    "core": {"fixed": 200, "per_match": 15},
    "pro": {"fixed": 1000, "per_match": 100},
}
DEFAULT_GENERATOR = "core"
