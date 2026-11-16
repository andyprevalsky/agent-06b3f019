"""Types for the project inventory domain (projects + GitHub repos)."""

from typing import NotRequired, Optional, TypedDict


class GithubRepoEntry(TypedDict):
    """One connected repo as the root's environment block shows it (public identifiers only)."""

    repo_name: str
    repo_url: str
    # gh:<owner>/<repo>: the github_repo_ref code-agent creation accepts.
    canonical_ref: str
    # A teammate's repo shared with one of the user's teams: sanitized display names.
    shared_by: NotRequired[str]
    shared_team: NotRequired[str]


class SharedBy(TypedDict):
    """Owner and team of a project a teammate shared (sanitized; teamName None when unsafe)."""

    ownerName: str
    teamName: Optional[str]


class ProjectEntry(TypedDict):
    """One project as the root's environment block shows it (public identifiers only)."""

    # Rose project id: the github_repo_ref code-agent creation accepts.
    id: str
    name: str
    # https://github.com/<owner>/<repo>, or None (no GitHub repo).
    repoUrl: Optional[str]
    # Code was synced from the user's computer (rose push).
    imported: bool
    # Set when a teammate shared it through a team (their env files stay private).
    shared: Optional[SharedBy]
