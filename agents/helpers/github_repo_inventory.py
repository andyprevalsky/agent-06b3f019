"""Connected GitHub repos for the root agent's ``<environment>`` block (pure).

    GET /api/integrations/github/repos (owner-scoped, connected + still granted)
        ──▶ compact_github_repos: {repo_name, repo_url, canonical_ref} per repo,
            deduplicated by canonical_ref, sorted by (owner, repo_name)
        ──▶ render_github_repos_section: one line per repo, "" when there are none

Only the three public identifiers ever reach the model, plus, for a
teammate's repo shared with one of the user's teams, its owner's display name
and the team name (sanitized, quoted): a URL carrying userinfo (credentials),
a non-GitHub URL or a malformed canonical ref drops the entry instead of being
rendered. The user's own connection of a repo always wins over a shared one. The canonical ref (``gh:<owner>/<repo>``,
back-end/src/providers/githubRepos/refs.ts) is the value code-agent creation
takes as ``github_repo_ref``.

CRITICAL: pure module (no I/O) — imported inside the Temporal workflow sandbox.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

GITHUB_REPOS_HEADING = "# Available GitHub repositories"
MAX_GITHUB_REPOS = 25
_CANONICAL_REF = re.compile(r"^gh:([a-z0-9_.-]+)/([a-z0-9_.-]+)$")
_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
# Display names are user-chosen: keep letters, digits and plain punctuation only.
_DISPLAY_UNSAFE = re.compile(r"[^\w .,&'()+-]")
MAX_DISPLAY_NAME = 60


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


def _repo_url(value: Any) -> Optional[str]:
    """``https://github.com/<owner>/<repo>`` without userinfo, query or fragment; else None."""
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname != "github.com" or parts.username or parts.password:
        return None
    if parts.port is not None or parts.query or parts.fragment:
        return None
    segments = [segment for segment in parts.path.split("/") if segment]
    if len(segments) != 2 or not all(_NAME.match(segment) for segment in segments):
        return None
    return f"https://github.com/{segments[0]}/{segments[1]}"


def _compact(entry: Any) -> Optional[Dict[str, str]]:
    if not isinstance(entry, dict):
        return None
    ref = entry.get("canonical_ref")
    match = _CANONICAL_REF.match(ref) if isinstance(ref, str) else None
    url = _repo_url(entry.get("repo_url"))
    if match is None or url is None:
        return None
    owner, repo = url.removeprefix("https://github.com/").split("/")
    if f"gh:{owner}/{repo}".lower() != ref:
        return None  # URL and ref name different repositories
    name = entry.get("repo_name")
    return {
        "repo_name": name if isinstance(name, str) and _NAME.match(name) else repo,
        "repo_url": url,
        "canonical_ref": ref,
        "owner": owner,
        **(_sharing(entry) or {}),
    }


def compact_github_repos(payload: Any) -> List[Dict[str, str]]:
    """Inventory response (``{"repos": [...]}`` or the list) → deduplicated, sorted entries."""
    entries = payload.get("repos") if isinstance(payload, dict) else payload
    by_ref: Dict[str, Dict[str, str]] = {}
    for entry in entries if isinstance(entries, list) else []:
        repo = _compact(entry)
        if repo is None:
            continue
        known = by_ref.get(repo["canonical_ref"])
        if known is None or ("shared_team" in known and "shared_team" not in repo):
            by_ref[repo["canonical_ref"]] = repo
    return sorted(by_ref.values(), key=lambda r: (r["owner"].lower(), r["repo_name"].lower(), r["canonical_ref"]))


def _line(repo: Dict[str, str]) -> str:
    line = f"- {repo['repo_name']} — {repo['repo_url']} ({repo['canonical_ref']})"
    if "shared_team" not in repo:
        return line
    return f'{line} — a teammate\'s repo, shared by "{repo["shared_by"]}" with team "{repo["shared_team"]}"'


def render_github_repos_section(repos: Any) -> str:
    """The high-level repo section of the root ``<environment>`` block; "" when there are none."""
    shown = compact_github_repos(repos)
    if not shown:
        return ""
    lines = [
        GITHUB_REPOS_HEADING,
        "",
        "High-level info: the repositories you can use when creating a code agent "
        "(pass the gh:owner/repo ref in parentheses as github_repo_ref):",
    ]
    lines.extend(_line(r) for r in shown[:MAX_GITHUB_REPOS])
    hidden = len(shown) - MAX_GITHUB_REPOS
    if hidden > 0:
        lines.append(f"+{hidden} more connected repositories")
    return "\n".join(lines)


GITHUB_REPOS_NONE = "None now: no connected GitHub repositories (the earlier list no longer applies)."


def previous_github_repos_section(block: Optional[str]) -> str:
    """The repo section of an already rendered ``<environment>`` block ("" when it had none)."""
    if not block:
        return ""
    start = block.find("\n" + GITHUB_REPOS_HEADING)
    if start < 0:
        return ""
    end = block.rfind("\n</environment>")
    return block[start + 1 : end if end > start else len(block)].rstrip()


def github_repos_section(repos: Optional[Any], previous_section: str = "") -> str:
    """The root's repo section given the live inventory and the section it was last shown.

    None (fetch failed) keeps the last section unchanged; an empty inventory after a shown
    one says so explicitly; an inventory that was never shown and is empty stays omitted.
    """
    if repos is None:
        return previous_section
    section = render_github_repos_section(repos)
    if section or not previous_section:
        return section
    return f"{GITHUB_REPOS_HEADING}\n\n{GITHUB_REPOS_NONE}"


__all__ = [
    "GITHUB_REPOS_HEADING",
    "GITHUB_REPOS_NONE",
    "MAX_GITHUB_REPOS",
    "compact_github_repos",
    "github_repos_section",
    "previous_github_repos_section",
    "render_github_repos_section",
]
