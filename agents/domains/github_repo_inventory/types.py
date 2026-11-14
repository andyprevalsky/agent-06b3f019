"""Types for the GitHub repo inventory domain."""

from typing import TypedDict


class GithubRepoEntry(TypedDict):
    """One connected repo as the root's environment block shows it (public identifiers only)."""

    repo_name: str
    repo_url: str
    # gh:<owner>/<repo>: the github_repo_ref code-agent creation accepts.
    canonical_ref: str
