"""Blackbox tests for vercel_api domain."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import httpx

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    setup_mock_fn,
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


async def test_ensure_vercel_project_found_existing():
    """ensure_vercel_project returns existing project if linked to the repo."""
    setup_mock(
        {
            "api.vercel.com/v9/projects": {
                "status": 200,
                "json": {
                    "projects": [
                        {
                            "id": "prj_1",
                            "name": "webapp-preview",
                            "link": {"org": "acme", "repo": "webapp"},
                            "alias": [{"domain": "webapp.vercel.app"}],
                        }
                    ]
                },
            }
        }
    )

    from helpers.vercel_api import ensure_vercel_project

    project = await ensure_vercel_project("test-token", "acme/webapp")

    assert project.id == "prj_1"
    assert project.name == "webapp-preview"
    assert project.github_repo == "acme/webapp"
    assert project.production_url == "webapp.vercel.app"


async def test_ensure_vercel_project_creates_new():
    """ensure_vercel_project creates a new project when none matches the repo."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and "v9/projects" in url:
            return httpx.Response(200, json={"projects": []})
        if request.method == "POST" and "v10/projects" in url:
            return httpx.Response(
                201,
                json={"id": "prj_new", "name": "webapp-preview"},
            )
        return httpx.Response(404, json={"error": "unexpected"})

    setup_mock_fn(handler)

    from helpers.vercel_api import ensure_vercel_project

    project = await ensure_vercel_project("test-token", "acme/webapp", team_id="team-1")

    assert project.id == "prj_new"
    assert project.github_repo == "acme/webapp"
    # POST payload should include gitRepository with github type
    calls = get_captured_requests()
    post_calls = [c for c in calls if c["method"] == "POST"]
    assert len(post_calls) == 1
    body = json.loads(post_calls[0]["requestBody"])
    assert body["gitRepository"]["type"] == "github"
    assert body["gitRepository"]["repo"] == "acme/webapp"


async def test_ensure_vercel_project_handles_409_collision():
    """ensure_vercel_project retries with UUID suffix on 409 name conflict."""
    call_counter = {"post": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and "v9/projects" in url:
            return httpx.Response(200, json={"projects": []})
        if request.method == "POST" and "v10/projects" in url:
            call_counter["post"] += 1
            if call_counter["post"] == 1:
                return httpx.Response(409, json={"error": "conflict"})
            return httpx.Response(201, json={"id": "prj_retry", "name": "webapp-preview-abc123"})
        return httpx.Response(404, json={"error": "unexpected"})

    setup_mock_fn(handler)

    from helpers.vercel_api import ensure_vercel_project

    project = await ensure_vercel_project("test-token", "acme/webapp")

    assert project.id == "prj_retry"
    assert call_counter["post"] == 2


async def test_get_deployment_for_branch_matches():
    """get_deployment_for_branch returns VercelDeployment for matching branch."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {
                    "deployments": [
                        {
                            "uid": "dpl_1",
                            "url": "preview-1.vercel.app",
                            "state": "READY",
                            "meta": {"githubCommitRef": "main"},
                            "created": "2024-01-01T00:00:00Z",
                        },
                        {
                            "uid": "dpl_2",
                            "url": "preview-2.vercel.app",
                            "state": "BUILDING",
                            "meta": {"githubCommitRef": "feature"},
                            "created": "2024-01-02T00:00:00Z",
                        },
                    ]
                },
            }
        }
    )

    from helpers.vercel_api import get_deployment_for_branch

    deployment = await get_deployment_for_branch("test-token", "prj_1", "feature")

    assert deployment is not None
    assert deployment.id == "dpl_2"
    assert deployment.url == "https://preview-2.vercel.app"
    assert deployment.state == "BUILDING"
    assert deployment.branch == "feature"


async def test_get_deployment_for_branch_not_found():
    """get_deployment_for_branch returns None when no match."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {"deployments": []},
            }
        }
    )

    from helpers.vercel_api import get_deployment_for_branch

    deployment = await get_deployment_for_branch("test-token", "prj_1", "nothing", team_id="team-a")

    assert deployment is None


async def test_list_deployments_parses_all():
    """list_deployments returns list of VercelDeployment objects."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {
                    "deployments": [
                        {
                            "uid": "dpl_1",
                            "url": "a.vercel.app",
                            "state": "READY",
                            "meta": {"gitBranch": "main"},
                            "created": "2024-01-01T00:00:00Z",
                        },
                        {
                            "uid": "dpl_2",
                            "url": "b.vercel.app",
                            "state": "ERROR",
                            "meta": {},
                        },
                    ]
                },
            }
        }
    )

    from helpers.vercel_api import list_deployments

    deployments = await list_deployments("test-token", "prj_1", team_id="team-a", limit=5)

    assert len(deployments) == 2
    assert deployments[0].id == "dpl_1"
    assert deployments[0].url == "https://a.vercel.app"
    assert deployments[0].branch == "main"
    assert deployments[1].state == "ERROR"
    assert deployments[1].branch is None


async def test_get_vercel_preview_url_ready():
    """get_vercel_preview_url returns URL when deployment is READY."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {
                    "deployments": [
                        {
                            "uid": "dpl_ready",
                            "url": "live.vercel.app",
                            "state": "READY",
                            "meta": {"githubCommitRef": "main"},
                        }
                    ]
                },
            }
        }
    )

    on_updates = []

    async def on_status(deployment):
        on_updates.append(deployment.state)

    from helpers.vercel_api import get_vercel_preview_url

    with patch("asyncio.sleep", new=AsyncMock()):
        url = await get_vercel_preview_url(
            token="test-token",
            project_id="prj_1",
            branch_name="main",
            poll_interval=0.01,
            timeout=5.0,
            on_status_update=on_status,
        )

    assert url == "https://live.vercel.app"
    assert "READY" in on_updates


async def test_get_vercel_preview_url_error_raises():
    """get_vercel_preview_url raises RuntimeError on ERROR state."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {
                    "deployments": [
                        {
                            "uid": "dpl_err",
                            "url": "x.vercel.app",
                            "state": "ERROR",
                            "meta": {"githubCommitRef": "main"},
                        }
                    ]
                },
            }
        }
    )

    from helpers.vercel_api import get_vercel_preview_url

    with patch("asyncio.sleep", new=AsyncMock()):
        try:
            await get_vercel_preview_url(
                token="test-token",
                project_id="prj_1",
                branch_name="main",
                poll_interval=0.01,
                timeout=5.0,
            )
            raise AssertionError("Expected RuntimeError")
        except RuntimeError as e:
            assert "failed" in str(e)


async def test_get_vercel_preview_url_canceled_raises():
    """get_vercel_preview_url raises RuntimeError on CANCELED state."""
    setup_mock(
        {
            "api.vercel.com/v6/deployments": {
                "status": 200,
                "json": {
                    "deployments": [
                        {
                            "uid": "dpl_cx",
                            "url": "c.vercel.app",
                            "state": "CANCELED",
                            "meta": {"githubCommitRef": "main"},
                        }
                    ]
                },
            }
        }
    )

    from helpers.vercel_api import get_vercel_preview_url

    with patch("asyncio.sleep", new=AsyncMock()):
        try:
            await get_vercel_preview_url(
                token="test-token",
                project_id="prj_1",
                branch_name="main",
                poll_interval=0.01,
                timeout=5.0,
            )
            raise AssertionError("Expected RuntimeError")
        except RuntimeError as e:
            assert "canceled" in str(e).lower()


async def run_all_tests():
    print("vercel-api blackbox tests:")
    r = BlackboxResult()
    r.record("parse_github_repo_owner_repo", test_parse_github_repo_owner_repo)
    r.record("parse_github_repo_full_url", test_parse_github_repo_full_url)
    r.record("parse_github_repo_with_git_suffix", test_parse_github_repo_with_git_suffix)
    r.record("parse_github_repo_invalid", test_parse_github_repo_invalid)
    r.record("parse_github_repo_non_github", test_parse_github_repo_non_github)
    await r.record_async("ensure_vercel_project_found_existing", test_ensure_vercel_project_found_existing)
    await r.record_async("ensure_vercel_project_creates_new", test_ensure_vercel_project_creates_new)
    await r.record_async("ensure_vercel_project_handles_409_collision", test_ensure_vercel_project_handles_409_collision)
    await r.record_async("get_deployment_for_branch_matches", test_get_deployment_for_branch_matches)
    await r.record_async("get_deployment_for_branch_not_found", test_get_deployment_for_branch_not_found)
    await r.record_async("list_deployments_parses_all", test_list_deployments_parses_all)
    await r.record_async("get_vercel_preview_url_ready", test_get_vercel_preview_url_ready)
    await r.record_async("get_vercel_preview_url_error_raises", test_get_vercel_preview_url_error_raises)
    await r.record_async("get_vercel_preview_url_canceled_raises", test_get_vercel_preview_url_canceled_raises)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
