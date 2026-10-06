#!/usr/bin/env python3
"""Render Prime Agent (PrimeIntellect-ai/prime-agent) prompts to
prompt-review/rendered/prime-agent/<id>.txt.

Prime Agent's system prompt is three markdown layers (include_str!) whose core
layer documents every programmatic tool; skills and factory machines are
markdown files, and the refine / compaction / autonomous prompts are Rust
string constants. This renderer copies the markdown verbatim, slices the core
layer's `## ` sections into per-tool goldens, and extracts the named constants.
"""

from __future__ import annotations

from pathlib import Path

from render_codex import extract_rust_raw_string

ROOT = Path(__file__).resolve().parent.parent.parent
PRIME = ROOT / "prime-agent"
OUT = ROOT / "prompt-review" / "rendered" / "prime-agent"

CORE_LAYER = "crates/pa-core/src/prompts/layers/core.md"

# (id, relative path under prime-agent/)
MARKDOWN_SPECS: list[tuple[str, str]] = [
    ("prime_core_harness", CORE_LAYER),
    ("prime_usage_rules", "crates/pa-core/src/prompts/layers/usage.md"),
    ("prime_opinionated_guidelines", "crates/pa-core/src/prompts/layers/opinionated.md"),
    ("prime_skill_refine", "skills/refine/SKILL.md"),
    ("prime_skill_compact", "skills/compact/SKILL.md"),
    ("prime_skill_goal", "skills/goal/SKILL.md"),
    ("prime_skill_factory", "skills/factory/SKILL.md"),
    ("prime_skill_agent_message", "skills/agent-message/SKILL.md"),
    ("prime_skill_agent_observe", "skills/agent-observe/SKILL.md"),
    ("prime_skill_rlm_heartbeat", "skills/rlm-heartbeat/SKILL.md"),
    ("prime_skill_websearch", "skills/websearch/SKILL.md"),
    ("prime_skill_edit", "skills/edit/SKILL.md"),
    ("prime_skill_mcp", "skills/mcp/SKILL.md"),
    ("prime_skill_skill_creator", "skills/skill-creator/SKILL.md"),
    ("prime_machine_builder", "prime-agent-runtime/src/rlm/machines/builder/MACHINE.md"),
    ("prime_machine_pr_manager", "prime-agent-runtime/src/rlm/machines/pr-manager/MACHINE.md"),
    ("prime_machine_review_sweep", "prime-agent-runtime/src/rlm/machines/review-sweep/MACHINE.md"),
]

# (id, `## ` heading inside the core layer)
CORE_SECTION_SPECS: list[tuple[str, str]] = [
    ("prime_core_tools", "Core tools"),
    ("prime_subagents", "Subagents"),
    ("prime_continual_harness", "Continual Harness"),
]

# (id, relative path under prime-agent/, rust const name)
RUST_CONST_SPECS: list[tuple[str, str, str]] = [
    ("prime_refinement_system", "crates/pa-core/src/refinement/planner.rs", "REFINEMENT_SYSTEM_PROMPT"),
    ("prime_auto_refine_review", "crates/pa-core/src/refinement/planner.rs", "AUTO_REFINE_REVIEW_SYSTEM_PROMPT"),
    ("prime_compaction_system", "crates/pa-core/src/session_engine/compaction_utils.rs", "SUMMARIZATION_SYSTEM_PROMPT"),
    ("prime_compaction_prompt", "crates/pa-core/src/session_engine/compaction.rs", "SUMMARIZATION_PROMPT"),
    ("prime_compaction_update_prompt", "crates/pa-core/src/session_engine/compaction.rs", "UPDATE_SUMMARIZATION_PROMPT"),
    ("prime_autonomous_continuation", "crates/pa-core/src/autonomous/mod.rs", "DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT"),
]


def write(stem: str, content: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    text = content.rstrip() + "\n"
    (OUT / f"{stem}.txt").write_text(text, encoding="utf-8")
    return len(text)


def read(rel: str) -> str:
    path = PRIME / rel
    if not path.exists():
        raise SystemExit(f"[render_prime_agent] missing {rel}")
    return path.read_text(encoding="utf-8")


def extract_section(src: str, heading: str) -> str:
    """Return the `## heading` block up to the next `## ` heading."""
    lines = src.splitlines()
    try:
        start = lines.index(f"## {heading}")
    except ValueError:
        raise ValueError(f"section `## {heading}` not found") from None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    return "\n".join(lines[start:end])


def main() -> int:
    if not PRIME.is_dir():
        raise SystemExit(
            f"[render_prime_agent] missing {PRIME} — run: bash scripts/sync-reference-repos.sh"
        )

    results: list[tuple[str, int]] = []
    for stem, rel in MARKDOWN_SPECS:
        results.append((stem, write(stem, read(rel))))

    core = read(CORE_LAYER)
    for stem, heading in CORE_SECTION_SPECS:
        results.append((stem, write(stem, extract_section(core, heading))))

    for stem, rel, const_name in RUST_CONST_SPECS:
        results.append((stem, write(stem, extract_rust_raw_string(read(rel), const_name))))

    print("Rendered Prime Agent prompts:")
    for stem, size in results:
        print(f"  {stem:<45s} {size:>7d} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
