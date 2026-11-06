"""Web fetch domain config — constants, limits, and MIME type mappings."""

# ── Download limits ──

MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024  # 50 MB per file

# ── Firecrawl ──

# Hard cap on the markdown payload we send to Haiku. Mirrors Claude Code's
# MAX_MARKDOWN_LENGTH (~40k chars ≈ 10k tokens) — beyond this the Haiku call
# pays diminishing returns and risks the "Prompt is too long" error on the
# small model.
MAX_MARKDOWN_LENGTH = 40_000

# Per-call cost (Firecrawl Standard tier = $83/mo / 100k credits ≈ $0.00083).
# Stored in cents for parity with other service-cost entries.
FIRECRAWL_COST_CENTS = 0.083

# The scrape activity's Temporal start-to-close budget. The provider chain below
# (Firecrawl, then the Parallel Extract fallback) must finish inside it so a hung
# page yields a typed tool error instead of an activity timeout plus a full retry.
WEB_FETCH_SCRAPE_ACTIVITY_TIMEOUT_SECONDS = 180

FIRECRAWL_SCRAPE_TIMEOUT_SECONDS = 90.0

# ── Parallel Extract fallback ──

PARALLEL_EXTRACT_API_URL = "https://api.parallel.ai/v1/extract"
PARALLEL_EXTRACT_TIMEOUT_SECONDS = 60.0

# Hard cap on one scrape_url call (both providers). Kept below the activity
# timeout; asserted by the web_fetch blackbox.
WEB_FETCH_SCRAPE_BUDGET_SECONDS = FIRECRAWL_SCRAPE_TIMEOUT_SECONDS + PARALLEL_EXTRACT_TIMEOUT_SECONDS

# Parallel Extract pricing is $1 / 1k URLs. Stored in cents.
PARALLEL_EXTRACT_COST_CENTS = 0.1

# Hard cap on one download_files_batch call (all files, sequential), leaving the
# rest of the 180s download activity for uploads.
WEB_FETCH_DOWNLOAD_BUDGET_SECONDS = 120.0

# ── MIME type mapping ──

MIME_TYPES: dict[str, str] = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "webp": "image/webp",
    "zip": "application/zip",
    "rar": "application/x-rar-compressed",
    "json": "application/json",
    "txt": "text/plain",
    "mp3": "audio/mpeg",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "avi": "video/x-msvideo",
}
