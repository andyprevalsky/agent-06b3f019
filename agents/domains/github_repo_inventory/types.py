"""Types for the project inventory domain."""

from typing import Optional, TypedDict


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
