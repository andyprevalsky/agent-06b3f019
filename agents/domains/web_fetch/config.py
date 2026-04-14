"""Web fetch domain config — constants, limits, and MIME type mappings."""

import re

# ── Regex patterns for media/file detection ──

IMAGE_EXTENSIONS = r"\.(?:png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff|avif)"
FILE_EXTENSIONS = r"\.(?:pdf|doc|docx|xls|xlsx|csv|zip|rar|ppt|pptx|txt|mp3|mp4|mov|avi)"
RE_FLAGS = re.IGNORECASE

# ── Download limits ──

MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024  # 50 MB per file

# ── Cost tracking ──

PARALLEL_AI_COST_CENTS = 0.5  # ~$0.005 per URL

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
