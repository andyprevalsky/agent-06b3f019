"""Attempt-completion domain service — business logic orchestration.

Pure logic layer: constructs the completion result.  The handler layer
owns I/O (posting tool events) so that patching in tests stays simple.
"""

from __future__ import annotations

from domains.attempt_completion.types import CompletionResult


def build_completion_result() -> CompletionResult:
    """Return the standard completion-attempt result.

    The workflow runs a verifier after receiving this to confirm
    whether the agent's phase/task is truly complete.
    """
    return CompletionResult(attempted=True)
