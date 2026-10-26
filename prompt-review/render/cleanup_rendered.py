#!/usr/bin/env python3
"""Final cleanup pass on rendered claude-code-src prompts.

Strips:
  - HTML comments (<!-- ... --> blocks, including multi-line)
  - Trailing whitespace from each line
  - Leftover variant separator lines (e.g. "--- alternative ... ---")
  - Section labels we accidentally injected (e.g. "(DEFAULT_PREFIX)" lines)

Output: same files, but cleaned. Idempotent.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RENDERED_ROOT = ROOT / "prompt-review" / "rendered"
# kimi-code is excluded: its goldens are verbatim copies whose prompts contain
# real `--- ... ---` lines that SEPARATOR_LINE would strip.
REPOS = ["ours", "claude-code-src", "openclaw", "hermes-agent", "codex", "prime-agent"]

# Patterns that indicate sidecar metadata accidentally emitted by renderers.
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
SEPARATOR_LINE = re.compile(r"^---\s*[A-Za-z][^-]*---\s*$")
LABEL_LINE = re.compile(r"^\([A-Z][A-Z_]+\)\s*$")
# concat-style box drawing separators (──────, ━━━━━, ══════)
BOX_SEPARATOR = re.compile(r"^[─━═]{2,}\s*$")
# Renderer-injected file markers
IMPORTED_FROM_MARKER = re.compile(r"^IMPORTED FROM .*:\s*$")
# Single-line annotation comments injected by openclaw/message-tool renderer
# (e.g. "# Default fallback (no channel config / no discovery)" or
# "# With channel-aware discovery (realistic Telegram example, ...)")
RENDERER_ANNOTATION = re.compile(
    r"^#\s+(Default fallback|With channel-aware discovery|With .* discovery|Without .*)\b.*$"
)
# Orphan trailing-backslash lines like `   - thing \` left behind when a
# `\\n` interpolation resolves to empty string (PowerShell prompt has these
# from `getBackgroundSection() ? ... + '\\n' : ''` substitutions).
ORPHAN_BACKSLASH = re.compile(r"^\s*\\\s*$")


def cleanup(text: str) -> str:
    stripped = text.lstrip()
    is_tool_schema_json = (
        stripped.startswith("{")
        and '"parameters"' in stripped
        and '"properties"' in stripped
    )

    text = HTML_COMMENT.sub("", text)
    out_lines = []
    for line in text.split("\n"):
        if SEPARATOR_LINE.match(line):
            continue
        if LABEL_LINE.match(line):
            continue
        if BOX_SEPARATOR.match(line):
            continue
        if IMPORTED_FROM_MARKER.match(line):
            continue
        if RENDERER_ANNOTATION.match(line):
            continue
        if ORPHAN_BACKSLASH.match(line):
            continue
        out_lines.append(line.rstrip())
    text = "\n".join(out_lines)
    # Convert literal `\n` escapes (left over from raw template-literal bodies)
    # into real newlines, except for schema JSON where this would make the
    # serialized object invalid (newlines inside quoted strings).
    if not is_tool_schema_json:
        text = text.replace("\\n\\n", "\n\n").replace("\\n", "\n")
    # Collapse 3+ blank lines to 2.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def main() -> int:
    total = 0
    for repo in REPOS:
        d = RENDERED_ROOT / repo
        if not d.exists():
            continue
        for f in sorted(d.glob("*.txt")):
            original = f.read_text(encoding="utf-8")
            cleaned = cleanup(original)
            if cleaned != original:
                f.write_text(cleaned, encoding="utf-8")
                print(f"  cleaned {repo}/{f.name} ({len(original)} -> {len(cleaned)} chars)")
                total += 1
    print(f"[cleanup] modified {total} files across {len(REPOS)} repos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
