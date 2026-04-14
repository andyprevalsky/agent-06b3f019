"""Configuration for spawn-browser-agent-v3 domain.

Constants, defaults, and environment reads.
"""

# Agent loop limits
MAX_ITERATIONS = 30
MAX_CONSECUTIVE_API_FAILURES = 5
ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES = 15
HEARTBEAT_TIMEOUT_SECONDS = 120
MAX_ACTIVITY_RETRIES = 2

# Session init retry settings
SESSION_MAX_WAIT_SECONDS = 900  # 15 minutes max
SESSION_RETRY_INTERVAL_SECONDS = 30

# Claude auth rotation
MAX_CLAUDE_TOKEN_ROTATIONS = 5

# Extract LLM settings
EXTRACT_MAX_CONTENT_LENGTH = 50000
EXTRACT_LLM_MODEL = "openai/gpt-4.1-mini"
EXTRACT_LLM_MAX_TOKENS = 4096
EXTRACT_LLM_TEMPERATURE = 0.1

# Rose API model name
ROSE_BROWSER_USE_MODEL = "rose-labs/rose-1-browser-use"

# Verifier settings
VERIFIER_ULTRA_MODEL = "rose-labs/rose-1-ultra"
VERIFIER_LITE_MODEL = "rose-labs/rose-1-lite"
VERIFIER_ULTRA_TIMEOUT_SECONDS = 7
VERIFIER_LITE_TIMEOUT_SECONDS = 15

# Write lock approval timeout
WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS = 120

# Steel pricing: $1/hour = 100 cents / 3,600,000 ms
STEEL_COST_CENTS_PER_MS = 100 / 3_600_000  # ~0.00002778

# Action loop delay between iterations (seconds)
ACTION_LOOP_DELAY_SECONDS = 0.5

# MIME type mappings for file downloads
MIME_TYPE_MAP = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "zip": "application/zip",
    "json": "application/json",
    "txt": "text/plain",
}
