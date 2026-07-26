"""Generation-scoped production task-queue resolution for zero-downtime cutover.

Each replay-surface generation gets its own Temporal task queue,
`<base>@<surfaceHash>`, where `surfaceHash` is the workflow replay-surface hash
(scripts/agent_workflow_surface_hash.py, provided to the worker as
`TEMPORAL_WORKER_SURFACE_HASH`). A worker only ever polls its own generation's
queue, so it can never be handed a workflow history produced by a different
build — that is what makes the kill-and-respawn cutover both correct (no
nondeterministic replay) and zero-downtime (new-generation workers serve new
work immediately; old-generation workers keep serving theirs until drained).

When no surface hash is provided the worker polls the plain base queue — the
pre-cutover behavior — so this is fully backward-compatible.
"""

from __future__ import annotations

# Separator between the base queue name and the generation surface hash. Chosen
# so a generation queue is visually distinct and cannot collide with the plain
# base queue name.
GENERATION_QUEUE_SEPARATOR = "@"


def resolve_production_task_queue(base_task_queue: str, surface_hash: str | None) -> str:
    """Return the generation-scoped production queue this worker should poll.

    `resolve_production_task_queue("navi-agent-tasks", "abc123")`
        -> "navi-agent-tasks@abc123"
    `resolve_production_task_queue("navi-agent-tasks", None)`  (or "")
        -> "navi-agent-tasks"   (backward-compatible plain queue)
    """
    if not base_task_queue:
        raise ValueError("base_task_queue is required to resolve a production queue")
    normalized = surface_hash.strip() if surface_hash else ""
    if not normalized:
        return base_task_queue
    if GENERATION_QUEUE_SEPARATOR in normalized:
        raise ValueError(
            f"surface hash must not contain '{GENERATION_QUEUE_SEPARATOR}': {surface_hash!r}"
        )
    return f"{base_task_queue}{GENERATION_QUEUE_SEPARATOR}{normalized}"


def generation_of_queue(task_queue: str) -> str | None:
    """Inverse: extract the surface hash from a generation queue, or None if plain."""
    base, sep, gen = task_queue.partition(GENERATION_QUEUE_SEPARATOR)
    return gen if sep and gen else None
