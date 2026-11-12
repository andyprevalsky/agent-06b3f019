"""Explicit GitHub repo selection (``github_repo_ref``) forwarded by spawns to the backend.

The backend resolves every spelling (``gh:owner/repo``, a GitHub URL, ``owner/repo``,
a Rose project id or ``rose-project:<id>``) against the user's connected repos and owns
the precedence (back-end/src/providers/githubRepos/resolve.ts):

    explicit github_repo_ref > trusted server repo > explicit project's repo >
    parent agent's ref > inherited project's repo

This side forwards only what the caller explicitly selected. Inheritance stays with the
backend, which reads the parent's (or the agent's) persisted Agent.githubRepoRef from
``parent_agent_id`` / ``agent_id``; an inherited ref is never sent as an explicit one,
and an explicit ref is never dropped in favour of an inherited one. A ref that is not
connected fails with an error naming it: agent create answers 404, code-session create
answers 403 ``GITHUB_ACCESS_DENIED``.
"""

from __future__ import annotations

from typing import Any, Optional

# Agent create (POST /api/agents, /api/agents/batch) answered 404 for the explicit ref.
GITHUB_REPO_NOT_CONNECTED_CODE = "GITHUB_REPO_NOT_CONNECTED"
# Code-session create answered 403 GITHUB_ACCESS_DENIED for the explicit ref.
GITHUB_REPO_REF_DENIED_CODE = "GITHUB_REPO_REF_DENIED"


def explicit_github_repo_ref(value: Any) -> Optional[str]:
    """The caller's explicit ``github_repo_ref`` (trimmed), or None when it selected none."""
    if not isinstance(value, str):
        return None
    ref = value.strip()
    return ref or None


def is_repo_not_connected_response(status_code: int, response_text: str) -> bool:
    """Agent create rejected the explicit ref (404 ``GitHub repo not connected``)."""
    return status_code == 404 and "github repo" in response_text.lower()


def repo_not_connected_message(ref: str, detail: str) -> str:
    return (
        f"GitHub repo {ref!r} is not connected for this user ({detail}). The agent was not "
        "created and no other repo was used. Connect the repo in Integrations, or pass the "
        "github_repo_ref of a connected repo."
    )


def repo_ref_denied_message(ref: str, detail: str) -> str:
    return (
        f"GitHub repo {ref!r} is not connected or not accessible for this user "
        f"(GITHUB_ACCESS_DENIED: {detail}). The code agent was not started on any other repo. "
        "Connect the repo in Integrations, or pass the github_repo_ref of a connected repo."
    )
