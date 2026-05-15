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

FIRECRAWL_SCRAPE_TIMEOUT_SECONDS = 120.0

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
