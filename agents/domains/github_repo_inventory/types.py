"""Types for the GitHub repo inventory domain."""

from typing import NotRequired, TypedDict


class GithubRepoEntry(TypedDict):
    """One connected repo as the root's environment block shows it (public identifiers only)."""

    repo_name: str
    repo_url: str
    # gh:<owner>/<repo>: the github_repo_ref code-agent creation accepts.
    canonical_ref: str
    # A teammate's repo shared with one of the user's teams: sanitized display names.
    shared_by: NotRequired[str]
    shared_team: NotRequired[str]
