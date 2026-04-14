"""Enrich domain config - constants, defaults, pricing."""

# Parallel AI Task API base URL
BASE_URL = "https://api.parallel.ai"

# Polling configuration
MAX_POLL_TIME_SECS = 600  # 10 minutes max
INITIAL_POLL_INTERVAL_SECS = 2.0
MAX_POLL_INTERVAL_SECS = 10.0
POLL_BACKOFF_FACTOR = 1.5
PROGRESS_UPDATE_INTERVAL_SECS = 5.0

# HTTP timeouts (seconds)
CREATE_TASK_TIMEOUT = 60.0
POLL_STATUS_TIMEOUT = 30.0
GET_RESULTS_TIMEOUT = 60.0

# Entity name display truncation
MAX_ENTITY_NAME_LENGTH = 50
TRUNCATED_SUFFIX = "..."
TRUNCATED_LENGTH = 47

# Processor pricing in cents per request
# Source: https://parallel.ai/pricing & https://docs.parallel.ai/task-api/guides/choose-a-processor
PROCESSOR_COSTS_CENTS: dict[str, float] = {
    "lite": 0.5,  # $0.005 per request ($5 per 1,000)
    "base": 1,  # $0.01 per request ($10 per 1,000)
    "core": 2.5,  # $0.025 per request ($25 per 1,000)
    "core2x": 5,  # $0.05 per request ($50 per 1,000)
    "pro": 10,  # $0.10 per request ($100 per 1,000)
    "ultra": 30,  # $0.30 per request ($300 per 1,000)
    "ultra2x": 60,  # $0.60 per request ($600 per 1,000)
    "ultra4x": 120,  # $1.20 per request ($1,200 per 1,000)
    "ultra8x": 240,  # $2.40 per request ($2,400 per 1,000)
}

# Default cost when processor is unknown
DEFAULT_COST_CENTS = 2.5
