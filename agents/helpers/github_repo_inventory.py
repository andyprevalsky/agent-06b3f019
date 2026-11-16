"""The user's projects for the root agent's ``<environment>`` block (pure).

A project IS a GitHub repo or code imported from the user's computer (with its
env files and startup script); the root picks one when it creates a code agent.

    GET /api/projects (owner-scoped; every connected GitHub repo is a project, plus
    projects teammates shared through a team)
        ──▶ compact_projects: {id, name, repoUrl, imported, shared} per project,
            folders (isRepository false: they only organize agents) dropped,
            deduplicated by id, sorted by (name, id)
        ──▶ project_listing: {projects: first MAX_PROJECTS + 1, total} (the activity
            payload; 10k agents: bounded per turn however many projects a user has)
        ──▶ render_projects_section: one line per project (max 25, then an exact
            "+N more" from total), "" when there are none

Only public identifiers ever reach the model: the project id (a lowercase
UUID; anything else drops the entry), a name of plain characters (else the
repo name, else "Untitled project") and ``https://github.com/<owner>/<repo>``.
A URL carrying userinfo (credentials), another host or any other shape is
dropped and the project reads as having no GitHub repo. A shared project names
its owner and team the same way (unsafe owner: "a teammate"; unsafe team:
omitted). The project id is the value code-agent creation takes as
``github_repo_ref``; the backend restores
exactly that project (back-end/src/providers/githubRepos/resolve.ts).

CRITICAL: pure module (no I/O) — imported inside the Temporal workflow sandbox.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

PROJECTS_HEADING = "# Available projects"
MAX_PROJECTS = 25
_PROJECT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_PROJECT_NAME = re.compile(r"^\w[\w .,'()&+#@:/-]{0,99}$")
_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_SCP_GITHUB = re.compile(r"^git@github\.com:([^/\s]+)/([^/\s]+)$")
IMPORTED_LOCATION = "imported from the user's computer (no GitHub repo)"
NO_REPO_LOCATION = "no GitHub repo"
UNTITLED_PROJECT = "Untitled project"
SHARED_OWNER_FALLBACK = "a teammate"
PROJECTS_INSTRUCTION = (
    "These are the user's projects. When creating a code agent, pick the project the task is "
    "about and pass its project id as github_repo_ref; do not guess a project that is not listed."
)
PROJECTS_NONE = "None now: the user has no projects (the earlier list no longer applies)."


def _github_url(owner: str, repo: str) -> Optional[str]:
    repo = repo.removesuffix(".git")
    if not (_SEGMENT.match(owner) and _SEGMENT.match(repo)):
        return None
    return f"https://github.com/{owner}/{repo}"


def _repo_url(value: Any) -> Optional[str]:
    """``https://github.com/<owner>/<repo>`` (an https or ``git@github.com:`` remote, no userinfo); else None."""
    if not isinstance(value, str):
        return None
    scp = _SCP_GITHUB.match(value.strip())
    if scp:
        return _github_url(scp.group(1), scp.group(2))
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname != "github.com" or parts.username or parts.password:
        return None
    if parts.port is not None or parts.query or parts.fragment:
        return None
    segments = [segment for segment in parts.path.split("/") if segment]
    return _github_url(segments[0], segments[1]) if len(segments) == 2 else None


def _imported(entry: Dict[str, Any]) -> bool:
    """Code was synced from the user's computer (compacted ``imported``, else ``sync`` of the API)."""
    if isinstance(entry.get("imported"), bool):
        return entry["imported"]
    sync = entry.get("sync")
    if not isinstance(sync, dict):
        return False
    revision = sync.get("revision")
    synced_revision = isinstance(revision, int) and not isinstance(revision, bool) and revision > 0
    return synced_revision or bool(sync.get("lastSyncedAt"))


def _safe_name(value: Any) -> Optional[str]:
    """A whitespace-collapsed name of plain characters, else None."""
    name = " ".join(value.split()) if isinstance(value, str) else ""
    return name if _PROJECT_NAME.match(name) else None


def _shared(value: Any) -> Optional[Dict[str, Optional[str]]]:
    """``{ownerName, teamName}`` of a project a teammate shared (None: the user's own)."""
    if not isinstance(value, dict):
        return None
    owner = _safe_name(value.get("ownerName")) or SHARED_OWNER_FALLBACK
    return {"ownerName": owner, "teamName": _safe_name(value.get("teamName"))}


def _compact(entry: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(entry, dict) or entry.get("isRepository") is False:
        return None  # a folder only organizes agents; a missing flag (older back-end) is a project
    project_id = entry.get("id")
    if not isinstance(project_id, str) or not _PROJECT_ID.match(project_id):
        return None
    url = _repo_url(entry.get("repoUrl"))
    name = _safe_name(entry.get("name")) or (url.rsplit("/", 1)[1] if url else UNTITLED_PROJECT)
    shared = _shared(entry.get("shared"))
    return {"id": project_id, "name": name, "repoUrl": url, "imported": _imported(entry), "shared": shared}


def compact_projects(payload: Any) -> List[Dict[str, Any]]:
    """GET /api/projects response (``{"projects": [...]}`` or the list) → deduplicated, sorted entries."""
    entries = payload.get("projects") if isinstance(payload, dict) else payload
    by_id: Dict[str, Dict[str, Any]] = {}
    for entry in entries if isinstance(entries, list) else []:
        project = _compact(entry)
        if project is not None:
            by_id.setdefault(project["id"], project)
    return sorted(by_id.values(), key=lambda p: (p["name"].lower(), p["name"], p["id"]))


def project_listing(projects: Any) -> Dict[str, Any]:
    """``{"projects": the first MAX_PROJECTS + 1 compacted entries, "total": all of them}``."""
    compact = compact_projects(projects)
    return {"projects": compact[: MAX_PROJECTS + 1], "total": len(compact)}


def _listing(projects: Any) -> Tuple[List[Dict[str, Any]], int]:
    """(sorted entries, total): a capped ``project_listing`` keeps its total, a plain list counts itself."""
    entries = compact_projects(projects)
    total = projects.get("total") if isinstance(projects, dict) else None
    if isinstance(total, int) and not isinstance(total, bool) and total >= len(entries):
        return entries, total
    return entries, len(entries)


def _location(project: Dict[str, Any]) -> str:
    if project["repoUrl"]:
        return project["repoUrl"]
    return IMPORTED_LOCATION if project["imported"] else NO_REPO_LOCATION


def _line(project: Dict[str, Any]) -> str:
    line = f"- {project['name']} — {_location(project)} (project {project['id']})"
    shared = project["shared"]
    if not shared:
        return line
    team = f" ({shared['teamName']})" if shared["teamName"] else ""
    return f"{line} — shared by {shared['ownerName']}{team}"


def render_projects_section(projects: Any) -> str:
    """The project section of the root ``<environment>`` block (a list or a listing); "" when there are none."""
    entries, total = _listing(projects)
    if not entries:
        return ""
    shown = entries[:MAX_PROJECTS]
    lines = [PROJECTS_HEADING, "", PROJECTS_INSTRUCTION]
    lines.extend(_line(p) for p in shown)
    hidden = total - len(shown)
    if hidden > 0:
        lines.append(f"+{hidden} more projects")
    return "\n".join(lines)


def previous_projects_section(block: Optional[str]) -> str:
    """The project section of an already rendered ``<environment>`` block ("" when it had none)."""
    if not block:
        return ""
    start = block.find("\n" + PROJECTS_HEADING)
    if start < 0:
        return ""
    end = block.rfind("\n</environment>")
    return block[start + 1 : end if end > start else len(block)].rstrip()


def projects_section(projects: Optional[Any], previous_section: str = "") -> str:
    """The root's project section given the live list and the section it was last shown.

    None (fetch failed) keeps the last section unchanged; an empty list after a shown
    one says so explicitly; a list that was never shown and is empty stays omitted.
    """
    if projects is None:
        return previous_section
    section = render_projects_section(projects)
    if section or not previous_section:
        return section
    return f"{PROJECTS_HEADING}\n\n{PROJECTS_NONE}"


__all__ = [
    "MAX_PROJECTS",
    "PROJECTS_HEADING",
    "PROJECTS_NONE",
    "compact_projects",
    "previous_projects_section",
    "project_listing",
    "projects_section",
    "render_projects_section",
]
