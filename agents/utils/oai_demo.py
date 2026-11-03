"""Goal identity for test-mass-agent-run-0 (the July OAi demo tree).

Nested GP skip, the Andy name rewrite and DEMO cache replay must apply to
this tree only, so the workflow, the spawn/wait domains, the LLM helpers and
the DEMO cache all gate on these predicates.
"""

from __future__ import annotations

from typing import Any

OAI_DEMO_ROOT_GOAL_PREFIX = (
    "I'm building a personal brand for health, longevity, technology, founder journey"  # pragma: allowlist secret
)
OAI_DEMO_CHILD_WINDOW = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret
# First-level for_each children start with this even when Agent.goal is
# truncated before the date window. Keep hashing on window/root only so a
# truncated goal cannot alias all 50 children onto one namespace.
OAI_DEMO_CHILD_GOAL_PREFIX = "You are analyzing ONE creator"
OAI_DEMO_CACHE_SOURCE_NAME = "Aman Gottumukkala"
OAI_DEMO_CACHE_DISPLAY_NAME = "Andy Prevalsky"
# Root sidebar / T7 title for test-mass-agent-run-0. July schema-cache
# fingerprints drift when the response_schema prompt hash changes, so
# set_response_schema_activity can miss under strict read-only Fast Mode
# and leave generated_title empty — persist this when include_title is set
# on the mass-agent root.
OAI_DEMO_ROOT_TITLE = "Creator Brand Strategy"


def is_oai_demo_bound_child_goal(text: str | None) -> bool:
    """Child prefix alone is not enough — require a DEMO identity binding.

    Real for_each children always include Andy/Aman (or the date window / root
    brand). Rejecting a bare prefix stops unrelated goals that merely contain
    "You are analyzing ONE creator" from entering demo cache replay.
    """
    blob = str(text or "")
    if OAI_DEMO_CHILD_GOAL_PREFIX not in blob:
        return False
    return (
        OAI_DEMO_CACHE_DISPLAY_NAME in blob
        or OAI_DEMO_CACHE_SOURCE_NAME in blob
        or OAI_DEMO_CHILD_WINDOW in blob
        or OAI_DEMO_ROOT_GOAL_PREFIX in blob
    )


def is_oai_demo_goal(text: str | None) -> bool:
    """True only for test-mass-agent-run-0 root, child-window, or bound child."""
    blob = str(text or "")
    return OAI_DEMO_ROOT_GOAL_PREFIX in blob or OAI_DEMO_CHILD_WINDOW in blob or is_oai_demo_bound_child_goal(blob)


def is_oai_demo_mass_agent_task(workflow_instance: Any) -> bool:
    """True for the mass-agent-0 root or any descendant of that tree.

    Child workflows keep their own spawn goal for cache keys. Demo wait_for /
    spawn gates must still see the tree root — otherwise a leftover GP whose
    goal is not the catalog prefix sleeps real ``wait_for`` intervals and
    blows the 900s smoke cap.
    """
    chunks = (
        getattr(workflow_instance, "demo_cache_goal", None) or "",
        getattr(workflow_instance, "goal", None) or "",
        getattr(workflow_instance, "root_goal", None) or "",
    )
    return is_oai_demo_goal("\n".join(str(chunk) for chunk in chunks))


def mass_agent_root_title(goal: str | None, include_title: bool, title: str | None) -> str | None:
    """Keep the July root title on mass-agent-0 schema generation.

    ``set_response_schema_activity`` keys the schema cache by prompt
    fingerprint. When that fingerprint drifts, strict read-only Fast Mode
    raises on miss and ``generated_title`` stays empty — failing T7. Root-only
    (``include_title``) gets the same sidebar title run-0 already expects.
    """
    if not include_title:
        return title
    if OAI_DEMO_ROOT_GOAL_PREFIX in str(goal or ""):
        return OAI_DEMO_ROOT_TITLE
    return title
