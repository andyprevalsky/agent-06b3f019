"""Connected GitHub repos for the root agent's ``<environment>`` block (pure).

    GET /api/integrations/github/repos (owner-scoped, connected + still granted)
        ──▶ compact_github_repos: {repo_name, repo_url, canonical_ref} per repo,
            deduplicated by canonical_ref, sorted by (owner, repo_name)
        ──▶ render_github_repos_section: one line per repo, "" when there are none

Only the three public identifiers ever reach the model: a URL carrying
userinfo (credentials), a non-GitHub URL or a malformed canonical ref drops
the entry instead of being rendered. The canonical ref (``gh:<owner>/<repo>``,
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
    }


def compact_github_repos(payload: Any) -> List[Dict[str, str]]:
    """Inventory response (``{"repos": [...]}`` or the list) → deduplicated, sorted entries."""
    entries = payload.get("repos") if isinstance(payload, dict) else payload
    by_ref: Dict[str, Dict[str, str]] = {}
    for entry in entries if isinstance(entries, list) else []:
        repo = _compact(entry)
        if repo is not None:
            by_ref.setdefault(repo["canonical_ref"], repo)
    return sorted(by_ref.values(), key=lambda r: (r["owner"].lower(), r["repo_name"].lower(), r["canonical_ref"]))


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
    lines.extend(f"- {r['repo_name']} — {r['repo_url']} ({r['canonical_ref']})" for r in shown[:MAX_GITHUB_REPOS])
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
