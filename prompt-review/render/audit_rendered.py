#!/usr/bin/env python3
"""Audit every rendered prompt for malformedness.

Runs a battery of checks per file. Prints a categorized report of
suspected issues — sorted by severity (high → low). Output is consumed
by humans + downstream sub-agents.

Categories:
  CRITICAL   — clearly broken (empty, source code at col 0, raw JS keywords)
  HIGH       — likely problem (unresolved ${var}, truncated, shrapnel)
  MEDIUM     — annotation leakage (HTML comments, box separators, labels)
  LOW        — cosmetic (excessive blank lines, leading whitespace)
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RENDERED_ROOT = ROOT / "prompt-review" / "rendered"
CATALOG = json.loads((ROOT / "prompt-review" / "catalog.json").read_text())

# IDs that are LEGITIMATELY JSON schemas (Hermes tool dicts, our browser
# tool defs) — those should NOT be flagged for "JSON-like content".
JSON_OK_IDS = {
    "browser_tool_observe", "browser_tool_extract", "browser_tool_click",
    "browser_tool_fill", "browser_tool_type", "browser_tool_press_key",
    "browser_tool_goto", "browser_tool_scroll", "browser_tool_wait",
    "browser_tool_attempt_completion", "browser_tool_screenshot",
    "browser_tool_aria_tree", "browser_tool_navback",
    "browser_tool_click_at_coordinates",
    "SPAWN_PARAM_REQUIREMENTS",
    "hermes_web_search_tool", "hermes_web_extract_tool",
    "hermes_terminal_tool", "hermes_delegate_tool", "hermes_clarify_tool",
}

# IDs whose content is intentionally short.
SHORT_OK_IDS = {
    "vapi_base_system_prompt",       # ~250 chars
    "claude_getCLISyspromptPrefix",  # one-liner
    "openclaw_message_tool",         # one-line description
    "hermes_session_search_guidance", # ~190 chars guidance
    "hermes_skills_guidance",        # short skills note
    "hermes_default_agent_identity", # ~500 chars identity
}


def _preview(text: str, max_chars: int = 80) -> str:
    snippet = text.strip().split("\n", 1)[0]
    return (snippet[:max_chars] + "…") if len(snippet) > max_chars else snippet


def audit_one(repo: str, idx: str, text: str) -> list[tuple[str, str, str]]:
    """Return a list of (severity, category, evidence) issues."""
    issues: list[tuple[str, str, str]] = []
    raw = text
    stripped = text.strip()

    # CRITICAL — empty / nearly-empty
    if len(stripped) < 30:
        issues.append(("CRITICAL", "empty",
                       f"only {len(stripped)} chars — almost certainly broken"))
        return issues
    if len(stripped) < 100 and idx not in SHORT_OK_IDS:
        issues.append(("HIGH", "very-short",
                       f"only {len(stripped)} chars — verify against source"))

    is_json = (
        stripped.startswith("{") and stripped.endswith("}")
        or stripped.startswith("[") and stripped.endswith("]")
    )
    json_ok = idx in JSON_OK_IDS or is_json

    # CRITICAL — JS / TS source keywords at column 0 (skip if inside a
    # legitimate <code> block, which our prompts contain as examples).
    if not json_ok:
        for line_no, line in enumerate(text.split("\n"), 1):
            if not line or line[0] in (" ", "\t"):
                continue
            stripped_line = line.lstrip()
            if (
                stripped_line.startswith((
                    "export const ", "export async function ", "export function ",
                    "export type ", "export default ",
                    "import ", "import {", "require(",
                ))
                or re.match(r"^const\s+[A-Z_a-z]", stripped_line)
                or re.match(r"^let\s+[A-Z_a-z]", stripped_line)
                or re.match(r"^var\s+[A-Z_a-z]", stripped_line)
            ):
                issues.append(("CRITICAL", "js-source-code",
                               f"line {line_no}: {_preview(line, 80)}"))
                break

    # CRITICAL — Python source keywords at column 0
    if not json_ok:
        for line_no, line in enumerate(text.split("\n"), 1):
            if not line or line[0] in (" ", "\t"):
                continue
            stripped_line = line.lstrip()
            if (
                stripped_line.startswith(("def ", "async def ", "class "))
                or re.match(r"^from\s+\w+\s+import", stripped_line)
                or re.match(r"^import\s+\w+", stripped_line)
            ):
                # `def get_system_prompt` and friends — historical functions.
                # CURRENT files should NEVER have these.
                issues.append(("CRITICAL", "py-source-code",
                               f"line {line_no}: {_preview(line, 80)}"))
                break

    # HIGH — unresolved ${variable} interpolations (TS template literals)
    interp_matches = re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_.()\s\?\:'\"!=&|+\-*/]*?)\}", text)
    if interp_matches:
        # Filter known-OK: e.g. ${something} that's a literal regex placeholder
        # and shouldn't be substituted (rare). Flag anything left.
        head = ", ".join(sorted(set(interp_matches))[:5])
        issues.append(("HIGH", "unresolved-interp",
                       f"{len(interp_matches)} `${{...}}` interpolations: {head}…"))

    # NOTE: Python `{var}` style placeholders are LEGITIMATE runtime
    # substitution markers in our prompts (the .format(...) call substitutes
    # them with real values when the prompt is sent to the LLM). The
    # template form is what gets reviewed/edited by humans, so leaving them
    # as `{var}` is the correct rendering. Not flagged.

    # HIGH — apostrophe-escape regex artifacts (word fragments at line start)
    fragments = re.findall(r"^(?:t|s|re|ve|ll|d|m)\s+\w+\s+\w+", text, re.M)
    if fragments:
        issues.append(("HIGH", "apostrophe-fragments",
                       f"{len(fragments)} word fragments from \\' regex bug: "
                       f"{fragments[0][:60]}…"))

    # HIGH — JS module-path strings (left over from concat-style extraction)
    paths = re.findall(r"['\"](\.{1,2}/[\w./\-]+\.(?:js|ts|tsx|mjs))['\"]", text)
    if paths:
        issues.append(("HIGH", "module-path-strings",
                       f"{len(paths)} JS-module-path strings: {paths[0][:60]}…"))

    # HIGH — `[truncated]` marker
    if "[truncated]" in text or stripped.endswith("...[truncated]"):
        issues.append(("HIGH", "truncated", "ends with [truncated]"))

    # MEDIUM — HTML comments (renderer annotations)
    if "<!--" in text and "-->" in text:
        m = re.search(r"<!--.{0,80}-->", text)
        evidence = (m.group(0) if m else "...")[:80]
        issues.append(("MEDIUM", "html-comment", f"contains HTML comment: {evidence}"))

    # MEDIUM — box separators
    if re.search(r"^[─━═]{2,}\s*$", text, re.M):
        issues.append(("MEDIUM", "box-separator", "leftover ─/━/═ separator line"))

    # MEDIUM — annotation labels like (DEFAULT_PREFIX)
    label_matches = re.findall(r"^\(([A-Z][A-Z_]+)\)\s*$", text, re.M)
    if label_matches:
        issues.append(("MEDIUM", "label-annotation",
                       f"label-style annotation: ({label_matches[0]})"))

    # MEDIUM — `--- text ---` separator lines
    sep_matches = re.findall(r"^---\s+\w[^-\n]*---\s*$", text, re.M)
    if sep_matches:
        issues.append(("MEDIUM", "dash-separator",
                       f"separator: {sep_matches[0][:50]}"))

    # MEDIUM — IMPORTED FROM markers
    if re.search(r"^IMPORTED FROM .*:\s*$", text, re.M):
        issues.append(("MEDIUM", "imported-from-marker",
                       "leftover IMPORTED FROM ... marker"))

    # MEDIUM — `# Default fallback ...` / `# With channel-aware ...` annotations
    annotation_matches = re.findall(
        r"^#\s+(Default fallback|With channel-aware|With .* discovery|Without .*).*$",
        text, re.M,
    )
    if annotation_matches:
        issues.append(("MEDIUM", "renderer-annotation-comment",
                       f"renderer annotation: # {annotation_matches[0][:50]}…"))

    # MEDIUM — literal `\n` escapes left raw
    if not is_json and re.search(r"(?<!\n)\\n[^a-zA-Z]", text):
        # Count non-newline `\n` occurrences (literal escape, not actual newline)
        n = len(re.findall(r"(?<!\n)\\n[^a-zA-Z]", text))
        if n >= 3:
            issues.append(("MEDIUM", "literal-newline-escape",
                           f"{n} `\\\\n` literals (escape, not newline)"))

    # MEDIUM — open/close pairs that look unbalanced (e.g. backticks)
    if text.count("```") % 2 != 0 and stripped.endswith("```"):
        issues.append(("LOW", "fence-balance", "odd number of ``` fences"))

    # LOW — leading/trailing whitespace, double blank lines
    if text != text.lstrip():
        issues.append(("LOW", "leading-whitespace", "starts with whitespace"))
    if re.search(r"\n{4,}", text):
        issues.append(("LOW", "many-blank-lines", "4+ consecutive blank lines"))

    return issues


def main() -> int:
    all_issues: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    total_files = 0
    files_with_issues = 0

    for repo in sorted(RENDERED_ROOT.iterdir()):
        if not repo.is_dir():
            continue
        for f in sorted(repo.glob("*.txt")):
            total_files += 1
            text = f.read_text()
            idx = f.stem
            issues = audit_one(repo.name, idx, text)
            if issues:
                files_with_issues += 1
                for sev, cat, evidence in issues:
                    all_issues[sev][cat].append({
                        "repo": repo.name, "id": idx, "evidence": evidence,
                    })

    print(f"=== Audit: {files_with_issues} of {total_files} files have issues ===\n")
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        if sev not in all_issues:
            continue
        cats = all_issues[sev]
        sev_total = sum(len(v) for v in cats.values())
        print(f"\n## {sev} ({sev_total})")
        for cat, items in sorted(cats.items(), key=lambda kv: -len(kv[1])):
            print(f"\n### {cat} — {len(items)}")
            for it in items[:25]:
                print(f"  {it['repo']}/{it['id']}: {it['evidence']}")
            if len(items) > 25:
                print(f"  ... and {len(items) - 25} more")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
