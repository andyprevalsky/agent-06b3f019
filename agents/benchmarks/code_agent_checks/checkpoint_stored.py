"""The code session's close checkpoint is stored, and stays small.

Every code-agent task close writes a platform checkpoint (back-end
providers/codeSessions/checkpoint.ts: worktree.tar.gz + repo bundle + CLI log).
The Rose checkout grew past the per-artifact cap (209,715,200 bytes) because each
close re-stored the unchanged tracked working tree: 208.2 MB when the benchmark
qualified, then ``Checkpoint worktree is 210456698 bytes (cap 209715200); refusing
to store`` on every close, which is best-effort and therefore silent to the run.
The archive now holds only what git cannot reproduce (modified, untracked and
ignored files), so a read-only task's checkpoint is kilobytes.

Check config: {"type": "code_agent_checkpoint_stored", "max_fraction_of_cap": F,
"min_checkpoints": 1, "cap_bytes": 209715200}. Passes when no close checkpoint
failed, at least ``min_checkpoints`` were stored, and each stored checkpoint is at
most F of the cap. Fails closed when the run has no checkpoint evidence or no
fraction is configured. The evidence is the run's own isolated backend log
(``evidence.checkpoints``).
"""

from __future__ import annotations

CHECK_TYPE = "code_agent_checkpoint_stored"
DEFAULT_CAP_BYTES = 200 * 1024 * 1024


def _mib(value: float) -> str:
    return f"{value / (1024 * 1024):.1f} MiB"


def check(evidence: dict, config: dict) -> tuple[bool, str]:
    fraction = config.get("max_fraction_of_cap")
    if not isinstance(fraction, (int, float)) or not 0 < fraction <= 1:
        return False, f"{CHECK_TYPE}: max_fraction_of_cap must be a number in (0, 1]"
    checkpoints = evidence.get("checkpoints")
    if not isinstance(checkpoints, dict):
        return False, f"{CHECK_TYPE}: the run recorded no checkpoint evidence"
    stored = checkpoints.get("stored") or []
    failed = checkpoints.get("failed") or []
    cap = int(config.get("cap_bytes") or DEFAULT_CAP_BYTES)
    limit = cap * float(fraction)
    minimum = int(config.get("min_checkpoints", 1))

    problems = []
    for failure in failed:
        sized = f" ({_mib(failure['worktree_bytes'])} against a {_mib(failure['cap_bytes'])} cap)" if failure.get("worktree_bytes") and failure.get("cap_bytes") else ""
        problems.append(
            f"close checkpoint for session {str(failure.get('codeSessionId'))[:8]} failed{sized}: "
            f"{str(failure.get('error') or '')[:160]}"
        )
    if len(stored) < minimum:
        problems.append(f"{len(stored)} checkpoint(s) stored, need at least {minimum}")
    for checkpoint in stored:
        size = checkpoint.get("bytes")
        if not isinstance(size, int) or size > limit:
            problems.append(
                f"checkpoint {str(checkpoint.get('codeSessionId'))[:8]}#{checkpoint.get('seq')} stored "
                f"{_mib(size) if isinstance(size, int) else size} over the {_mib(limit)} budget "
                f"({fraction:.0%} of the {_mib(cap)} cap)"
            )
    detail = "; ".join(
        f"{str(item.get('codeSessionId'))[:8]}#{item.get('seq')} {item.get('reason')} {_mib(item['bytes'])}"
        for item in stored
        if isinstance(item.get("bytes"), int)
    )
    if problems:
        return False, f"{CHECK_TYPE} failed: {'; '.join(problems)} || stored: {detail or 'none'}"
    return True, f"{CHECK_TYPE} ok: {len(stored)} stored, each within {fraction:.0%} of the cap || {detail}"
