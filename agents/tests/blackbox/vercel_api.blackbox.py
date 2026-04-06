"""Blackbox tests for vercel_api domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_parse_github_repo_owner_repo():
    """_parse_github_repo parses 'owner/repo' format."""
    from helpers.vercel_api import _parse_github_repo

    owner, repo = _parse_github_repo("myorg/myrepo")

    assert owner == "myorg"
    assert repo == "myrepo"


def test_parse_github_repo_full_url():
    """_parse_github_repo parses full GitHub URL."""
    from helpers.vercel_api import _parse_github_repo

    owner, repo = _parse_github_repo("https://github.com/acme/webapp")

    assert owner == "acme"
    assert repo == "webapp"


def test_parse_github_repo_with_git_suffix():
    """_parse_github_repo strips .git suffix from URL."""
    from helpers.vercel_api import _parse_github_repo

    owner, repo = _parse_github_repo("https://github.com/acme/webapp.git")

    assert owner == "acme"
    assert repo == "webapp"


def test_parse_github_repo_invalid():
    """_parse_github_repo raises ValueError for invalid format."""
    from helpers.vercel_api import _parse_github_repo

    try:
        _parse_github_repo("not-a-valid-url")
        raise AssertionError("Should have raised ValueError")
    except ValueError as e:
        assert "Invalid GitHub repo format" in str(e)


def test_parse_github_repo_non_github():
    """_parse_github_repo raises ValueError for non-GitHub URLs."""
    from helpers.vercel_api import _parse_github_repo

    try:
        _parse_github_repo("https://gitlab.com/org/repo")
        raise AssertionError("Should have raised ValueError")
    except ValueError as e:
        assert "Invalid GitHub repo format" in str(e)


async def run_all_tests():
    print("vercel-api blackbox tests:")
    r = BlackboxResult()
    r.record("parse_github_repo_owner_repo", test_parse_github_repo_owner_repo)
    r.record("parse_github_repo_full_url", test_parse_github_repo_full_url)
    r.record("parse_github_repo_with_git_suffix", test_parse_github_repo_with_git_suffix)
    r.record("parse_github_repo_invalid", test_parse_github_repo_invalid)
    r.record("parse_github_repo_non_github", test_parse_github_repo_non_github)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
