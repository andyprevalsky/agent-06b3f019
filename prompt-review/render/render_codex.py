#!/usr/bin/env python3
"""Render Codex (openai/codex) prompts to prompt-review/rendered/codex/<id>.txt.

Codex ships most prompt text as markdown templates (include_str!) plus a few
Rust raw-string constants for multi-agent role hints. This renderer copies the
markdown verbatim and extracts the named Rust string constants.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CODEX = ROOT / "codex"
OUT = ROOT / "prompt-review" / "rendered" / "codex"

# (id, relative path under codex/, optional rust const name for .rs files)
MARKDOWN_SPECS: list[tuple[str, str]] = [
    ("codex_base_instructions", "codex-rs/protocol/src/prompts/base_instructions/default.md"),
    ("codex_models_manager_prompt", "codex-rs/models-manager/prompt.md"),
    ("codex_gpt52_codex_prompt", "codex-rs/core/gpt-5.2-codex_prompt.md"),
    ("codex_gpt52_codex_instructions_template", "codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md"),
    ("codex_gpt51_codex_max_prompt", "codex-rs/core/gpt-5.1-codex-max_prompt.md"),
    ("codex_orchestrator", "codex-rs/core/templates/agents/orchestrator.md"),
    ("codex_compact_prompt", "codex-rs/prompts/templates/compact/prompt.md"),
    ("codex_persistent_mode", "codex-rs/prompts/templates/persistent_mode.md"),
    ("codex_collab_experimental", "codex-rs/core/templates/collab/experimental_prompt.md"),
    ("codex_guardian_classifier", "codex-rs/prompts/templates/guardian/classifier_instructions.md"),
    ("codex_sandbox_workspace_write", "codex-rs/prompts/templates/permissions/sandbox_mode/workspace_write.md"),
    ("codex_sandbox_read_only", "codex-rs/prompts/templates/permissions/sandbox_mode/read_only.md"),
    ("codex_sandbox_danger_full_access", "codex-rs/prompts/templates/permissions/sandbox_mode/danger_full_access.md"),
    ("codex_approval_on_request", "codex-rs/prompts/templates/permissions/approval_policy/on_request.md"),
    ("codex_realtime_backend", "codex-rs/prompts/templates/realtime/backend_prompt.md"),
    ("codex_review_rubric", "codex-rs/prompts/templates/review/rubric.md"),
]

RUST_CONST_SPECS: list[tuple[str, str, str]] = [
    (
        "codex_multi_agent_root",
        "codex-rs/prompts/src/model_messages/multi_agent.rs",
        "DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT",
    ),
    (
        "codex_multi_agent_subagent",
        "codex-rs/prompts/src/model_messages/multi_agent.rs",
        "DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT",
    ),
    (
        "codex_multi_agent_shared_hint",
        "codex-rs/prompts/src/multi_agent_instructions.rs",
        "DEFAULT_MULTI_AGENT_V2_SHARED_USAGE_HINT_TEXT",
    ),
]


def write(stem: str, content: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    text = content.rstrip() + "\n"
    (OUT / f"{stem}.txt").write_text(text, encoding="utf-8")
    return len(text)


def extract_rust_raw_string(src: str, const_name: str) -> str:
    """Extract `const NAME: &str = r#"..."#;` (or plain `"..."`) body."""
    # Prefer raw string r#"..."#
    m = re.search(
        rf'const\s+{re.escape(const_name)}\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#\s*;',
        src,
    )
    if m:
        return m.group(1)
    # Fallback: concatenated / plain string — capture until trailing `;`
    m = re.search(
        rf'const\s+{re.escape(const_name)}\s*:\s*&str\s*=\s*"((?:\\.|[^"\\])*)"\s*;',
        src,
    )
    if m:
        return bytes(m.group(1), "utf-8").decode("unicode_escape")
    raise ValueError(f"const {const_name} not found")


def main() -> int:
    if not CODEX.is_dir():
        raise SystemExit(
            f"[render_codex] missing {CODEX} — run: bash scripts/sync-reference-repos.sh"
        )

    results: list[tuple[str, int]] = []
    for stem, rel in MARKDOWN_SPECS:
        path = CODEX / rel
        if not path.exists():
            raise SystemExit(f"[render_codex] missing {rel}")
        results.append((stem, write(stem, path.read_text(encoding="utf-8"))))

    for stem, rel, const_name in RUST_CONST_SPECS:
        path = CODEX / rel
        if not path.exists():
            raise SystemExit(f"[render_codex] missing {rel}")
        body = extract_rust_raw_string(path.read_text(encoding="utf-8"), const_name)
        results.append((stem, write(stem, body)))

    print("Rendered Codex prompts:")
    for stem, size in results:
        print(f"  {stem:<45s} {size:>7d} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
