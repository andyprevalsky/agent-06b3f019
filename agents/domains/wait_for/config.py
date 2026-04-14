"""Wait-for domain configuration: constants and defaults."""

# ~80k tokens ~ 320k chars -- liberal budget that fits comfortably in the
# evaluator LLM's context window while preventing unbounded payloads from
# web_fetch results causing timeouts or silent failures.
EVIDENCE_CHAR_BUDGET = 320_000

# Maximum wait duration in seconds (31 days).
MAX_WAIT_SECONDS = 2_678_400

# Condition-polling bounds.
MIN_CHECK_INTERVAL_SECONDS = 60
MAX_CHECK_INTERVAL_SECONDS = 86_400
MIN_CHECKS = 1
MAX_CHECKS = 100

# Default polling parameters when caller omits them.
DEFAULT_CHECK_INTERVAL_SECONDS = 900
DEFAULT_MAX_CHECKS = 20

# Default model for cheap condition evaluation.
DEFAULT_MODEL = "rose-labs/rose-1-lite"
