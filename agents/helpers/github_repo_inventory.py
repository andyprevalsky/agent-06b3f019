"""The user's projects for the root agent's ``<environment>`` block (pure).

A project IS a GitHub repo or code imported from the user's computer (with its
env files and startup script); the root picks one when it creates a code agent.

    GET /api/projects (owner-scoped; every connected GitHub repo is a project, plus
    projects teammates shared through a team)
        ──▶ compact_projects: {id, name, repoUrl, imported, shared} per project,
            folders (isRepository false: they only organize agents) dropped,
            deduplicated by id, sorted by (name, id)
    GET /api/integrations/github/repos (the user's connected repos, plus repos
    teammates share with the user's teams, main #2238)
        ──▶ compact_github_repos: {repo_name, repo_url, canonical_ref, owner,
            [shared_by, shared_team]} per repo, deduplicated by canonical_ref
            (the user's own connection wins over a teammate's share)
        ──▶ project_listing: projects, then the repos no listed project covers
            (same canonical gh: ref), sorted together by (name, id or ref);
            {projects, repos: the first MAX_PROJECTS + 1 of both, total} (the
            activity payload; 10k agents: bounded per turn however many a user has)
        ──▶ render_projects_section: one line per project or repo (max 25, then an
            exact "+N more" from total), "" when there are none

Only public identifiers ever reach the model: the project id (a lowercase
UUID; anything else drops the entry), a name of plain characters (else the
repo name, else "Untitled project") and ``https://github.com/<owner>/<repo>``.
A URL carrying userinfo (credentials), another host or any other shape is
dropped and the project reads as having no GitHub repo. A shared project names
its owner and team the same way (unsafe owner: "a teammate"; unsafe team:
omitted). A listed repo shows its canonical ``gh:<owner>/<repo>`` ref
(back-end/src/providers/githubRepos/refs.ts; a malformed ref or one naming
another repo than the URL drops it) and, for a teammate's share, its owner's
display name and the team name (unsafe characters removed, quoted). The
project id or the gh: ref is the value code-agent creation takes as
``github_repo_ref``; the backend restores exactly that project or repo
(back-end/src/providers/githubRepos/resolve.ts).

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
_CANONICAL_REF = re.compile(r"^gh:([a-z0-9_.-]+)/([a-z0-9_.-]+)$")
# Display names are user-chosen: keep letters, digits and plain punctuation only.
_DISPLAY_UNSAFE = re.compile(r"[^\w .,&'()+-]")
MAX_DISPLAY_NAME = 60
_PUBLIC_REPO_KEYS = ("repo_name", "repo_url", "canonical_ref", "shared_by", "shared_team")
IMPORTED_LOCATION = "imported from the user's computer (no GitHub repo)"
NO_REPO_LOCATION = "no GitHub repo"
UNTITLED_PROJECT = "Untitled project"
SHARED_OWNER_FALLBACK = "a teammate"
PROJECTS_INSTRUCTION = (
    "These are the user's projects. When creating a code agent, pick the project the task is "
    "about and pass the project id or gh: ref shown in parentheses as github_repo_ref; do not "
    "guess a project that is not listed."
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


# ------------------------------------------------------------- GitHub repos (main #2238)


def _display_name(value: Any) -> Optional[str]:
    """A one-line, quote-free, bounded display name, or None."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(_DISPLAY_UNSAFE.sub(" ", value).split())[:MAX_DISPLAY_NAME].strip()
    return cleaned or None


def _sharing(entry: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """``shared_by`` / ``shared_team`` of a teammate's shared repo (backend or compacted form)."""
    shared = entry.get("shared")
    if isinstance(shared, dict):
        owner, team = shared.get("owner_name"), shared.get("team_name")
    elif "shared_team" in entry:
        owner, team = entry.get("shared_by"), entry.get("shared_team")
    else:
        return None
    return {"shared_by": _display_name(owner) or "a teammate", "shared_team": _display_name(team) or "your team"}


def _compact_repo(entry: Any) -> Optional[Dict[str, str]]:
    if not isinstance(entry, dict):
        return None
    ref = entry.get("canonical_ref")
    match = _CANONICAL_REF.match(ref) if isinstance(ref, str) else None
    url = _repo_url(entry.get("repo_url"))
    if match is None or url is None:
        return None
    owner, repo = url.removeprefix("https://github.com/").split("/")
    canonical_ref = match.group(0)
    if f"gh:{owner}/{repo}".lower() != canonical_ref:
        return None  # URL and ref name different repositories
    name = entry.get("repo_name")
    return {
        "repo_name": name if isinstance(name, str) and _SEGMENT.match(name) else repo,
        "repo_url": url,
        "canonical_ref": canonical_ref,
        "owner": owner,
        **(_sharing(entry) or {}),
    }


def compact_github_repos(payload: Any) -> List[Dict[str, str]]:
    """Inventory response (``{"repos": [...]}`` or the list) → deduplicated, sorted entries."""
    entries = payload.get("repos") if isinstance(payload, dict) else payload
    by_ref: Dict[str, Dict[str, str]] = {}
    for entry in entries if isinstance(entries, list) else []:
        repo = _compact_repo(entry)
        if repo is None:
            continue
        known = by_ref.get(repo["canonical_ref"])
        if known is None or ("shared_team" in known and "shared_team" not in repo):
            by_ref[repo["canonical_ref"]] = repo
    return sorted(by_ref.values(), key=lambda r: (r["owner"].lower(), r["repo_name"].lower(), r["canonical_ref"]))


# ------------------------------------------------------------- one list, one cap


def _sort_key(entry: Dict[str, Any]) -> Tuple[str, str, str]:
    name = entry["name"] if "id" in entry else entry["repo_name"]
    return (name.lower(), name, entry["id"] if "id" in entry else entry["canonical_ref"])


def _merged(projects: Any, repos: Any) -> List[Dict[str, Any]]:
    """Projects plus the repos no listed project covers (same canonical gh: ref), sorted together."""
    listed = compact_projects(projects)
    covered = {f"gh:{p['repoUrl'].removeprefix('https://github.com/')}".lower() for p in listed if p["repoUrl"]}
    extra = [repo for repo in compact_github_repos(repos) if repo["canonical_ref"] not in covered]
    return sorted([*listed, *extra], key=_sort_key)


def project_listing(projects: Any, repos: Any = ()) -> Dict[str, Any]:
    """``{"projects", "repos": the first MAX_PROJECTS + 1 entries of both, "total": all of them}``."""
    entries = _merged(projects, repos)
    kept = entries[: MAX_PROJECTS + 1]
    return {
        "projects": [entry for entry in kept if "id" in entry],
        "repos": [{k: entry[k] for k in _PUBLIC_REPO_KEYS if k in entry} for entry in kept if "id" not in entry],
        "total": len(entries),
    }


def _listing(payload: Any) -> Tuple[List[Dict[str, Any]], int]:
    """(sorted entries, total): a capped ``project_listing`` keeps its total, a plain list counts itself."""
    listing = isinstance(payload, dict) and ("projects" in payload or "repos" in payload)
    entries = _merged(payload, payload) if listing else _merged(payload, ())
    total = payload.get("total") if isinstance(payload, dict) else None
    if isinstance(total, int) and not isinstance(total, bool) and total >= len(entries):
        return entries, total
    return entries, len(entries)


def _location(project: Dict[str, Any]) -> str:
    if project["repoUrl"]:
        return project["repoUrl"]
    return IMPORTED_LOCATION if project["imported"] else NO_REPO_LOCATION


def _repo_line(repo: Dict[str, str]) -> str:
    line = f"- {repo['repo_name']} — {repo['repo_url']} ({repo['canonical_ref']})"
    if "shared_team" not in repo:
        return line
    return f'{line} — a teammate\'s repo, shared by "{repo["shared_by"]}" with team "{repo["shared_team"]}"'


def _line(project: Dict[str, Any]) -> str:
    if "id" not in project:
        return _repo_line(project)
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
    "compact_github_repos",
    "compact_projects",
    "previous_projects_section",
    "project_listing",
    "projects_section",
    "render_projects_section",
]
